/* ============================================================
   Meteo — logica applicativa
   Dati: Open-Meteo (nessuna chiave, nessun account).
   ============================================================ */

const VERSION = '3.0.0';
const API      = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE  = 'https://geocoding-api.open-meteo.com/v1/search';
const AIR      = 'https://air-quality-api.open-meteo.com/v1/air-quality';

/* Tre centri di calcolo indipendenti: il tedesco ad alta risoluzione,
   l'europeo e l'americano. Quanto si discostano fra loro è la misura
   più onesta di quanto valga la previsione. */
const MODELS = ['icon_seamless', 'ecmwf_ifs025', 'gfs_seamless'];

/* Chiave pubblica delle notifiche. La corrispondente privata vive
   solo fra i Secrets del repo e firma gli invii. */
const VAPID_PUBLIC = 'BK-x-91iwRSuCarnTsqhsSS1Uhfp7PMVGSoTkzEh5t82USzbYbxCpJv_wQS-5ec4EFjgwy6Ht_OKEUxVhXxdMBU';

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

/* Soglie degli avvisi: solo cose che cambiano davvero la giornata. */
const JUMP_DEG    = 6;    // °C di scarto fra oggi e domani che vale un avviso
const FROST_DEG   = 0;    // gelo notturno
const HEAT_DEG    = 33;   // caldo che pesa
const GALE_KMH    = 60;   // raffiche da mettere in guardia
const AQI_BAD     = 60;   // indice europeo: da qui in su si sente

/* Indice europeo della qualità dell'aria */
const AQI_BANDS = [
  [ 20, 'Buona'], [ 40, 'Discreta'], [ 60, 'Media'],
  [ 80, 'Scarsa'], [100, 'Molto scarsa'], [Infinity, 'Pessima'],
];

/* Pollini: nome italiano e soglie basso / moderato / alto in grani/m³,
   secondo le fasce usate in aerobiologia. */
const POLLEN = [
  ['alder_pollen',   'Ontano',      [10, 50, 200]],
  ['birch_pollen',   'Betulla',     [10, 50, 200]],
  ['grass_pollen',   'Graminacee',  [15, 30, 100]],
  ['olive_pollen',   'Olivo',       [15, 50, 200]],
  ['mugwort_pollen', 'Artemisia',   [ 5, 15,  50]],
  ['ragweed_pollen', 'Ambrosia',    [ 5, 11,  50]],
];
const POLLEN_WORDS = ['assente', 'basso', 'moderato', 'alto', 'molto alto'];

/* --- Dal numero alla parola ---
   Un valore in km/h o in percento non fa cambiare comportamento a
   nessuno che non sia del mestiere. Ogni misura porta con sé la
   parola comune che le corrisponde. */

const WIND_WORDS = [
  [  6, 'aria ferma'],     [ 19, 'brezza leggera'], [ 28, 'brezza'],
  [ 38, 'vento moderato'], [ 49, 'vento sostenuto'], [ 61, 'vento forte'],
  [ 74, 'burrasca'],       [Infinity, 'tempesta'],
];
const GUST_WORDS = [
  [ 19, 'trascurabili'], [ 38, 'moderate'], [ 49, 'sensibili'],
  [ 61, 'forti'],        [ 74, 'molto forti'], [Infinity, 'pericolose'],
];
const UV_WORDS = [
  [ 2, 'basso'], [ 5, 'medio'], [ 7, 'alto'], [ 10, 'molto alto'], [Infinity, 'estremo'],
];
const pick = (table, v) => (table.find(r => v <= r[0]) || table[table.length - 1])[1];

const windWord = kmh => pick(WIND_WORDS, kmh ?? 0);
const gustWord = kmh => pick(GUST_WORDS, kmh ?? 0);
const uvWord   = v   => pick(UV_WORDS, v ?? 0);

/* L'umidità da sola non dice nulla: 90% a 12° è nebbia, a 30° è afa. */
function humidityWord(rh, temp) {
  if (rh == null) return '';
  if (temp >= 27 && rh >= 60) return 'afa';
  if (rh < 30) return 'aria secca';
  if (rh < 55) return 'aria normale';
  if (rh < 75) return 'aria umida';
  return 'aria molto umida';
}

/* "fra 9 ore" si capisce meglio di "20:21" quando la domanda è
   quanta luce resta. */
function untilWord(ms) {
  const min = Math.round(ms / 60000);
  if (min <= 1) return 'adesso';
  if (min < 60) return 'fra ' + min + ' min';
  const h = Math.round(min / 60);
  if (h < 24) return 'fra ' + h + (h === 1 ? ' ora' : ' ore');
  return 'domani';
}

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
let loadSeq = 0;       // per non far scrivere a una richiesta sorpassata

/* ---------- 3. Tempo ---------------------------------------
   Open-Meteo con timezone=auto restituisce orari "da orologio
   a muro" della località, senza offset. Li confrontiamo fra
   loro trattandoli tutti come UTC, e portiamo "adesso" nella
   stessa scala sommando l'offset della località. Così l'app
   resta corretta anche guardando una città in un altro fuso. */

const tsOf   = s => Date.parse(s.length === 10 ? s + 'T00:00:00Z' : s + 'Z');
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
    past_days: '5',            /* serve a dire "prima pioggia dopo N giorni" */
    forecast_minutely_15: '20',
  });
  const res = await fetch(API + '?' + q, { signal });
  if (!res.ok) throw new Error('Il servizio meteo ha risposto ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.reason || 'Risposta non valida');
  return data;
}

async function fetchAir(place, signal) {
  const q = new URLSearchParams({
    latitude: place.lat, longitude: place.lon,
    current: 'european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,'
           + POLLEN.map(p => p[0]).join(','),
    timezone: 'auto', forecast_days: '1',
  });
  const res = await fetch(AIR + '?' + q, { signal });
  if (!res.ok) throw new Error('aria non disponibile');
  return res.json();
}

async function fetchSpread(place, signal) {
  const q = new URLSearchParams({
    latitude: place.lat, longitude: place.lon,
    daily: 'temperature_2m_max,precipitation_sum,precipitation_probability_max',
    models: MODELS.join(','),
    timezone: 'auto', forecast_days: '7',
  });
  const res = await fetch(API + '?' + q, { signal });
  if (!res.ok) throw new Error('modelli non disponibili');
  return res.json();
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
  const ti = todayIndex(data);   /* i giorni già trascorsi non si consigliano */
  for (let i = ti; i < d.time.length; i++) {
    const rise = tsOf(d.sunrise[i]);
    const set  = tsOf(d.sunset[i]);
    if (now < set - 30 * 60000) {
      const started = now > rise;
      return {
        from: Math.max(now, rise), to: set, dayIndex: i,
        label: i === ti
          ? (started ? 'fino al tramonto' : 'oggi, dall’alba al tramonto')
          : 'domani, dall’alba al tramonto',
        tomorrow: i > ti,
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
  return adviceFromHours(data, hrs, win, chill);
}

/* Lo stesso ragionamento applicato a un giorno qualunque della
   settimana: è ciò che permette di aprire sabato e sapere come
   vestirsi sabato. */
function dressAdviceForDay(data, i, chill) {
  const d = data.daily;
  if (!d.sunrise || !d.sunrise[i] || !d.sunset[i]) return null;
  const from = tsOf(d.sunrise[i]), to = tsOf(d.sunset[i]);
  const hrs = hoursIn(data, from, to);
  if (!hrs.length) return null;
  return adviceFromHours(data, hrs, { from, to, dayIndex: i, label: '', tomorrow: false }, chill);
}

function adviceFromHours(data, hrs, win, chill) {
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
    /* dire solo "smette" quando poi ricomincia sarebbe mezza verità */
    const again = pts.findIndex((p, i) => i > end && p.mm >= RAIN_ON);
    return {
      pts, peak, dry: false,
      text: again === -1
        ? `${word} in corso. Dovrebbe smettere verso le ${hhmm(pts[end].iso)}.`
        : `${word} in corso: pausa verso le ${hhmm(pts[end].iso)}, poi riprende verso le ${hhmm(pts[again].iso)}.`,
    };
  }

  const inMin = minutesBetween(now, pts[wetIdx].t);
  const when = inMin <= 20 ? 'tra pochi minuti' : `tra circa ${Math.round(inMin / 5) * 5} minuti`;
  return {
    pts, peak, dry: false,
    text: `${word} ${strength} ${when}, verso le ${hhmm(pts[wetIdx].iso)}.`,
  };
}

/* ---------- 7a. Avvisi, accordo fra modelli, aria ----------
   Tre domande a cui i numeri grezzi non rispondono: che cosa
   sta cambiando, quanto vale la previsione, che aria si respira. */

/* Con past_days la giornata di oggi non è più la prima della lista. */
function todayIndex(data) {
  const d = data.daily, now = nowTs(data);
  for (let i = 0; i < d.time.length; i++) {
    if (now < tsOf(d.time[i]) + 24 * 3600000) return i;
  }
  return 0;
}

const AQI_WORD = v => (AQI_BANDS.find(b => v <= b[0]) || AQI_BANDS[5])[1];

function pollenLevel(value, steps) {
  if (!value || value < 1) return 0;
  if (value < steps[0]) return 1;
  if (value < steps[1]) return 2;
  if (value < steps[2]) return 3;
  return 4;
}

/* --- che cosa sta cambiando --- */
function changeAlerts(bundle) {
  const data = bundle.f, d = data.daily;
  const ti = todayIndex(data), now = nowTs(data);
  const out = [];
  /* il tipo identifica l'evento a prescindere da come lo si racconta:
     serve a non ripetere la stessa allerta quando la frase cambia
     ("temporale verso le 12" e poi "temporale in corso"). */
  const add = (rank, kind, ico, tipo, text) => out.push({ rank, kind, ico, tipo, text });
  const round = v => Math.round(v);
  const todayStr = d.time[ti];

  /* temporale in arrivo */
  const storm = hoursIn(data, now, now + 24 * 3600000).find(h => isStormCode(h.code));
  if (storm) {
    const inMin = minutesBetween(now, storm.t);
    const when = dayKey(storm.iso) === todayStr ? 'oggi' : 'domani';
    add(1, 'warm', 'alert', 'temporale', inMin <= 30
      ? 'Temporale in corso o imminente.'
      : `Temporale ${when} verso le ${hhmm(storm.iso)}.`);
  }

  /* gelo notturno */
  for (let i = ti; i < Math.min(ti + 2, d.time.length); i++) {
    if (d.temperature_2m_min[i] <= FROST_DEG) {
      add(2, 'cool', 'down', 'gelo', `Gelo ${i === ti ? 'stanotte' : 'domani notte'}, minima ${round(d.temperature_2m_min[i])}°.`);
      break;
    }
  }

  /* caldo forte */
  for (let i = ti; i < Math.min(ti + 2, d.time.length); i++) {
    if (d.temperature_2m_max[i] >= HEAT_DEG) {
      add(3, 'hot', 'up', 'caldo', `Caldo forte ${i === ti ? 'oggi' : 'domani'}, fino a ${round(d.temperature_2m_max[i])}°.`);
      break;
    }
  }

  /* raffiche */
  const gust = d.wind_gusts_10m_max && d.wind_gusts_10m_max[ti];
  if (gust >= GALE_KMH) add(3, 'warm', 'wind', 'raffiche', `Raffiche fino a ${round(gust)} km/h oggi.`);

  /* sbalzo fra oggi e domani */
  const a = d.temperature_2m_max[ti], b = d.temperature_2m_max[ti + 1];
  if (a != null && b != null && Math.abs(b - a) >= JUMP_DEG) {
    add(4, b < a ? 'cool' : 'hot', b < a ? 'down' : 'up', 'sbalzo',
        `Domani ${round(Math.abs(b - a))}° in ${b < a ? 'meno' : 'più'} di oggi.`);
  }

  /* la prima pioggia dopo una serie di giorni asciutti */
  let dryRun = 0;
  for (let i = ti - 1; i >= 0; i--) {
    if ((d.precipitation_sum[i] ?? 0) < 1) dryRun++; else break;
  }
  if (dryRun >= 4) {
    for (let i = ti; i < Math.min(ti + 3, d.time.length); i++) {
      if ((d.precipitation_sum[i] ?? 0) >= 2) {
        const when = i === ti ? 'oggi' : i === ti + 1 ? 'domani' : weekday(d.time[i], false);
        add(5, 'cool', 'drop', 'primapioggia', `Prima pioggia dopo ${dryRun} giorni asciutti: ${when}.`);
        break;
      }
    }
  }

  /* aria e pollini, solo quando pesano */
  const air = bundle.air && bundle.air.current;
  if (air) {
    if (air.european_aqi >= AQI_BAD) {
      add(4, 'warm', 'haze', 'aria', `Aria ${AQI_WORD(air.european_aqi).toLowerCase()} oggi, indice ${round(air.european_aqi)}.`);
    }
    const worst = POLLEN
      .map(([k, name, steps]) => ({ name, lvl: pollenLevel(air[k], steps) }))
      .sort((x, y) => y.lvl - x.lvl)[0];
    if (worst && worst.lvl >= 3) {
      add(4, 'warm', 'haze', 'pollini', `${worst.name}: pollini a livello ${POLLEN_WORDS[worst.lvl]}.`);
    }
  }

  return out.sort((x, y) => x.rank - y.rank).slice(0, 2);
}

/* --- quanto vale la previsione ---
   Tre modelli sullo stesso giorno: più si discostano, meno vale.
   Le scale (2.5°, 4 mm, 40 punti di probabilità) sono tarate su
   quanto normalmente divergono già al primo giorno. */
function modelSpread(bundle) {
  const sp = bundle.spread;
  if (!sp || !sp.daily) return null;
  const d = sp.daily;
  const range = a => Math.max(...a) - Math.min(...a);
  const map = new Map();
  for (let i = 0; i < d.time.length; i++) {
    const pick = k => MODELS.map(m => d[k + '_' + m] && d[k + '_' + m][i]).filter(v => v != null);
    const T = pick('temperature_2m_max');
    const P = pick('precipitation_sum');
    const O = pick('precipitation_probability_max');
    if (T.length < 2) continue;
    const u = Math.max(
      range(T) / 2.5,
      P.length > 1 ? range(P) / 4 : 0,
      O.length > 1 ? range(O) / 40 : 0
    );
    map.set(d.time[i], { u, level: u < 1 ? 3 : u < 2 ? 2 : 1, dt: range(T) });
  }
  return map.size ? map : null;
}

function trustSentence(map, data) {
  const d = data.daily, ti = todayIndex(data);
  let shaky = -1;
  for (let i = ti; i < d.time.length; i++) {
    const e = map.get(d.time[i]);
    if (e && e.level === 1) { shaky = i; break; }
  }
  if (shaky === -1) return 'I tre modelli concordano su tutta la settimana: previsione solida.';
  if (shaky <= ti + 1) return 'I tre modelli <b>non concordano già da subito</b>: prendi anche i prossimi giorni con cautela.';
  return `I tre modelli vanno d'accordo fino a <b>${weekday(d.time[shaky - 1], false)}</b>; da lì in poi divergono e la previsione è solo indicativa.`;
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
  if (which !== null) $('air-card').hidden = true;   /* in positivo decide renderAir */
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

function renderAlerts(list) {
  const box = $('alerts');
  box.textContent = '';
  box.hidden = !list.length;
  list.forEach(a => {
    const row = el('div', 'alert ' + a.kind);
    row.appendChild(icon(a.ico || 'alert'));
    row.appendChild(el('span', null, a.text));
    box.appendChild(row);
  });
}

function renderAir(air) {
  const cur = air && air.current;
  const card = $('air-card');
  card.hidden = !cur || cur.european_aqi == null;
  if (card.hidden) return;

  const box = $('air');
  box.textContent = '';
  const aqi = cur.european_aqi;

  const top = el('div', 'air-top');
  top.appendChild(el('div', 'air-label', AQI_WORD(aqi)));
  top.appendChild(el('div', 'air-value', 'indice ' + Math.round(aqi)));
  box.appendChild(top);

  const scale = el('div', 'air-scale');
  const mark = el('i');
  mark.style.left = Math.max(0, Math.min(100, aqi / 110 * 100)) + '%';
  scale.appendChild(mark);
  box.appendChild(scale);

  const parts = el('div', 'air-parts');
  [['PM2.5', cur.pm2_5], ['PM10', cur.pm10], ['O₃', cur.ozone], ['NO₂', cur.nitrogen_dioxide]]
    .filter(pair => pair[1] != null)
    .forEach(([k, v]) => {
      const sp = el('span');
      sp.appendChild(document.createTextNode(k + ' '));
      sp.appendChild(el('b', null, Math.round(v)));
      parts.appendChild(sp);
    });
  box.appendChild(parts);

  /* i pollini contano solo quando ci sono: fuori stagione la
     sezione resta una riga sola invece di sei zeri */
  const active = POLLEN
    .map(([k, name, steps]) => ({ name, steps, v: cur[k] ?? 0, lvl: pollenLevel(cur[k], steps) }))
    .filter(x => x.lvl >= 1)
    .sort((a, b) => b.lvl - a.lvl || b.v - a.v)
    .slice(0, 3);

  if (!active.length) {
    box.appendChild(el('p', 'air-quiet', 'Nessun polline rilevante in questo momento.'));
    return;
  }
  const list = el('div', 'pollen');
  active.forEach(x => {
    const row = el('div', 'pollen-row' + (x.lvl >= 3 ? ' high' : ''));
    row.appendChild(el('div', 'pollen-name', x.name));
    row.appendChild(el('div', 'pollen-level', POLLEN_WORDS[x.lvl]));
    const bar = el('div', 'pollen-bar');
    const fill = el('span');
    fill.style.width = Math.min(100, x.v / x.steps[2] * 100) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    list.appendChild(row);
  });
  box.appendChild(list);
}

/* La striscia delle ore, usata sia in apertura sia dentro un giorno.
   Le ore di notte sono più scure, alba e tramonto compaiono al loro
   posto nella sequenza, e la pioggia è una fascia continua sotto:
   così si vede quando piove, non solo se. */
function renderHours(box, hrs, data, opts = {}) {
  box.textContent = '';
  if (!hrs.length) return;

  const d = data.daily;
  const from = hrs[0].t, to = hrs[hrs.length - 1].t + 3599000;
  const marks = [];
  if (d.sunrise) {
    for (let i = 0; i < d.sunrise.length; i++) {
      [[d.sunrise[i], 'alba'], [d.sunset[i], 'tramonto']].forEach(([iso, label]) => {
        if (!iso) return;
        const t = tsOf(iso);
        if (t >= from && t <= to) marks.push({ t, iso, label });
      });
    }
  }

  const items = hrs.map(h => ({ t: h.t, h }))
    .concat(marks.map(m => ({ t: m.t, m })))
    .sort((a, b) => a.t - b.t);

  items.forEach((it, i) => {
    if (it.m) {
      const c = el('div', 'hour sunmark');
      const box2 = el('div', 'hour-sun');
      box2.appendChild(icon('sun'));
      box2.appendChild(el('span', null, it.m.label));
      box2.appendChild(el('span', null, hhmm(it.m.iso)));
      c.appendChild(box2);
      box.appendChild(c);
      return;
    }
    const h = it.h;
    const primo = opts.markNow && !items.slice(0, i).some(x => x.h);
    const c = el('div', 'hour' + (primo ? ' is-now' : '') + (h.day ? '' : ' night'));
    c.dataset.t = h.t;
    c.appendChild(el('div', 'hour-time', primo ? 'ora' : hhmm(h.iso)));
    c.appendChild(icon(wmo(h.code, h.day)[0], 'hour-ico'));
    c.appendChild(el('div', 'hour-temp', Math.round(h.temp) + '°'));
    c.appendChild(el('div', 'hour-pop', h.pop >= 20 ? h.pop + '%' : ''));
    const bagnato = h.mm >= 0.1 || h.pop >= 50;
    const rain = el('div', 'hour-rain' + (bagnato ? '' : ' dry'));
    rain.title = h.mm ? h.mm.toFixed(1) + ' mm' : (h.pop || 0) + '%';
    c.appendChild(rain);
    box.appendChild(c);
  });
}

let lastPlaceId = null;
let current = null;      // ultimo insieme di dati disegnato

function renderAll(bundle, cachedAt) {
  current = bundle;
  const data = bundle.f;
  const chill = store.chill;
  applyScene(skyScene(data));
  const advice = dressAdvice(data, chill);
  const cur = data.current;
  const ti = todayIndex(data);

  renderAlerts(changeAlerts(bundle));
  renderAir(bundle.air);

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
  const di = advice ? advice.window.dayIndex : ti;
  $('now-range').textContent =
    `min ${Math.round(data.daily.temperature_2m_min[di])}° · max ${Math.round(data.daily.temperature_2m_max[di])}°`;

  /* i quattro dettagli */
  const facts = $('facts');
  facts.textContent = '';
  const d0 = data.daily, wi = advice ? advice.window : null;
  const di2 = wi ? wi.dayIndex : ti;
  const nowMs = nowTs(data);
  const sunUp = wi && !wi.tomorrow && nowMs < tsOf(d0.sunset[ti]);
  const gust = Math.round(cur.wind_gusts_10m ?? 0);
  const rh = Math.round(cur.relative_humidity_2m ?? 0);
  const sunIso = sunUp ? d0.sunset[ti] : d0.sunrise[Math.min(di2, d0.sunrise.length - 1)];
  const rows = [
    ['Vento', Math.round(cur.wind_speed_10m) + ' <small>km/h</small>',
      windWord(cur.wind_speed_10m), cur.wind_speed_10m >= 39],
    ['Raffiche', gust + ' <small>km/h</small>',
      gust >= GUST_WINDY ? 'ombrello a rischio' : gustWord(gust), gust >= GUST_WINDY],
    ['Umidità', rh + '<small>%</small>',
      humidityWord(rh, cur.temperature_2m), rh >= 60 && cur.temperature_2m >= 27],
    [sunUp ? 'Tramonto' : 'Alba', hhmm(sunIso), untilWord(tsOf(sunIso) - nowMs), false],
  ];
  rows.forEach(([k, v, word, warn]) => {
    const cell = el('div', 'fact' + (warn ? ' alert' : ''));
    cell.appendChild(el('span', 'fact-k', k));
    const val = el('div', 'fact-v');
    val.innerHTML = v;
    cell.appendChild(val);
    if (word) cell.appendChild(el('div', 'fact-w', word));
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
  renderHours($('hours'), hoursIn(data, now, now + 24 * 3600000).slice(0, 24), data, { markNow: true });

  /* giorni: l'archivio dei giorni scorsi serve solo agli avvisi,
     qui si parte da oggi */
  const d = data.daily;
  const spread = modelSpread(bundle);
  const idx = [];
  for (let i = ti; i < d.time.length; i++) idx.push(i);
  const lo = Math.min(...idx.map(i => d.temperature_2m_min[i]));
  const hi = Math.max(...idx.map(i => d.temperature_2m_max[i]));
  const span = Math.max(hi - lo, 1);
  const list = $('days');
  list.textContent = '';
  idx.forEach(i => {
    const iso = d.time[i];
    const row = el('div', 'day');
    const nm = el('div', 'day-name' + (i === ti ? ' today' : ''), i === ti ? 'oggi' : weekday(iso));
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

    /* quanto i tre modelli concordano su questo giorno */
    const e = spread && spread.get(iso);
    const trust = el('div', 'day-trust' + (e && e.level === 1 ? ' low' : ''));
    for (let k = 0; k < 3; k++) {
      trust.appendChild(el('i', e && k < e.level ? 'on' : null));
    }
    trust.title = e
      ? 'Scarto fra i modelli: ' + e.dt.toFixed(1) + '°'
      : 'accordo fra i modelli non disponibile';
    row.appendChild(trust);

    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', 'Apri ' + (i === ti ? 'oggi' : weekday(iso, false)));
    row.onclick = () => openDay(i);
    row.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDay(i); } };
    list.appendChild(row);
  });

  const trustLine = $('trust');
  trustLine.hidden = !spread;
  if (spread) trustLine.innerHTML = trustSentence(spread, data);

  /* aggiornamento */
  const ageMin = Math.round((Date.now() - cachedAt) / 60000);
  const stamp = $('stamp');
  stamp.textContent = ageMin < 2
    ? 'aggiornato ora'
    : 'aggiornato ' + (ageMin < 60 ? ageMin + ' min fa' : Math.round(ageMin / 60) + ' h fa');
  stamp.className = 'stamp' + (ageMin > 90 ? ' stale' : '');

  if (dvIndex != null) {
    const ti = todayIndex(data);
    if (dvIndex < ti) dvIndex = ti;                    /* è passata la mezzanotte */
    if (dvIndex >= data.daily.time.length) dvIndex = data.daily.time.length - 1;
    renderDay();
  }

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

/* ---------- 8b. Un giorno a schermo intero -----------------
   Il verdetto vale per tutta la settimana, non solo per oggi:
   qui si apre il singolo giorno e lo si sfoglia scorrendo. */

let dvIndex = null;

function openDay(i) {
  if (!current) return;
  dvIndex = i;
  const dv = $('dayview');
  /* prima si mostra, poi si disegna: a pannello nascosto le posizioni
     valgono zero e lo scorrimento iniziale della striscia non prende */
  dv.hidden = false;
  document.body.style.overflow = 'hidden';
  renderDay();
  dv.scrollTop = 0;
}

function closeDay() {
  $('dayview').hidden = true;
  document.body.style.overflow = '';
  dvIndex = null;
}

function stepDay(dir) {
  if (dvIndex == null || !current) return;
  const d = current.f.daily;
  const ti = todayIndex(current.f);
  const next = dvIndex + dir;
  if (next < ti || next >= d.time.length) return;
  dvIndex = next;
  renderDay();
  $('dayview').scrollTop = 0;
}

function renderDay() {
  const bundle = current, data = bundle.f, d = data.daily, i = dvIndex;
  const ti = todayIndex(data);

  const giorno = new Date(tsOf(d.time[i]));
  $('dv-title').textContent = i === ti ? 'Oggi'
    : giorno.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  $('dv-prev').disabled = i <= ti;
  $('dv-next').disabled = i >= d.time.length - 1;

  const body = $('dv-body');
  body.textContent = '';

  /* come vestirsi quel giorno */
  const adv = dressAdviceForDay(data, i, store.chill);
  if (adv) {
    body.appendChild(el('h1', 'dv-verdict', adv.main));
    if (adv.note) {
      const n = el('p', 'dv-note');
      n.innerHTML = adv.note;
      body.appendChild(n);
    }
  }

  /* minima e massima, sulla scala della settimana */
  const idx = [];
  for (let k = ti; k < d.time.length; k++) idx.push(k);
  const lo = Math.min(...idx.map(k => d.temperature_2m_min[k]));
  const hi = Math.max(...idx.map(k => d.temperature_2m_max[k]));
  const span = Math.max(hi - lo, 1);
  const range = el('div', 'dv-range');
  range.appendChild(el('span', 'dv-lo', Math.round(d.temperature_2m_min[i]) + '°'));
  const bar = el('div', 'dv-range-bar');
  const fill = el('span');
  fill.style.left  = ((d.temperature_2m_min[i] - lo) / span * 100) + '%';
  fill.style.width = ((d.temperature_2m_max[i] - d.temperature_2m_min[i]) / span * 100) + '%';
  bar.appendChild(fill);
  range.appendChild(bar);
  range.appendChild(el('span', 'dv-hi', Math.round(d.temperature_2m_max[i]) + '°'));
  body.appendChild(range);

  /* le ore di quel giorno */
  const from = tsOf(d.time[i]), to = from + 24 * 3600000 - 1000;
  const hrs = hoursIn(data, from, to);
  if (hrs.length) {
    const sec = el('section', 'dv-section');
    sec.appendChild(el('h3', null, 'Ora per ora'));
    const strip = el('div', 'hours');
    sec.appendChild(strip);
    body.appendChild(sec);
    renderHours(strip, hrs, data, { markNow: i === ti });
    /* aprire un giorno e vedere per prime le ore in cui si dorme non
       serve: si parte da adesso, o dall'alba per i giorni futuri. */
    const inizio = i === ti ? nowTs(data) : (d.sunrise[i] ? tsOf(d.sunrise[i]) - 3600000 : from);
    const target = [...strip.children].find(n => n.dataset.t && +n.dataset.t >= inizio);
    if (target) strip.scrollLeft = Math.max(0, target.offsetLeft - 8);
  }

  /* i numeri, con la parola che li spiega */
  const mm    = hrs.reduce((a, h) => a + (h.mm || 0), 0);
  const pop   = hrs.length ? Math.max(...hrs.map(h => h.pop || 0)) : 0;
  const wind  = hrs.length ? Math.max(...hrs.map(h => h.wind || 0)) : 0;
  const gust  = Math.max(d.wind_gusts_10m_max ? (d.wind_gusts_10m_max[i] || 0) : 0,
                         hrs.length ? Math.max(...hrs.map(h => h.gust || 0)) : 0);
  const uv    = d.uv_index_max ? (d.uv_index_max[i] || 0) : 0;
  const ore   = hrs.filter(h => (h.mm || 0) >= 0.1).length;

  const facts = [
    ['Pioggia', mm >= 0.1 ? mm.toFixed(1) + ' <small>mm</small>' : pop + '<small>%</small>',
      mm >= 0.1 ? (ore + (ore === 1 ? ' ora bagnata' : ' ore bagnate')) : (pop >= 40 ? 'possibile' : 'asciutto'),
      mm >= 5],
    ['Vento', Math.round(wind) + ' <small>km/h</small>', windWord(wind), wind >= 39],
    ['Raffiche', Math.round(gust) + ' <small>km/h</small>',
      gust >= GUST_WINDY ? 'ombrello a rischio' : gustWord(gust), gust >= GUST_WINDY],
    ['Raggi UV', String(Math.round(uv)), uvWord(uv), uv >= UV_STRONG],
    ['Alba', d.sunrise[i] ? hhmm(d.sunrise[i]) : '—', '', false],
    ['Tramonto', d.sunset[i] ? hhmm(d.sunset[i]) : '—',
      d.sunrise[i] && d.sunset[i]
        ? Math.round((tsOf(d.sunset[i]) - tsOf(d.sunrise[i])) / 3600000) + ' ore di luce' : '', false],
  ];
  const sec2 = el('section', 'dv-section');
  sec2.appendChild(el('h3', null, 'In dettaglio'));
  const grid = el('div', 'dv-facts');
  facts.forEach(([k, v, w, warn]) => {
    const cell = el('div', 'dv-fact' + (warn ? ' alert' : ''));
    cell.appendChild(el('span', 'dv-fact-k', k));
    const val = el('div', 'dv-fact-v');
    val.innerHTML = v;
    cell.appendChild(val);
    if (w) cell.appendChild(el('div', 'dv-fact-w', w));
    grid.appendChild(cell);
  });
  sec2.appendChild(grid);

  /* quanto vale la previsione di questo giorno */
  const sp = modelSpread(bundle);
  const e = sp && sp.get(d.time[i]);
  if (e) {
    const t = el('p', 'dv-trust');
    t.innerHTML = e.level === 3
      ? 'I tre modelli <b>concordano</b> su questo giorno.'
      : e.level === 2
        ? `I modelli differiscono di <b>${e.dt.toFixed(1)}°</b> sulla massima: previsione probabile ma non certa.`
        : `I modelli differiscono di <b>${e.dt.toFixed(1)}°</b>: su questo giorno c'è poco da fidarsi.`;
    sec2.appendChild(t);
  }
  body.appendChild(sec2);

  /* a che punto della settimana siamo */
  const dots = $('dv-dots');
  dots.textContent = '';
  idx.forEach(k => dots.appendChild(el('i', k === i ? 'on' : null)));
}

/* ---------- 8c. Gesti -------------------------------------- */

function onSwipe(node, handler, ignore) {
  let x0 = null, y0 = null;
  node.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || (ignore && e.target.closest(ignore))) { x0 = null; return; }
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  node.addEventListener('touchend', e => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    /* orizzontale deciso: non deve scattare mentre si scorre la pagina */
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.8) handler(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function stepPlace(dir) {
  const n = store.places.length;
  if (n < 2) return;
  store.active = (store.active + dir + n) % n;
  load();
}

/* trascina verso il basso per aggiornare */
function setupPull() {
  const ind = $('pull');
  let y0 = null, armed = false;

  const reset = () => {
    ind.style.opacity = '0';
    ind.style.transform = '';
    ind.classList.remove('armed', 'spinning');
    y0 = null; armed = false;
  };

  document.addEventListener('touchstart', e => {
    const libero = window.scrollY <= 0 && $('dayview').hidden && $('sheet').hidden;
    y0 = (libero && e.touches.length === 1) ? e.touches[0].clientY : null;
    armed = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy <= 0) { ind.style.opacity = '0'; return; }
    const p = Math.min(dy / 90, 1);
    ind.style.opacity = String(p);
    ind.style.transform = 'translateY(' + Math.min(dy * .4, 44) + 'px)';
    armed = p >= 1;
    ind.classList.toggle('armed', armed);
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (y0 == null) return;
    if (armed) {
      ind.classList.add('spinning');
      Promise.resolve(load(true)).then(reset, reset);
    } else {
      reset();
    }
    y0 = null;
  }, { passive: true });
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
  /* una copia salvata da una versione precedente dell'app non ha
     la forma che il rendering si aspetta: si scarta e si riscarica */
  let cached = store.cacheGet(place.id);
  if (cached && (!cached.data || cached.data.v !== 3)) { store.cacheDel(place.id); cached = null; }
  /* Se aria o modelli non erano arrivati (capita quando il servizio
     è freddo su una località mai chiesta), non si aspettano dieci
     minuti per riprovare: si ritenta al giro dopo. */
  const completo = !!(cached && cached.data && cached.data.air && cached.data.spread);
  const fresh = cached && Date.now() - cached.at < (completo ? 10 : 2) * 60000;
  if (cached) {
    try { renderAll(cached.data, cached.at); } catch (e) { showState('state-loading'); }
  } else {
    showState('state-loading');
  }
  if (fresh && !force) return;

  if (inflight) inflight.abort();
  inflight = new AbortController();
  const signal = inflight.signal;
  const seq = ++loadSeq;
  /* se nel frattempo si è cambiata località, i dati vecchi non scrivono */
  const ancoraMia = () => seq === loadSeq &&
    store.places[store.active] && store.places[store.active].id === place.id;

  try {
    /* Aria e modelli partono subito ma nessuno li aspetta: la previsione
       si disegna appena arriva, il resto si aggiunge quando è pronto.
       Su una località mai chiesta prima Open-Meteo può metterci qualche
       secondo, e non è un buon motivo per lasciare la schermata vuota. */
    const pAir    = fetchAir(place, signal).catch(() => null);
    const pSpread = fetchSpread(place, signal).catch(() => null);

    const bundle = { v: 3, f: await fetchForecast(place, signal), air: null, spread: null };
    if (!ancoraMia()) return;
    store.cacheSet(place.id, bundle);
    renderAll(bundle, Date.now());

    const [air, spread] = await Promise.all([pAir, pSpread]);
    if (!ancoraMia()) return;
    bundle.air = air;
    bundle.spread = spread;
    store.cacheSet(place.id, bundle);
    renderAll(bundle, Date.now());
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (!cached) showState('state-error', navigator.onLine
      ? e.message
      : 'Sei offline e per questa località non ho ancora salvato nulla.');
  } finally {
    if (seq === loadSeq) inflight = null;
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

/* --- allerte push --- */

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);
const isInstalled = () =>
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

async function enableAlerts() {
  const btn = $('btn-alerts');
  const say = (t, reset) => {
    btn.textContent = t;
    if (reset) setTimeout(() => { btn.textContent = 'Attiva le allerte'; }, 5000);
  };

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return say('Questo browser non le supporta', true);
  }
  /* su iPhone il permesso si può chiedere solo dall'app installata */
  if (isIOS() && !isInstalled()) {
    return say('Prima aggiungi l’app alla schermata Home', true);
  }
  if (!store.places.length) return say('Aggiungi prima una località', true);

  try {
    say('Chiedo il permesso…');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return say('Permesso negato', true);

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToBytes(VAPID_PUBLIC),
    });

    $('alert-code').value = JSON.stringify({
      sub: sub.toJSON(),
      places: store.places.map(p => ({ name: p.name, lat: p.lat, lon: p.lon })),
    });
    $('alert-setup').hidden = false;
    say('Permesso concesso — manca solo il codice qui sotto');
  } catch (e) {
    say('Non è riuscito: ' + (e.message || e.name), true);
  }
}

async function copyAlertCode() {
  const btn = $('btn-copy');
  const val = $('alert-code').value;
  try {
    await navigator.clipboard.writeText(val);
    btn.textContent = 'Copiato';
  } catch (e) {
    $('alert-code').select();
    btn.textContent = 'Selezionato: copialo a mano';
  }
  setTimeout(() => { btn.textContent = 'Copia il codice'; }, 3000);
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
$('btn-alerts').onclick = enableAlerts;
$('dv-close').onclick = closeDay;
$('dv-prev').onclick  = () => stepDay(-1);
$('dv-next').onclick  = () => stepDay(1);

/* scorrendo di lato: dentro un giorno si cambia giorno, in apertura
   si cambia località. La striscia delle ore scorre per conto suo. */
onSwipe($('dayview'), stepDay, '.hours');
onSwipe($('main'), stepPlace, '.hours');
setupPull();

document.addEventListener('keydown', e => {
  if ($('dayview').hidden) return;
  if (e.key === 'Escape') closeDay();
  if (e.key === 'ArrowLeft') stepDay(-1);
  if (e.key === 'ArrowRight') stepDay(1);
});
$('btn-copy').onclick = copyAlertCode;
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
