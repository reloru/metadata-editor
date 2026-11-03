// TIFF and DNG files (TIFF 6.0, Adobe DNG 1.7): view EXIF/XMP, remove GPS in place.
// Only the start of the file is read; tags are addressed by absolute offsets, so the only write is a
// same-length rewrite of that region, and only when the whole GPS IFD lies inside it.

import { readBytes, formatBytes } from './bytes.js';
import { decodeUtf8 } from './text.js';
import { makeField } from './fields.js';
import { parseTiff, exifRows, gpsSummary, removeGps, gpsWithin, gpsTimeNote, STRIPPED_NOTE, NO_EXIF_NOTE } from './tiff.js';
import { xmpInfo } from './image.js';

const HEAD = 4 * 1048576;

export function detect(head) {
  if (head.length < 4) return false;
  return (head[0] === 0x49 && head[1] === 0x49 && head[2] === 42 && head[3] === 0) || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 42);
}

export async function load(file) {
  const head = await readBytes(file, 0, Math.min(file.size, HEAD));
  let t;
  try { t = parseTiff(head); } catch (err) { throw new Error(`TIFF: ${err.message}`); }
  if (!t.ifd0) throw new Error('TIFF: first directory not readable');
  const dng = t.ifd0.entries.get(0xc612);
  const doc = { format: dng ? 'DNG' : 'TIFF', file, head, fields: [], technical: [], notes: [], sections: [], c2pa: null, readOnly: null, gpsField: null };
  const rows = exifRows(t);
  if (rows.length) doc.sections.push({ title: 'EXIF', rows });
  const gps = gpsSummary(t);
  const ptr = t.ifd0.entries.get(0x8825);
  if (gps && gpsWithin(t, head)) {
    doc.gpsField = makeField({ cls: 'edit', kind: 'readonly', key: 'GPS', label: 'Location (GPS)', value: '', display: gps, deleteLabel: 'Remove location',
      note: 'Removing clears only the GPS data, in place; the rest of the metadata stays.' });
  } else if (ptr) {
    doc.notes.push(gps ? `Location: ${gps}. It is stored beyond the part of the file this app reads, so it cannot be removed here.` : 'This file points to GPS data that could not be read.');
  }
  const tn = gpsTimeNote(t);
  if (tn) doc.notes.push(tn);
  const cam = rows.find((r) => r[0] === 'Camera');
  const date = rows.find((r) => r[0] === 'Date taken');
  if (!t.exif && !ptr) doc.notes.push(NO_EXIF_NOTE);
  else if (!cam && !date && !gps) doc.notes.push(STRIPPED_NOTE);
  const fields = [];
  if (doc.gpsField) fields.push(doc.gpsField);
  fields.push(makeField({ cls: 'protected', kind: 'info', key: 'EXIF', label: 'EXIF (TIFF tags)', deletable: false,
    display: [cam && cam[1], date && date[1], gps ? 'GPS' : null].filter(Boolean).join(' · ') || 'basic tags only' }));
  const xe = t.ifd0.entries.get(0x02bc);
  if (xe && xe.at + xe.size <= head.length) {
    const x = xmpInfo(decodeUtf8(head.subarray(xe.at, xe.at + xe.size)));
    doc.sections.push({ title: 'XMP', rows: x.rows.length ? x.rows : [['', 'No simple properties']] });
    if (x.hasGps) doc.notes.push('XMP also records a location, which this app cannot remove from TIFF/DNG files.');
    fields.push(makeField({ cls: 'protected', kind: 'info', key: 'XMP', label: 'XMP', deletable: false, display: `${x.rows.length} properties · ${formatBytes(xe.size)}` }));
  }
  fields.push(makeField({ cls: 'protected', kind: 'info', key: 'data', label: dng ? 'Raw image data and previews' : 'Image data', deletable: false, display: formatBytes(file.size) }));
  doc.fields = fields;
  doc.notes.push(`${doc.format} files are view-only except for removing the EXIF location.`);
  const w = t.ifd0.entries.get(0x100);
  const h = t.ifd0.entries.get(0x101);
  doc.technical.push(['Container', `${doc.format} (${t.le ? 'little' : 'big'}-endian)`]);
  if (dng && Array.isArray(dng.value)) doc.technical.push(['DNG version', dng.value.slice(0, 4).join('.')]);
  if (w && h && Array.isArray(w.value) && Array.isArray(h.value)) doc.technical.push([dng ? 'First image (often a preview)' : 'Dimensions', `${w.value[0]}×${h.value[0]}`]);
  doc.technical.push(['Metadata', [t.exif && 'EXIF', ptr && 'GPS', xe && 'XMP'].filter(Boolean).join(', ') || 'none']);
  doc.summary = `${doc.format}${cam ? ' · ' + cam[1] : ''}`;
  return doc;
}

export function addable() { return []; }
export function addField() { throw new Error('Fields cannot be added to TIFF/DNG files'); }
export function removeNewField() {}

export async function build(doc) {
  if (!(doc.gpsField && doc.gpsField.deleted)) return [doc.file];
  const head = removeGps(doc.head);
  if (!head) return [doc.file];
  return [head, doc.file.slice(head.length)];
}

export function provenance() { return []; }
