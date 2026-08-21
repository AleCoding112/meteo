/* Apre l'app in un iPhone virtuale, misura quello che serve e
   ne salva la fotografia. Serve per vedere davvero come viene,
   invece di indovinare.

   Uso:  node tools/probe.js [scena] [--full]
         node tools/probe.js storm --full                        */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9412;
const OUT = process.env.SCRATCH || '/tmp';
const URL_BASE = 'http://127.0.0.1:8765/';

const DEVICE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const page = args.find(a => !a.startsWith('--')) || '__seed.html';

  const profile = path.join(OUT, 'chrome-probe');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  /* attende che la porta risponda, poi si crea una scheda propria:
     non si dà per scontato che ce ne sia già una aperta */
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(250);
    try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); up = true; }
    catch (e) { /* non è ancora in ascolto */ }
  }
  if (!up) { console.error('Chrome non risponde sulla porta ' + PORT); chrome.kill(); process.exit(1); }

  let target;
  try {
    target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  } catch (e) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find(t => t.type === 'page');
  }
  if (!target || !target.webSocketDebuggerUrl) { console.error('nessuna scheda disponibile'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', DEVICE);
  await send('Page.navigate', { url: URL_BASE + page });
  await sleep(6500);

  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.value;
  };

  /* --- misure che contano su un telefono --- */
  const report = await evalJs(`(() => {
    const de = document.documentElement;
    const over = [...document.querySelectorAll('body *')]
      .filter(n => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) &&
               getComputedStyle(n).position !== 'fixed';
      })
      .slice(0, 8)
      .map(n => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
                (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : '') +
                ' → ' + Math.round(n.getBoundingClientRect().right) + 'px');
    const el = s => document.querySelector(s);
    const box = s => { const n = el(s); if (!n) return null; const r = n.getBoundingClientRect();
                       return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    return {
      viewport: innerWidth + '×' + innerHeight,
      scrollWidth: de.scrollWidth,
      overflowX: de.scrollWidth > innerWidth,
      pageHeight: de.scrollHeight,
      scene: de.dataset.scene,
      font: getComputedStyle(document.body).fontFamily.split(',')[0],
      fontLoaded: document.fonts ? document.fonts.check('700 40px Manrope') : null,
      sporgono: over,
      main: box('main'), stage: box('.stage'), verdict: box('.verdict'),
      rain: box('.rain'), alerts: box('.alerts'), glyph: box('.glyph'),
      primaSchermata: (() => {
        const r = el('.rain'); if (!r) return null;
        return r.getBoundingClientRect().bottom <= innerHeight ? 'sì, la pioggia entra' :
               'no, la pioggia finisce a ' + Math.round(r.getBoundingClientRect().bottom) + 'px';
      })(),
      testo: {
        verdetto: el('#verdict') && el('#verdict').textContent,
        finestra: el('#hero-window') && el('#hero-window').textContent,
        pioggia: el('#rain-verdict') && el('#rain-verdict').textContent,
        avvisi: [...document.querySelectorAll('.alert')].map(n => n.textContent.trim()),
      },
    };
  })()`);

  console.log(JSON.stringify(report, null, 1));

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: full,
    clip: full ? { x: 0, y: 0, width: DEVICE.width, height: Math.min(report.pageHeight, 4000), scale: 1 } : undefined,
  });
  const file = path.join(OUT, full ? 'full.png' : 'shot.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('\nfotografia: ' + file);

  ws.close();
  chrome.kill();
}
main().catch(e => { console.error(e); process.exit(1); });
