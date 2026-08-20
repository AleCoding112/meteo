/* Banco di prova della logica pura (sezioni 1-7 di app.js),
   su dati veri e su casi costruiti a mano.
   Uso:  node tools/test-logic.js                            */

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const pure = src.split('/* ---------- 8. Rendering')[0];
const L = new Function(pure + `
  return { wmo, dressAdvice, rainNow, daylightWindow, hoursIn, tsOf, nowTs, LAYERS, isSnowCode };
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
    timezone: 'auto', forecast_days: '7', forecast_minutely_15: '20',
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

  console.log(fails ? `\n${fails} verifiche fallite` : '\nTutte le verifiche superate');
  process.exit(fails ? 1 : 0);
})();
