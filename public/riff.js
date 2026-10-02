// WAV (RIFF/WAVE): chunk walking, LIST/INFO editing, ID3 chunk editing.

import { readBytes, u16le, u32le, fourcc, fourccBytes, concat, u32leBytes, formatBytes, formatDuration } from './bytes.js';
import { decodeUtf8OrLatin1, encodeUtf8, validateIsoDay } from './text.js';
import { makeField, isChanged } from './fields.js';
import * as id3 from './id3.js';

export const INFO_EDIT = {
  INAM: { label: 'Title' },
  IART: { label: 'Artist' },
  ICMT: { label: 'Comment', kind: 'multiline' },
  IPRD: { label: 'Product / Album' },
  IGNR: { label: 'Genre' },
  ICRD: { label: 'Creation date', validate: validateIsoDay, placeholder: 'YYYY-MM-DD' },
  ICOP: { label: 'Copyright' },
  IENG: { label: 'Engineer' },
  IKEY: { label: 'Keywords' },
};
const INFO_PRESERVE = {
  ISFT: 'Software', ISRC: 'Source', ISBJ: 'Subject', ITCH: 'Technician', ISRF: 'Source form',
  IARL: 'Archival location', ICMS: 'Commissioned', ICRP: 'Cropped', IDIM: 'Dimensions', IDPI: 'Dots per inch',
  ILGT: 'Lightness', IMED: 'Medium', IPLT: 'Palette', ISHP: 'Sharpness', ILNG: 'Language', ITRK: 'Track number',
  IPRT: 'Part', IFRM: 'Total parts',
};

const FORMAT_TAGS = { 1: 'PCM', 3: 'IEEE float', 6: 'A-law', 7: 'µ-law', 0x55: 'MPEG Layer III', 0x11: 'IMA ADPCM', 2: 'MS ADPCM', 0xfffe: 'Extensible' };

export function detect(head) {
  if (head.length < 12) return false;
  const id = fourcc(head, 0);
  return (id === 'RIFF' || id === 'RF64' || id === 'BW64') && fourcc(head, 8) === 'WAVE';
}

function infoText(data) {
  let z = 0;
  while (z < data.length && data[z] !== 0) z++;
  return decodeUtf8OrLatin1(data.subarray(0, z));
}

function parseInfo(list) {
  // list: LIST chunk data starting with 'INFO'
  const items = [];
  let o = 4;
  while (o + 8 <= list.length) {
    const id = fourcc(list, o);
    const size = u32le(list, o + 4);
    const dataEnd = Math.min(list.length, o + 8 + size);
    let next = o + 8 + size;
    if (size & 1) {
      // Some writers omit the pad byte; only skip it when it is zero.
      if (next < list.length && list[next] === 0) next++;
    }
    const data = list.subarray(o + 8, dataEnd);
    const pad = size & 1 ? [0] : [];
    items.push({ id, data, raw: concat([list.subarray(o, o + 8), data, new Uint8Array(pad)]) });
    o = next;
  }
  return items;
}

function fmtInfo(d) {
  if (d.length < 16) return null;
  let tag = u16le(d, 0);
  const out = {
    formatTag: tag, channels: u16le(d, 2), sampleRate: u32le(d, 4), byteRate: u32le(d, 8),
    blockAlign: u16le(d, 12), bits: u16le(d, 14),
  };
  if (tag === 0xfffe && d.length >= 40) out.subFormat = u16le(d, 24);
  out.codec = tag === 0xfffe && out.subFormat !== undefined
    ? `Extensible (${FORMAT_TAGS[out.subFormat] || '0x' + out.subFormat.toString(16)})`
    : FORMAT_TAGS[tag] || '0x' + tag.toString(16);
  return out;
}

function infoField(item, idx) {
  const def = INFO_EDIT[item.id];
  const value = infoText(item.data);
  if (def) {
    return makeField({ key: item.id, group: 'INFO', label: def.label, kind: def.kind || 'text', value, validate: def.validate || null, placeholder: def.placeholder, infoIndex: idx });
  }
  return makeField({ key: item.id, group: 'INFO', cls: 'preserve', kind: 'info', label: `${INFO_PRESERVE[item.id] || 'INFO'} (${item.id})`, display: value, infoIndex: idx });
}

export async function load(file) {
  const head = await readBytes(file, 0, 12);
  const id = fourcc(head, 0);
  if (id === 'RF64' || id === 'BW64') throw new Error(`${id} files (64-bit WAV) are not supported.`);
  if (id !== 'RIFF' || fourcc(head, 8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  const riffEnd = Math.min(file.size, 8 + u32le(head, 4));
  const doc = {
    format: 'WAV', file, fields: [], technical: [], notes: [], c2pa: null, readOnly: null,
    chunks: [], info: null, id3: null, trailingStart: null,
  };
  let o = 12;
  let fmt = null;
  let dataSize = null;
  while (o + 8 <= riffEnd) {
    const h = await readBytes(file, o, o + 8);
    const cid = fourcc(h, 0);
    const size = u32le(h, 4);
    const dataStart = o + 8;
    const dataEnd = Math.min(file.size, dataStart + size);
    const next = dataStart + size + (size & 1);
    const chunk = { id: cid, offset: o, size, dataStart, dataEnd, end: Math.min(file.size, next) };
    doc.chunks.push(chunk);
    const sizeStr = formatBytes(dataEnd - dataStart);
    if (cid === 'fmt ') {
      fmt = fmtInfo(await readBytes(file, dataStart, Math.min(dataEnd, dataStart + 64)));
      chunk.field = makeField({ cls: 'protected', kind: 'info', key: cid, label: 'Format (fmt )', deletable: false, display: fmt ? `${fmt.codec}, ${fmt.bits}-bit, ${fmt.sampleRate} Hz, ${fmt.channels} ch` : 'unreadable' });
    } else if (cid === 'data') {
      dataSize = dataEnd - dataStart;
      chunk.field = makeField({ cls: 'protected', kind: 'info', key: cid, label: 'Audio data (data)', deletable: false, display: sizeStr });
    } else if (cid === 'C2PA') {
      const jumbf = await readBytes(file, dataStart, dataEnd);
      if (!doc.c2pa) doc.c2pa = { where: 'C2PA chunk', jumbf, chunk };
      chunk.field = makeField({ cls: 'protected', kind: 'info', key: cid, label: 'C2PA manifest (C2PA chunk)', deletable: false, display: sizeStr, c2pa: true });
    } else if (cid === 'LIST' && size >= 4 && fourcc(await readBytes(file, dataStart, dataStart + 4), 0) === 'INFO' && !doc.info) {
      const list = await readBytes(file, dataStart, dataEnd);
      const items = parseInfo(list);
      doc.info = { chunk, items, fields: items.map(infoField) };
      chunk.info = true;
    } else if ((cid === 'id3 ' || cid === 'ID3 ') && !doc.id3) {
      const bytes = await readBytes(file, dataStart, dataEnd);
      try {
        const tag = id3.parseTag(bytes);
        if (tag.unsupported) throw new Error(tag.unsupported + ' not supported');
        const r = id3.tagFields(tag, 'ID3');
        doc.id3 = { chunk, tag, fields: r.fields, chunkId: cid };
        chunk.id3 = true;
      } catch (err) {
        chunk.field = makeField({ cls: 'preserve', kind: 'info', key: cid, label: `ID3 chunk ('${cid}')`, display: `not editable (${err.message}), ${sizeStr}` });
      }
    } else {
      let label = `Chunk '${cid}'`;
      if (cid === 'LIST' && size >= 4) label = `LIST '${fourcc(await readBytes(file, dataStart, dataStart + 4), 0)}'`;
      chunk.field = makeField({ cls: 'preserve', kind: 'info', key: cid, label, display: sizeStr });
    }
    o = next;
  }
  if (o < file.size && Math.max(o, riffEnd) < file.size) {
    doc.trailingStart = Math.max(o, riffEnd);
    doc.trailingField = makeField({ cls: 'preserve', kind: 'info', key: 'trailing', label: 'Data after RIFF chunk', display: formatBytes(file.size - doc.trailingStart) });
  }
  collectFields(doc);

  doc.technical.push(['Container', 'RIFF WAVE']);
  const tags = [];
  if (doc.info) tags.push('LIST/INFO');
  if (doc.id3) tags.push(`${id3.versionLabel(doc.id3.tag)} chunk`);
  doc.technical.push(['Tags', tags.join(', ') || 'none']);
  if (fmt) {
    doc.technical.push(['Codec', fmt.codec], ['Sample rate', `${fmt.sampleRate} Hz`], ['Channels', String(fmt.channels)], ['Bit depth', `${fmt.bits}`]);
  }
  doc.technical.push(['Duration', fmt && fmt.byteRate && dataSize !== null ? formatDuration(dataSize / fmt.byteRate) : 'unknown']);
  const isft = doc.info && doc.info.fields.find((f) => f.key === 'ISFT');
  if (isft) doc.technical.push(['Encoder (ISFT)', isft.display]);
  if (doc.id3) for (const f of doc.id3.fields) if (f.key === 'TSSE') doc.technical.push(['Encoder (ID3 TSSE)', f.display]);
  doc.summary = `WAV · ${fmt ? fmt.codec + ' ' + fmt.bits + '-bit' : 'unknown format'}${tags.length ? ' · ' + tags.join(' + ') : ''}`;
  return doc;
}

function collectFields(doc) {
  const out = [];
  for (const c of doc.chunks) {
    if (c.info) out.push(...doc.info.fields);
    else if (c.id3) out.push(...doc.id3.fields);
    else if (c.field) out.push(c.field);
  }
  if (doc.info && !doc.info.chunk) out.push(...doc.info.fields);
  if (doc.id3 && !doc.id3.chunk) out.push(...doc.id3.fields);
  if (doc.trailingField) out.push(doc.trailingField);
  doc.fields.length = 0;
  doc.fields.push(...out);
}

export function addable(doc) {
  const out = [];
  const live = doc.info ? doc.info.fields.filter((f) => !f.deleted) : [];
  for (const k of Object.keys(INFO_EDIT)) if (!live.some((f) => f.key === k)) out.push({ key: 'INFO:' + k, label: `${INFO_EDIT[k].label} (INFO)` });
  if (doc.id3) {
    for (const a of id3.addable(doc.id3.tag, doc.id3.fields)) out.push({ key: 'ID3:' + a.key, label: `${a.label} (ID3)` });
  } else {
    out.push({ key: 'ID3CHUNK', label: 'Add ID3 chunk (cover art, lyrics)' });
  }
  return out;
}

export function addField(doc, key) {
  if (key === 'ID3CHUNK') {
    doc.id3 = { chunk: null, tag: id3.emptyTag(4), fields: [], chunkId: 'id3 ' };
    collectFields(doc);
    return null;
  }
  const [ns, k] = key.split(':');
  let f;
  if (ns === 'INFO') {
    if (!doc.info) doc.info = { chunk: null, items: [], fields: [] };
    const def = INFO_EDIT[k];
    f = makeField({ key: k, group: 'INFO', label: def.label, kind: def.kind || 'text', value: '', validate: def.validate || null, placeholder: def.placeholder, isNew: true, infoIndex: -1 });
    doc.info.fields.push(f);
  } else {
    f = id3.newField(doc.id3.tag, k, doc.id3.fields, 'ID3');
    doc.id3.fields.push(f);
  }
  collectFields(doc);
  return f;
}

export function removeNewField(doc, f) {
  for (const list of [doc.info && doc.info.fields, doc.id3 && doc.id3.fields]) {
    if (list && list.includes(f)) list.splice(list.indexOf(f), 1);
  }
  collectFields(doc);
}

function chunkBytes(id, data) {
  const pad = data.length & 1 ? new Uint8Array(1) : new Uint8Array(0);
  return concat([fourccBytes(id), u32leBytes(data.length), data, pad]);
}

function buildInfo(info) {
  const parts = [fourccBytes('INFO')];
  let any = false;
  for (const f of info.fields) {
    if (f.deleted) continue;
    any = true;
    if (!f.isNew && !isChanged(f)) {
      parts.push(info.items[f.infoIndex].raw);
    } else {
      parts.push(chunkBytes(f.key, concat([encodeUtf8(f.value), new Uint8Array(1)])));
    }
  }
  return any ? chunkBytes('LIST', concat(parts)) : null;
}

function rawChunk(file, c) {
  const parts = [file.slice(c.offset, c.end)];
  // Restore a missing pad byte (odd-sized chunk truncated at EOF) so following chunks stay aligned.
  if ((c.size & 1) && c.end === c.dataStart + c.size) parts.push(new Uint8Array(1));
  return parts;
}

export async function build(doc, opts = {}) {
  const file = doc.file;
  const removeC2pa = !!opts.removeC2pa;
  const body = [];
  const infoChanged = doc.info && doc.info.fields.some(isChanged);
  const id3Changed = doc.id3 && (doc.id3.chunk === null ? doc.id3.fields.some((f) => !f.deleted) : id3.tagChanged(doc.id3.fields, false));
  const newId3 = doc.id3 && doc.id3.chunk === null && id3Changed ? chunkBytes('id3 ', id3.buildTag(doc.id3.tag, doc.id3.fields)) : null;
  let insertedInfo = false;
  let insertedId3 = false;
  for (const c of doc.chunks) {
    if (c.id === 'data' && doc.info && !doc.info.chunk && !insertedInfo) {
      const l = buildInfo(doc.info);
      if (l) body.push(l);
      insertedInfo = true;
    }
    if (c.id === 'C2PA' && newId3 && !insertedId3) {
      body.push(newId3);
      insertedId3 = true;
    }
    if (c.info) {
      if (infoChanged) { const l = buildInfo(doc.info); if (l) body.push(l); }
      else body.push(...rawChunk(file, c));
      continue;
    }
    if (c.id3) {
      if (id3Changed) body.push(chunkBytes(doc.id3.chunkId, id3.buildTag(doc.id3.tag, doc.id3.fields)));
      else body.push(...rawChunk(file, c));
      continue;
    }
    if (c.id === 'C2PA' && removeC2pa && doc.c2pa && doc.c2pa.chunk === c) continue;
    if (c.field && c.field.deleted) continue;
    body.push(...rawChunk(file, c));
  }
  if (doc.info && !doc.info.chunk && !insertedInfo) {
    const l = buildInfo(doc.info);
    if (l) body.push(l);
  }
  if (newId3 && !insertedId3) body.push(newId3);
  let size = 4;
  for (const p of body) size += p.byteLength !== undefined ? p.byteLength : p.size;
  if (size > 0xffffffff) throw new Error('Output exceeds the 4 GB RIFF limit');
  const header = concat([fourccBytes('RIFF'), u32leBytes(size), fourccBytes('WAVE')]);
  const parts = [header, ...body];
  if (doc.trailingStart !== null && !(doc.trailingField && doc.trailingField.deleted)) parts.push(file.slice(doc.trailingStart));
  return parts;
}

export function provenance(doc) {
  const out = [];
  if (doc.info) for (const f of doc.info.fields) if (f.key === 'ICMT' && !f.deleted) out.push({ text: f.value, where: 'INFO ICMT' });
  if (doc.id3) for (const f of doc.id3.fields) {
    const p = id3.provenanceText(f);
    if (p) out.push({ text: p.text, where: 'ID3 chunk ' + p.where });
  }
  return out;
}
