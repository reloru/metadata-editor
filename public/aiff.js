// AIFF / AIFF-C (Apple AIFF 1.3, AIFF-C draft 1991): big-endian chunks, text chunks, ID3 chunk.

import { readBytes, u16be, u32be, fourcc, fourccBytes, concat, u32beBytes, formatBytes, formatDuration } from './bytes.js';
import { decodeLatin1, encodeLatin1, isLatin1 } from './text.js';
import { makeField, isChanged } from './fields.js';
import * as id3 from './id3.js';

export const TEXT_CHUNKS = { NAME: 'Title (NAME)', AUTH: 'Author (AUTH)', '(c) ': 'Copyright ((c) )', ANNO: 'Annotation (ANNO)' };

export function detect(head) {
  return head.length >= 12 && fourcc(head, 0) === 'FORM' && /^AIF[FC]$/.test(fourcc(head, 8));
}

// 80-bit IEEE 754 extended (big-endian) -> number.
export function extended(b, o) {
  const exp = ((b[o] & 0x7f) << 8) | b[o + 1];
  const hi = u32be(b, o + 2);
  const lo = u32be(b, o + 6);
  if (!exp && !hi && !lo) return 0;
  const v = (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
  return b[o] & 0x80 ? -v : v;
}

function latin1Only(v) {
  return isLatin1(v) ? null : 'AIFF text chunks hold ISO-8859-1 only; use an ID3 field for other characters';
}

function textField(id, value, chunk) {
  return makeField({ key: id, label: TEXT_CHUNKS[id], kind: id === 'ANNO' ? 'multiline' : 'text', value, validate: latin1Only, chunk });
}

export async function load(file) {
  const head = await readBytes(file, 0, 12);
  const form = fourcc(head, 8);
  const formEnd = Math.min(file.size, 8 + u32be(head, 4));
  const doc = { format: form === 'AIFC' ? 'AIFC' : 'AIFF', file, fields: [], technical: [], notes: [], c2pa: null, readOnly: null, chunks: [], id3: null, newText: [], trailingStart: null };
  let o = 12;
  let comm = null;
  while (o + 8 <= formEnd) {
    const h = await readBytes(file, o, o + 8);
    const id = fourcc(h, 0);
    const size = u32be(h, 4);
    const dataStart = o + 8;
    const dataEnd = Math.min(file.size, dataStart + size);
    const next = dataStart + size + (size & 1);
    const c = { id, offset: o, size, dataStart, dataEnd, end: Math.min(file.size, next) };
    doc.chunks.push(c);
    const sizeStr = formatBytes(dataEnd - dataStart);
    if (id === 'COMM') {
      const d = await readBytes(file, dataStart, Math.min(dataEnd, dataStart + 64));
      comm = { ch: u16be(d, 0), frames: u32be(d, 2), bits: u16be(d, 6), rate: extended(d, 8) };
      if (form === 'AIFC' && d.length >= 22) {
        comm.compression = fourcc(d, 18);
        const n = d[22] || 0;
        comm.compressionName = decodeLatin1(d.subarray(23, 23 + n));
      }
      c.field = makeField({ cls: 'protected', kind: 'info', key: id, label: 'Format (COMM)', deletable: false,
        display: `${comm.compression ? comm.compression.trim() + ', ' : ''}${comm.bits}-bit, ${Math.round(comm.rate)} Hz, ${comm.ch} ch` });
    } else if (id === 'SSND') {
      c.field = makeField({ cls: 'protected', kind: 'info', key: id, label: 'Sound data (SSND)', deletable: false, display: sizeStr });
    } else if (id === 'FVER') {
      c.field = makeField({ cls: 'protected', kind: 'info', key: id, label: 'Format version (FVER)', deletable: false, display: sizeStr });
    } else if (TEXT_CHUNKS[id]) {
      c.field = textField(id, decodeLatin1(await readBytes(file, dataStart, dataEnd)).replace(/\0+$/, ''), c);
    } else if ((id === 'ID3 ' || id === 'id3 ') && !doc.id3) {
      try {
        const tag = id3.parseTag(await readBytes(file, dataStart, dataEnd));
        if (tag.unsupported) throw new Error(tag.unsupported + ' not supported');
        doc.id3 = { chunk: c, tag, fields: id3.tagFields(tag, 'ID3').fields, chunkId: id };
        c.id3 = true;
      } catch (err) {
        c.field = makeField({ cls: 'preserve', kind: 'info', key: id, label: `ID3 chunk ('${id}')`, display: `not editable (${err.message}), ${sizeStr}` });
      }
    } else {
      const names = { MARK: 'Markers', INST: 'Instrument', COMT: 'Comments (timestamped)', APPL: 'Application data', MIDI: 'MIDI data', AESD: 'AES channel status' };
      c.field = makeField({ cls: 'preserve', kind: 'info', key: id, label: `${names[id] || 'Chunk'} (${id.trim()})`, display: sizeStr });
    }
    o = next;
  }
  if (o < file.size && Math.max(o, formEnd) < file.size) {
    doc.trailingStart = Math.max(o, formEnd);
    doc.trailingField = makeField({ cls: 'preserve', kind: 'info', key: 'trailing', label: 'Data after FORM chunk', display: formatBytes(file.size - doc.trailingStart) });
  }
  collect(doc);
  doc.technical.push(['Container', form === 'AIFC' ? 'AIFF-C' : 'AIFF']);
  if (comm) {
    if (comm.compression) doc.technical.push(['Codec', `${comm.compression.trim()}${comm.compressionName ? ' (' + comm.compressionName + ')' : ''}`]);
    doc.technical.push(['Sample rate', `${Math.round(comm.rate)} Hz`], ['Channels', String(comm.ch)], ['Bit depth', String(comm.bits)],
      ['Duration', comm.rate ? formatDuration(comm.frames / comm.rate) : 'unknown']);
  }
  doc.technical.push(['Tags', [doc.chunks.some((c) => TEXT_CHUNKS[c.id]) && 'text chunks', doc.id3 && `${id3.versionLabel(doc.id3.tag)} chunk`].filter(Boolean).join(', ') || 'none']);
  doc.summary = `${doc.format}${comm ? ` · ${comm.bits}-bit ${Math.round(comm.rate)} Hz` : ''}`;
  return doc;
}

function collect(doc) {
  const out = [];
  for (const c of doc.chunks) {
    if (c.id3) out.push(...doc.id3.fields);
    else if (c.field) out.push(c.field);
  }
  out.push(...doc.newText);
  if (doc.id3 && !doc.id3.chunk) out.push(...doc.id3.fields);
  if (doc.trailingField) out.push(doc.trailingField);
  doc.fields = out;
}

export function addable(doc) {
  const live = doc.fields.filter((f) => !f.deleted);
  const out = Object.keys(TEXT_CHUNKS).filter((k) => k === 'ANNO' || !live.some((f) => f.key === k)).map((k) => ({ key: 'TXT:' + k, label: TEXT_CHUNKS[k] }));
  if (doc.id3) for (const a of id3.addable(doc.id3.tag, doc.id3.fields)) out.push({ key: 'ID3:' + a.key, label: `${a.label} (ID3)` });
  else out.push({ key: 'ID3CHUNK', label: 'Add ID3 chunk (cover art, lyrics, more fields)' });
  return out;
}

export function addField(doc, key) {
  if (key === 'ID3CHUNK') {
    doc.id3 = { chunk: null, tag: id3.emptyTag(4), fields: [], chunkId: 'ID3 ' };
    collect(doc);
    return null;
  }
  const [ns, k] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  let f;
  if (ns === 'TXT') {
    f = textField(k, '', null);
    f.isNew = true;
    doc.newText.push(f);
  } else {
    f = id3.newField(doc.id3.tag, k, doc.id3.fields, 'ID3');
    doc.id3.fields.push(f);
  }
  collect(doc);
  return f;
}

export function removeNewField(doc, f) {
  for (const list of [doc.newText, doc.id3 && doc.id3.fields]) if (list && list.includes(f)) list.splice(list.indexOf(f), 1);
  collect(doc);
}

function chunkBytes(id, data) {
  return concat([fourccBytes(id), u32beBytes(data.length), data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}

function rawChunk(file, c) {
  const parts = [file.slice(c.offset, c.end)];
  if ((c.size & 1) && c.end === c.dataStart + c.size) parts.push(new Uint8Array(1));
  return parts;
}

export async function build(doc) {
  const file = doc.file;
  const body = [];
  const id3Changed = doc.id3 && (doc.id3.chunk === null ? doc.id3.fields.some((f) => !f.deleted) : id3.tagChanged(doc.id3.fields, false));
  const newText = doc.newText.filter((f) => !f.deleted).map((f) => chunkBytes(f.key, encodeLatin1(f.value)));
  let inserted = false;
  for (const c of doc.chunks) {
    if (c.id === 'SSND' && !inserted) { body.push(...newText); inserted = true; }
    if (c.id3) {
      if (id3Changed) body.push(chunkBytes(doc.id3.chunkId, id3.buildTag(doc.id3.tag, doc.id3.fields)));
      else body.push(...rawChunk(file, c));
      continue;
    }
    const f = c.field;
    if (f && f.deleted) continue;
    if (f && TEXT_CHUNKS[c.id] && isChanged(f)) { body.push(chunkBytes(c.id, encodeLatin1(f.value))); continue; }
    body.push(...rawChunk(file, c));
  }
  if (!inserted) body.push(...newText);
  if (doc.id3 && doc.id3.chunk === null && id3Changed) body.push(chunkBytes('ID3 ', id3.buildTag(doc.id3.tag, doc.id3.fields)));
  let size = 4;
  for (const p of body) size += p.byteLength !== undefined ? p.byteLength : p.size;
  if (size > 0xffffffff) throw new Error('Output exceeds the 4 GB AIFF limit');
  const parts = [concat([fourccBytes('FORM'), u32beBytes(size), fourccBytes(doc.format === 'AIFC' ? 'AIFC' : 'AIFF')]), ...body];
  if (doc.trailingStart !== null && !(doc.trailingField && doc.trailingField.deleted)) parts.push(file.slice(doc.trailingStart));
  return parts;
}

export function provenance(doc) {
  const out = [];
  for (const f of doc.fields) if (!f.deleted && f.key === 'ANNO') out.push({ text: f.value, where: 'AIFF ANNO' });
  if (doc.id3) for (const f of doc.id3.fields) { const p = id3.provenanceText(f); if (p) out.push({ text: p.text, where: 'ID3 chunk ' + p.where }); }
  return out;
}
