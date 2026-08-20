/* ============================================================
   Meteo — logica applicativa
   Dati: Open-Meteo (nessuna chiave, nessun account).
   ============================================================ */

const VERSION = '2.0.0';
const API      = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE  = 'https://geocoding-api.open-meteo.com/v1/search';

/* ---------- 1. Tabelle e soglie ---------------------------- */

/* Scala d'abbigliamento: la soglia è il MINIMO di temperatura
   percepita nella finestra in cui sei fuori, non la media —
   ci si veste per il momento più freddo, non per quello medio. */
const LAYERS = [
  { from:  28, main: 'Il più leggero che hai.' },
  { from:  24, main: 'Maglietta.' },
  { from:  20, main: 'Maglietta, felpa per la sera.' },
  { from:  16, main: 'Felpa leggera.' },
  { from:  12, main: 'Felpa e giacca leggera.' },
  { from:   8, main: 'Giacca.' },
  { from:   4, main: 'Giacca pesante.' },
  { from:   0, main: 'Cappotto e sciarpa.' },
  { from:-99, main: 'Cappotto pesante, sciarpa e guanti.' },
];

const CHILL_STEP = 1.5;   // °C di percepito per ogni tacca del cursore
const CHILL_WORDS = {
  '-4':'molto freddoloso', '-3':'freddoloso', '-2':'un po’ freddoloso',
  '-1':'quasi equilibrato', '0':'equilibrato', '1':'quasi equilibrato',
  '2':'un po’ caldoso', '3':'caldoso', '4':'molto caldoso',
};

const POP_UMBRELLA  = 40;   // % di probabilità oltre cui conta l'ombrello
const MM_UMBRELLA   = 0.5;  // mm cumulati che valgono comunque l'ombrello
const GUST_WINDY    = 45;   // km/h: sopra, l'ombrello è controproducente
const UV_STRONG     = 7;
const SWING_LAYERED = 9;    // °C di escursione che giustificano la cipolla
const RAIN_ON       = 0.1;  // mm/15min: sotto questa soglia non è pioggia

/* Codici WMO -> icona + descrizione */
function wmo(code, isDay = 1) {
  const d = isDay ? 1 : 0;
  const m = {
    0:  [d ? 'sun' : 'moon', d ? 'sereno' : 'sereno'],
    1:  [d ? 'sun' : 'moon', 'poco nuvoloso'],
    2:  [d ? 'cloud-sun' : 'cloud-moon', 'parzialmente nuvoloso'],
    3:  ['cloud', 'coperto'],
    45: ['fog', 'nebbia'], 48: ['fog', 'nebbia gelata'],
    51: ['drizzle', 'pioviggine'], 53: ['drizzle', 'pioviggine'], 55: ['drizzle', 'pioviggine intensa'],
    56: ['drizzle', 'pioviggine gelata'], 57: ['drizzle', 'pioviggine gelata'],
    61: ['rain', 'pioggia debole'], 63: ['rain', 'pioggia'], 65: ['rain', 'pioggia forte'],
    66: ['rain', 'pioggia gelata'], 67: ['rain', 'pioggia gelata forte'],
    71: ['snow', 'neve debole'], 73: ['snow', 'neve'], 75: ['snow', 'neve forte'],
    77: ['snow', 'nevischio'],
    80: ['rain', 'rovesci'], 81: ['rain', 'rovesci'], 82: ['rain', 'rovesci forti'],
    85: ['snow', 'rovesci di neve'], 86: ['snow', 'rovesci di neve'],
    95: ['thunder', 'temporale'], 96: ['thunder', 'temporale con grandine'], 99: ['thunder', 'temporale con grandine'],
  };
  return m[code] || ['cloud', '—'];
}
const isSnowCode = c => (c >= 71 && c <= 77) || c === 85 || c === 86;
const isStormCode = c => c >= 95;

/* ---------- 2. Stato e memoria del dispositivo ------------- */

const store = {
  get places() { return read('meteo.places', []); },
  set places(v) { write('meteo.places', v); },
  get active() { return read('meteo.active', 0); },
  set active(v) { write('meteo.active', v); },
  get chill() { return read('meteo.chill', 0); },
  set chill(v) { write('meteo.chill', v); },
  cacheGet(id) { return read('meteo.cache.' + id, null); },
  cacheSet(id, data) { write('meteo.cache.' + id, { at: Date.now(), data }); },
  cacheDel(id) { try { localStorage.removeItem('meteo.cache.' + id); } catch (e) {} },
};
function read(k, fallback) {
  try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
  catch (e) { return fallback; }
}
function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

let inflight = null;   // AbortController della richiesta in corso

/* ---------- 3. Tempo ---------------------------------------
   Open-Meteo con timezone=auto restituisce orari "da orologio
   a muro" della località, senza offset. Li confrontiamo fra
   loro trattandoli tutti come UTC, e portiamo "adesso" nella
   stessa scala sommando l'offset della località. Così l'app
   resta corretta anche guardando una città in un altro fuso. */

const tsOf   = s => Date.parse(s + 'Z');
const nowTs  = d => Date.now() + (d.utc_offset_seconds || 0) * 1000;
const hhmm   = s => s.slice(11, 16);
const dayKey = s => s.slice(0, 10);

function weekday(iso, short = true) {
  return new Date(tsOf(iso)).toLocaleDateString('it-IT', {
    weekday: short ? 'short' : 'long', timeZone: 'UTC',
  }).replace('.', '');
}
function minutesBetween(a, b) { return Math.round((b - a) / 60000); }

/* ---------- 4. Rete ---------------------------------------- */

async function fetchForecast(place, signal) {
  const q = new URLSearchParams({
    latitude:  place.lat,
    longitude: place.lon,
    current:   'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,is_day',
    minutely_15: 'precipitation,weather_code',
    hourly:    'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,uv_index,is_day',
    daily:     'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_gusts_10m_max',
    timezone:  'auto',
    forecast_days: '7',
    forecast_minutely_15: '20',
  });
  const res = await fetch(API + '?' + q, { signal });
  if (!res.ok) throw new Error('Il servizio meteo ha risposto ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.reason || 'Risposta non valida');
  return data;
}

async function searchPlaces(name, signal) {
  const q = new URLSearchParams({ name, count: '8', language: 'it', format: 'json' });
  const res = await fetch(GEOCODE + '?' + q, { signal });
  if (!res.ok) throw new Error('ricerca non disponibile');
  return (await res.json()).results || [];
}

/* ---------- 5. Finestra della giornata ---------------------
   Si veste per le ore in cui si è fuori: da adesso al tramonto.
   Dopo il tramonto la domanda diventa "domani come mi vesto",
   quindi la finestra scivola all'alba successiva. */

function daylightWindow(data) {
  const now = nowTs(data);
  const d = data.daily;
  for (let i = 0; i < d.time.length; i++) {
    const rise = tsOf(d.sunrise[i]);
    const set  = tsOf(d.sunset[i]);
    if (now < set - 30 * 60000) {
      const started = now > rise;
      return {
        from: Math.max(now, rise), to: set, dayIndex: i,
        label: i === 0
          ? (started ? 'fino al tramonto' : 'oggi, dall’alba al tramonto')
          : 'domani, dall’alba al tramonto',
        tomorrow: i > 0,
      };
    }
  }
  return { from: now, to: now + 12 * 3600000, dayIndex: 0, label: 'prossime 12 ore', tomorrow: false };
}

function hoursIn(data, from, to) {
  const h = data.hourly;
  if (!h || !h.time) return [];
  const out = [];
  for (let i = 0; i < h.time.length; i++) {
    const t = tsOf(h.time[i]);
    if (t >= from - 1800000 && t <= to + 1800000) {
      out.push({
        t, iso: h.time[i],
        temp: h.temperature_2m[i],
        feels: h.apparent_temperature[i],
        pop: h.precipitation_probability[i] ?? 0,
        mm: h.precipitation[i] ?? 0,
        code: h.weather_code[i],
        wind: h.wind_speed_10m[i],
        gust: h.wind_gusts_10m[i] ?? 0,
        uv: h.uv_index[i] ?? 0,
        day: h.is_day[i],
      });
    }
  }
  return out;
}

/* ---------- 6. Il verdetto --------------------------------- */

function dressAdvice(data, chill) {
  const win = daylightWindow(data);
  let hrs = hoursIn(data, win.from, win.to);
  if (!hrs.length) hrs = hoursIn(data, win.from, win.from + 12 * 3600000);
  if (!hrs.length) {
    /* La finestra cade fuori dalle ore disponibili (previsione
       troncata): meglio consigliare sulle ore che ci sono che
       lasciare la schermata muta. */
    const all = hoursIn(data, -Infinity, Infinity);
    const now = nowTs(data);
    hrs = all.filter(h => h.t >= now).slice(0, 12);
    if (!hrs.length) hrs = all.slice(-12);
  }
  if (!hrs.length) return null;

  const feels = hrs.map(h => h.feels);
  const feelsMin = Math.min(...feels);
  const feelsMax = Math.max(...feels);
  const popMax   = Math.max(...hrs.map(h => h.pop));
  const mmSum    = hrs.reduce((s, h) => s + h.mm, 0);
  const gustMax  = Math.max(...hrs.map(h => h.gust));
  const uvMax    = Math.max(...hrs.map(h => h.uv));
  const snow     = hrs.some(h => isSnowCode(h.code));
  const storm    = hrs.some(h => isStormCode(h.code));

  /* Il cursore sposta la percezione: caldoso = "sento più caldo
     di quanto dica il modello", quindi meno strati. */
  const adjusted = feelsMin + chill * CHILL_STEP;
  const layer = LAYERS.find(l => adjusted >= l.from);

  const notes = [];
  const wet = popMax >= POP_UMBRELLA || mmSum >= MM_UMBRELLA;

  if (wet) {
    const first = hrs.find(h => h.pop >= POP_UMBRELLA || h.mm >= 0.2);
    const gear = gustMax >= GUST_WINDY
      ? 'Vento forte: meglio il cappuccio dell’ombrello'
      : (snow ? 'Scarpe che tengano' : 'Ombrello');
    if (first && minutesBetween(nowTs(data), first.t) > 90) {
      notes.push(`${gear} <span class="warn">dalle ${hhmm(first.iso)}</span>`);
    } else {
      notes.push(gear);
    }
  } else if (gustMax >= GUST_WINDY) {
    notes.push(`Raffiche fino a ${Math.round(gustMax)} km/h`);
  }

  if (storm) notes.push('possibili temporali');
  else if (snow && !wet) notes.push('neve in arrivo');

  const swing = feelsMax - feelsMin;
  if (swing >= SWING_LAYERED) notes.push(`${Math.round(swing)}° di escursione, vestiti a cipolla`);
  if (uvMax >= UV_STRONG && notes.length < 3) notes.push('sole forte');

  return {
    window: win,
    main: layer.main,
    note: notes.length ? notes[0] + (notes.length > 1 ? ' · ' + notes.slice(1).join(' · ') : '') : '',
    feelsMin, feelsMax,
  };
}

/* ---------- 7. Pioggia nell'immediato -----------------------
   minutely_15 viene dal modello ad alta risoluzione disponibile
   sulla località: risponde bene a "nella prossima ora piove?",
   non è un radar al minuto. */

function maxPop(data, from, to) {
  const hrs = hoursIn(data, from, to);
  return hrs.length ? Math.max(...hrs.map(h => h.pop)) : 0;
}

function rainNow(data) {
  const m = data.minutely_15;
  if (!m || !m.time) return null;
  const now = nowTs(data);
  const pts = [];
  for (let i = 0; i < m.time.length; i++) {
    const t = tsOf(m.time[i]);
    if (t >= now - 15 * 60000 && pts.length < 12) {
      pts.push({ t, iso: m.time[i], mm: m.precipitation[i] ?? 0, code: m.weather_code?.[i] ?? 0 });
    }
  }
  if (pts.length < 4) return null;

  const wetIdx = pts.findIndex(p => p.mm >= RAIN_ON);
  const peak = Math.max(...pts.map(p => p.mm));
  const snowing = pts.some(p => p.mm >= RAIN_ON && isSnowCode(p.code));
  const word = snowing ? 'Neve' : 'Pioggia';
  const spanMin = minutesBetween(pts[0].t, pts[pts.length - 1].t) + 15;
  const spanTxt = spanMin >= 120 ? Math.round(spanMin / 60) + ' ore' : spanMin + ' minuti';

  if (wetIdx === -1) {
    /* Il nowcast dice quanta acqua cade, la previsione oraria dice
       quanto è probabile che cada: con temporali sparsi le due cose
       divergono. Meglio dichiararlo che spacciare una certezza. */
    const popNow = maxPop(data, pts[0].t, pts[pts.length - 1].t);
    if (popNow >= 60) {
      return { pts, peak, dry: true, soft: true,
        text: `Niente ${word.toLowerCase()} prevista qui, ma probabilità al ${popNow}%: rovesci sparsi in zona.` };
    }
    return { pts, peak, dry: true, text: `Niente ${word.toLowerCase()} nelle prossime ${spanTxt}.` };
  }

  const intensity = mmH => (mmH < 1 ? 'debole' : mmH < 4 ? 'moderata' : 'forte');
  const strength = intensity(peak * 4);

  if (wetIdx === 0) {
    /* Sta già scendendo: interessa quando smette. */
    let end = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      if (pts[i].mm < RAIN_ON && pts[i + 1].mm < RAIN_ON) { end = i; break; }
    }
    if (end === -1) {
      return { pts, peak, dry: false, text: `${word} in corso, ${strength}. Non smette entro ${spanTxt}.` };
    }
    return { pts, peak, dry: false, text: `${word} in corso. Dovrebbe smettere verso le ${hhmm(pts[end].iso)}.` };
  }

  const inMin = minutesBetween(now, pts[wetIdx].t);
  const when = inMin <= 20 ? 'tra pochi minuti' : `tra circa ${Math.round(inMin / 5) * 5} minuti`;
  return {
    pts, peak, dry: false,
    text: `${word} ${strength} ${when}, verso le ${hhmm(pts[wetIdx].iso)}.`,
  };
}

/* ---------- 7b. Il cielo -----------------------------------
   La scena di sfondo traduce condizione e ora in un colore:
   si capisce che tempo fa prima ancora di leggere. Alba e
   tramonto vincono sul sereno o nuvoloso, ma non su pioggia,
   neve e temporale — quelli restano l'informazione dominante. */

const NEAR_HORIZON = 50 * 60000;   // quanto dura il "momento d'oro"

function skyScene(data) {
  const cur = data.current || {};
  const code = cur.weather_code ?? 0;
  const isDay = cur.is_day ?? 1;
  const now = nowTs(data);
  const d = data.daily;

  let near = null;
  if (d && d.sunrise) {
    for (let i = 0; i < Math.min(2, d.sunrise.length); i++) {
      if (Math.abs(now - tsOf(d.sunrise[i])) < NEAR_HORIZON) near = 'dawn';
      if (Math.abs(now - tsOf(d.sunset[i]))  < NEAR_HORIZON) near = 'dusk';
    }
  }

  if (isStormCode(code)) return 'storm';
  if (isSnowCode(code))  return 'snow';
  if (code >= 51)        return isDay ? 'rain-day' : 'rain-night';
  if (code === 45 || code === 48) return 'fog';
  if (near) return near;
  if (code === 3) return isDay ? 'overcast'  : 'night-cloud';
  if (code === 2) return isDay ? 'day-cloud' : 'night-cloud';
  return isDay ? 'day-clear' : 'night-clear';
}

function applyScene(name) {
  const root = document.documentElement;
  if (root.dataset.scene === name) return;
  root.dataset.scene = name;
  /* la barra di stato di iOS si intona al cielo */
  const top = getComputedStyle(root).getPropertyValue('--sky-1').trim();
  if (top) document.getElementById('theme-color').setAttribute('content', top);
}

/* ---------- 8. Rendering ----------------------------------- */

const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const icon = (name, cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.appendChild(u);
  return s;
};

function showState(which, msg) {
  ['state-loading', 'state-empty', 'state-error'].forEach(id => { $(id).hidden = id !== which; });
  ['hero', 'hours-card', 'days-card'].forEach(id => { $(id).hidden = which !== null; });
  $('stamp').hidden = which !== null;
  if (msg) $('error-msg').textContent = msg;
}

function renderPlaces() {
  const nav = $('places');
  nav.textContent = '';
  store.places.forEach((p, i) => {
    const b = el('button', 'place', p.name);
    b.setAttribute('aria-current', String(i === store.active));
    b.onclick = () => { store.active = i; load(); };
    nav.appendChild(b);
  });
  const active = nav.children[store.active];
  if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

let lastPlaceId = null;

function renderAll(data, cachedAt) {
  const chill = store.chill;
  applyScene(skyScene(data));
  const advice = dressAdvice(data, chill);
  const cur = data.current;

  /* verdetto */
  if (advice) {
    $('hero-window').textContent = advice.window.label;
    $('verdict').textContent = advice.main;
    $('verdict-note').innerHTML = advice.note;
    $('verdict-note').hidden = !advice.note;
  }

  /* condizione attuale */
  const [ic] = wmo(cur.weather_code, cur.is_day);
  const nowIco = $('now-icon');
  nowIco.replaceWith(Object.assign(icon(ic, 'now-ico'), { id: 'now-icon' }));
  $('now-temp').textContent = Math.round(cur.temperature_2m);
  $('now-feels').textContent = 'percepiti ' + Math.round(cur.apparent_temperature) + '°';
  const di = advice ? advice.window.dayIndex : 0;
  $('now-range').textContent =
    `min ${Math.round(data.daily.temperature_2m_min[di])}° · max ${Math.round(data.daily.temperature_2m_max[di])}°`;

  /* i quattro dettagli */
  const facts = $('facts');
  facts.textContent = '';
  const d0 = data.daily, wi = advice ? advice.window : null;
  const di2 = wi ? wi.dayIndex : 0;
  const nowMs = nowTs(data);
  const sunUp = wi && !wi.tomorrow && nowMs < tsOf(d0.sunset[0]);
  const rows = [
    ['Vento', Math.round(cur.wind_speed_10m) + ' <small>km/h</small>'],
    ['Raffiche', Math.round(cur.wind_gusts_10m ?? 0) + ' <small>km/h</small>'],
    ['Umidità', Math.round(cur.relative_humidity_2m ?? 0) + '<small>%</small>'],
    sunUp
      ? ['Tramonto', hhmm(d0.sunset[0])]
      : ['Alba', hhmm(d0.sunrise[Math.min(di2, d0.sunrise.length - 1)])],
  ];
  rows.forEach(([k, v]) => {
    const cell = el('div', 'fact');
    cell.appendChild(el('span', 'fact-k', k));
    const val = el('div', 'fact-v');
    val.innerHTML = v;
    cell.appendChild(val);
    facts.appendChild(cell);
  });

  /* pioggia */
  const rain = rainNow(data);
  $('rain-card').hidden = !rain;
  if (rain) {
    $('rain-verdict').textContent = rain.text;
    $('rain-verdict').className = 'rain-text' + (rain.dry && !rain.soft ? ' dry' : '');
    const chart = $('rain-chart');
    chart.className = 'rain-chart' + (rain.dry ? ' flat' : '');
    chart.textContent = '';
    const scale = Math.max(rain.peak, 0.6);
    rain.pts.forEach((p, i) => {
      const bar = el('div', 'rain-bar' + (p.mm >= RAIN_ON ? ' wet' : '') + (i === 0 ? ' now' : ''));
      const h = rain.dry ? 3 : 3 + 54 * Math.sqrt(Math.min(p.mm, scale) / scale);
      bar.style.height = h + 'px';
      bar.title = hhmm(p.iso) + ' · ' + p.mm.toFixed(1) + ' mm';
      chart.appendChild(bar);
    });
    const ax = $('rain-axis');
    ax.textContent = '';
    ax.appendChild(el('span', null, 'ora'));
    ax.appendChild(el('span', null, hhmm(rain.pts[Math.floor(rain.pts.length / 2)].iso)));
    ax.appendChild(el('span', null, hhmm(rain.pts[rain.pts.length - 1].iso)));
  }

  /* ore */
  const now = nowTs(data);
  const next = hoursIn(data, now, now + 24 * 3600000).slice(0, 24);
  const box = $('hours');
  box.textContent = '';
  next.forEach((h, i) => {
    const c = el('div', 'hour' + (i === 0 ? ' is-now' : ''));
    c.appendChild(el('div', 'hour-time', i === 0 ? 'ora' : hhmm(h.iso)));
    c.appendChild(icon(wmo(h.code, h.day)[0], 'hour-ico'));
    c.appendChild(el('div', 'hour-temp', Math.round(h.temp) + '°'));
    c.appendChild(el('div', 'hour-pop', h.pop >= 20 ? h.pop + '%' : ''));
    box.appendChild(c);
  });

  /* giorni */
  const d = data.daily;
  const lo = Math.min(...d.temperature_2m_min);
  const hi = Math.max(...d.temperature_2m_max);
  const span = Math.max(hi - lo, 1);
  const list = $('days');
  list.textContent = '';
  d.time.forEach((iso, i) => {
    const row = el('div', 'day');
    const nm = el('div', 'day-name' + (i === 0 ? ' today' : ''), i === 0 ? 'oggi' : weekday(iso));
    row.appendChild(nm);
    row.appendChild(icon(wmo(d.weather_code[i], 1)[0], 'day-ico'));
    const pop = d.precipitation_probability_max[i];
    row.appendChild(el('div', 'day-pop', pop >= 30 ? pop + '%' : ''));
    row.appendChild(el('div', 'day-min', Math.round(d.temperature_2m_min[i]) + '°'));
    const bar = el('div', 'day-bar');
    const fill = el('span');
    fill.style.left  = ((d.temperature_2m_min[i] - lo) / span * 100) + '%';
    fill.style.width = ((d.temperature_2m_max[i] - d.temperature_2m_min[i]) / span * 100) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('div', 'day-max', Math.round(d.temperature_2m_max[i]) + '°'));
    list.appendChild(row);
  });

  /* aggiornamento */
  const ageMin = Math.round((Date.now() - cachedAt) / 60000);
  const stamp = $('stamp');
  stamp.textContent = ageMin < 2
    ? 'aggiornato ora'
    : 'aggiornato ' + (ageMin < 60 ? ageMin + ' min fa' : Math.round(ageMin / 60) + ' h fa');
  stamp.className = 'stamp' + (ageMin > 90 ? ' stale' : '');

  const place = store.places[store.active];
  if (place && place.id !== lastPlaceId) {
    lastPlaceId = place.id;
    const stage = $('hero');
    stage.classList.remove('enter');
    void stage.offsetWidth;          // forza il riavvio dell'animazione
    stage.classList.add('enter');
  }

  showState(null);
}

/* ---------- 9. Caricamento --------------------------------- */

async function load(force = false) {
  const places = store.places;
  if (!places.length) { showState('state-empty'); renderPlaces(); return; }
  if (store.active >= places.length) store.active = 0;
  const place = places[store.active];
  renderPlaces();

  /* Prima la copia salvata: la schermata è utile all'istante,
     anche in metropolitana. Poi si aggiorna da sola. */
  const cached = store.cacheGet(place.id);
  const fresh = cached && Date.now() - cached.at < 10 * 60000;
  if (cached) {
    try { renderAll(cached.data, cached.at); } catch (e) { showState('state-loading'); }
  } else {
    showState('state-loading');
  }
  if (fresh && !force) return;

  if (inflight) inflight.abort();
  inflight = new AbortController();
  try {
    const data = await fetchForecast(place, inflight.signal);
    store.cacheSet(place.id, data);
    renderAll(data, Date.now());
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (!cached) showState('state-error', navigator.onLine
      ? e.message
      : 'Sei offline e per questa località non ho ancora salvato nulla.');
  } finally {
    inflight = null;
  }
}

/* ---------- 10. Impostazioni ------------------------------- */

function openSheet() {
  $('sheet').hidden = false;
  $('sheet-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  renderFavs();
}
function closeSheet() {
  $('sheet').hidden = true;
  $('sheet-backdrop').hidden = true;
  document.body.style.overflow = '';
  $('search').value = '';
  $('results').hidden = true;
  load();
}

function renderFavs() {
  const list = $('fav-list');
  const places = store.places;
  list.textContent = '';
  if (!places.length) {
    const li = el('li', 'hint', 'Nessuna località salvata.');
    list.appendChild(li);
    return;
  }
  places.forEach((p, i) => {
    const li = el('li', 'fav');
    const name = el('div', 'fav-name', p.name);
    if (p.sub) name.appendChild(el('div', 'fav-sub', p.sub));
    li.appendChild(name);

    const up = el('button', 'fav-act', '↑');
    up.setAttribute('aria-label', 'Sposta su');
    up.disabled = i === 0;
    up.onclick = () => move(i, -1);
    const dn = el('button', 'fav-act', '↓');
    dn.setAttribute('aria-label', 'Sposta giù');
    dn.disabled = i === places.length - 1;
    dn.onclick = () => move(i, 1);
    const rm = el('button', 'fav-act del', '×');
    rm.setAttribute('aria-label', 'Rimuovi ' + p.name);
    rm.onclick = () => {
      const arr = store.places;
      store.cacheDel(arr[i].id);
      arr.splice(i, 1);
      store.places = arr;
      if (store.active >= arr.length) store.active = Math.max(0, arr.length - 1);
      renderFavs();
    };
    li.append(up, dn, rm);
    list.appendChild(li);
  });
}

function move(i, dir) {
  const arr = store.places;
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  store.places = arr;
  if (store.active === i) store.active = j;
  else if (store.active === j) store.active = i;
  renderFavs();
}

function addPlace(p) {
  const arr = store.places;
  if (arr.some(x => x.id === p.id)) return;
  arr.push(p);
  store.places = arr;
  store.active = arr.length - 1;
  renderFavs();
  $('search').value = '';
  $('results').hidden = true;
}

let searchCtl = null, searchTimer = null;
function onSearch() {
  const q = $('search').value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) { $('results').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    if (searchCtl) searchCtl.abort();
    searchCtl = new AbortController();
    const box = $('results');
    try {
      const found = await searchPlaces(q, searchCtl.signal);
      box.textContent = '';
      box.hidden = false;
      if (!found.length) {
        box.appendChild(el('li', 'r-empty', 'Nessun risultato per «' + q + '».'));
        return;
      }
      found.forEach(r => {
        const sub = [r.admin1, r.country].filter(Boolean).join(', ');
        const li = el('li');
        const b = el('button', null, r.name);
        b.appendChild(el('span', 'r-sub', sub));
        b.onclick = () => addPlace({
          id: 'g' + r.id, name: r.name, sub,
          lat: r.latitude, lon: r.longitude,
        });
        li.appendChild(b);
        box.appendChild(li);
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      box.hidden = false;
      box.textContent = '';
      box.appendChild(el('li', 'r-empty', 'Ricerca non disponibile: sei offline?'));
    }
  }, 280);
}

function useGeolocation() {
  const btn = $('btn-geo');
  if (!navigator.geolocation) { btn.textContent = 'Posizione non disponibile'; return; }
  btn.textContent = 'Rilevo la posizione…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      const arr = store.places.filter(p => p.id !== 'geo');
      arr.push({
        id: 'geo', name: 'Dove sono',
        sub: latitude.toFixed(3) + ', ' + longitude.toFixed(3),
        lat: +latitude.toFixed(4), lon: +longitude.toFixed(4),
      });
      store.places = arr;
      store.active = arr.length - 1;
      store.cacheDel('geo');
      btn.textContent = 'Usa la posizione attuale';
      renderFavs();
    },
    err => {
      btn.textContent = err.code === 1
        ? 'Permesso negato — abilitalo nelle impostazioni'
        : 'Posizione non trovata, riprova';
      setTimeout(() => { btn.textContent = 'Usa la posizione attuale'; }, 4000);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
  );
}

function setChill(v) {
  store.chill = v;
  $('chill-val').textContent = CHILL_WORDS[String(v)] || 'equilibrato';
  const cached = store.cacheGet((store.places[store.active] || {}).id);
  if (cached) { try { renderAll(cached.data, cached.at); } catch (e) {} }
}

/* ---------- 11. Avvio -------------------------------------- */

$('btn-settings').onclick = openSheet;
$('btn-close').onclick = closeSheet;
$('sheet-backdrop').onclick = closeSheet;
$('btn-first-add').onclick = openSheet;
$('btn-retry').onclick = () => load(true);
$('btn-geo').onclick = useGeolocation;
$('search').oninput = onSearch;
$('chill').oninput = e => setChill(+e.target.value);
$('version-line').textContent = 'Versione ' + VERSION;

$('chill').value = store.chill;
setChill(store.chill);

document.addEventListener('scroll', () => {
  $('main').parentElement && document.querySelector('.topbar')
    .classList.toggle('scrolled', window.scrollY > 4);
}, { passive: true });

/* Tornando sull'app dopo un po', i dati si aggiornano da soli. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('sheet').hidden) load();
});
window.addEventListener('online', () => load(true));

load();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
