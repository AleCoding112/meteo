/* Banco di prova della logica pura (sezioni 1-7 di app.js),
   su dati veri e su casi costruiti a mano.
   Uso:  node tools/test-logic.js                            */

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const pure = src.split('/* ---------- 8. Rendering')[0];
const L = new Function(pure + `
  return { wmo, dressAdvice, rainNow, daylightWindow, hoursIn, tsOf, nowTs, LAYERS, isSnowCode,
           todayIndex, changeAlerts, modelSpread, trustSentence, pollenLevel, AQI_WORD,
           skyScene, POLLEN, POLLEN_WORDS, MODELS, dayKey, weekday };
`)();

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };

const get = async (lat, lon) => {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,is_day',
    minutely_15: 'precipitation,weather_code',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,uv_index,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_gusts_10m_max',
    timezone: 'auto', forecast_days: '7', past_days: '5', forecast_minutely_15: '20',
  });
  const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q);
  return r.json();
};

(async () => {
  const spots = [
    ['Milano',      45.464,  9.190],
    ['Bormio',      46.468, 10.372],
    ['Palermo',     38.116, 13.361],
    ['Tokyo',       35.690, 139.692],   // fuso opposto: "ora" deve restare coerente
    ['Ushuaia',    -54.802, -68.303],   // emisfero sud, inverno
    ['Reykjavik',   64.146, -21.942],   // giorni lunghissimi
  ];

  for (const [name, lat, lon] of spots) {
    const d = await get(lat, lon);
    const now = L.nowTs(d);
    const win = L.daylightWindow(d);
    const a = L.dressAdvice(d, 0);
    const r = L.rainNow(d);
    const localClock = new Date(now).toISOString().slice(11, 16);

    console.log(`\n${name}  (ora locale ${localClock}, ${d.timezone})`);
    console.log(`  finestra : ${win.label}  ${new Date(win.from).toISOString().slice(11,16)}→${new Date(win.to).toISOString().slice(11,16)}`);
    console.log(`  verdetto : "${a.main}"  ${a.note ? '| ' + a.note.replace(/<[^>]+>/g, '') : ''}`);
    console.log(`  percepito: ${a.feelsMin.toFixed(1)}° … ${a.feelsMax.toFixed(1)}°`);
    console.log(`  pioggia  : ${r ? r.text : '— (minutely non disponibile)'}`);

    ok(!!a && !!a.main, 'produce un verdetto');
    ok(win.to > win.from, 'finestra non degenere');
    ok(win.from >= now - 3600000, 'finestra non inizia nel passato');
    ok(a.feelsMin <= a.feelsMax, 'min percepito ≤ max');
    ok(r === null || r.pts.length >= 4, 'nowcast con abbastanza punti');
    ok(r === null || r.pts[0].t >= now - 16 * 60000, 'nowcast parte da adesso, non da stanotte');
  }

  /* --- casi costruiti: verifico le soglie una per una --- */
  console.log('\nScala d\'abbigliamento (percepito minimo → capo):');
  const mk = feels => {
    const iso = t => new Date(t).toISOString().slice(0, 16);
    const start = Math.floor((Date.now() - 12 * 3600000) / 3600000) * 3600000;
    const hours = Array.from({ length: 48 }, (_, i) => start + i * 3600000);
    return {
      utc_offset_seconds: 0,
      daily: {
        time: [iso(Date.now()).slice(0,10)],
        sunrise: [iso(Date.now() - 3600000)],
        sunset:  [iso(Date.now() + 9 * 3600000)],
        temperature_2m_min: [feels], temperature_2m_max: [feels + 5],
      },
      hourly: {
        time: hours.map(iso),
        temperature_2m: hours.map(() => feels),
        apparent_temperature: hours.map(() => feels),
        precipitation_probability: hours.map(() => 0),
        precipitation: hours.map(() => 0),
        weather_code: hours.map(() => 0),
        wind_speed_10m: hours.map(() => 5),
        wind_gusts_10m: hours.map(() => 8),
        uv_index: hours.map(() => 2),
        is_day: hours.map(() => 1),
      },
    };
  };
  for (const t of [32, 26, 22, 18, 14, 10, 6, 2, -6]) {
    console.log(`  ${String(t).padStart(3)}°  →  ${L.dressAdvice(mk(t), 0).main}`);
  }
  const soglie = [32, 26, 22, 18, 14, 10, 6, 2, -6].map(t => L.dressAdvice(mk(t), 0).main);
  ok(new Set(soglie).size === soglie.length, 'ogni fascia dà un consiglio diverso');

  console.log('\nEffetto del cursore a 14° percepiti:');
  for (const c of [-4, -2, 0, 2, 4]) {
    console.log(`  ${c > 0 ? '+' : ''}${c}  →  ${L.dressAdvice(mk(14), c).main}`);
  }
  ok(L.dressAdvice(mk(14), 4).main !== L.dressAdvice(mk(14), -4).main, 'il cursore cambia il verdetto');
  ok(L.dressAdvice(mk(14), -4).main !== L.dressAdvice(mk(14), 0).main, '"freddoloso" aggiunge uno strato');

  /* --- pioggia in arrivo, in corso, assente --- */
  console.log('\nNowcast:');
  const rainCase = (mms, label) => {
    const t0 = Math.floor(Date.now() / 900000) * 900000;
    const d = {
      utc_offset_seconds: 0,
      minutely_15: {
        time: mms.map((_, i) => new Date(t0 + i * 900000).toISOString().slice(0, 16)),
        precipitation: mms,
        weather_code: mms.map(m => (m > 0 ? 61 : 0)),
      },
    };
    const r = L.rainNow(d);
    console.log(`  ${label.padEnd(22)} → ${r.text}`);
    return r;
  };
  const a1 = rainCase([0,0,0,0.4,0.8,0.6,0.2,0,0,0,0,0], 'inizia tra ~45 min');
  const a2 = rainCase([0.9,1.4,0.6,0.1,0,0,0,0,0,0,0,0], 'in corso, poi spiove');
  const a3 = rainCase(new Array(12).fill(0),              'asciutto');
  const a4 = rainCase(new Array(12).fill(1.8),            'non smette');
  ok(!a1.dry && /minuti/.test(a1.text), 'annuncia l\'inizio con anticipo');
  ok(!a2.dry && /smettere/.test(a2.text), 'dice quando smette');
  ok(a3.dry, 'riconosce l\'asciutto');
  ok(/Non smette/.test(a4.text), 'non promette schiarite che non ci sono');

  /* --- dopo il tramonto la finestra passa a domani --- */
  const night = mk(10);
  night.daily.sunset = [new Date(Date.now() - 7200000).toISOString().slice(0, 16)];
  night.daily.sunrise = [new Date(Date.now() - 50000000).toISOString().slice(0, 16)];
  night.daily.time.push('x');
  night.daily.sunrise.push(new Date(Date.now() + 36000000).toISOString().slice(0, 16));
  night.daily.sunset.push(new Date(Date.now() + 72000000).toISOString().slice(0, 16));
  night.daily.temperature_2m_min.push(4); night.daily.temperature_2m_max.push(12);
  const nightAdv = L.dressAdvice(night, 0);
  console.log('\nDi sera → "' + (nightAdv ? nightAdv.window.label : 'nessuna finestra') + '"');
  ok(nightAdv && nightAdv.window.tomorrow, 'dopo il tramonto guarda a domani');

  /* ================= novità: avvisi, modelli, aria ================= */

  const bundleOf = async (lat, lon) => {
    const f = await get(lat, lon);
    const airQ = new URLSearchParams({
      latitude: lat, longitude: lon,
      current: 'european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,' + L.POLLEN.map(p => p[0]).join(','),
      timezone: 'auto', forecast_days: '1',
    });
    const spQ = new URLSearchParams({
      latitude: lat, longitude: lon,
      daily: 'temperature_2m_max,precipitation_sum,precipitation_probability_max',
      models: L.MODELS.join(','), timezone: 'auto', forecast_days: '7',
    });
    const [air, spread] = await Promise.all([
      fetch('https://air-quality-api.open-meteo.com/v1/air-quality?' + airQ).then(r => r.json()),
      fetch('https://api.open-meteo.com/v1/forecast?' + spQ).then(r => r.json()),
    ]);
    return { v: 3, f, air, spread };
  };

  console.log('\n══ Avvisi, accordo fra modelli e aria (dati veri) ══');
  for (const [name, lat, lon] of [['Milano', 45.464, 9.190], ['Bormio', 46.468, 10.372]]) {
    const b = await bundleOf(lat, lon);
    const ti = L.todayIndex(b.f);
    const today = new Date(L.nowTs(b.f)).toISOString().slice(0, 10);
    const alerts = L.changeAlerts(b);
    const spread = L.modelSpread(b);

    console.log(`\n${name}`);
    console.log(`  oggi è l'indice ${ti} di ${b.f.daily.time.length} (${b.f.daily.time[ti]})`);
    console.log(`  avvisi   : ${alerts.length ? alerts.map(a => '[' + a.kind + '] ' + a.text).join(' / ') : 'nessuno'}`);
    console.log(`  modelli  : ${spread ? [...spread.entries()].slice(0, 7).map(([d, e]) => e.level).join(' ') : 'non disponibili'}`);
    if (spread) console.log(`  giudizio : ${L.trustSentence(spread, b.f).replace(/<[^>]+>/g, '')}`);
    const air = b.air && b.air.current;
    if (air) {
      const poll = L.POLLEN.map(([k, n, st]) => [n, air[k], L.pollenLevel(air[k], st)])
        .filter(x => x[2] >= 1).map(x => `${x[0]} ${x[1]} (${L.POLLEN_WORDS[x[2]]})`);
      console.log(`  aria     : ${L.AQI_WORD(air.european_aqi)} (${air.european_aqi}) · PM2.5 ${air.pm2_5}`);
      console.log(`  pollini  : ${poll.length ? poll.join(', ') : 'nessuno rilevante'}`);
    }

    ok(b.f.daily.time[ti] === today, 'individua oggi dentro l\'archivio');
    const w = L.daylightWindow(b.f);
    const localHour = +new Date(L.nowTs(b.f)).toISOString().slice(11, 13);
    const beforeSunset = localHour < 19;
    ok(!beforeSunset || !w.tomorrow,
       'di giorno consiglia per oggi, non per domani (finestra: ' + w.label + ')');
    ok(ti > 0, 'i giorni passati ci sono davvero (servono agli avvisi)');
    ok(Array.isArray(alerts) && alerts.length <= 2, 'al massimo due avvisi');
    ok(!spread || [...spread.values()].every(e => e.level >= 1 && e.level <= 3), 'livelli di accordo nel range');
    ok(!spread || L.trustSentence(spread, b.f).length > 20, 'il giudizio è una frase sensata');
  }

  /* --- avvisi su casi costruiti --- */
  console.log('\n══ Avvisi su casi costruiti ══');
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const mkBundle = (over = {}, air = null) => {
    const n = 8, past = 5;
    const base = {
      time:  Array.from({ length: n }, (_, i) => day(i - past)),
      sunrise: Array.from({ length: n }, (_, i) => day(i - past) + 'T06:30'),
      sunset:  Array.from({ length: n }, (_, i) => day(i - past) + 'T20:30'),
      temperature_2m_max: Array(n).fill(20),
      temperature_2m_min: Array(n).fill(12),
      precipitation_sum: Array(n).fill(0),
      precipitation_probability_max: Array(n).fill(10),
      weather_code: Array(n).fill(1),
      wind_gusts_10m_max: Array(n).fill(15),
      uv_index_max: Array(n).fill(4),
    };
    Object.assign(base, over);
    const hours = Array.from({ length: 48 }, (_, i) =>
      new Date(Math.floor(Date.now() / 3600000) * 3600000 + i * 3600000).toISOString().slice(0, 16));
    return { v: 3, air, spread: null, f: {
      utc_offset_seconds: 0, daily: base,
      hourly: {
        time: hours,
        temperature_2m: hours.map(() => 20), apparent_temperature: hours.map(() => 20),
        precipitation_probability: hours.map(() => 10), precipitation: hours.map(() => 0),
        weather_code: hours.map(() => 1), wind_speed_10m: hours.map(() => 5),
        wind_gusts_10m: hours.map(() => 12), uv_index: hours.map(() => 4),
        is_day: hours.map(() => 1),
      },
    } };
  };
  const T = (label, over, air) => {
    const a = L.changeAlerts(mkBundle(over, air));
    console.log(`  ${label.padEnd(26)} → ${a.length ? a.map(x => x.text).join(' | ') : '(nessuno)'}`);
    return a;
  };
  const tMax = v => { const a = Array(8).fill(20); a[5] = v; return a; };   // indice 5 = oggi

  const a_jump = T('domani 9° in meno', { temperature_2m_max: [20,20,20,20,20,26,17,20] });
  const a_frost = T('gelo stanotte', { temperature_2m_min: [8,8,8,8,8,-2,4,6] });
  const a_heat = T('caldo forte oggi', { temperature_2m_max: tMax(36) });
  const a_gale = T('raffiche 75 km/h', { wind_gusts_10m_max: [15,15,15,15,15,75,20,15] });
  const a_dry = T('pioggia dopo 5 asciutti', { precipitation_sum: [0,0,0,0,0,6,0,0] });
  const a_air = T('aria scarsa', {}, { current: { european_aqi: 72, pm2_5: 40 } });
  const a_poll = T('ambrosia alta', {}, { current: { european_aqi: 15, ragweed_pollen: 30 } });
  const a_none = T('giornata normale', {});

  ok(/9° in meno/.test(a_jump[0].text), 'riconosce lo sbalzo termico');
  ok(/Gelo stanotte/.test(a_frost[0].text), 'riconosce il gelo');
  ok(/Caldo forte oggi/.test(a_heat[0].text), 'riconosce il caldo');
  ok(/75 km\/h/.test(a_gale[0].text), 'riconosce le raffiche');
  ok(a_dry.some(x => /5 giorni asciutti/.test(x.text)), 'riconosce la prima pioggia');
  ok(a_air.some(x => /Aria scarsa/i.test(x.text)), 'segnala l\'aria scarsa');
  ok(a_poll.some(x => /Ambrosia/.test(x.text)), 'segnala i pollini alti');
  ok(a_none.length === 0, 'in una giornata normale non disturba');

  /* --- soglie aria e pollini --- */
  console.log('\n══ Scale ══');
  console.log('  aria   :', [10, 30, 50, 70, 90, 130].map(v => v + '=' + L.AQI_WORD(v)).join('  '));
  const gr = L.POLLEN.find(p => p[0] === 'grass_pollen')[2];
  console.log('  gramin.:', [0, 8, 20, 60, 300].map(v => v + '=' + L.POLLEN_WORDS[L.pollenLevel(v, gr)]).join('  '));
  ok(L.AQI_WORD(10) === 'Buona' && L.AQI_WORD(130) === 'Pessima', 'scala dell\'aria agli estremi');
  ok(L.pollenLevel(0, gr) === 0 && L.pollenLevel(300, gr) === 4, 'scala dei pollini agli estremi');

  /* --- i cieli --- */
  console.log('\n══ Cieli ══');
  const skyOf = (code, isDay) => L.skyScene({
    utc_offset_seconds: 0,
    current: { weather_code: code, is_day: isDay },
    daily: { time: [day(0)], sunrise: [day(0) + 'T04:00'], sunset: [day(0) + 'T23:50'] },
  });
  const cieli = [[0,1],[0,0],[2,1],[3,1],[3,0],[45,1],[61,1],[61,0],[71,1],[95,1]];
  console.log('  ' + cieli.map(([c, d]) => `${c}${d ? '' : 'n'}=${skyOf(c, d)}`).join('  '));
  ok(new Set(cieli.map(([c, d]) => skyOf(c, d))).size >= 8, 'i cieli sono distinti fra loro');

  console.log(fails ? `\n${fails} verifiche fallite` : '\nTutte le verifiche superate');
  process.exit(fails ? 1 : 0);
})();
