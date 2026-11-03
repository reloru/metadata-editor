// "Photo info": caption, keywords and date taken, each kept in more than one place (EXIF and XMP).
// Editing one of these fields writes every copy at save time; the per-block fields are left as the user set
// them, and copies are computed on clones so reverting a Photo info field undoes everything.

import { makeField, isChanged } from './fields.js';
import { newExifField } from './exifedit.js';
import { newXmpField } from './xmpedit.js';

const P_DESC = 0x010e;
const P_TAKEN = 0x9003;
const P_DIGITIZED = 0x9004;
const P_OFFSET = 0x9011;
const P_OFFSET_D = 0x9012;

function find(fields, pred) { return fields ? fields.find((f) => !f.isNew && pred(f)) : null; }
const exifF = (doc, tag) => doc.exifEdit && find(doc.exifEdit.fields, (f) => f.exifTag && f.exifTag.tag === tag);
const xmpF = (doc, name) => doc.xmpEdit && find(doc.xmpEdit.fields, (f) => f.xmpProp === name);

function validateDate(v) {
  if (v === '') return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( [+-]\d{2}:\d{2})?$/.test(v) ? null : 'Use YYYY-MM-DD HH:MM:SS, optionally followed by +HH:MM';
}

// Builds the Photo info fields (none when the file has nowhere editable to write them).
export function photoInfoFields(doc) {
  const exifOk = doc.exifEdit && !doc.exifEdit.readOnly;
  const xmpOk = doc.xmpEdit && !doc.xmpEdit.readOnly;
  if (!exifOk && !xmpOk) return [];
  const out = [];
  const val = (f) => (f && !f.kind.startsWith('read') ? f.value : '');
  const caption = val(xmpF(doc, 'dc:description')) || val(exifF(doc, P_DESC));
  out.push(makeField({ group: 'Photo info', key: 'caption', label: 'Caption', kind: 'multiline', value: caption, sync: 'caption',
    note: `Saved to ${[exifOk && 'EXIF', xmpOk && 'XMP'].filter(Boolean).join(' and ')}.` }));
  if (xmpOk) {
    out.push(makeField({ group: 'Photo info', key: 'keywords', label: 'Keywords', kind: 'multiline', value: val(xmpF(doc, 'dc:subject')), sync: 'keywords', note: 'One per line. Saved to XMP.' }));
  }
  let date = '';
  const t = exifF(doc, P_TAKEN);
  if (t && val(t)) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/.exec(t.value);
    const o = exifF(doc, P_OFFSET);
    if (m) date = `${m[1]}-${m[2]}-${m[3]} ${m[4]}${o && val(o) ? ' ' + o.value : ''}`;
  } else {
    const x = xmpF(doc, 'photoshop:DateCreated');
    const m = x && /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{2}:\d{2})?/.exec(val(x));
    if (m) date = `${m[1]} ${m[2]}${m[3] ? ' ' + m[3] : ''}`;
  }
  const real = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  const bad = real && (+real[1] < 1 || +real[2] < 1 || +real[2] > 12 || +real[3] < 1 || +real[3] > new Date(Date.UTC(+real[1], +real[2], 0)).getUTCDate());
  out.push(makeField({ group: 'Photo info', key: 'taken', label: 'Date taken', kind: 'text', value: date, sync: 'taken', validate: validateDate,
    placeholder: 'YYYY-MM-DD HH:MM:SS +HH:MM',
    note: `Saved to every date-taken copy (EXIF original and digitized, XMP).${bad ? ' This is not a real calendar date, so Photos ignores it and shows another date instead.' : ''}` }));
  return out;
}

function clone(f) { return Object.assign(Object.create(Object.getPrototypeOf(f)), f); }

// Field lists with Photo info edits applied, for the writers.
export function effectiveFields(doc) {
  const exif = doc.exifEdit ? doc.exifEdit.fields.map(clone) : null;
  const xmp = doc.xmpEdit ? doc.xmpEdit.fields.map(clone) : null;
  const synced = (doc.photoInfo || []).filter(isChanged);
  if (!synced.length) return { exif, xmp };
  const exifOk = exif && !doc.exifEdit.readOnly;
  const xmpOk = xmp && !doc.xmpEdit.readOnly;
  const setExif = (tag, v) => {
    if (!exifOk) return;
    let f = exif.find((x) => x.exifTag && x.exifTag.tag === tag && !x.deleted);
    if (!f) {
      if (v === null) return;
      f = newExifField(`EXIFTAG:${tag >= 0x9000 ? 'exif' : 'ifd0'}:${tag}`, 'EXIF');
      exif.push(f);
    }
    if (v === null) f.deleted = true; else f.value = v;
  };
  const setXmp = (name, v) => {
    if (!xmpOk) return;
    let f = xmp.find((x) => x.xmpProp === name && !x.deleted);
    if (!f) {
      if (v === null) return;
      f = newXmpField(`XMPPROP:${name}`);
      xmp.push(f);
    }
    if (v === null) f.deleted = true; else f.value = v;
  };
  for (const s of synced) {
    const v = s.deleted || s.value === '' ? null : s.value;
    if (s.sync === 'caption') { setExif(P_DESC, v); setXmp('dc:description', v); }
    if (s.sync === 'keywords') setXmp('dc:subject', v);
    if (s.sync === 'taken') {
      const m = v && /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})(?: ([+-]\d{2}:\d{2}))?$/.exec(v);
      const exifDate = m ? `${m[1]}:${m[2]}:${m[3]} ${m[4]}` : null;
      setExif(P_TAKEN, exifDate);
      if (exif && exif.some((x) => x.exifTag && x.exifTag.tag === P_DIGITIZED && !x.deleted)) setExif(P_DIGITIZED, exifDate);
      if (m && m[5]) {
        setExif(P_OFFSET, m[5]);
        if (exif && exif.some((x) => x.exifTag && x.exifTag.tag === P_OFFSET_D && !x.deleted)) setExif(P_OFFSET_D, m[5]);
      } else if (!m) setExif(P_OFFSET, null);
      const iso = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}${m[5] || ''}` : null;
      setXmp('photoshop:DateCreated', iso);
      if (xmp && xmp.some((x) => x.xmpProp === 'xmp:CreateDate' && !x.deleted)) setXmp('xmp:CreateDate', iso);
    }
  }
  return { exif, xmp };
}
