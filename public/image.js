// JPEG (ITU-T T.81, JFIF, EXIF, CIPA DC-007 MPF) and PNG (ISO/IEC 15948, PNG 3rd ed.) metadata:
// view, delete segments/chunks, remove location, edit comments and text chunks.

import { readBytes, u16be, u32be, u32le, fourcc, fourccBytes, concat, formatBytes, crc32, u32beBytes, u32leBytes } from './bytes.js';
import { decodeLatin1, decodeUtf8, decodeUtf8OrLatin1, decodeUtf16be, encodeUtf8, encodeLatin1, isLatin1 } from './text.js';
import { makeField, isChanged } from './fields.js';
import { parseTiff, exifRows, gpsSummary, removeGps } from './tiff.js';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detect(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
  if (head.length >= 12 && fourcc(head, 0) === 'RIFF' && fourcc(head, 8) === 'WEBP') return true;
  return head.length >= 8 && PNG_SIG.every((x, i) => head[i] === x);
}

export async function load(file) {
  const head = await readBytes(file, 0, 12);
  if (fourcc(head, 0) === 'RIFF') return loadWebp(file);
  return head[0] === 0xff ? loadJpeg(file) : loadPng(file);
}

// ---- shared helpers ----

function startsWith(b, s, o = 0) {
  if (b.length < o + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

const XMP_SKIP = /^(xmlns|rdf|x|xml|stEvt|stRef):/;

// Simple properties of an XMP packet as [name, value] rows, and whether it records a location.
export function xmpInfo(text) {
  const rows = [];
  const seen = new Set();
  const push = (k, v) => {
    const t = v.trim();
    if (!t || XMP_SKIP.test(k) || seen.has(k) || rows.length >= 40) return;
    seen.add(k);
    rows.push([k, t.length > 200 ? t.slice(0, 200) + '…' : t]);
  };
  for (const m of text.matchAll(/\s([A-Za-z][\w.-]*:[\w.-]+)="([^"]*)"/g)) push(m[1], m[2]);
  for (const m of text.matchAll(/<([A-Za-z][\w.-]*:[\w.-]+)>([^<]+)<\/\1>/g)) push(m[1], m[2]);
  for (const m of text.matchAll(/<([A-Za-z][\w.-]*:[\w.-]+)>\s*<rdf:(?:Alt|Seq|Bag)>\s*<rdf:li[^>]*>([^<]*)<\/rdf:li>/g)) push(m[1], m[2]);
  return { rows, hasGps: /exif:GPS(Latitude|Longitude)|Iptc4xmpExt:LocationCreated|photoshop:City/.test(text) };
}

// ICC profile description ('desc' tag, v2 textDescription or v4 multiLocalizedUnicode).
export function iccDescription(p) {
  if (p.length < 132) return null;
  const n = u32be(p, 128);
  for (let i = 0; i < n && 132 + i * 12 + 12 <= p.length; i++) {
    const e = 132 + i * 12;
    if (fourcc(p, e) !== 'desc') continue;
    const o = u32be(p, e + 4);
    if (o + 12 > p.length) return null;
    const t = fourcc(p, o);
    if (t === 'desc') return decodeLatin1(p.subarray(o + 12, Math.min(p.length, o + 12 + u32be(p, o + 8)))).replace(/\0+$/, '');
    if (t === 'mluc' && u32be(p, o + 8) > 0 && o + 28 <= p.length) {
      const len = u32be(p, o + 20);
      const off = u32be(p, o + 24);
      return decodeUtf16be(p.subarray(o + off, Math.min(p.length, o + off + len)));
    }
    return null;
  }
  return null;
}

function exifFields(doc, tiffBytes, where, group) {
  let t;
  try { t = parseTiff(tiffBytes); } catch (err) { doc.notes.push(`${where}: ${err.message}`); return null; }
  const rows = exifRows(t);
  doc.sections.push({ title: `EXIF (${where})`, rows: rows.length ? rows : [['', 'No common fields']] });
  const gps = gpsSummary(t);
  if (gps) {
    doc.gpsField = makeField({ cls: 'edit', kind: 'readonly', key: 'GPS', group, label: 'Location (GPS)', value: '', display: gps, deleteLabel: 'Remove location',
      note: 'Removing clears only the GPS data; the rest of the EXIF (date, camera, orientation) stays.' });
  }
  const cam = rows.find((r) => r[0] === 'Camera');
  const date = rows.find((r) => r[0] === 'Date taken');
  return [cam && cam[1], date && date[1], gps ? 'GPS' : null].filter(Boolean).join(' · ') || `${formatBytes(tiffBytes.length)}`;
}

function xmpField(doc, text, label, extra) {
  const x = xmpInfo(text);
  doc.sections.push({ title: label, rows: x.rows.length ? x.rows : [['', 'No simple properties']] });
  if (x.hasGps) doc.notes.push(`${label} also records a location; delete the ${label} block to remove it.`);
  return makeField({ cls: 'preserve', kind: 'info', label, display: `${x.rows.length} properties${x.hasGps ? ', includes location' : ''} · ${formatBytes(text.length)}`, ...extra });
}

async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('decompression unavailable');
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ---- JPEG ----

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const SOF_NAMES = { 0xc0: 'Baseline', 0xc1: 'Extended sequential', 0xc2: 'Progressive', 0xc3: 'Lossless' };

async function loadJpeg(file) {
  const doc = { format: 'JPEG', file, fields: [], technical: [], notes: [], sections: [], c2pa: null, readOnly: null, segs: [], sosStart: null, mpf: null, gpsField: null };
  let o = 2;
  while (o + 4 <= file.size) {
    const h = await readBytes(file, o, o + 4);
    if (h[0] !== 0xff) throw new Error(`JPEG: expected a marker at byte ${o}`);
    const m = h[1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    if (m === 0xda || m === 0xd9) { doc.sosStart = o; break; }
    const end = o + 2 + u16be(h, 2);
    if (end > file.size) throw new Error('JPEG segment exceeds file size');
    doc.segs.push({ marker: m, start: o, end });
    o = end;
  }
  if (doc.sosStart === null) throw new Error('JPEG: no image data found');

  const tables = [];
  let sof = null;
  const jumbf = new Map();
  const icc = [];
  for (const s of doc.segs) {
    const m = s.marker;
    const isApp = m >= 0xe0 && m <= 0xef;
    if (!isApp && m !== 0xfe) {
      if (SOF.has(m)) {
        const d = await readBytes(doc.file, s.start + 4, s.end);
        sof = { kind: SOF_NAMES[m] || `SOF${m - 0xc0}`, bits: d[0], height: u16be(d, 1), width: u16be(d, 3), comps: d[5] };
      }
      tables.push(s);
      continue;
    }
    const d = await readBytes(doc.file, s.start + 4, s.end);
    s.data = d;
    const size = formatBytes(s.end - s.start);
    const afterMpf = !!doc.mpf;
    const pf = (label, display, extra = {}) => makeField({ cls: 'preserve', kind: 'info', key: `APP${m - 0xe0}`, label, display, seg: s, deletable: !afterMpf, ...extra });
    if (m === 0xfe) {
      const text = decodeUtf8OrLatin1(d);
      s.field = afterMpf
        ? pf('Comment (COM)', text, { key: 'COM' })
        : makeField({ key: 'COM', label: 'Comment (COM)', kind: text.includes('\n') ? 'multiline' : 'text', value: text, seg: s, validate: comValidate });
    } else if (m === 0xe0 && startsWith(d, 'JFIF\0')) {
      s.field = makeField({ cls: 'protected', kind: 'info', key: 'APP0', label: 'JFIF header', display: `v${d[5]}.${String(d[6]).padStart(2, '0')}`, deletable: false });
    } else if (m === 0xe1 && startsWith(d, 'Exif\0')) {
      s.exif = true;
      s.tiff = d.subarray(6);
      s.field = pf('EXIF', exifFields(doc, s.tiff, 'APP1', null), { note: 'Deleting EXIF also removes orientation, so a rotated photo may display sideways.' });
      if (doc.gpsField) doc.gpsField.seg = s;
    } else if (m === 0xe1 && startsWith(d, 'http://ns.adobe.com/xap/1.0/\0')) {
      s.field = xmpField(doc, decodeUtf8(d.subarray(29)), 'XMP', { key: 'APP1', seg: s, deletable: !afterMpf });
    } else if (m === 0xe1 && startsWith(d, 'http://ns.adobe.com/xmp/extension/\0')) {
      s.field = pf('Extended XMP', size);
    } else if (m === 0xe2 && startsWith(d, 'ICC_PROFILE\0')) {
      icc.push(s);
      s.field = pf('ICC colour profile', size, { iccPart: `${d[12]}/${d[13]}` });
    } else if (m === 0xe2 && startsWith(d, 'MPF\0')) {
      let count = '?';
      try {
        const t = d.subarray(4);
        const le = t[0] === 0x49;
        const r16 = (x) => (le ? t[x] | (t[x + 1] << 8) : (t[x] << 8) | t[x + 1]);
        const r32 = (x) => (le ? (t[x] | (t[x + 1] << 8) | (t[x + 2] << 16) | (t[x + 3] << 24)) >>> 0 : u32be(t, x));
        const ifd = r32(4);
        for (let i = 0; i < r16(ifd); i++) if (r16(ifd + 2 + i * 12) === 0xb001) count = r32(ifd + 2 + i * 12 + 8);
      } catch { /* count stays unknown */ }
      doc.mpf = s;
      s.field = makeField({ cls: 'protected', kind: 'info', key: 'APP2', label: 'Multi-picture index (MPF)', display: `${count} images (extra images follow the main one)`, deletable: false });
    } else if (m === 0xeb && startsWith(d, 'JP') && d.length >= 16) {
      const inst = u16be(d, 2);
      const seq = u32be(d, 4);
      if (!jumbf.has(inst)) jumbf.set(inst, []);
      jumbf.get(inst).push({ seq, s, d });
    } else if (m === 0xed && startsWith(d, 'Photoshop 3.0\0')) {
      s.field = pf('Photoshop / IPTC', size);
    } else if (m === 0xee && startsWith(d, 'Adobe')) {
      s.field = makeField({ cls: 'protected', kind: 'info', key: 'APP14', label: 'Adobe colour transform', display: size, deletable: false });
    } else {
      let id = '';
      for (let i = 0; i < Math.min(d.length, 32) && d[i] >= 0x20 && d[i] < 0x7f; i++) id += String.fromCharCode(d[i]);
      s.field = pf(`APP${m - 0xe0}${id ? ' ' + id : ''}`, size);
    }
  }
  if (icc.length) {
    try {
      const parts = icc.map((s) => ({ n: s.data[12], b: s.data.subarray(14) })).sort((a, b) => a.n - b.n);
      const desc = iccDescription(concat(parts.map((p) => p.b)));
      for (const s of icc) s.field.display = `${desc ? desc + ' · ' : ''}${formatBytes(s.end - s.start)} · deleting changes how colours display`;
    } catch { /* keep size only */ }
  }
  for (const [inst, list] of jumbf) {
    list.sort((a, b) => a.seq - b.seq);
    const first = list[0].d.subarray(8);
    const hdr = u32be(first, 0) === 1 ? 16 : 8;
    const body = concat([first, ...list.slice(1).map((x) => x.d.subarray(8 + hdr))]);
    const isC2pa = fourcc(first, 4) === 'jumb' && !doc.c2pa;
    if (isC2pa) doc.c2pa = { where: `APP11 JUMBF (${list.length} segment${list.length === 1 ? '' : 's'})`, jumbf: body, segs: list.map((x) => x.s) };
    const f = isC2pa
      ? makeField({ cls: 'protected', kind: 'info', key: 'APP11', label: 'C2PA manifest (APP11)', display: formatBytes(body.length), deletable: false, c2pa: true })
      : makeField({ cls: 'preserve', kind: 'info', key: 'APP11', label: `JUMBF box ${inst}`, display: formatBytes(body.length), group: null, jumbfSegs: list.map((x) => x.s) });
    list[0].s.field = f;
    for (const x of list) x.s.jumbf = f;
  }
  if (doc.mpf) doc.notes.push('This JPEG holds extra images after the main one (MPF). Blocks after the MPF index cannot be changed without breaking them.');

  doc.newComments = [];
  const fields = [];
  if (doc.gpsField) fields.push(doc.gpsField);
  for (const s of doc.segs) if (s.field) fields.push(s.field);
  if (tables.length) fields.push(makeField({ cls: 'protected', kind: 'info', key: 'tables', label: 'Image coding tables', display: tables.map((s) => markerName(s.marker)).join(', '), deletable: false }));
  fields.push(makeField({ cls: 'protected', kind: 'info', key: 'scan', label: 'Compressed image data', display: formatBytes(doc.file.size - doc.sosStart), deletable: false }));
  doc.fields = fields;
  doc.technical.push(['Container', 'JPEG']);
  if (sof) doc.technical.push(['Dimensions', `${sof.width}×${sof.height}`], ['Coding', `${sof.kind}, ${sof.bits}-bit`], ['Components', String(sof.comps)]);
  const kinds = [doc.segs.some((s) => s.exif) && 'EXIF', doc.segs.some((s) => s.field && s.field.label === 'XMP') && 'XMP', icc.length && 'ICC', doc.c2pa && 'C2PA', doc.mpf && 'MPF'].filter(Boolean);
  doc.technical.push(['Metadata', kinds.join(', ') || 'none']);
  doc.summary = `JPEG${sof ? ` · ${sof.width}×${sof.height}` : ''}${kinds.length ? ' · ' + kinds.join(', ') : ''}`;
  return doc;
}

function markerName(m) {
  if (SOF.has(m)) return `SOF${m - 0xc0}`;
  return { 0xc4: 'DHT', 0xdb: 'DQT', 0xdd: 'DRI', 0xcc: 'DAC', 0xdc: 'DNL' }[m] || `0x${m.toString(16)}`;
}

function comValidate(v) {
  return encodeUtf8(v).length + 2 > 0xffff ? 'Comment too long (64 KB limit per JPEG segment)' : null;
}

function comSegment(text) {
  const b = encodeUtf8(text);
  return concat([new Uint8Array([0xff, 0xfe, (b.length + 2) >> 8, (b.length + 2) & 255]), b]);
}

function buildJpeg(doc, removeC2pa) {
  const parts = [new Uint8Array([0xff, 0xd8])];
  const newComs = doc.newComments.filter((f) => !f.deleted).map((f) => comSegment(f.value));
  let inserted = false;
  const insert = () => { if (!inserted) { parts.push(...newComs); inserted = true; } };
  const gpsOff = doc.gpsField && doc.gpsField.deleted;
  for (const s of doc.segs) {
    if (s === doc.mpf) insert();
    const f = s.field;
    if (removeC2pa && doc.c2pa && doc.c2pa.segs.includes(s)) continue;
    if (s.jumbf && s.jumbf.deleted) continue;
    if (f && f.deleted) continue;
    if (s.exif && gpsOff && doc.gpsField.seg === s) {
      const tiff = removeGps(s.tiff);
      const len = s.end - s.start - 2;
      parts.push(tiff ? concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 255]), s.data.subarray(0, 6), tiff]) : doc.file.slice(s.start, s.end));
      continue;
    }
    if (f && f.key === 'COM' && f.cls === 'edit' && isChanged(f)) { parts.push(comSegment(f.value)); continue; }
    parts.push(doc.file.slice(s.start, s.end));
  }
  insert();
  parts.push(doc.file.slice(doc.sosStart));
  return parts;
}

// ---- PNG ----

const COLOR_TYPES = { 0: 'Greyscale', 2: 'RGB', 3: 'Palette', 4: 'Greyscale + alpha', 6: 'RGBA' };
const CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT']);
const COLOUR = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'sBIT', 'mDCV', 'cLLI']);
const READ = new Set(['IHDR', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'iCCP', 'caBX', 'tIME', 'pHYs', 'cICP', 'sRGB', 'gAMA', 'acTL']);
const PNG_TEXT_KEYS = ['Title', 'Author', 'Description', 'Copyright', 'Comment', 'Creation Time', 'Software', 'Source'];

function parseItxt(d) {
  let z = 0;
  while (z < d.length && d[z] !== 0) z++;
  const keyword = decodeLatin1(d.subarray(0, z));
  const compressed = d[z + 1] === 1;
  let p = z + 3;
  let q = p;
  while (q < d.length && d[q] !== 0) q++;
  const lang = decodeLatin1(d.subarray(p, q));
  p = q + 1;
  q = p;
  while (q < d.length && d[q] !== 0) q++;
  const tkw = decodeUtf8(d.subarray(p, q));
  return { keyword, compressed, lang, tkw, text: d.subarray(q + 1) };
}

function keywordOf(d) {
  let z = 0;
  while (z < d.length && d[z] !== 0) z++;
  return { keyword: decodeLatin1(d.subarray(0, z)), rest: d.subarray(z + 1) };
}

async function loadPng(file) {
  const doc = { format: 'PNG', file, fields: [], technical: [], notes: [], sections: [], c2pa: null, readOnly: null, chunks: [], gpsField: null, newText: [] };
  let o = 8;
  let ihdr = null;
  let idat = null;
  let frames = null;
  while (o + 12 <= file.size) {
    const h = await readBytes(file, o, o + 8);
    const len = u32be(h, 0);
    const type = fourcc(h, 4);
    const end = o + 12 + len;
    if (!/^[A-Za-z]{4}$/.test(type) || end > file.size) throw new Error(`PNG: invalid chunk at byte ${o}`);
    const c = { type, start: o, len, end };
    doc.chunks.push(c);
    if (READ.has(type)) c.data = await readBytes(file, o + 8, o + 8 + len);
    const size = formatBytes(len);
    const pf = (label, display, extra = {}) => makeField({ cls: 'preserve', kind: 'info', key: type, label, display, chunk: c, ...extra });
    if (type === 'IHDR') {
      const d = c.data;
      ihdr = { width: u32be(d, 0), height: u32be(d, 4), bits: d[8], color: d[9], interlace: d[12] };
      c.field = makeField({ cls: 'protected', kind: 'info', key: type, label: 'Image header (IHDR)', display: `${ihdr.width}×${ihdr.height}`, deletable: false });
    } else if (type === 'IDAT') {
      if (!idat) { idat = { n: 0, bytes: 0, first: c }; c.field = makeField({ cls: 'protected', kind: 'info', key: type, label: 'Image data (IDAT)', display: '', deletable: false }); }
      idat.n++;
      idat.bytes += len;
    } else if (type === 'acTL') {
      frames = u32be(c.data, 0);
      c.field = makeField({ cls: 'protected', kind: 'info', key: type, label: 'Animation control (APNG)', display: `${frames} frames`, deletable: false });
    } else if (CRITICAL.has(type)) {
      if (type !== 'IEND' && type !== 'fcTL' && type !== 'fdAT') c.field = makeField({ cls: 'protected', kind: 'info', key: type, label: type, display: size, deletable: false });
    } else if (type === 'tEXt') {
      const { keyword, rest } = keywordOf(c.data);
      const text = decodeLatin1(rest);
      c.field = makeField({ key: 'tEXt', label: keyword, kind: text.includes('\n') ? 'multiline' : 'text', value: text, chunk: c, keyword });
    } else if (type === 'iTXt') {
      const t = parseItxt(c.data);
      if (t.keyword === 'XML:com.adobe.xmp') {
        const xml = t.compressed ? await inflate(t.text).then(decodeUtf8, () => '') : decodeUtf8(t.text);
        c.field = xmpField(doc, xml, 'XMP', { key: 'iTXt', chunk: c });
      } else if (t.compressed) {
        let shown;
        try { shown = decodeUtf8(await inflate(t.text)); } catch { shown = `compressed, ${size}`; }
        c.field = pf(`${t.keyword} (iTXt, compressed)`, shown);
      } else {
        const text = decodeUtf8(t.text);
        c.field = makeField({ key: 'iTXt', label: t.keyword, kind: text.includes('\n') ? 'multiline' : 'text', value: text, chunk: c, keyword: t.keyword, itxt: t });
      }
    } else if (type === 'zTXt') {
      const { keyword, rest } = keywordOf(c.data);
      let shown;
      try { shown = decodeLatin1(await inflate(rest.subarray(1))); } catch { shown = `compressed, ${size}`; }
      c.field = pf(`${keyword} (zTXt)`, shown);
    } else if (type === 'eXIf') {
      c.field = pf('EXIF (eXIf)', exifFields(doc, c.data, 'eXIf', null), { note: 'Deleting EXIF also removes orientation.' });
      if (doc.gpsField) doc.gpsField.chunk = c;
    } else if (type === 'caBX') {
      if (!doc.c2pa) doc.c2pa = { where: 'caBX chunk', jumbf: c.data, chunk: c };
      c.field = makeField({ cls: 'protected', kind: 'info', key: type, label: 'C2PA manifest (caBX)', display: size, deletable: false, c2pa: doc.c2pa.chunk === c });
    } else if (type === 'tIME') {
      const d = c.data;
      c.field = pf('Last modified (tIME)', `${u16be(d, 0)}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')} ${[d[4], d[5], d[6]].map((x) => String(x).padStart(2, '0')).join(':')} UTC`);
    } else if (type === 'pHYs') {
      const d = c.data;
      c.field = pf('Pixel density (pHYs)', d[8] === 1 ? `${Math.round(u32be(d, 0) * 0.0254)} × ${Math.round(u32be(d, 4) * 0.0254)} DPI` : `${u32be(d, 0)}:${u32be(d, 4)} aspect`);
    } else if (type === 'iCCP') {
      const { keyword, rest } = keywordOf(c.data);
      let desc = null;
      try { desc = iccDescription(await inflate(rest.subarray(1))); } catch { desc = null; }
      c.field = pf('ICC colour profile (iCCP)', `${desc || keyword} · ${size} · deleting changes how colours display`);
    } else if (COLOUR.has(type)) {
      c.field = pf(`Colour info (${type})`, `${size} · deleting changes how colours display`);
    } else {
      c.field = pf(type === 'iDOT' ? 'Apple decoding hint (iDOT)' : `Chunk ${type}`, size);
    }
    o = end;
    if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG: missing IHDR');
  if (idat) idat.first.field.display = `${idat.n} chunk${idat.n === 1 ? '' : 's'}, ${formatBytes(idat.bytes)}`;
  if (o < file.size) {
    doc.trailingStart = o;
    doc.trailingField = makeField({ cls: 'preserve', kind: 'info', key: 'trailing', label: 'Data after IEND', display: formatBytes(file.size - o) });
  }
  collectPng(doc);
  doc.technical.push(['Container', frames ? 'PNG (animated)' : 'PNG'], ['Dimensions', `${ihdr.width}×${ihdr.height}`],
    ['Colour', `${COLOR_TYPES[ihdr.color] || ihdr.color}, ${ihdr.bits}-bit`], ['Interlaced', ihdr.interlace ? 'Adam7' : 'no']);
  const kinds = [...new Set(doc.chunks.filter((c) => ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP', 'caBX'].includes(c.type)).map((c) => ({ eXIf: 'EXIF', iCCP: 'ICC', caBX: 'C2PA' }[c.type] || 'text')))];
  doc.technical.push(['Metadata', kinds.join(', ') || 'none']);
  doc.summary = `PNG · ${ihdr.width}×${ihdr.height}${kinds.length ? ' · ' + kinds.join(', ') : ''}`;
  return doc;
}

function collectPng(doc) {
  const out = [];
  if (doc.gpsField) out.push(doc.gpsField);
  for (const c of doc.chunks) if (c.field) out.push(c.field);
  out.push(...doc.newText);
  if (doc.trailingField) out.push(doc.trailingField);
  doc.fields = out;
}

function pngChunk(type, data) {
  const t = fourccBytes(type);
  return concat([u32beBytes(data.length), t, data, u32beBytes(crc32(t, data))]);
}

function textChunk(keyword, text, itxt) {
  if (!itxt && isLatin1(text)) return pngChunk('tEXt', concat([encodeLatin1(keyword), new Uint8Array([0]), encodeLatin1(text)]));
  const lang = itxt ? itxt.lang : '';
  const tkw = itxt ? itxt.tkw : '';
  return pngChunk('iTXt', concat([encodeLatin1(keyword), new Uint8Array([0, 0, 0]), encodeLatin1(lang), new Uint8Array([0]), encodeUtf8(tkw), new Uint8Array([0]), encodeUtf8(text)]));
}

function buildPng(doc, removeC2pa) {
  const parts = [Uint8Array.from(PNG_SIG)];
  const gpsOff = doc.gpsField && doc.gpsField.deleted;
  let inserted = false;
  for (const c of doc.chunks) {
    if (!inserted && c.type === 'IDAT') {
      for (const f of doc.newText) if (!f.deleted) parts.push(textChunk(f.keyword, f.value, null));
      inserted = true;
    }
    const f = c.field;
    if (removeC2pa && doc.c2pa && doc.c2pa.chunk === c) continue;
    if (f && f.deleted) continue;
    if (c.type === 'eXIf' && gpsOff && doc.gpsField.chunk === c) {
      const t = removeGps(c.data);
      parts.push(t ? pngChunk('eXIf', t) : doc.file.slice(c.start, c.end));
      continue;
    }
    if (f && f.cls === 'edit' && isChanged(f) && (c.type === 'tEXt' || c.type === 'iTXt')) {
      parts.push(textChunk(f.keyword, f.value, f.itxt || null));
      continue;
    }
    parts.push(doc.file.slice(c.start, c.end));
  }
  if (doc.trailingStart !== undefined && !(doc.trailingField && doc.trailingField.deleted)) parts.push(doc.file.slice(doc.trailingStart));
  return parts;
}

// ---- WebP (RIFF container, VP8X extended format) ----

const WEBP_FLAGS = { ICCP: 0x20, EXIF: 0x08, 'XMP ': 0x04 };

async function loadWebp(file) {
  const doc = { format: 'WebP', file, fields: [], technical: [], notes: [], sections: [], c2pa: null, readOnly: null, chunks: [], gpsField: null };
  const head = await readBytes(file, 0, 12);
  const riffEnd = Math.min(file.size, 8 + u32le(head, 4));
  let o = 12;
  let dims = null;
  let kind = 'lossy';
  while (o + 8 <= riffEnd) {
    const h = await readBytes(file, o, o + 8);
    const id = fourcc(h, 0);
    const size = u32le(h, 4);
    const end = o + 8 + size + (size & 1);
    if (o + 8 + size > file.size) throw new Error('WebP chunk exceeds file size');
    const c = { id, start: o, size, end: Math.min(end, file.size) };
    doc.chunks.push(c);
    const sz = formatBytes(size);
    if (id === 'VP8X') {
      const d = await readBytes(file, o + 8, o + 8 + 10);
      c.flags = d[0];
      dims = { w: 1 + (d[4] | (d[5] << 8) | (d[6] << 16)), h: 1 + (d[7] | (d[8] << 8) | (d[9] << 16)) };
      c.field = makeField({ cls: 'protected', kind: 'info', key: id, label: 'Extended header (VP8X)', display: `${dims.w}×${dims.h}`, deletable: false });
    } else if (id === 'EXIF') {
      let d = await readBytes(file, o + 8, o + 8 + size);
      c.tiffAt = startsWith(d, 'Exif\0\0') ? 6 : 0;
      c.data = d;
      d = d.subarray(c.tiffAt);
      c.field = makeField({ cls: 'preserve', kind: 'info', key: id, label: 'EXIF', display: exifFields(doc, d, 'EXIF chunk', null), chunk: c, note: null });
      if (doc.gpsField) doc.gpsField.chunk = c;
    } else if (id === 'XMP ') {
      c.field = xmpField(doc, decodeUtf8(await readBytes(file, o + 8, o + 8 + size)), 'XMP', { key: 'XMP', chunk: c });
    } else if (id === 'ICCP') {
      const d = await readBytes(file, o + 8, o + 8 + size);
      const desc = iccDescription(d);
      c.field = makeField({ cls: 'preserve', kind: 'info', key: id, label: 'ICC colour profile', display: `${desc ? desc + ' · ' : ''}${sz} · deleting changes how colours display`, chunk: c });
    } else if (id === 'VP8 ' || id === 'VP8L') {
      kind = id === 'VP8L' ? 'lossless' : 'lossy';
      if (!dims) {
        const d = await readBytes(file, o + 8, o + 8 + 10);
        dims = id === 'VP8L'
          ? { w: 1 + (((d[2] << 8) | d[1]) & 0x3fff), h: 1 + ((((d[4] << 16) | (d[3] << 8) | d[2]) >> 6) & 0x3fff) }
          : { w: (d[6] | (d[7] << 8)) & 0x3fff, h: (d[8] | (d[9] << 8)) & 0x3fff };
      }
      c.field = makeField({ cls: 'protected', kind: 'info', key: id, label: `Image data (${id.trim()}, ${kind})`, display: sz, deletable: false });
    } else if (id === 'ANIM' || id === 'ANMF' || id === 'ALPH') {
      if (id !== 'ANMF' || !doc.chunks.some((x) => x.id === 'ANMF' && x !== c)) c.field = makeField({ cls: 'protected', kind: 'info', key: id, label: { ANIM: 'Animation (ANIM)', ANMF: 'Animation frames (ANMF)', ALPH: 'Alpha (ALPH)' }[id], display: sz, deletable: false });
    } else {
      c.field = makeField({ cls: 'preserve', kind: 'info', key: id, label: `Chunk '${id}'`, display: sz, chunk: c });
    }
    o = end;
  }
  if (o < file.size) {
    doc.trailingStart = o;
    doc.trailingField = makeField({ cls: 'preserve', kind: 'info', key: 'trailing', label: 'Data after RIFF chunk', display: formatBytes(file.size - o) });
  }
  doc.fields = [...(doc.gpsField ? [doc.gpsField] : []), ...doc.chunks.filter((c) => c.field).map((c) => c.field), ...(doc.trailingField ? [doc.trailingField] : [])];
  const kinds = ['EXIF', 'XMP ', 'ICCP'].filter((k) => doc.chunks.some((c) => c.id === k)).map((k) => (k === 'ICCP' ? 'ICC' : k.trim()));
  doc.technical.push(['Container', 'WebP'], ['Dimensions', dims ? `${dims.w}×${dims.h}` : 'unknown'], ['Coding', kind + (doc.chunks.some((c) => c.id === 'ANIM') ? ', animated' : '')], ['Metadata', kinds.join(', ') || 'none']);
  doc.summary = `WebP${dims ? ` · ${dims.w}×${dims.h}` : ''}${kinds.length ? ' · ' + kinds.join(', ') : ''}`;
  return doc;
}

function buildWebp(doc) {
  const body = [];
  const gpsOff = doc.gpsField && doc.gpsField.deleted;
  const gone = new Set(doc.chunks.filter((c) => c.field && c.field.deleted).map((c) => c.id));
  for (const c of doc.chunks) {
    if (c.field && c.field.deleted) continue;
    if (c.id === 'VP8X') {
      let flags = c.flags;
      for (const [id, bit] of Object.entries(WEBP_FLAGS)) if (gone.has(id) && !doc.chunks.some((x) => x.id === id && !(x.field && x.field.deleted))) flags &= ~bit;
      if (flags !== c.flags) {
        body.push(concat([fourccBytes('VP8X'), u32leBytes(c.size), new Uint8Array([flags])]), doc.file.slice(c.start + 9, c.end));
        continue;
      }
    }
    if (c.id === 'EXIF' && gpsOff && doc.gpsField.chunk === c) {
      const t = removeGps(c.data.subarray(c.tiffAt));
      if (t) {
        body.push(concat([fourccBytes('EXIF'), u32leBytes(c.size), c.data.subarray(0, c.tiffAt), t, c.size & 1 ? new Uint8Array(1) : new Uint8Array(0)]));
        continue;
      }
    }
    body.push(doc.file.slice(c.start, c.end));
  }
  let size = 4;
  for (const p of body) size += p.byteLength !== undefined ? p.byteLength : p.size;
  const parts = [concat([fourccBytes('RIFF'), u32leBytes(size), fourccBytes('WEBP')]), ...body];
  if (doc.trailingStart !== undefined && !(doc.trailingField && doc.trailingField.deleted)) parts.push(doc.file.slice(doc.trailingStart));
  return parts;
}

// ---- module interface ----

export function addable(doc) {
  if (doc.format === 'WebP') return [];
  if (doc.format === 'JPEG') {
    const has = doc.fields.some((f) => f.key === 'COM' && !f.deleted) || doc.newComments.some((f) => !f.deleted);
    return has ? [] : [{ key: 'COM', label: 'Comment (COM)' }];
  }
  const live = doc.fields.filter((f) => !f.deleted && (f.key === 'tEXt' || f.key === 'iTXt'));
  return PNG_TEXT_KEYS.filter((k) => !live.some((f) => f.keyword === k)).map((k) => ({ key: k, label: `${k} (text chunk)` }));
}

export function addField(doc, key) {
  if (doc.format === 'JPEG') {
    const f = makeField({ key: 'COM', label: 'Comment (COM)', kind: 'multiline', value: '', isNew: true, validate: comValidate });
    doc.newComments.push(f);
    doc.fields.splice(doc.fields.findIndex((x) => x.key === 'tables' || x.key === 'scan'), 0, f);
    return f;
  }
  const f = makeField({ key: 'tEXt', label: key, keyword: key, kind: key === 'Description' || key === 'Comment' ? 'multiline' : 'text', value: '', isNew: true });
  doc.newText.push(f);
  collectPng(doc);
  return f;
}

export function removeNewField(doc, f) {
  if (doc.format === 'JPEG') {
    doc.newComments.splice(doc.newComments.indexOf(f), 1);
    doc.fields.splice(doc.fields.indexOf(f), 1);
    return;
  }
  doc.newText.splice(doc.newText.indexOf(f), 1);
  collectPng(doc);
}

export async function build(doc, opts = {}) {
  const removeC2pa = !!opts.removeC2pa;
  if (doc.format === 'WebP') return buildWebp(doc);
  return doc.format === 'JPEG' ? buildJpeg(doc, removeC2pa) : buildPng(doc, removeC2pa);
}

export function provenance(doc) {
  const out = [];
  for (const f of doc.fields) {
    if (f.deleted || f.cls !== 'edit' || typeof f.value !== 'string') continue;
    if (f.key === 'COM' || (f.keyword && /comment|description/i.test(f.keyword))) out.push({ text: f.value, where: f.key === 'COM' ? 'JPEG COM' : `PNG ${f.keyword}` });
  }
  return out;
}
