// Format-agnostic document operations: open, change tracking, save.

import { readBytes, fourcc } from './bytes.js';
import { isChanged, fieldError, revertField } from './fields.js';
import { parseSuno } from './text.js';
import { parseManifestStore, summarize, hashBinding, checkDataHash } from './c2pa.js';
import * as mp3 from './mp3.js';
import * as riff from './riff.js';
import * as bmff from './bmff.js';

const MIME = { MP3: 'audio/mpeg', WAV: 'audio/wav', M4A: 'audio/mp4', MP4: 'video/mp4' };

function unsupported(head) {
  if (head.length >= 4) {
    const t = fourcc(head, 0);
    if (t === 'fLaC') return 'FLAC';
    if (t === 'OggS') return 'Ogg';
    if (t === 'FORM' && head.length >= 12 && /^AIF[FC]$/.test(fourcc(head, 8))) return 'AIFF';
  }
  return null;
}

export async function openFile(file) {
  const head = await readBytes(file, 0, 16);
  const other = unsupported(head);
  if (other) throw new Error(`${other} files are not supported.`);
  let mod;
  if (riff.detect(head)) mod = riff;
  else if (bmff.detect(head)) mod = bmff;
  else if (await mp3.detect(head)) mod = mp3;
  else throw new Error('Unrecognized file: not MP3, WAV, M4A or MP4 (detected by content, not extension).');
  const doc = await mod.load(file);
  if (mod === mp3 && doc.tagEnd) {
    const after = await readBytes(file, doc.tagEnd, doc.tagEnd + 4);
    if (unsupported(after)) throw new Error(`${unsupported(after)} files are not supported.`);
  }
  doc.mod = mod;
  if (doc.c2pa) {
    doc.c2pa.choice = null;
    try {
      const store = parseManifestStore(doc.c2pa.jumbf);
      doc.c2pa.store = store;
      doc.c2pa.summary = summarize(store);
      doc.c2pa.binding = hashBinding(store);
    } catch (err) {
      doc.c2pa.error = err.message;
      doc.c2pa.binding = { kind: 'none' };
    }
  }
  return doc;
}

export function fieldsChanged(doc) {
  return doc.fields.some(isChanged);
}

export function changeCount(doc) {
  return doc.fields.filter(isChanged).length + (doc.c2pa && doc.c2pa.choice === 'remove' ? 1 : 0);
}

export function isDirty(doc) {
  return changeCount(doc) > 0;
}

export function needsC2paChoice(doc) {
  return !!doc.c2pa && fieldsChanged(doc) && !doc.c2pa.choice;
}

export function errors(doc) {
  const out = [];
  for (const f of doc.fields) {
    const e = fieldError(f);
    if (e) out.push({ field: f, error: e });
  }
  return out;
}

export function addable(doc) {
  if (doc.readOnly) return [];
  return doc.mod.addable(doc);
}

export function addField(doc, key) {
  return doc.mod.addField(doc, key);
}

export function revert(doc, f) {
  if (f.isNew) doc.mod.removeNewField(doc, f);
  else revertField(f);
}

export function revertAll(doc) {
  for (const f of [...doc.fields]) if (isChanged(f) || f.isNew) revert(doc, f);
  if (doc.c2pa) doc.c2pa.choice = null;
}

// Build the output file. With no pending change the original file is returned unchanged.
export async function buildOutput(doc) {
  if (doc.readOnly) throw new Error(doc.readOnly);
  const errs = errors(doc);
  if (errs.length) throw new Error(`${errs[0].field.label}: ${errs[0].error}`);
  if (needsC2paChoice(doc)) throw new Error('Choose whether to remove or keep the C2PA manifest.');
  const type = doc.file.type || MIME[doc.format] || 'application/octet-stream';
  if (!isDirty(doc)) return new Blob([doc.file], { type });
  const parts = await doc.mod.build(doc, { removeC2pa: !!doc.c2pa && doc.c2pa.choice === 'remove' });
  const blob = new Blob(parts, { type });
  if (doc.mod === bmff) {
    const bad = await bmff.verifyPayload(doc.file, blob, doc.lastVerify);
    if (bad) throw new Error(`Chunk offset verification failed (${bad} mismatches); nothing saved.`);
  }
  return blob;
}

export function provenance(doc) {
  const out = [];
  for (const p of doc.mod.provenance(doc)) {
    const s = parseSuno(p.text);
    if (s) out.push({ where: p.where, ...s });
  }
  return out;
}

export async function checkC2paHash(doc) {
  const b = doc.c2pa && doc.c2pa.binding;
  if (!b || b.kind === 'none') return { result: 'none', message: 'No hard-binding hash assertion found' };
  if (b.kind === 'other') return { result: 'not-checked', message: `Not checked (${b.label})` };
  return checkDataHash(doc.file, b.assertion, b.claimAlg);
}

export { isChanged };
