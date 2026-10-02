// Generates the PWA icons in public/ (run: node tools/make-icons.js). Uses only node:zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [10, 102, 216];
const FG = [255, 255, 255];
// Waveform bars: [center x, half height] in units of the icon size, kept inside the 80% maskable safe zone.
const BARS = [[0.30, 0.10], [0.40, 0.20], [0.50, 0.28], [0.60, 0.17], [0.70, 0.08]];
const BAR_HALF_W = 0.035;

function inBar(x, y) {
  for (const [cx, hh] of BARS) {
    const dx = Math.abs(x - cx);
    if (dx > BAR_HALF_W) continue;
    const top = 0.5 - hh + BAR_HALF_W;
    const bot = 0.5 + hh - BAR_HALF_W;
    if (y >= top && y <= bot) return true;
    const cy = y < top ? top : bot;
    if (dx * dx + (y - cy) * (y - cy) <= BAR_HALF_W * BAR_HALF_W) return true;
  }
  return false;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const S = 4;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) if (inBar((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size)) hit++;
      const a = hit / (S * S);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../public/', import.meta.url);
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(new URL(name, out), png(size));
}
