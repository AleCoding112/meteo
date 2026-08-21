/* Controlla le località e manda una notifica solo quando c'è
   qualcosa che merita: temporali, gelo, caldo forte, raffiche,
   sbalzi bruschi, aria pessima.

   Le soglie non sono riscritte qui: si riusa la stessa logica
   che gira dentro l'app, così restano in un posto solo.

   Ambiente:  ALERT_CONFIG  (JSON: subscription + località)
              VAPID_PRIVATE (segreto)
              VAPID_SUBJECT (facoltativo)
   Uso:       node tools/send-alerts.js [--dry]                   */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const STATE = path.join(ROOT, '.state', 'sent.json');

/* soglia di importanza: 1 temporale, 2 gelo, 3 caldo/raffiche,
   4 sbalzi e aria. Il 5 (prima pioggia) non è un'allerta. */
const MAX_RANK = 4;
const KEEP = 300;

/* --- la logica dell'app, riusata così com'è --- */
const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const L = new Function(src.split('/* ---------- 8. Rendering')[0] + `
  return { changeAlerts, todayIndex, POLLEN, MODELS, nowTs };
`)();
const VAPID_PUBLIC = (src.match(/const VAPID_PUBLIC = '([^']+)'/) || [])[1];

async function bundleFor(place) {
  const common = { latitude: place.lat, longitude: place.lon, timezone: 'auto' };
  const q = o => new URLSearchParams({ ...common, ...o });

  const forecast = q({
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,is_day',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,uv_index,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_gusts_10m_max',
    forecast_days: '7', past_days: '5',
  });
  const air = q({
    current: 'european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,' + L.POLLEN.map(p => p[0]).join(','),
    forecast_days: '1',
  });

  const grab = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url.split('?')[0] + ' → ' + r.status);
    return r.json();
  };
  const [f, a] = await Promise.all([
    grab('https://api.open-meteo.com/v1/forecast?' + forecast),
    grab('https://air-quality-api.open-meteo.com/v1/air-quality?' + air).catch(() => null),
  ]);
  return { v: 3, f, air: a, spread: null };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { sent: [] }; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  state.sent = state.sent.slice(-KEEP);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n');
}

async function main() {
  const raw = process.env.ALERT_CONFIG;
  if (!raw) {
    console.log('ALERT_CONFIG non impostato: niente da fare (l\'app non è ancora stata collegata).');
    return;
  }
  const cfg = JSON.parse(raw);
  const places = cfg.places || [];
  if (!places.length) { console.log('nessuna località nella configurazione.'); return; }

  const state = loadState();
  const seen = new Set(state.sent.map(x => x.key));
  const today = new Date().toISOString().slice(0, 10);
  const toSend = [];

  for (const place of places) {
    let bundle;
    try { bundle = await bundleFor(place); }
    catch (e) { console.log(`${place.name}: dati non disponibili (${e.message})`); continue; }

    const alerts = L.changeAlerts(bundle).filter(a => a.rank <= MAX_RANK);
    console.log(`${place.name}: ${alerts.length ? alerts.map(a => a.text).join(' | ') : 'niente da segnalare'}`);

    for (const a of alerts) {
      const key = `${today}|${place.name}|${a.text}`;
      if (seen.has(key)) continue;         // già detto oggi
      seen.add(key);
      toSend.push({ key, title: place.name, body: a.text });
    }
  }

  if (!toSend.length) { console.log('\nnessuna allerta nuova.'); return; }
  console.log(`\n${toSend.length} allerte nuove:`);
  toSend.forEach(m => console.log(`  → ${m.title}: ${m.body}`));

  if (DRY) { console.log('\n(prova a vuoto: non invio nulla)'); return; }

  const priv = process.env.VAPID_PRIVATE;
  if (!priv) { console.log('\nVAPID_PRIVATE mancante: non posso firmare l\'invio.'); process.exit(1); }

  const webpush = require('web-push');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://github.com', VAPID_PUBLIC, priv);

  for (const m of toSend) {
    try {
      await webpush.sendNotification(cfg.sub, JSON.stringify({
        title: m.title, body: m.body, tag: 'meteo-' + m.key.slice(0, 16),
      }));
      state.sent.push({ key: m.key, at: Date.now() });
      console.log(`inviata: ${m.title} — ${m.body}`);
    } catch (e) {
      const code = e.statusCode || 0;
      if (code === 404 || code === 410) {
        console.log('la registrazione del telefono è scaduta: riattiva le allerte dall\'app.');
        break;
      }
      console.log(`invio fallito (${code}): ${e.message}`);
    }
  }
  saveState(state);
}

main().catch(e => { console.error(e); process.exit(1); });
