// TIFF and DNG files (TIFF 6.0, Adobe DNG 1.7): view EXIF/XMP, remove GPS in place.
// Only the start of the file is read; tags are addressed by absolute offsets, so the only write is a
// same-length rewrite of that region, and only when the whole GPS IFD lies inside it.

import { readBytes, formatBytes } from './bytes.js';
import { decodeUtf8 } from './text.js';
import { makeField } from './fields.js';
import { parseTiff, exifRows, gpsSummary, removeGps, gpsWithin, gpsTimeNote, STRIPPED_NOTE, NO_EXIF_NOTE } from './tiff.js';
import { xmpInfo } from './image.js';
import { exifTagFields, exifAddable, newExifField, exifChanged, writeExifParts } from './exifedit.js';

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
  try { doc.exifEdit = { fields: exifTagFields(head, 'EXIF', { imageFile: true }) }; } catch { doc.exifEdit = null; }
  const fields = [];
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
  doc.otherFields = fields;
  collect(doc);
  doc.notes.push(`${doc.format}: EXIF and descriptive tags can be edited; image tags and data are never touched.`);
  const w = t.ifd0.entries.get(0x100);
  const h = t.ifd0.entries.get(0x101);
  doc.technical.push(['Container', `${doc.format} (${t.le ? 'little' : 'big'}-endian)`]);
  if (dng && Array.isArray(dng.value)) doc.technical.push(['DNG version', dng.value.slice(0, 4).join('.')]);
  if (w && h && Array.isArray(w.value) && Array.isArray(h.value)) doc.technical.push([dng ? 'First image (often a preview)' : 'Dimensions', `${w.value[0]}×${h.value[0]}`]);
  doc.technical.push(['Metadata', [t.exif && 'EXIF', ptr && 'GPS', xe && 'XMP'].filter(Boolean).join(', ') || 'none']);
  doc.summary = `${doc.format}${cam ? ' · ' + cam[1] : ''}`;
  return doc;
}

function collect(doc) {
  doc.fields = [...(doc.gpsField ? [doc.gpsField] : []), ...(doc.exifEdit ? doc.exifEdit.fields : []), ...doc.otherFields];
}
export function addable(doc) { return doc.exifEdit ? exifAddable(doc.exifEdit.fields) : []; }
export function addField(doc, key) {
  const f = newExifField(key, 'EXIF');
  doc.exifEdit.fields.push(f);
  collect(doc);
  return f;
}
export function removeNewField(doc, f) {
  doc.exifEdit.fields.splice(doc.exifEdit.fields.indexOf(f), 1);
  collect(doc);
}

export async function build(doc) {
  if (doc.exifEdit && exifChanged(doc.exifEdit.fields, null)) {
    // New IFDs and values are appended at the end of the file (TIFF offsets are file offsets).
    const { head, tail } = writeExifParts(doc.head, doc.exifEdit.fields, { dropGps: !!(doc.gpsField && doc.gpsField.deleted), appendAt: doc.file.size });
    return [head, doc.file.slice(head.length), tail];
  }
  if (!(doc.gpsField && doc.gpsField.deleted)) return [doc.file];
  const head = removeGps(doc.head);
  if (!head) return [doc.file];
  return [head, doc.file.slice(head.length)];
}

export function provenance() { return []; }
