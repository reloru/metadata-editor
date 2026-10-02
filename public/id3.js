// ID3v2.3 / ID3v2.4 tag parsing and writing (id3.org id3v2.3.0, id3v2.4.0-structure, id3v2.4.0-frames).

import { u32be, concat, formatBytes } from './bytes.js';
import {
  decodeLatin1, decodeUtf16, decodeUtf16be, decodeUtf8, encodeLatin1, encodeUtf16Bom, encodeUtf8, isLatin1,
  stripTrailingNulls, validateTrack, validateBpm, validateIsrc, validateYear, validateId3Timestamp, validateLang,
} from './text.js';
import { makeField, isChanged, PICTURE_TYPES } from './fields.js';
import { C2PA_MIME } from './c2pa.js';

export const ID3_HEADER = 10;

export function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}
export function syncsafeBytes(v) {
  if (v < 0 || v > 0x0fffffff) throw new Error('ID3 size exceeds 256 MB limit');
  return new Uint8Array([(v >>> 21) & 0x7f, (v >>> 14) & 0x7f, (v >>> 7) & 0x7f, v & 0x7f]);
}

// Reverse the unsynchronisation scheme: every FF 00 becomes FF.
export function deunsync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && i + 1 < b.length && b[i + 1] === 0x00) i++;
  }
  return out.slice(0, n);
}

// Parse the 10-byte header. Returns null if not an ID3v2 header.
export function readHeader(b) {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  if (b[3] === 0xff || b[4] === 0xff) return null;
  if ((b[6] | b[7] | b[8] | b[9]) & 0x80) return null;
  const flags = b[5];
  const size = syncsafe(b, 6);
  const hasFooter = b[3] === 4 && (flags & 0x10) !== 0;
  return { major: b[3], revision: b[4], flags, size, hasFooter, totalSize: 10 + size + (hasFooter ? 10 : 0) };
}

const FRAME_ID = /^[A-Z0-9]{4}$/;

function validFrameStart(b, o) {
  if (o === b.length) return true;
  if (o > b.length) return false;
  if (b[o] === 0) return true;
  if (o + 4 > b.length) return false;
  return FRAME_ID.test(decodeLatin1(b.subarray(o, o + 4)));
}

// Parse a complete tag (header + body [+ footer]).
export function parseTag(bytes) {
  const h = readHeader(bytes);
  if (!h) throw new Error('Not an ID3v2 tag');
  const tag = {
    major: h.major, revision: h.revision, flags: h.flags, size: h.size, hasFooter: h.hasFooter,
    totalSize: h.totalSize, frames: [], junk: null, unsupported: null, extHeader: false, unsync: (h.flags & 0x80) !== 0,
  };
  if (h.major !== 3 && h.major !== 4) {
    tag.unsupported = `ID3v2.${h.major}`;
    return tag;
  }
  let body = bytes.subarray(10, 10 + h.size);
  if (body.length < h.size) throw new Error('ID3 tag truncated');
  if (h.major === 3 && tag.unsync) body = deunsync(body);
  let o = 0;
  if (h.flags & 0x40) {
    tag.extHeader = true;
    if (h.major === 3) o = 4 + u32be(body, 0);
    else o = syncsafe(body, 0);
    if (o > body.length) throw new Error('Invalid ID3 extended header');
  }
  while (o + 10 <= body.length) {
    if (body[o] === 0) break; // padding
    const id = decodeLatin1(body.subarray(o, o + 4));
    if (!FRAME_ID.test(id)) break;
    let size;
    if (h.major === 3) {
      size = u32be(body, o + 4);
    } else {
      const plain = u32be(body, o + 4);
      const hasHigh = (body[o + 4] | body[o + 5] | body[o + 6] | body[o + 7]) & 0x80;
      size = hasHigh ? plain : syncsafe(body, o + 4);
      // Some writers store plain 32-bit sizes in v2.4; prefer whichever lands on a valid next frame.
      if (!hasHigh && size !== plain && !validFrameStart(body, o + 10 + size) && validFrameStart(body, o + 10 + plain)) size = plain;
    }
    if (o + 10 + size > body.length) break;
    const status = body[o + 8];
    const format = body[o + 9];
    let data = body.subarray(o + 10, o + 10 + size);
    let raw = body.subarray(o, o + 10 + size);
    let preserveReason = null;
    if (h.major === 3) {
      if (format & 0x80) preserveReason = 'compressed';
      else if (format & 0x40) preserveReason = 'encrypted';
      else if (format & 0x20) preserveReason = 'grouped';
    } else {
      if ((format & 0x02) || tag.unsync) {
        data = deunsync(data);
        // Rewrite without unsynchronisation: same header, unsync flag cleared, decoded data.
        const hdr = raw.slice(0, 10);
        hdr.set(syncsafeBytes(data.length), 4);
        hdr[9] = format & ~0x02;
        raw = concat([hdr, data]);
      }
      if (format & 0x08) preserveReason = 'compressed';
      else if (format & 0x04) preserveReason = 'encrypted';
      else if (format & 0x40) preserveReason = 'grouped';
      if (!preserveReason && (format & 0x01)) data = data.subarray(4); // data length indicator
    }
    tag.frames.push({ id, status, format, size, data, raw: raw.slice(), preserveReason });
    o += 10 + size;
  }
  // Anything after the last frame that is not zero padding is kept as unparsed data.
  let end = body.length;
  while (end > o && body[end - 1] === 0) end--;
  if (end > o) tag.junk = body.slice(o, end);
  return tag;
}

export function emptyTag(major = 4) {
  return { major, revision: 0, flags: 0, size: 0, hasFooter: false, totalSize: 0, frames: [], junk: null, unsupported: null, extHeader: false, unsync: false };
}

// ---- string helpers ----

function termLen(enc) { return enc === 1 || enc === 2 ? 2 : 1; }

function decodeStr(b, enc) {
  if (enc === 0) return decodeLatin1(b);
  if (enc === 1) return decodeUtf16(b);
  if (enc === 2) return decodeUtf16be(b);
  return decodeUtf8(b);
}

// Read a terminated string starting at o. Returns { str, next }.
function readStr(b, o, enc) {
  const t = termLen(enc);
  let z = o;
  if (t === 1) {
    while (z < b.length && b[z] !== 0) z++;
  } else {
    while (z + 1 < b.length && !(b[z] === 0 && b[z + 1] === 0)) z += 2;
    if (z + 1 >= b.length) z = b.length;
  }
  return { str: decodeStr(b.subarray(o, z), enc), next: Math.min(b.length, z + t) };
}

function decodeTextValues(b, enc) {
  const s = stripTrailingNulls(decodeStr(b, enc));
  return s.split('\u0000');
}

function chooseEnc(major, strings) {
  if (major === 4) return 3;
  return strings.every(isLatin1) ? 0 : 1;
}
function encodeStr(s, enc, terminate) {
  let b;
  if (enc === 0) b = encodeLatin1(s);
  else if (enc === 1) b = encodeUtf16Bom(s);
  else if (enc === 3) b = encodeUtf8(s);
  else throw new Error('unsupported encoding');
  if (!terminate) return b;
  return concat([b, new Uint8Array(termLen(enc))]);
}

// ---- frame content parsers ----

function parseText(f) {
  if (f.data.length < 1) return '';
  return decodeTextValues(f.data.subarray(1), f.data[0]).join(' / ');
}
function parseTxxx(f) {
  const enc = f.data[0];
  const d = readStr(f.data, 1, enc);
  return { desc: d.str, value: stripTrailingNulls(decodeStr(f.data.subarray(d.next), enc)).split('\u0000').join(' / ') };
}
function parseLangText(f) {
  const enc = f.data[0];
  const lang = decodeLatin1(f.data.subarray(1, 4));
  const d = readStr(f.data, 4, enc);
  return { lang, desc: d.str, text: stripTrailingNulls(decodeStr(f.data.subarray(d.next), enc)) };
}
function parseUrl(f) {
  return stripTrailingNulls(decodeLatin1(f.data));
}
function parseApic(f) {
  const enc = f.data[0];
  let z = 1;
  while (z < f.data.length && f.data[z] !== 0) z++;
  const mime = decodeLatin1(f.data.subarray(1, z));
  const ptype = f.data[z + 1];
  const d = readStr(f.data, z + 2, enc);
  return { mime, ptype, desc: d.str, data: f.data.slice(d.next) };
}
function parseGeob(f) {
  const enc = f.data[0];
  let z = 1;
  while (z < f.data.length && f.data[z] !== 0) z++;
  const mime = decodeLatin1(f.data.subarray(1, z));
  const fn = readStr(f.data, z + 1, enc);
  const desc = readStr(f.data, fn.next, enc);
  return { mime, filename: fn.str, desc: desc.str, object: f.data.subarray(desc.next) };
}
function parsePriv(f) {
  let z = 0;
  while (z < f.data.length && f.data[z] !== 0) z++;
  return { owner: decodeLatin1(f.data.subarray(0, z)), size: Math.max(0, f.data.length - z - 1) };
}

// ---- field definitions ----

export const TEXT_FIELDS = {
  TIT2: { label: 'Title' },
  TPE1: { label: 'Artist' },
  TPE2: { label: 'Album artist' },
  TALB: { label: 'Album' },
  TCON: { label: 'Genre' },
  TRCK: { label: 'Track', validate: validateTrack, placeholder: 'n or n/total' },
  TPOS: { label: 'Disc', validate: validateTrack, placeholder: 'n or n/total' },
  TBPM: { label: 'BPM', validate: validateBpm, inputmode: 'numeric' },
  TKEY: { label: 'Initial key' },
  TCOM: { label: 'Composer' },
  TEXT: { label: 'Lyricist' },
  TCOP: { label: 'Copyright' },
  TPUB: { label: 'Publisher' },
  TSRC: { label: 'ISRC', validate: validateIsrc, placeholder: 'CCXXXYYNNNNN' },
};
const DATE_V3 = { key: 'TYER', label: 'Year', validate: validateYear, placeholder: 'YYYY', inputmode: 'numeric' };
const DATE_V4 = { key: 'TDRC', label: 'Recording date', validate: validateId3Timestamp, placeholder: 'yyyy-MM-dd' };

function dateDef(major) { return major === 3 ? DATE_V3 : DATE_V4; }

function editTextDef(id, major) {
  if (TEXT_FIELDS[id]) return { key: id, ...TEXT_FIELDS[id] };
  const d = dateDef(major);
  return id === d.key ? d : null;
}

function latin1Url(v) { return isLatin1(v) ? null : 'URL must be ISO-8859-1 (percent-encode other characters)'; }

function validateLangText(v, f) {
  if (f.value.lang !== f.orig?.lang || f.isNew) {
    const e = validateLang(v.lang);
    if (e) return e;
  }
  const dup = f.siblings && f.siblings().some((g) => g !== f && !g.deleted && g.key === f.key &&
    g.value.lang === v.lang && g.value.desc === v.desc);
  return dup ? `Another ${f.key} has the same language and description` : null;
}

const PRESERVE_LABELS = {
  TSSE: 'Encoder settings', TXXX: 'User text', PRIV: 'Private', GEOB: 'Object', TENC: 'Encoded by',
  TLEN: 'Length', TDRL: 'Release date', TDEN: 'Encoding time', TDAT: 'Date', TIME: 'Time', TRDA: 'Recording dates',
  TORY: 'Original year', TDOR: 'Original release', TSOT: 'Title sort', TSOP: 'Artist sort', TSOA: 'Album sort',
  TSO2: 'Album artist sort', TSOC: 'Composer sort', TLAN: 'Language', TMED: 'Media type', TFLT: 'File type',
  TOAL: 'Original album', TOPE: 'Original artist', TIT1: 'Content group', TIT3: 'Subtitle', TPE3: 'Conductor',
  TPE4: 'Remixer', WXXX: 'User URL', WCOM: 'Commercial URL', WCOP: 'Copyright URL', WOAF: 'File URL',
  WOAR: 'Artist URL', WORS: 'Radio URL', WPAY: 'Payment URL', WPUB: 'Publisher URL', UFID: 'Unique file ID',
  POPM: 'Popularimeter', PCNT: 'Play counter', MCDI: 'Music CD ID', SYLT: 'Synced lyrics', CHAP: 'Chapter', CTOC: 'Table of contents',
};

// Build fields for a parsed tag. Each frame becomes exactly one field (field.frameIndex).
// Returns { fields, c2pa } where c2pa = { frameIndex, jumbf } | null.
export function tagFields(tag, group = null) {
  const fields = [];
  let c2pa = null;
  const siblings = () => fields;
  const base = (i, f, extra) => makeField({ group, frameIndex: i, key: f.id, ...extra });
  if (tag.unsupported) return { fields, c2pa };
  tag.frames.forEach((f, i) => {
    const sizeStr = formatBytes(f.raw.length);
    if (f.preserveReason) {
      fields.push(base(i, f, { cls: 'preserve', kind: 'info', label: PRESERVE_LABELS[f.id] || f.id, display: `${f.id} (${f.preserveReason}, ${sizeStr})` }));
      return;
    }
    try {
      const def = editTextDef(f.id, tag.major);
      if (def) {
        fields.push(base(i, f, { label: def.label, kind: 'text', value: parseText(f), validate: def.validate || null, placeholder: def.placeholder, inputmode: def.inputmode }));
      } else if (f.id === 'COMM' || f.id === 'USLT') {
        const v = parseLangText(f);
        fields.push(base(i, f, {
          label: f.id === 'COMM' ? 'Comment' : 'Lyrics', kind: f.id === 'COMM' ? 'comment' : 'lyrics',
          value: v, validate: validateLangText, siblings,
        }));
      } else if (f.id === 'WOAS') {
        fields.push(base(i, f, { label: 'Source URL', kind: 'url', value: parseUrl(f), validate: latin1Url }));
      } else if (f.id === 'APIC') {
        const p = parseApic(f);
        const editable = p.ptype === 3;
        fields.push(base(i, f, {
          label: `Picture: ${PICTURE_TYPES[p.ptype] || 'type ' + p.ptype}`, kind: 'picture', value: p, readOnly: !editable,
        }));
      } else if (f.id === 'GEOB') {
        const g = parseGeob(f);
        if (g.mime.toLowerCase() === C2PA_MIME) {
          c2pa = { frameIndex: i, jumbf: g.object };
          fields.push(base(i, f, { cls: 'protected', kind: 'info', deletable: false, label: 'C2PA manifest (GEOB)', display: `${g.mime}, ${formatBytes(g.object.length)}`, c2pa: true }));
        } else {
          fields.push(base(i, f, { cls: 'preserve', kind: 'info', label: 'Object (GEOB)', display: `${g.mime || '(no MIME)'}${g.filename ? ', ' + g.filename : ''}${g.desc ? ', “' + g.desc + '”' : ''}, ${formatBytes(g.object.length)}` }));
        }
      } else if (f.id === 'TXXX') {
        const t = parseTxxx(f);
        fields.push(base(i, f, { cls: 'preserve', kind: 'info', label: `User text (TXXX): ${t.desc}`, display: t.value, txxx: t }));
      } else if (f.id === 'PRIV') {
        const p = parsePriv(f);
        fields.push(base(i, f, { cls: 'preserve', kind: 'info', label: 'Private (PRIV)', display: `${p.owner}, ${formatBytes(p.size)}` }));
      } else if (f.id[0] === 'T' && f.id !== 'TXXX') {
        fields.push(base(i, f, { cls: 'preserve', kind: 'info', label: `${PRESERVE_LABELS[f.id] || 'Text'} (${f.id})`, display: parseText(f) }));
      } else if (f.id[0] === 'W' && f.id !== 'WXXX') {
        fields.push(base(i, f, { cls: 'preserve', kind: 'info', label: `${PRESERVE_LABELS[f.id] || 'URL'} (${f.id})`, display: parseUrl(f) }));
      } else {
        fields.push(base(i, f, { cls: 'preserve', kind: 'info', label: `${PRESERVE_LABELS[f.id] || 'Frame'} (${f.id})`, display: sizeStr }));
      }
    } catch {
      fields.push(base(i, f, { cls: 'preserve', kind: 'info', label: `Frame (${f.id})`, display: `unparsed, ${sizeStr}` }));
    }
  });
  if (tag.junk) fields.push(makeField({ group, key: 'junk', cls: 'preserve', kind: 'info', label: 'Unparsed tag data', display: formatBytes(tag.junk.length), junk: true }));
  return { fields, c2pa };
}

// Fields that "Add field" may create for this tag.
export function addable(tag, fields) {
  if (tag.unsupported) return [];
  const live = fields.filter((f) => !f.deleted);
  const has = (k) => live.some((f) => f.key === k);
  const out = [];
  for (const k of Object.keys(TEXT_FIELDS)) if (!has(k)) out.push({ key: k, label: TEXT_FIELDS[k].label });
  const d = dateDef(tag.major);
  if (!has(d.key)) out.push({ key: d.key, label: d.label });
  out.push({ key: 'COMM', label: 'Comment' });
  out.push({ key: 'USLT', label: 'Lyrics' });
  if (!has('WOAS')) out.push({ key: 'WOAS', label: 'Source URL' });
  if (!live.some((f) => f.key === 'APIC' && f.value && f.value.ptype === 3)) out.push({ key: 'APIC', label: 'Front cover' });
  return out;
}

export function newField(tag, key, fields, group = null) {
  const siblings = () => fields;
  const common = { group, key, isNew: true, frameIndex: -1 };
  const def = editTextDef(key, tag.major);
  if (def) return makeField({ ...common, label: def.label, kind: 'text', value: '', validate: def.validate || null, placeholder: def.placeholder, inputmode: def.inputmode });
  if (key === 'COMM' || key === 'USLT') {
    let desc = '';
    const taken = (d) => fields.some((f) => !f.deleted && f.key === key && f.value.lang === 'eng' && f.value.desc === d);
    for (let n = 2; taken(desc); n++) desc = String(n);
    return makeField({ ...common, label: key === 'COMM' ? 'Comment' : 'Lyrics', kind: key === 'COMM' ? 'comment' : 'lyrics', value: { lang: 'eng', desc, text: '' }, validate: validateLangText, siblings });
  }
  if (key === 'WOAS') return makeField({ ...common, label: 'Source URL', kind: 'url', value: '', validate: latin1Url });
  if (key === 'APIC') return makeField({ ...common, label: 'Picture: Front cover', kind: 'picture', value: { mime: '', ptype: 3, desc: '', data: null }, validate: (v) => (v.data ? null : 'Choose an image') });
  throw new Error('Cannot add ' + key);
}

// ---- writing ----

function frameHeader(id, size, major, status) {
  const h = new Uint8Array(10);
  for (let i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
  if (major === 4) h.set(syncsafeBytes(size), 4);
  else { h[4] = size >>> 24; h[5] = (size >>> 16) & 255; h[6] = (size >>> 8) & 255; h[7] = size & 255; }
  h[8] = status;
  h[9] = 0;
  return h;
}

function serializeField(f, major) {
  const v = f.value;
  let data;
  if (f.kind === 'text') {
    const enc = chooseEnc(major, [v]);
    data = concat([new Uint8Array([enc]), encodeStr(v, enc, false)]);
  } else if (f.kind === 'comment' || f.kind === 'lyrics') {
    const enc = chooseEnc(major, [v.desc, v.text]);
    data = concat([new Uint8Array([enc]), encodeLatin1(v.lang), encodeStr(v.desc, enc, true), encodeStr(v.text, enc, false)]);
  } else if (f.kind === 'url') {
    data = encodeLatin1(v);
  } else if (f.kind === 'picture') {
    const enc = chooseEnc(major, [v.desc]);
    data = concat([new Uint8Array([enc]), encodeLatin1(v.mime), new Uint8Array([0, v.ptype]), encodeStr(v.desc, enc, true), v.data]);
  } else {
    throw new Error('Cannot serialize ' + f.key);
  }
  return data;
}

// Serialize the tag. fields: the fields produced by tagFields/newField for this tag.
// opts.removeC2pa drops the C2PA GEOB frame.
export function buildTag(tag, fields, opts = {}) {
  const major = tag.major;
  const byFrame = new Map();
  for (const f of fields) if (f.frameIndex >= 0) byFrame.set(f.frameIndex, f);
  const parts = [];
  tag.frames.forEach((fr, i) => {
    const f = byFrame.get(i);
    if (f && f.deleted) return;
    if (f && f.c2pa && opts.removeC2pa) return;
    if (f && isChanged(f)) {
      const data = serializeField(f, major);
      const statusMask = major === 4 ? 0x70 : 0xe0;
      parts.push(frameHeader(fr.id, data.length, major, fr.status & statusMask), data);
    } else {
      parts.push(fr.raw);
    }
  });
  for (const f of fields) {
    if (!f.isNew || f.deleted) continue;
    const data = serializeField(f, major);
    parts.push(frameHeader(f.key, data.length, major, 0), data);
  }
  const junkField = fields.find((f) => f.junk);
  if (tag.junk && !(junkField && junkField.deleted)) parts.push(tag.junk);
  const content = concat(parts);
  let size;
  if (tag.hasFooter) size = content.length;
  else if (content.length <= tag.size) size = tag.size;
  else size = content.length + 2048;
  const flags = tag.flags & ~(0x80 | 0x40);
  const out = new Uint8Array(10 + size + (tag.hasFooter ? 10 : 0));
  out.set([0x49, 0x44, 0x33, major, tag.revision, flags], 0);
  out.set(syncsafeBytes(size), 6);
  out.set(content, 10);
  if (tag.hasFooter) {
    out.set([0x33, 0x44, 0x49, major, tag.revision, flags], 10 + size);
    out.set(syncsafeBytes(size), 10 + size + 6);
  }
  return out;
}

export function tagChanged(fields, removeC2pa) {
  return fields.some((f) => isChanged(f) || (removeC2pa && f.c2pa));
}

export function versionLabel(tag) {
  return tag.unsupported ? tag.unsupported : `ID3v2.${tag.major}.${tag.revision}`;
}

// Suno provenance candidates: COMM text and TXXX "comment" value.
export function provenanceText(f) {
  if (f.deleted) return null;
  if (f.key === 'COMM' && f.value) return { text: f.value.text, where: 'COMM' };
  if (f.key === 'TXXX' && f.txxx && f.txxx.desc.toLowerCase() === 'comment') return { text: f.txxx.value, where: 'TXXX comment' };
  return null;
}
