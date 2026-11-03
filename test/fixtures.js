// Synthetic fixture builders. No real audio; payloads are deterministic pseudo-random bytes.

import { createHash } from 'node:crypto';

export const enc = new TextEncoder();

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function u32be(v) { return new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
export function u32le(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]); }
export function u16be(v) { return new Uint8Array([(v >>> 8) & 255, v & 255]); }
export function u16le(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
export function u64be(v) { return concat([u32be(Math.floor(v / 4294967296)), u32be(v % 4294967296)]); }
export function latin1(s) { return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
export function utf16bom(s) {
  const b = new Uint8Array(2 + s.length * 2);
  b[0] = 0xff; b[1] = 0xfe;
  for (let i = 0; i < s.length; i++) { b[2 + 2 * i] = s.charCodeAt(i) & 255; b[3 + 2 * i] = s.charCodeAt(i) >> 8; }
  return b;
}

export function prng(seed, n) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 255;
  }
  return out;
}

export function indexOf(hay, needle, from = 0) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export const SUNO_ID = '0b7d5e1c-3f2a-4c6b-9d8e-1a2b3c4d5e6f';
export const SUNO_TEXT = `made with suno; created=2025-03-04T05:06:07.000Z; id=${SUNO_ID}`;
export const FAKE_JPEG = concat([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), latin1('JFIF\0'), prng(7, 200), new Uint8Array([0xff, 0xd9])]);
export const FAKE_PNG = concat([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), prng(9, 120)]);

// ---- CBOR encoder (test only). Unsigned ints use 4-byte width when `wide` is set so values can be patched. ----
class Wide { constructor(v) { this.v = v; } }
export const wide = (v) => new Wide(v);

function cborHead(major, n) {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return concat([new Uint8Array([(major << 5) | 25]), u16be(n)]);
  return concat([new Uint8Array([(major << 5) | 26]), u32be(n)]);
}
export class CTag { constructor(tag, value) { this.tag = tag; this.value = value; } }

export function cbor(v) {
  if (v instanceof Wide) return concat([new Uint8Array([26]), u32be(v.v)]);
  if (v instanceof CTag) return concat([cborHead(6, v.tag), cbor(v.value)]);
  if (v instanceof Map) return concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (v === null) return new Uint8Array([0xf6]);
  if (v === true) return new Uint8Array([0xf5]);
  if (v === false) return new Uint8Array([0xf4]);
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') { const b = enc.encode(v); return concat([cborHead(3, b.length), b]); }
  if (v instanceof Uint8Array) return concat([cborHead(2, v.length), v]);
  if (Array.isArray(v)) return concat([cborHead(4, v.length), ...v.map(cbor)]);
  const keys = Object.keys(v);
  return concat([cborHead(5, keys.length), ...keys.flatMap((k) => [cbor(k), cbor(v[k])])]);
}

// ---- JUMBF ----
function uuidBytes(s) { return Uint8Array.from(s.replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16))); }
const T_STORE = '63327061-0011-0010-8000-00aa00389b71';
const T_MANIFEST = '63326d61-0011-0010-8000-00aa00389b71';
const T_ASSERTIONS = '63326173-0011-0010-8000-00aa00389b71';
const T_CLAIM = '6332636c-0011-0010-8000-00aa00389b71';
const T_SIG = '63326373-0011-0010-8000-00aa00389b71';
const T_CBOR = '63626f72-0011-0010-8000-00aa00389b71';

function box(type, ...payload) {
  const body = concat(payload);
  return concat([u32be(body.length + 8), latin1(type), body]);
}
function jumb(label, type, ...content) {
  const jumd = box('jumd', uuidBytes(type), new Uint8Array([0x03]), enc.encode(label), new Uint8Array([0]));
  return box('jumb', jumd, ...content);
}

export const HASH_MARK = new Uint8Array(32).fill(0xab);

// Manifest store with c2pa.actions.v2, com.suno.provenance and a hash assertion.
// hash: { kind: 'data', start, length } | { kind: 'bmff' }
// extra.signature: CBOR bytes for the c2pa.signature box; extra.claim: fields merged into the claim;
// extra.assertions: [label, value] pairs appended to the assertion store.
export function manifestStore(hash, extra = {}) {
  const assertions = [
    jumb('c2pa.actions.v2', T_CBOR, box('cbor', cbor({
      actions: [{ action: 'c2pa.created', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia', softwareAgent: { name: 'Suno', version: '4.5' } }],
    }))),
    jumb('com.suno.provenance', T_CBOR, box('cbor', cbor({ song_id: SUNO_ID, model: 'v4.5', created: '2025-03-04T05:06:07Z' }))),
  ];
  for (const [label, value] of extra.assertions || []) assertions.push(jumb(label, T_CBOR, box('cbor', cbor(value))));
  if (hash.kind === 'data') {
    assertions.push(jumb('c2pa.hash.data', T_CBOR, box('cbor', cbor({
      exclusions: [{ start: wide(hash.start), length: wide(hash.length) }], name: 'jumbf manifest', alg: 'sha256', hash: HASH_MARK, pad: new Uint8Array(4),
    }))));
  } else {
    assertions.push(jumb('c2pa.hash.bmff.v2', T_CBOR, box('cbor', cbor({ exclusions: [{ xpath: '/uuid' }], alg: 'sha256', hash: new Uint8Array(32), name: 'jumbf manifest' }))));
  }
  const claim = jumb('c2pa.claim.v2', T_CLAIM, box('cbor', cbor({
    instanceID: 'xmp:iid:00000000-0000-0000-0000-000000000001', claim_generator_info: { name: 'Suno', version: '1.0' }, alg: 'sha256',
    signature: 'self#jumbf=c2pa.signature', created_assertions: [], ...(extra.claim || {}),
  })));
  const sig = jumb('c2pa.signature', T_SIG, box('cbor', extra.signature || cbor(new Uint8Array(64))));
  const manifest = jumb('urn:c2pa:11111111-2222-3333-4444-555555555555', T_MANIFEST, jumb('c2pa.assertions', T_ASSERTIONS, ...assertions), claim, sig);
  return jumb('c2pa', T_STORE, manifest);
}

// Replace HASH_MARK in a finished file with SHA-256 over the file minus [start, start+length).
export function sealDataHash(file, start, length) {
  const at = indexOf(file, HASH_MARK);
  if (at < 0) throw new Error('hash marker not found');
  const h = createHash('sha256');
  h.update(file.subarray(0, start));
  h.update(file.subarray(start + length));
  const out = file.slice();
  out.set(new Uint8Array(h.digest()), at);
  return out;
}

// ---- ID3 ----
function syncsafe(n) { return new Uint8Array([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]); }

export function frame(major, id, data, format = 0) {
  return concat([latin1(id), major === 4 ? syncsafe(data.length) : u32be(data.length), new Uint8Array([0, format]), data]);
}
export function textData(major, s) {
  if (major === 4) return concat([new Uint8Array([3]), enc.encode(s)]);
  return concat([new Uint8Array([1]), utf16bom(s)]);
}
function strTerm(major, s) {
  return major === 4 ? concat([enc.encode(s), new Uint8Array([0])]) : concat([utf16bom(s), new Uint8Array([0, 0])]);
}
export function commData(major, lang, desc, text) {
  return concat([new Uint8Array([major === 4 ? 3 : 1]), latin1(lang), strTerm(major, desc), major === 4 ? enc.encode(text) : utf16bom(text)]);
}
export function txxxData(major, desc, value) {
  return concat([new Uint8Array([major === 4 ? 3 : 1]), strTerm(major, desc), major === 4 ? enc.encode(value) : utf16bom(value)]);
}
export function apicData(major, mime, ptype, desc, data) {
  return concat([new Uint8Array([major === 4 ? 3 : 1]), latin1(mime), new Uint8Array([0, ptype]), strTerm(major, desc), data]);
}
export function geobData(mime, filename, desc, obj) {
  return concat([new Uint8Array([3]), latin1(mime), new Uint8Array([0]), enc.encode(filename), new Uint8Array([0]), enc.encode(desc), new Uint8Array([0]), obj]);
}
export function id3Tag(major, frames, padding, flags = 0) {
  const body = concat([...frames, new Uint8Array(padding)]);
  return concat([latin1('ID3'), new Uint8Array([major, 0, flags]), syncsafe(body.length), body]);
}
export function unsync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xff && (i + 1 === b.length || b[i + 1] === 0 || b[i + 1] >= 0xe0)) out.push(0);
  }
  return Uint8Array.from(out);
}

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames.
export function mpegFrames(count, seed, xingFrames = null) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    const f = prng(seed + i, 417);
    f.set([0xff, 0xfb, 0x90, 0x00], 0);
    if (i === 0 && xingFrames !== null) {
      f.fill(0, 4, 36);
      f.set(concat([latin1('Info'), u32be(0x0f), u32be(xingFrames), u32be(417 * count), new Uint8Array(100), u32be(50), latin1('LAME3.100')]), 36);
    }
    frames.push(f);
  }
  return concat(frames);
}

export function fixture1() {
  const M = 3;
  const tag = id3Tag(M, [
    frame(M, 'TIT2', textData(M, 'Ocean Drive')),
    frame(M, 'TPE1', textData(M, 'Suno Artist')),
    frame(M, 'COMM', commData(M, 'eng', '', SUNO_TEXT)),
    frame(M, 'USLT', commData(M, 'eng', '', 'Line one\nLine two')),
    frame(M, 'WOAS', latin1('https://suno.com/song/' + SUNO_ID)),
    frame(M, 'APIC', apicData(M, 'image/jpeg', 3, '', FAKE_JPEG)),
  ], 1024);
  return concat([tag, mpegFrames(4, 100, 1000)]);
}

export function fixture2() {
  const M = 4;
  const build = (start, length) => {
    const geob = frame(M, 'GEOB', geobData('application/c2pa', 'c2pa', 'c2pa manifest store', manifestStore({ kind: 'data', start, length })));
    const frames = [
      frame(M, 'TIT2', textData(M, 'Ocean Drive')),
      frame(M, 'TPE1', textData(M, 'Suno Artist')),
      frame(M, 'TSSE', textData(M, 'Lavf60.3.100')),
      frame(M, 'WOAS', latin1('https://suno.com/song/' + SUNO_ID)),
      frame(M, 'TXXX', txxxData(M, 'comment', SUNO_TEXT)),
      frame(M, 'COMM', commData(M, 'eng', '', SUNO_TEXT)),
      frame(M, 'APIC', apicData(M, 'image/jpeg', 3, 'cover', FAKE_JPEG)),
      frame(M, 'USLT', commData(M, 'eng', '', 'Ünïcødé lyrics ✓')),
      geob,
    ];
    const tag = id3Tag(M, frames, 512);
    const geobStart = 10 + frames.slice(0, -1).reduce((n, f) => n + f.length, 0);
    return { file: concat([tag, mpegFrames(3, 200)]), geobStart, geobLen: geob.length };
  };
  const a = build(0, 0);
  const b = build(a.geobStart, a.geobLen);
  return { bytes: sealDataHash(b.file, b.geobStart, b.geobLen), exclusion: [b.geobStart, b.geobLen] };
}

export function fixture3() {
  const M = 4;
  const tag = id3Tag(M, [frame(M, 'TXXX', txxxData(M, 'comment', SUNO_TEXT)), frame(M, 'TSSE', textData(M, 'Lavf60.3.100'))], 256);
  return concat([tag, mpegFrames(3, 300)]);
}

// v2.4 with footer (no padding).
export function fixtureFooter() {
  const M = 4;
  const frames = concat([frame(M, 'TIT2', textData(M, 'Footer Song')), frame(M, 'TSSE', textData(M, 'enc'))]);
  const hdr = concat([latin1('ID3'), new Uint8Array([4, 0, 0x10]), syncsafe(frames.length)]);
  const ftr = concat([latin1('3DI'), new Uint8Array([4, 0, 0x10]), syncsafe(frames.length)]);
  return concat([hdr, frames, ftr, mpegFrames(2, 400)]);
}

// v2.3 with tag-level unsynchronisation.
export function fixtureUnsync() {
  const M = 3;
  const body = concat([
    frame(M, 'TIT2', textData(M, 'ÿÿ Unsync')), // U+00FF encodes as FF 00 in UTF-16LE
    frame(M, 'APIC', apicData(M, 'image/jpeg', 3, '', FAKE_JPEG)),
    frame(M, 'TSSE', textData(M, 'enc')),
    new Uint8Array(64),
  ]);
  const u = unsync(body);
  const tag = concat([latin1('ID3'), new Uint8Array([3, 0, 0x80]), syncsafe(u.length), u]);
  return { bytes: concat([tag, mpegFrames(2, 500)]), unsynced: u.length !== body.length };
}

// ---- RIFF ----
export function chunk(id, data) {
  return concat([latin1(id), u32le(data.length), data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}
export function infoList(items) {
  return chunk('LIST', concat([latin1('INFO'), ...items.map(([id, s]) => chunk(id, concat([enc.encode(s), new Uint8Array([0])])))]));
}
export function riff(chunks) {
  const body = concat(chunks);
  return concat([latin1('RIFF'), u32le(body.length + 4), latin1('WAVE'), body]);
}
export function fmtPcm(rate = 48000, ch = 2, bits = 16) {
  const ba = (ch * bits) / 8;
  return chunk('fmt ', concat([u16le(1), u16le(ch), u32le(rate), u32le(rate * ba), u16le(ba), u16le(bits)]));
}

export function fixture4() {
  const build = (start, length) => {
    const pre = [fmtPcm(), infoList([['ICMT', SUNO_TEXT], ['ISFT', 'Lavf60.3.100']]), chunk('data', prng(4, 4800))];
    const c2 = chunk('C2PA', manifestStore({ kind: 'data', start, length }));
    const file = riff([...pre, c2]);
    return { file, start: 12 + pre.reduce((n, c) => n + c.length, 0), length: c2.length };
  };
  const a = build(0, 0);
  const b = build(a.start, a.length);
  return { bytes: sealDataHash(b.file, b.start, b.length), exclusion: [b.start, b.length] };
}

export function fixtureWavOdd() {
  const M = 4;
  const tag = id3Tag(M, [frame(M, 'TIT2', textData(M, 'Odd')), frame(M, 'TXXX', txxxData(M, 'comment', SUNO_TEXT))], 100);
  return riff([
    fmtPcm(44100, 1, 16),
    infoList([['INAM', 'abc'], ['IART', 'xy'], ['ISRC', 'vinyl'], ['ISFT', 'Tool 1']]), // "abc\0" even, "xy\0" odd
    chunk('data', prng(5, 999)), // odd-sized data chunk with pad byte
    chunk('id3 ', tag),
  ]);
}

// ---- BMFF ----
export function bbox(type, ...payload) {
  const body = concat(payload);
  return concat([u32be(body.length + 8), latin1(type), body]);
}
export function bbox64(type, ...payload) {
  const body = concat(payload);
  return concat([u32be(1), latin1(type), u64be(body.length + 16), body]);
}
export function full(type, v, flags, ...payload) {
  return bbox(type, new Uint8Array([v, flags >> 16, (flags >> 8) & 255, flags & 255]), ...payload);
}
export function c2paUuid(store) {
  return bbox('uuid', uuidBytes('d8fec3d6-1b0e-483c-9297-5828877ec481'), new Uint8Array(4), latin1('manifest\0'), new Uint8Array(8), store);
}
function hdlr(type) { return full('hdlr', 0, 0, new Uint8Array(4), latin1(type), new Uint8Array(12), new Uint8Array([0])); }
function mvhd() { return full('mvhd', 0, 0, u32be(0), u32be(0), u32be(1000), u32be(5000), new Uint8Array(80)); }
function stsd(entry) { return full('stsd', 0, 0, u32be(1), entry); }
function mp4a() {
  return bbox('mp4a', new Uint8Array(6), u16be(1), new Uint8Array(8), u16be(2), u16be(16), u16be(0), u16be(0), u32be(44100 * 65536));
}
function avc1() { return bbox('avc1', new Uint8Array(6), u16be(1), new Uint8Array(16), u16be(640), u16be(360), new Uint8Array(50)); }
function tx3g() { return bbox('tx3g', new Uint8Array(6), u16be(1), new Uint8Array(30)); }
function stco(offsets) { return full('stco', 0, 0, u32be(offsets.length), ...offsets.map(u32be)); }
function co64(offsets) { return full('co64', 0, 0, u32be(offsets.length), ...offsets.map(u64be)); }
function trak(handler, entry, offTable) {
  return bbox('trak', full('tkhd', 0, 3, new Uint8Array(80)), bbox('mdia', full('mdhd', 0, 0, new Uint8Array(20)), hdlr(handler),
    bbox('minf', bbox('stbl', stsd(entry), full('stts', 0, 0, u32be(0)), offTable))));
}
export function dataItem(type, dtype, payload) {
  return bbox(type, bbox('data', new Uint8Array([0, 0, 0, dtype]), new Uint8Array(4), payload));
}
export const A9 = '©';
function ilst(items) { return bbox('ilst', ...items); }
function metaMdir(items, freeSize) {
  return full('meta', 0, 0, hdlr('mdir'), ilst(items), ...(freeSize ? [bbox('free', new Uint8Array(freeSize - 8))] : []));
}

// Chunk layout: n chunks of `chunkSize` bytes, each starting with a unique marker.
function mdatPayload(n, chunkSize, seed) {
  const parts = [];
  for (let i = 0; i < n; i++) { const c = prng(seed + i, chunkSize); c.set(latin1(`CHK${String(i).padStart(3, '0')}`)); parts.push(c); }
  return concat(parts);
}

// Assemble with offsets computed from the final position of mdat; iterate because moov size depends on table width only.
function assemble(order, makeMoov, mdatBody, chunkCounts, large = false) {
  let offsets = chunkCounts.map((n) => new Array(n).fill(0));
  for (let pass = 0; pass < 2; pass++) {
    const moov = makeMoov(offsets);
    const mdat = large ? bbox64('mdat', mdatBody) : bbox('mdat', mdatBody);
    const boxes = order.map((x) => (x === 'moov' ? moov : x === 'mdat' ? mdat : x));
    let pos = 0;
    let mdatData = 0;
    for (const b of boxes) { if (b === mdat) mdatData = pos + (large ? 16 : 8); pos += b.length; }
    let k = 0;
    offsets = chunkCounts.map((n) => Array.from({ length: n }, () => mdatData + (k++) * 512));
    if (pass === 1) return concat(boxes);
  }
}

// opts.metaFree: size of free inside meta (0 = none); opts.large: 64-bit mdat size
export function fixture5(opts = {}) {
  const metaFree = opts.metaFree === undefined ? 64 : opts.metaFree;
  const items = [
    dataItem(A9 + 'too', 1, enc.encode('Lavf60.3.100')),
    dataItem(A9 + 'lyr', 1, enc.encode('First line\nSecond line')),
    dataItem(A9 + 'cmt', 1, enc.encode(SUNO_TEXT)),
  ];
  const makeMoov = (o) => bbox('moov', mvhd(), trak('soun', mp4a(), stco(o[0])), trak('sbtl', tx3g(), stco(o[1])), bbox('udta', metaMdir(items, metaFree)));
  const order = [bbox('ftyp', latin1('M4A '), u32be(0), latin1('M4A isommp42')), c2paUuid(manifestStore({ kind: 'bmff' })), 'moov', bbox('free', new Uint8Array(32)), 'mdat'];
  return assemble(order, makeMoov, mdatPayload(6, 512, 50), [4, 2], !!opts.large);
}

// opts.noUdta: moov without udta (metadata path must be created)
export function fixture6(opts = {}) {
  const items = [dataItem(A9 + 'too', 1, enc.encode('Lavf61.1.100'))];
  const udta = opts.noUdta ? [] : [bbox('udta', metaMdir(items, 0))];
  const makeMoov = (o) => bbox('moov', mvhd(), trak('vide', avc1(), co64(o[0])), trak('soun', mp4a(), stco(o[1])), ...udta);
  const order = [bbox('ftyp', latin1('isom'), u32be(512), latin1('isomiso2avc1mp41')), c2paUuid(manifestStore({ kind: 'bmff' })), bbox('free', new Uint8Array(16)), 'mdat', 'moov'];
  return assemble(order, makeMoov, mdatPayload(5, 512, 60), [3, 2]);
}

export function toFile(bytes, name = 'f.bin') {
  return new File([bytes], name);
}

// ---- DER (test only) ----
function derLen(n) {
  if (n < 128) return new Uint8Array([n]);
  if (n < 256) return new Uint8Array([0x81, n]);
  return new Uint8Array([0x82, n >> 8, n & 255]);
}
export function der(tag, ...content) {
  const b = concat(content);
  return concat([new Uint8Array([tag]), derLen(b.length), b]);
}
export function derOid(s) {
  const p = s.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    const groups = [];
    let v = n;
    do { groups.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v);
    groups.forEach((g, i) => out.push(i < groups.length - 1 ? g | 0x80 : g));
  }
  return der(0x06, Uint8Array.from(out));
}
const seq = (...c) => der(0x30, ...c);
const set = (...c) => der(0x31, ...c);
export function derName(cn, o) {
  return seq(set(seq(derOid('2.5.4.3'), der(0x0c, enc.encode(cn)))), set(seq(derOid('2.5.4.10'), der(0x13, latin1(o)))));
}
// Certificate with only the fields the reader looks at being meaningful. Times: 'YYMMDDhhmmssZ'.
export function derCert(subject, issuer, notBefore, notAfter) {
  const alg = seq(derOid('1.2.840.10045.4.3.2'));
  const tbs = seq(der(0xa0, der(0x02, new Uint8Array([2]))), der(0x02, new Uint8Array([1])), alg, issuer,
    seq(der(0x17, latin1(notBefore)), der(0x17, latin1(notAfter))), subject, seq(seq(derOid('1.2.840.10045.2.1')), der(0x03, new Uint8Array([0, 4]))));
  return seq(tbs, alg, der(0x03, new Uint8Array([0, 1, 2])));
}
// RFC 3161 TimeStampToken with TSTInfo genTime ('YYYYMMDDhhmmssZ') and embedded certificates.
export function derTimestamp(genTime, certs) {
  const tst = seq(der(0x02, new Uint8Array([1])), derOid('1.2.3.4'), seq(seq(derOid('2.16.840.1.101.3.4.2.1')), der(0x04, new Uint8Array(32))),
    der(0x02, new Uint8Array([5])), der(0x18, latin1(genTime)));
  const eci = seq(derOid('1.2.840.113549.1.9.16.1.4'), der(0xa0, der(0x04, tst)));
  const sd = seq(der(0x02, new Uint8Array([3])), set(), eci, der(0xa0, ...certs), set());
  return seq(derOid('1.2.840.113549.1.7.2'), der(0xa0, sd));
}
// COSE_Sign1 (tag 18) with ES256, an x5chain in the protected header and a sigTst2 timestamp in the unprotected header.
export function coseSignature() {
  const root = derName('Test C2PA Root CA', 'Test Org');
  const leaf = derCert(derName('Test Content Credentials', 'Test Org'), root, '260723150014Z', '281025150014Z');
  const rootCert = derCert(root, root, '260723150014Z', '360720150014Z');
  const tsaRoot = derName('Test TSA Root', 'Time Co');
  const tsaLeaf = derCert(derName('Test Timestamp Responder', 'Time Co'), tsaRoot, '260101000000Z', '370101000000Z');
  const tsaRootCert = derCert(tsaRoot, tsaRoot, '250101000000Z', '380101000000Z');
  const token = derTimestamp('20250304050610Z', [tsaRootCert, tsaLeaf]);
  const prot = cbor(new Map([[1, -7], [33, [leaf, rootCert]]]));
  const unprot = new Map([['sigTst2', { tstTokens: [{ val: token }] }]]);
  return cbor(new CTag(18, [prot, unprot, null, new Uint8Array(64)]));
}
