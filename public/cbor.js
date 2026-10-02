// CBOR decoder (RFC 8949): major types 0-7, tags, indefinite lengths.
// Maps with only text keys decode to null-prototype objects; other maps decode to Map.
// Byte strings decode to Uint8Array. Integers beyond 2^53 decode to BigInt.

export class CborTag {
  constructor(tag, value) { this.tag = tag; this.value = value; }
}
export const CBOR_UNDEFINED = Symbol('cbor-undefined');
export class CborSimple {
  constructor(value) { this.value = value; }
}

const BREAK = Symbol('break');
const MAX_DEPTH = 256;

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

class Decoder {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = 0;
  }
  need(n) {
    if (this.o + n > this.b.length) throw new Error('CBOR: unexpected end of data');
  }
  u8() { this.need(1); return this.b[this.o++]; }
  arg(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return this.u8();
    if (ai === 25) { this.need(2); const v = this.dv.getUint16(this.o); this.o += 2; return v; }
    if (ai === 26) { this.need(4); const v = this.dv.getUint32(this.o); this.o += 4; return v; }
    if (ai === 27) {
      this.need(8);
      const v = this.dv.getBigUint64(this.o); this.o += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new Error('CBOR: invalid additional info ' + ai);
  }
  len(ai) {
    const n = this.arg(ai);
    if (typeof n !== 'number') throw new Error('CBOR: length too large');
    return n;
  }
  bytes(n) {
    this.need(n);
    const v = this.b.slice(this.o, this.o + n);
    this.o += n;
    return v;
  }
  item(depth = 0, allowBreak = false) {
    if (depth > MAX_DEPTH) throw new Error('CBOR: nesting too deep');
    const ib = this.u8();
    const mt = ib >> 5;
    const ai = ib & 31;
    switch (mt) {
      case 0: return this.arg(ai);
      case 1: {
        const n = this.arg(ai);
        return typeof n === 'bigint' ? -1n - n : -1 - n;
      }
      case 2:
      case 3: {
        let raw;
        if (ai === 31) {
          const chunks = [];
          for (;;) {
            const cb = this.u8();
            if (cb === 0xff) break;
            if (cb >> 5 !== mt || (cb & 31) === 31) throw new Error('CBOR: bad indefinite string chunk');
            chunks.push(this.bytes(this.len(cb & 31)));
          }
          let n = 0;
          for (const c of chunks) n += c.length;
          raw = new Uint8Array(n);
          let o = 0;
          for (const c of chunks) { raw.set(c, o); o += c.length; }
        } else {
          raw = this.bytes(this.len(ai));
        }
        return mt === 2 ? raw : new TextDecoder('utf-8').decode(raw);
      }
      case 4: {
        const arr = [];
        if (ai === 31) {
          for (;;) {
            const v = this.item(depth + 1, true);
            if (v === BREAK) break;
            arr.push(v);
          }
        } else {
          const n = this.len(ai);
          for (let i = 0; i < n; i++) arr.push(this.item(depth + 1));
        }
        return arr;
      }
      case 5: {
        const entries = [];
        if (ai === 31) {
          for (;;) {
            const k = this.item(depth + 1, true);
            if (k === BREAK) break;
            entries.push([k, this.item(depth + 1)]);
          }
        } else {
          const n = this.len(ai);
          for (let i = 0; i < n; i++) {
            const k = this.item(depth + 1);
            entries.push([k, this.item(depth + 1)]);
          }
        }
        if (entries.every(([k]) => typeof k === 'string')) {
          const obj = Object.create(null);
          for (const [k, v] of entries) obj[k] = v;
          return obj;
        }
        return new Map(entries);
      }
      case 6: {
        const tag = this.arg(ai);
        return new CborTag(tag, this.item(depth + 1));
      }
      case 7: {
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        if (ai === 23) return CBOR_UNDEFINED;
        if (ai < 20) return new CborSimple(ai);
        if (ai === 24) return new CborSimple(this.u8());
        if (ai === 25) { this.need(2); const v = halfToFloat(this.dv.getUint16(this.o)); this.o += 2; return v; }
        if (ai === 26) { this.need(4); const v = this.dv.getFloat32(this.o); this.o += 4; return v; }
        if (ai === 27) { this.need(8); const v = this.dv.getFloat64(this.o); this.o += 8; return v; }
        if (ai === 31) {
          if (!allowBreak) throw new Error('CBOR: unexpected break');
          return BREAK;
        }
        throw new Error('CBOR: reserved simple value');
      }
    }
    throw new Error('CBOR: unreachable');
  }
}

export function decodeCbor(bytes) {
  const d = new Decoder(bytes);
  return d.item();
}

// Decode and report the number of bytes consumed.
export function decodeCborPrefix(bytes) {
  const d = new Decoder(bytes);
  const value = d.item();
  return { value, length: d.o };
}
