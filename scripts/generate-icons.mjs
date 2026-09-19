// Generates the PWA icons (PNG) without external dependencies.
// Design: caramel rounded tile with a cream crêpe folded into a quarter.
// Run: npm run icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG_TOP = hex('#C9652F');
const BG_BOTTOM = hex('#9C4321');
const CREPE = hex('#FFF1DC');
const FOLD = hex('#F3C98C');
const EDGE = hex('#E0A45C');
const WHITE = [255, 255, 255];

/** Returns [r,g,b,a] (a in 0..1) for a point in unit coordinates, or null. */
function shade(u, v, { tile, inset, mono }) {
  // Background tile
  const layers = [];
  if (tile) {
    const r = tile === 'full' ? 0 : 0.22;
    const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
    const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
    if (tile === 'full' || dx * dx + dy * dy <= r * r) {
      const t = v;
      layers.push([...BG_TOP.map((c, i) => c + (BG_BOTTOM[i] - c) * t), 1]);
    }
  }
  // Crêpe: a circle with a folded quarter (bottom-right) and a darker rim
  const cx = 0.5;
  const cy = 0.5;
  const R = 0.3 * inset;
  const x = u - cx;
  const y = v - cy;
  const d = Math.hypot(x, y);
  if (d <= R) {
    const folded = x > 0 && y > 0 && x + y > R * 0.95 * 0.0 && x > -y + R * 0.35;
    if (mono) layers.push([...WHITE, 1]);
    else if (d > R * 0.9) layers.push([...EDGE, 1]);
    else if (folded) layers.push([...FOLD, 1]);
    else layers.push([...CREPE, 1]);
  }
  return layers.length ? layers[layers.length - 1] : null;
}

function render(size, opts) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += c[3];
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (a > 0) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
      }
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, buf);
}

const files = {
  'icon-192.png': render(192, { tile: 'rounded', inset: 1 }),
  'icon-512.png': render(512, { tile: 'rounded', inset: 1 }),
  // Maskable: full-bleed background, content inside the 80% safe zone
  'maskable-512.png': render(512, { tile: 'full', inset: 0.8 }),
  'apple-touch-icon.png': render(180, { tile: 'full', inset: 0.9 }),
  'badge-72.png': render(72, { tile: null, inset: 1.4, mono: true }),
  'favicon-32.png': render(32, { tile: 'rounded', inset: 1 }),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(path.join(out, name), data);
  console.log('wrote', name, data.length, 'bytes');
}
