// EXIF editing (TIFF 6.0 / EXIF 2.32), append-only: existing bytes never move. Changed IFDs and values are
// written after the end of the TIFF data and pointers are updated; the bytes they replace are zeroed.
// This keeps MakerNote and thumbnail offsets (which can be absolute) valid.

import { reader, readIfd, parseTiff, SIZES } from './tiff.js';
import { decodeUtf8OrLatin1, decodeUtf16, encodeUtf8, isLatin1 } from './text.js';
import { makeField, isChanged } from './fields.js';
import { concat, formatBytes } from './bytes.js';

const P_EXIF = 0x8769;
const P_GPS = 0x8825;
const P_INTEROP = 0xa005;
const POINTERS = new Set([P_EXIF, P_GPS, P_INTEROP, 0x0201, 0x0202]);

// [name, label] by IFD.
export const TAGS = {
  ifd0: {
    0x010e: ['ImageDescription', 'Description / caption'], 0x010f: ['Make', 'Camera make'], 0x0110: ['Model', 'Camera model'],
    0x0112: ['Orientation', 'Orientation (1–8)'], 0x011a: ['XResolution', 'X resolution'], 0x011b: ['YResolution', 'Y resolution'],
    0x0128: ['ResolutionUnit', 'Resolution unit'], 0x0131: ['Software', 'Software'], 0x0132: ['DateTime', 'Date modified'],
    0x013b: ['Artist', 'Artist'], 0x013c: ['HostComputer', 'Host computer'], 0x0213: ['YCbCrPositioning', 'YCbCr positioning'],
    0x8298: ['Copyright', 'Copyright'], 0x02bc: ['XMLPacket', 'XMP packet'], 0x9c9b: ['XPTitle', 'Windows title'],
    0x9c9c: ['XPComment', 'Windows comment'], 0x9c9d: ['XPAuthor', 'Windows author'], 0x9c9e: ['XPKeywords', 'Windows keywords'],
  },
  exif: {
    0x829a: ['ExposureTime', 'Exposure time (s)'], 0x829d: ['FNumber', 'F-number'], 0x8822: ['ExposureProgram', 'Exposure program'],
    0x8827: ['ISO', 'ISO'], 0x9000: ['ExifVersion', 'EXIF version'], 0x9003: ['DateTimeOriginal', 'Date taken'],
    0x9004: ['DateTimeDigitized', 'Date digitized'], 0x9010: ['OffsetTime', 'Time zone (modified)'],
    0x9011: ['OffsetTimeOriginal', 'Time zone (taken)'], 0x9012: ['OffsetTimeDigitized', 'Time zone (digitized)'],
    0x9101: ['ComponentsConfiguration', 'Components'], 0x9201: ['ShutterSpeedValue', 'Shutter speed (APEX)'],
    0x9202: ['ApertureValue', 'Aperture (APEX)'], 0x9203: ['BrightnessValue', 'Brightness (APEX)'],
    0x9204: ['ExposureBiasValue', 'Exposure bias'], 0x9207: ['MeteringMode', 'Metering mode'], 0x9209: ['Flash', 'Flash'],
    0x920a: ['FocalLength', 'Focal length (mm)'], 0x9214: ['SubjectArea', 'Subject area'], 0x927c: ['MakerNote', 'Maker note'],
    0x9286: ['UserComment', 'User comment'], 0x9290: ['SubSecTime', 'Sub-second (modified)'],
    0x9291: ['SubSecTimeOriginal', 'Sub-second (taken)'], 0x9292: ['SubSecTimeDigitized', 'Sub-second (digitized)'],
    0xa000: ['FlashpixVersion', 'FlashPix version'], 0xa001: ['ColorSpace', 'Colour space'], 0xa002: ['PixelXDimension', 'Pixel width'],
    0xa003: ['PixelYDimension', 'Pixel height'], 0xa217: ['SensingMethod', 'Sensing method'], 0xa301: ['SceneType', 'Scene type'],
    0xa402: ['ExposureMode', 'Exposure mode'], 0xa403: ['WhiteBalance', 'White balance'], 0xa405: ['FocalLengthIn35mmFilm', 'Focal length (35 mm equiv.)'],
    0xa406: ['SceneCaptureType', 'Scene capture type'], 0xa420: ['ImageUniqueID', 'Image unique ID'], 0xa430: ['CameraOwnerName', 'Camera owner'],
    0xa431: ['BodySerialNumber', 'Camera serial number'], 0xa432: ['LensSpecification', 'Lens specification'], 0xa433: ['LensMake', 'Lens make'],
    0xa434: ['LensModel', 'Lens model'], 0xa435: ['LensSerialNumber', 'Lens serial number'], 0xa460: ['CompositeImage', 'Composite image'],
  },
};

// Tags that can be added, with their type.
const ADDABLE = [
  ['ifd0', 0x010e, 2], ['ifd0', 0x013b, 2], ['ifd0', 0x8298, 2], ['exif', 0x9286, 7], ['exif', 0x9003, 2], ['exif', 0x9011, 2],
];

const DATE_TAGS = new Set([0x0132, 0x9003, 0x9004]);
const OFFSET_TAGS = new Set([0x9010, 0x9011, 0x9012]);
const MAX_VALUES = 32;

function tagName(ifd, tag) {
  const t = TAGS[ifd] && TAGS[ifd][tag];
  return t ? t[0] : `0x${tag.toString(16).padStart(4, '0')}`;
}
function tagLabel(ifd, tag) {
  const t = TAGS[ifd] && TAGS[ifd][tag];
  return t ? t[1] : `EXIF tag 0x${tag.toString(16).padStart(4, '0')}`;
}

// Raw value as editable text, or null when it is not text-editable.
function rawText(b, r, e) {
  if (e.at + e.size > b.length) return null;
  const v = b.subarray(e.at, e.at + e.size);
  if (e.type === 2) return decodeUtf8OrLatin1(v).replace(/\0+$/, '');
  if (e.type === 7) {
    if (e.tag !== 0x9286 || v.length < 8) return null;
    const code = decodeUtf8OrLatin1(v.subarray(0, 8)).replace(/\0/g, '');
    const body = v.subarray(8);
    const s = code === 'UNICODE' ? decodeUtf16(body, r.le) : decodeUtf8OrLatin1(body);
    return s.replace(/\0+$/, '');
  }
  if (e.count > MAX_VALUES || !SIZES[e.type] || e.type === 11 || e.type === 12) return null;
  const out = [];
  for (let i = 0; i < e.count; i++) {
    const o = e.at + i * SIZES[e.type];
    if (e.type === 1) out.push(b[o]);
    else if (e.type === 6) out.push(b[o] << 24 >> 24);
    else if (e.type === 3) out.push(r.u16(o));
    else if (e.type === 8) out.push(r.u16(o) << 16 >> 16);
    else if (e.type === 4) out.push(r.u32(o));
    else if (e.type === 9) out.push(r.u32(o) | 0);
    else if (e.type === 5) out.push(`${r.u32(o)}/${r.u32(o + 4)}`);
    else if (e.type === 10) out.push(`${r.u32(o) | 0}/${r.u32(o + 4) | 0}`);
  }
  return out.join(' ');
}

function fraction(tok) {
  const m = /^(-?\d+)\/(-?\d+)$/.exec(tok);
  if (m) return [Number(m[1]), Number(m[2])];
  const x = Number(tok);
  if (!Number.isFinite(x)) return null;
  if (Number.isInteger(x)) return [x, 1];
  let d = 1;
  while (d < 1000000 && !Number.isInteger(Math.round(x * d * 1e9) / 1e9)) d *= 10;
  const n = Math.round(x * d);
  const g = (a, c) => (c ? g(c, a % c) : Math.abs(a));
  const k = g(n, d) || 1;
  return [n / k, d / k];
}

const RANGES = { 1: [0, 255], 6: [-128, 127], 3: [0, 65535], 8: [-32768, 32767], 4: [0, 4294967295], 9: [-2147483648, 2147483647] };

export function validateExif(v, f) {
  const { type, tag } = f.exifTag;
  if (type === 2) {
    if (DATE_TAGS.has(tag) && v !== '' && !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return 'Use YYYY:MM:DD HH:MM:SS';
    if (OFFSET_TAGS.has(tag) && v !== '' && !/^[+-]\d{2}:\d{2}$/.test(v)) return 'Use +HH:MM or -HH:MM';
    return null;
  }
  if (type === 7) return null;
  const toks = v.trim().split(/[\s,]+/).filter(Boolean);
  if (!toks.length) return 'Enter a value';
  for (const t of toks) {
    if (type === 5 || type === 10) {
      const fr = fraction(t);
      if (!fr || fr[1] === 0) return 'Use numbers or fractions like 1/60';
      if (type === 5 && (fr[0] < 0 || fr[0] > 4294967295 || fr[1] > 4294967295)) return 'Out of range';
    } else {
      const n = Number(t);
      const [lo, hi] = RANGES[type];
      if (!Number.isInteger(n) || n < lo || n > hi) return `Whole numbers ${lo}…${hi}`;
    }
  }
  return null;
}

// Encode text into { type, count, bytes } for an entry.
function encodeValue(le, type, tag, text) {
  const w16 = (b, o, v) => { if (le) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; } else { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; } };
  const w32 = (b, o, v) => { if (le) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; } else { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; } };
  if (type === 2) {
    const s = encodeUtf8(text);
    const bytes = concat([s, new Uint8Array(1)]);
    return { type, count: bytes.length, bytes };
  }
  if (tag === 0x02bc) {
    const bytes = encodeUtf8(text);
    return { type, count: bytes.length, bytes };
  }
  if (type === 7) {
    let bytes;
    if (isLatin1(text) && /^[\x00-\x7f]*$/.test(text)) bytes = concat([new Uint8Array([65, 83, 67, 73, 73, 0, 0, 0]), encodeUtf8(text)]);
    else {
      const u = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) w16(u, i * 2, text.charCodeAt(i));
      bytes = concat([new Uint8Array([85, 78, 73, 67, 79, 68, 69, 0]), u]);
    }
    return { type, count: bytes.length, bytes };
  }
  const toks = text.trim().split(/[\s,]+/).filter(Boolean);
  const size = SIZES[type];
  const bytes = new Uint8Array(toks.length * size);
  toks.forEach((t, i) => {
    const o = i * size;
    if (type === 5 || type === 10) { const [n, d] = fraction(t); w32(bytes, o, n >>> 0); w32(bytes, o + 4, d >>> 0); }
    else if (type === 1 || type === 6) bytes[o] = Number(t) & 255;
    else if (type === 3 || type === 8) w16(bytes, o, Number(t) & 0xffff);
    else w32(bytes, o, Number(t) >>> 0);
  });
  return { type, count: toks.length, bytes };
}

// Editable fields for every tag of IFD0 and the Exif IFD, plus the IFD1 thumbnail. GPS is handled by the
// location field; pointer and thumbnail-offset tags are not listed.
export function exifTagFields(b, group, opts = {}) {
  const t = parseTiff(b);
  const r = reader(b);
  const fields = [];
  for (const [name, ifd] of [['ifd0', t.ifd0], ['exif', t.exif]]) {
    if (!ifd) continue;
    for (const e of [...ifd.entries.values()].sort((a, c) => a.tag - c.tag)) {
      if (POINTERS.has(e.tag) || (name === 'ifd0' && e.tag === 0x02bc)) continue;
      // In TIFF/DNG files IFD0 also describes the image itself; only descriptive tags are offered there.
      if (opts.imageFile && name === 'ifd0' && !TAGS.ifd0[e.tag]) continue;
      const text = opts.readOnly ? null : rawText(b, r, e);
      const base = { group, key: tagName(name, e.tag), label: tagLabel(name, e.tag), exifTag: { ifd: name, tag: e.tag, type: e.type } };
      if (text === null) {
        fields.push(makeField({ ...base, cls: 'edit', kind: 'readonly', value: '', display: `${formatBytes(e.size)}${e.tag === 0x927c ? ' · camera-maker data, removable as a whole' : ''}`, readOnly: !!opts.readOnly, deletable: !opts.readOnly }));
      } else {
        fields.push(makeField({ ...base, cls: 'edit', kind: text.includes('\n') || text.length > 60 ? 'multiline' : 'text', value: text, validate: validateExif,
          placeholder: DATE_TAGS.has(e.tag) ? 'YYYY:MM:DD HH:MM:SS' : OFFSET_TAGS.has(e.tag) ? '+HH:MM' : null }));
      }
    }
  }
  if (t.ifd0 && t.ifd0.next && !opts.imageFile) {
    try {
      const ifd1 = readIfd(b, r, t.ifd0.next);
      const len = ifd1 && ifd1.entries.get(0x0202);
      fields.push(makeField({ group, key: 'Thumbnail', label: 'Embedded thumbnail (IFD1)', cls: 'edit', kind: 'readonly', value: '', exifThumb: true,
        display: `${len && Array.isArray(len.value) ? formatBytes(len.value[0]) : 'present'} · a small preview copy of the image`, readOnly: !!opts.readOnly, deletable: !opts.readOnly }));
    } catch { /* unreadable IFD1: not offered */ }
  }
  return fields;
}

export function exifAddable(fields) {
  const live = fields.filter((f) => !f.deleted && f.exifTag);
  return ADDABLE.filter(([ifd, tag]) => !live.some((f) => f.exifTag.ifd === ifd && f.exifTag.tag === tag))
    .map(([ifd, tag]) => ({ key: `EXIFTAG:${ifd}:${tag}`, label: `${tagLabel(ifd, tag)} (EXIF)` }));
}

export function newExifField(key, group) {
  const [, ifd, tagStr] = key.split(':');
  const tag = Number(tagStr);
  const def = ADDABLE.find(([i, t]) => i === ifd && t === tag);
  return makeField({ group, key: tagName(ifd, tag), label: tagLabel(ifd, tag), kind: 'text', value: '', isNew: true, exifTag: { ifd, tag, type: def[2] },
    validate: validateExif, placeholder: DATE_TAGS.has(tag) ? 'YYYY:MM:DD HH:MM:SS' : OFFSET_TAGS.has(tag) ? '+HH:MM' : null });
}

export function exifChanged(fields, gpsField) {
  return fields.some((f) => isChanged(f)) || !!(gpsField && gpsField.deleted);
}

// Apply field edits to a TIFF. Returns the new bytes (never shorter than the input).
export function writeExif(src, fields, opts = {}) {
  const { head, tail } = writeExifParts(src, fields, opts);
  return concat([head, tail]);
}

// As writeExif, but new data is addressed from appendAt (default: the end of src) and returned separately,
// for TIFF files where src is only the start of a larger file.
export function writeExifParts(src, fields, { dropGps = false, appendAt = src.length } = {}) {
  const t = parseTiff(src);
  const r = reader(src);
  const le = r.le;
  const out = src.slice();
  const tail = [];
  let pos = appendAt;
  const put = (bytes) => {
    if (pos & 1) { tail.push(new Uint8Array(1)); pos++; }
    const at = pos;
    tail.push(bytes);
    pos += bytes.length;
    return at;
  };
  const zero = (a, n) => { if (a >= 0 && a + n <= out.length) out.fill(0, a, a + n); };
  const w16 = (b, o, v) => { if (le) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; } else { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; } };
  const w32 = (b, o, v) => { if (le) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; } else { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; } };
  const zeroIfd = (ifd) => {
    if (!ifd) return;
    for (const e of ifd.entries.values()) if (e.size > 4) zero(e.at, e.size);
    zero(ifd.off, 2 + ifd.n * 12 + 4);
  };
  const entryBytes = (tag, enc) => {
    const e = new Uint8Array(12);
    w16(e, 0, tag); w16(e, 2, enc.type); w32(e, 4, enc.count);
    if (enc.bytes.length <= 4) e.set(enc.bytes, 8);
    else w32(e, 8, put(enc.bytes));
    return e;
  };
  // edits: Map(tag -> null (delete) | { type, count, bytes })
  const rewrite = (ifd, edits, next) => {
    const entries = new Map();
    if (ifd) for (const e of ifd.entries.values()) entries.set(e.tag, src.slice(e.entry, e.entry + 12));
    for (const [tag, enc] of edits) {
      const old = ifd && ifd.entries.get(tag);
      if (old && old.size > 4) zero(old.at, old.size);
      if (enc === null) entries.delete(tag);
      else entries.set(tag, entryBytes(tag, enc));
    }
    const tags = [...entries.keys()].sort((a, c) => a - c);
    const b = new Uint8Array(2 + tags.length * 12 + 4);
    w16(b, 0, tags.length);
    tags.forEach((tag, i) => b.set(entries.get(tag), 2 + i * 12));
    w32(b, 2 + tags.length * 12, next);
    if (ifd) zero(ifd.off, 2 + ifd.n * 12 + 4);
    return put(b);
  };

  const edits = { ifd0: new Map(), exif: new Map() };
  let dropThumb = false;
  for (const f of fields) {
    if (f.exifThumb) { if (f.deleted) dropThumb = true; continue; }
    if (!f.exifTag || !isChanged(f)) continue;
    const { ifd, tag, type } = f.exifTag;
    if (f.deleted) edits[ifd].set(tag, null);
    else edits[ifd].set(tag, encodeValue(le, type, tag, f.value));
  }
  if (dropGps && t.ifd0 && t.ifd0.entries.has(P_GPS)) {
    zeroIfd(t.gps);
    edits.ifd0.set(P_GPS, null);
  }
  if (edits.exif.size) {
    const at = rewrite(t.exif, edits.exif, t.exif ? t.exif.next : 0);
    edits.ifd0.set(P_EXIF, { type: 4, count: 1, bytes: (() => { const b = new Uint8Array(4); w32(b, 0, at); return b; })() });
  }
  let next = t.ifd0 ? t.ifd0.next : 0;
  if (dropThumb && next) {
    try {
      const ifd1 = readIfd(src, r, next);
      const off = ifd1.entries.get(0x0201);
      const len = ifd1.entries.get(0x0202);
      if (off && len) zero(off.value[0], len.value[0]);
      zeroIfd(ifd1);
    } catch { /* leave as is */ }
    next = 0;
  }
  if (!edits.ifd0.size && next === (t.ifd0 ? t.ifd0.next : 0)) return { head: out, tail: concat(tail) };
  const at0 = rewrite(t.ifd0, edits.ifd0, next);
  w32(out, 4, at0);
  return { head: out, tail: concat(tail) };
}
