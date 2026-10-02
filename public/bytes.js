// Binary helpers shared by the format modules.

export async function readBytes(blob, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(blob.size, end);
  if (e <= s) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(s, e).arrayBuffer());
}

export function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
export function u24be(b, o) { return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; }
export function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
export function u64be(b, o) {
  const hi = u32be(b, o);
  const lo = u32be(b, o + 4);
  const v = hi * 4294967296 + lo;
  if (!Number.isSafeInteger(v)) throw new Error('64-bit value exceeds safe integer range');
  return v;
}
export function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
export function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
export function i16be(b, o) { const v = u16be(b, o); return v & 0x8000 ? v - 0x10000 : v; }

export function putU16be(b, o, v) { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; }
export function putU32be(b, o, v) {
  b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
}
export function putU64be(b, o, v) {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error('invalid 64-bit value');
  putU32be(b, o, Math.floor(v / 4294967296));
  putU32be(b, o + 4, v % 4294967296);
}
export function putU32le(b, o, v) {
  b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255;
}

export function u32beBytes(v) { const b = new Uint8Array(4); putU32be(b, 0, v); return b; }
export function u32leBytes(v) { const b = new Uint8Array(4); putU32le(b, 0, v); return b; }

// 4-character code from bytes; bytes > 0x7F map to Latin-1 (0xA9 -> ©).
export function fourcc(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
export function fourccBytes(s) {
  if (s.length !== 4) throw new Error('fourcc must be 4 characters: ' + s);
  const b = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const c = s.charCodeAt(i);
    if (c > 255) throw new Error('fourcc not Latin-1: ' + s);
    b[i] = c;
  }
  return b;
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function indexOfSeq(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function hex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function uuidString(b, o = 0) {
  const h = hex(b.subarray(o, o + 16));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Total byte length of a list of Blob parts (Uint8Array or Blob).
export function partsSize(parts) {
  let n = 0;
  for (const p of parts) n += p.byteLength !== undefined ? p.byteLength : p.size;
  return n;
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return 'unknown';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
