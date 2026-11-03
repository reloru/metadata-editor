// TIFF / EXIF reader (TIFF 6.0, EXIF 2.32) and in-place GPS removal.

import { decodeUtf8OrLatin1, decodeUtf16 } from './text.js';

const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function reader(b) {
  if (b.length < 8) throw new Error('TIFF too short');
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) throw new Error('Not a TIFF header');
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  return { le, u16, u32 };
}

function readIfd(b, r, off) {
  if (!off || off + 2 > b.length) return null;
  const n = r.u16(off);
  if (off + 2 + n * 12 + 4 > b.length) throw new Error('IFD exceeds data');
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const tag = r.u16(e);
    const type = r.u16(e + 2);
    const count = r.u32(e + 4);
    const size = (SIZES[type] || 1) * count;
    const at = size <= 4 ? e + 8 : r.u32(e + 8);
    entries.set(tag, { tag, type, count, size, at, entry: e, value: decodeValue(b, r, type, count, at, size) });
  }
  return { off, n, entries, next: r.u32(off + 2 + n * 12) };
}

function decodeValue(b, r, type, count, at, size) {
  if (at + size > b.length) return undefined;
  if (type === 2) return decodeUtf8OrLatin1(b.subarray(at, at + size)).replace(/\0+$/, '').trim();
  if (type === 7) return b.subarray(at, at + size);
  const out = [];
  for (let i = 0; i < Math.min(count, 64); i++) {
    const o = at + i * (SIZES[type] || 1);
    if (type === 3) out.push(r.u16(o));
    else if (type === 4) out.push(r.u32(o));
    else if (type === 1) out.push(b[o]);
    else if (type === 8) { const v = r.u16(o); out.push(v & 0x8000 ? v - 0x10000 : v); }
    else if (type === 9) out.push(r.u32(o) | 0);
    else if (type === 5) out.push(r.u32(o + 4) ? r.u32(o) / r.u32(o + 4) : 0);
    else if (type === 10) out.push((r.u32(o + 4) | 0) ? (r.u32(o) | 0) / (r.u32(o + 4) | 0) : 0);
  }
  return out;
}

// Parse a TIFF structure (bytes start at the byte-order mark).
export function parseTiff(b) {
  const r = reader(b);
  if (r.u16(2) !== 42) throw new Error('Bad TIFF magic');
  const ifd0 = readIfd(b, r, r.u32(4));
  const sub = (ifd, tag) => {
    const e = ifd && ifd.entries.get(tag);
    try { return e && e.value ? readIfd(b, r, e.value[0]) : null; } catch { return null; }
  };
  const exif = sub(ifd0, 0x8769);
  const gps = sub(ifd0, 0x8825);
  return { le: r.le, ifd0, exif, gps };
}

const ORIENT = ['', 'Normal', 'Mirrored', 'Rotated 180°', 'Mirrored vertically', 'Mirrored, rotated 90° CCW', 'Rotated 90° CW', 'Mirrored, rotated 90° CW', 'Rotated 90° CCW'];

function val(ifd, tag) {
  const e = ifd && ifd.entries.get(tag);
  return e ? e.value : undefined;
}
function str(ifd, tag) {
  const v = val(ifd, tag);
  return typeof v === 'string' && v ? v : null;
}
function num(ifd, tag) {
  const v = val(ifd, tag);
  return Array.isArray(v) && v.length ? v[0] : null;
}

function userComment(v) {
  if (!(v instanceof Uint8Array) || v.length <= 8) return null;
  const code = decodeUtf8OrLatin1(v.subarray(0, 8)).replace(/\0/g, '');
  const body = v.subarray(8);
  const s = code === 'UNICODE' ? decodeUtf16(body) : decodeUtf8OrLatin1(body);
  return s.replace(/\0+$/, '').trim() || null;
}

function dms(v, ref) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const deg = v[0] + v[1] / 60 + v[2] / 3600;
  return `${deg.toFixed(6)}° ${ref || ''}`.trim();
}

export const STRIPPED_NOTE = 'This file’s EXIF has no camera, date or location. The image was likely re-saved or shared in a way that removes them; the original photo may still have them.';
export const NO_EXIF_NOTE = 'No EXIF in this file: no camera, date or location data.';

export function gpsSummary(t) {
  const g = t.gps;
  if (!g || !g.entries.size) return null;
  const lat = dms(val(g, 2), str(g, 1));
  const lon = dms(val(g, 4), str(g, 3));
  const parts = [];
  if (lat && lon) parts.push(`${lat}, ${lon}`);
  const alt = num(g, 6);
  if (alt !== null) parts.push(`${(num(g, 5) === 1 ? -alt : alt).toFixed(1)} m`);
  const time = val(g, 7);
  const date = str(g, 0x1d);
  if (date || Array.isArray(time)) parts.push([date, Array.isArray(time) ? time.map((x) => String(Math.floor(x)).padStart(2, '0')).join(':') + ' UTC' : null].filter(Boolean).join(' '));
  return parts.join(' · ') || `${g.entries.size} GPS tags`;
}

// Human-readable rows for the common EXIF fields.
export function exifRows(t) {
  const { ifd0, exif } = t;
  const rows = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push([k, String(v)]); };
  add('Camera', [str(ifd0, 0x010f), str(ifd0, 0x0110)].filter(Boolean).join(' ') || null);
  add('Lens', str(exif, 0xa434));
  add('Software', str(ifd0, 0x0131));
  const taken = str(exif, 0x9003);
  add('Date taken', taken ? `${taken}${str(exif, 0x9011) ? ' ' + str(exif, 0x9011) : ''}` : null);
  add('Date digitized', str(exif, 0x9004));
  add('Date modified', str(ifd0, 0x0132));
  const et = num(exif, 0x829a);
  add('Exposure', [et ? (et < 1 ? `1/${Math.round(1 / et)} s` : `${et} s`) : null, num(exif, 0x829d) ? `f/${num(exif, 0x829d).toFixed(1)}` : null,
    num(exif, 0x8827) ? `ISO ${num(exif, 0x8827)}` : null, num(exif, 0x920a) ? `${num(exif, 0x920a).toFixed(1)} mm` : null].filter(Boolean).join(' · ') || null);
  const o = num(ifd0, 0x0112);
  add('Orientation', o ? ORIENT[o] || o : null);
  add('Pixel size', num(exif, 0xa002) && num(exif, 0xa003) ? `${num(exif, 0xa002)}×${num(exif, 0xa003)}` : null);
  add('Description', str(ifd0, 0x010e));
  add('Artist', str(ifd0, 0x013b));
  add('Copyright', str(ifd0, 0x8298));
  add('User comment', userComment(val(exif, 0x9286)));
  return rows;
}

// Remove GPS from a TIFF in place: drop the GPS pointer from IFD0 (later entries shift up, freed bytes zeroed)
// and zero the GPS IFD and its out-of-line values. Length and every other offset stay the same.
// Returns a new Uint8Array, or null when there is no GPS IFD.
export function removeGps(src) {
  const t = parseTiff(src);
  const ptr = t.ifd0 && t.ifd0.entries.get(0x8825);
  if (!ptr) return null;
  const b = src.slice();
  const r = reader(b);
  if (t.gps) {
    for (const e of t.gps.entries.values()) if (e.size > 4 && e.at + e.size <= b.length) b.fill(0, e.at, e.at + e.size);
    b.fill(0, t.gps.off, Math.min(b.length, t.gps.off + 2 + t.gps.n * 12 + 4));
  }
  const { off, n } = t.ifd0;
  const start = off + 2;
  const end = start + n * 12;
  const i = (ptr.entry - start) / 12;
  b.copyWithin(start + i * 12, start + (i + 1) * 12, end + 4); // later entries and the next-IFD pointer
  b.fill(0, end - 8, end + 4);
  const c = n - 1;
  if (r.le) { b[off] = c & 255; b[off + 1] = c >> 8; } else { b[off] = c >> 8; b[off + 1] = c & 255; }
  return b;
}

// Whether the GPS IFD and all its out-of-line values lie inside b (needed before an in-place removal).
export function gpsWithin(t, b) {
  const g = t.gps;
  if (!g) return false;
  if (g.off + 2 + g.n * 12 + 4 > b.length) return false;
  for (const e of g.entries.values()) if (e.size > 4 && e.at + e.size > b.length) return false;
  return true;
}

function exifUtc(date, offset) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(date || '');
  if (!m) return NaN;
  const o = /^([+-])(\d{2}):(\d{2})$/.exec(offset || '');
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return o ? local - (o[1] === '-' ? -1 : 1) * ((+o[2]) * 60 + (+o[3])) * 60000 : NaN;
}

// A note when the GPS timestamp (UTC) and Date taken differ by more than an hour. Editing the date
// (for example with Photos' Adjust) can leave the GPS time at the original capture time.
export function gpsTimeNote(t) {
  const g = t.gps;
  if (!g) return null;
  const d = str(g, 0x1d);
  const tm = val(g, 7);
  if (!d || !Array.isArray(tm) || tm.length < 3) return null;
  const dm = /^(\d{4}):(\d{2}):(\d{2})$/.exec(d);
  if (!dm) return null;
  const gpsMs = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], Math.floor(tm[0]), Math.floor(tm[1]), Math.floor(tm[2]));
  const taken = exifUtc(str(t.exif, 0x9003), str(t.exif, 0x9011));
  if (!Number.isFinite(gpsMs) || !Number.isFinite(taken) || Math.abs(gpsMs - taken) <= 3600000) return null;
  const gpsText = new Date(gpsMs).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  return `The GPS timestamp (${gpsText}) does not match Date taken (${str(t.exif, 0x9003)} ${str(t.exif, 0x9011)}). One of them was probably edited: the GPS time can show when the location was set (for example with Photos' Adjust), and Date taken can be changed the same way. Remove location also removes the GPS time.`;
}
