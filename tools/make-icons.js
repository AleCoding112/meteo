/* Genera le icone PNG dell'app senza dipendenze esterne.
   Disegno a 4x e riduzione a valle per avere bordi puliti.
   Uso:  node tools/make-icons.js                              */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* --- geometria del simbolo, in coordinate 0..1 -------------
   Tutto resta entro il cerchio di sicurezza delle icone
   "maskable", così Android non ne taglia i bordi.           */
const SUN   = { x: .62, y: .36, r: .150 };
const PUFFS = [
  { x: .44, y: .565, r: .170 },
  { x: .30, y: .630, r: .118 },
  { x: .585, y: .630, r: .128 },
];
const BASE = { x0: .30, x1: .585, y0: .565, y1: .748 };

const C_SUN   = [255, 194,  51];
const C_CLOUD = [233, 240, 250];
const C_BG_A  = [ 30,  46,  82];
const C_BG_B  = [ 11,  16,  30];

const inCircle = (x, y, c) => (x - c.x) ** 2 + (y - c.y) ** 2 <= c.r * c.r;
const inCloud = (x, y) =>
  PUFFS.some(p => inCircle(x, y, p)) ||
  (x >= BASE.x0 && x <= BASE.x1 && y >= BASE.y0 && y <= BASE.y1);

function shade(x, y) {
  const t = Math.min(1, Math.max(0, (x + y) / 2));
  const bg = C_BG_A.map((a, i) => Math.round(a + (C_BG_B[i] - a) * t));
  if (inCloud(x, y)) return C_CLOUD;
  if (inCircle(x, y, SUN)) return C_SUN;
  return bg;
}

function render(size) {
  const SS = 4, S = size * SS;
  const out = Buffer.alloc(size * size * 4);
  const acc = new Float64Array(size * size * 3);
  for (let py = 0; py < S; py++) {
    const y = (py + .5) / S;
    for (let px = 0; px < S; px++) {
      const c = shade((px + .5) / S, y);
      const o = ((py / SS | 0) * size + (px / SS | 0)) * 3;
      acc[o] += c[0]; acc[o + 1] += c[1]; acc[o + 2] += c[2];
    }
  }
  const n = SS * SS;
  for (let i = 0, j = 0; i < size * size; i++, j += 4) {
    out[j]     = Math.round(acc[i * 3]     / n);
    out[j + 1] = Math.round(acc[i * 3 + 1] / n);
    out[j + 2] = Math.round(acc[i * 3 + 2] / n);
    out[j + 3] = 255;
  }
  return out;
}

/* --- incapsulamento PNG ------------------------------------ */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const [name, size] of [['icon-192', 192], ['icon-512', 512], ['apple-touch-icon', 180]]) {
  const file = path.join(dir, name + '.png');
  fs.writeFileSync(file, png(render(size), size));
  console.log(name + '.png  ' + size + 'x' + size + '  ' + (fs.statSync(file).size / 1024).toFixed(1) + ' kB');
}
