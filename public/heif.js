// HEIF / HEIC / AVIF (ISO/IEC 23008-12): view EXIF and XMP items; remove GPS in place.
// Items are addressed by absolute file offsets (iloc), so nothing may change length: the only write is a
// same-length rewrite of the EXIF item.

import { readBytes, u16be, u32be, u64be, fourcc, formatBytes } from './bytes.js';
import { decodeUtf8 } from './text.js';
import { makeField } from './fields.js';
import { parseTiff, exifRows, gpsSummary, removeGps } from './tiff.js';
import { xmpInfo } from './image.js';
import { C2PA_BMFF_UUID, jumbfFromBmffUuidPayload } from './c2pa.js';

export const BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

export function detect(head) {
  return head.length >= 12 && fourcc(head, 4) === 'ftyp' && BRANDS.has(fourcc(head, 8));
}

function boxes(b, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32be(b, o);
    let hdr = 8;
    if (size === 1) { size = u64be(b, o + 8); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) throw new Error(`HEIF: invalid box size at ${o}`);
    out.push({ type: fourcc(b, o + 4), start: o, hdr, end: o + size });
    o += size;
  }
  return out;
}

function sizedInt(b, o, n) {
  if (n === 0) return 0;
  if (n === 4) return u32be(b, o);
  if (n === 8) return u64be(b, o);
  throw new Error('HEIF: unsupported iloc field size');
}

function parseIloc(b, box) {
  let o = box.start + box.hdr;
  const v = b[o];
  o += 4;
  const offSize = b[o] >> 4;
  const lenSize = b[o] & 15;
  const baseSize = b[o + 1] >> 4;
  const idxSize = v >= 1 ? b[o + 1] & 15 : 0;
  o += 2;
  const count = v < 2 ? u16be(b, o) : u32be(b, o);
  o += v < 2 ? 2 : 4;
  const items = new Map();
  for (let i = 0; i < count; i++) {
    const id = v < 2 ? u16be(b, o) : u32be(b, o);
    o += v < 2 ? 2 : 4;
    let method = 0;
    if (v >= 1) { method = u16be(b, o) & 15; o += 2; }
    o += 2; // data_reference_index
    const base = sizedInt(b, o, baseSize);
    o += baseSize;
    const n = u16be(b, o);
    o += 2;
    const extents = [];
    for (let k = 0; k < n; k++) {
      o += idxSize;
      const off = sizedInt(b, o, offSize);
      o += offSize;
      const len = sizedInt(b, o, lenSize);
      o += lenSize;
      extents.push({ offset: base + off, length: len });
    }
    items.set(id, { method, extents });
  }
  return items;
}

function parseIinf(b, box) {
  let o = box.start + box.hdr;
  const v = b[o];
  o += 4;
  o += v === 0 ? 2 : 4;
  const out = [];
  for (const e of boxes(b, o, box.end)) {
    if (e.type !== 'infe') continue;
    const p = e.start + e.hdr;
    const ev = b[p];
    if (ev < 2) continue;
    let q = p + 4;
    const id = ev === 2 ? u16be(b, q) : u32be(b, q);
    q += (ev === 2 ? 2 : 4) + 2;
    const type = fourcc(b, q);
    q += 4;
    let z = q;
    while (z < e.end && b[z]) z++;
    const name = decodeUtf8(b.subarray(q, z));
    let contentType = '';
    if (type === 'mime') {
      let y = z + 1;
      while (y < e.end && b[y]) y++;
      contentType = decodeUtf8(b.subarray(z + 1, y));
    }
    out.push({ id, type, name, contentType });
  }
  return out;
}

export async function load(file) {
  const doc = { format: 'HEIF', file, fields: [], technical: [], notes: [], sections: [], c2pa: null, readOnly: null, exif: null, gpsField: null };
  const top = [];
  let o = 0;
  let brand = '';
  let metaBuf = null;
  while (o + 8 <= file.size) {
    const h = await readBytes(file, o, o + 16);
    let size = u32be(h, 0);
    const type = fourcc(h, 4);
    if (size === 1) size = u64be(h, 8); else if (size === 0) size = file.size - o;
    if (size < 8 || o + size > file.size) throw new Error(`HEIF: box '${type}' at ${o} has an invalid size`);
    const box = { type, start: o, size };
    top.push(box);
    if (type === 'ftyp') {
      const b = await readBytes(file, o, o + Math.min(size, 64));
      brand = fourcc(b, 8);
    } else if (type === 'meta') {
      metaBuf = await readBytes(file, o, o + size);
    } else if (type === 'uuid') {
      const b = await readBytes(file, o + 8, o + 24);
      const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      if (`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` === C2PA_BMFF_UUID) {
        const { jumbf } = jumbfFromBmffUuidPayload(await readBytes(file, o + 24, o + size));
        if (jumbf && !doc.c2pa) doc.c2pa = { where: 'uuid box', jumbf };
      }
    }
    o += size;
  }
  if (!metaBuf) throw new Error('HEIF: no meta box');
  doc.format = /^avi/.test(brand) ? 'AVIF' : 'HEIC';
  const meta = { start: 0, hdr: 12, end: metaBuf.length };
  const kids = boxes(metaBuf, meta.hdr, meta.end);
  const iloc = kids.find((k) => k.type === 'iloc');
  const iinf = kids.find((k) => k.type === 'iinf');
  const items = iinf ? parseIinf(metaBuf, iinf) : [];
  const locs = iloc ? parseIloc(metaBuf, iloc) : new Map();
  let width = 0;
  let height = 0;
  const iprp = kids.find((k) => k.type === 'iprp');
  if (iprp) {
    const ipco = boxes(metaBuf, iprp.start + iprp.hdr, iprp.end).find((k) => k.type === 'ipco');
    if (ipco) {
      for (const p of boxes(metaBuf, ipco.start + ipco.hdr, ipco.end)) {
        if (p.type !== 'ispe') continue;
        const w = u32be(metaBuf, p.start + p.hdr + 4);
        const hh = u32be(metaBuf, p.start + p.hdr + 8);
        if (w * hh > width * height) { width = w; height = hh; }
      }
    }
  }
  const fields = [];
  const readItem = async (it) => {
    const loc = locs.get(it.id);
    if (!loc || loc.method !== 0 || loc.extents.length !== 1) return null;
    const { offset, length } = loc.extents[0];
    if (offset + length > file.size) return null;
    return { offset, length, data: await readBytes(file, offset, offset + length) };
  };
  for (const it of items) {
    if (it.type === 'Exif') {
      const r = await readItem(it);
      if (!r) { fields.push(makeField({ cls: 'preserve', kind: 'info', key: 'Exif', label: 'EXIF', display: 'stored in pieces; not readable here', deletable: false })); continue; }
      const tiffAt = 4 + u32be(r.data, 0);
      let t;
      try { t = parseTiff(r.data.subarray(tiffAt)); } catch (err) { doc.notes.push('EXIF: ' + err.message); continue; }
      const rows = exifRows(t);
      doc.sections.push({ title: 'EXIF', rows: rows.length ? rows : [['', 'No common fields']] });
      doc.exif = { offset: r.offset + tiffAt, tiff: r.data.subarray(tiffAt) };
      const gps = gpsSummary(t);
      if (gps) {
        doc.gpsField = makeField({ cls: 'edit', kind: 'readonly', key: 'GPS', label: 'Location (GPS)', value: '', display: gps, deleteLabel: 'Remove location',
          note: 'Removing clears only the GPS data, in place; the rest of the EXIF stays.' });
      }
      const cam = rows.find((x) => x[0] === 'Camera');
      const date = rows.find((x) => x[0] === 'Date taken');
      fields.push(makeField({ cls: 'preserve', kind: 'info', key: 'Exif', label: 'EXIF', deletable: false,
        display: [cam && cam[1], date && date[1], gps && 'GPS', formatBytes(r.length)].filter(Boolean).join(' · ') }));
    } else if (it.type === 'mime' && /xmp|rdf\+xml/i.test(it.contentType)) {
      const r = await readItem(it);
      if (!r) continue;
      const x = xmpInfo(decodeUtf8(r.data));
      doc.sections.push({ title: 'XMP', rows: x.rows.length ? x.rows : [['', 'No simple properties']] });
      if (x.hasGps) doc.notes.push('XMP also records a location, which this app cannot remove from HEIF files.');
      fields.push(makeField({ cls: 'preserve', kind: 'info', key: 'XMP', label: 'XMP', deletable: false, display: `${x.rows.length} properties · ${formatBytes(r.length)}` }));
    }
  }
  const counts = {};
  for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;
  fields.push(makeField({ cls: 'protected', kind: 'info', key: 'items', label: 'Image items', deletable: false, display: Object.entries(counts).map(([k, n]) => `${n} ${k.trim()}`).join(', ') || 'none' }));
  for (const b of top) {
    if (b.type === 'meta') continue;
    fields.push(makeField({ cls: 'protected', kind: 'info', key: b.type, label: b.type === 'mdat' ? 'Media data (mdat)' : b.type === 'ftyp' ? `File type (${brand})` : `Box '${b.type}'`, deletable: false, display: formatBytes(b.size) }));
  }
  doc.fields = doc.gpsField ? [doc.gpsField, ...fields] : fields;
  if (doc.c2pa) {
    doc.notes.push('This file has a C2PA manifest. Removing it would move image data, so only "keep" is possible.');
    doc.c2pa.noRemove = true;
  }
  doc.notes.push(`${doc.format} files are view-only except for removing the EXIF location.`);
  doc.technical.push(['Container', `${doc.format} (brand ${brand.trim()})`]);
  if (width) doc.technical.push(['Dimensions', `${width}×${height}`]);
  doc.technical.push(['Metadata', [doc.exif && 'EXIF', doc.sections.some((s) => s.title === 'XMP') && 'XMP', doc.c2pa && 'C2PA'].filter(Boolean).join(', ') || 'none']);
  doc.summary = `${doc.format}${width ? ` · ${width}×${height}` : ''}${doc.exif ? ' · EXIF' : ''}`;
  return doc;
}

export function addable() { return []; }
export function addField() { throw new Error('Fields cannot be added to HEIF files'); }
export function removeNewField() {}

export async function build(doc, opts = {}) {
  if (opts.removeC2pa) throw new Error('The C2PA manifest cannot be removed from HEIF files here.');
  if (!(doc.gpsField && doc.gpsField.deleted)) return [doc.file];
  const t = removeGps(doc.exif.tiff);
  if (!t) return [doc.file];
  return [doc.file.slice(0, doc.exif.offset), t, doc.file.slice(doc.exif.offset + t.length)];
}

export function provenance() { return []; }
