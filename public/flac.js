// FLAC (RFC 9639): metadata blocks, Vorbis comments, PICTURE blocks. Audio frames are copied untouched;
// nothing after the metadata uses absolute file offsets, so the metadata may change length.

import { readBytes, u32be, u32le, fourcc, concat, formatBytes, formatDuration, hex, u32beBytes, u32leBytes } from './bytes.js';
import { decodeUtf8, encodeUtf8 } from './text.js';
import { makeField, isChanged, PICTURE_TYPES, imageInfo } from './fields.js';
import * as id3 from './id3.js';

const BLOCK_NAMES = ['STREAMINFO', 'PADDING', 'APPLICATION', 'SEEKTABLE', 'VORBIS_COMMENT', 'CUESHEET', 'PICTURE'];
const MAX_BLOCK = 0xffffff;

export const COMMENT_FIELDS = {
  TITLE: 'Title', ARTIST: 'Artist', ALBUMARTIST: 'Album artist', ALBUM: 'Album', GENRE: 'Genre', DATE: 'Date',
  TRACKNUMBER: 'Track', TRACKTOTAL: 'Track total', DISCNUMBER: 'Disc', DISCTOTAL: 'Disc total', COMPOSER: 'Composer',
  LYRICIST: 'Lyricist', PERFORMER: 'Performer', CONDUCTOR: 'Conductor', BPM: 'BPM', ISRC: 'ISRC', COPYRIGHT: 'Copyright',
  LABEL: 'Label', ORGANIZATION: 'Organization', GROUPING: 'Grouping', COMMENT: 'Comment', DESCRIPTION: 'Description', LYRICS: 'Lyrics',
};
const MULTILINE = new Set(['COMMENT', 'DESCRIPTION', 'LYRICS']);

export function detect(head) {
  return head.length >= 4 && fourcc(head, 0) === 'fLaC';
}

function validateKey(v) {
  return /^[\x20-\x3c\x3e-\x7d]+$/.test(v) ? null : 'Field names are ASCII without "="';
}

function parseComments(d) {
  const vlen = u32le(d, 0);
  const vendor = decodeUtf8(d.subarray(4, 4 + vlen));
  let o = 4 + vlen;
  const n = u32le(d, o);
  o += 4;
  const entries = [];
  for (let i = 0; i < n && o + 4 <= d.length; i++) {
    const len = u32le(d, o);
    const s = decodeUtf8(d.subarray(o + 4, o + 4 + len));
    o += 4 + len;
    const eq = s.indexOf('=');
    entries.push(eq < 0 ? { key: s, value: '' } : { key: s.slice(0, eq), value: s.slice(eq + 1) });
  }
  return { vendor, entries };
}

function commentField(key, values, extra = {}) {
  const up = key.toUpperCase();
  const multi = values.length > 1;
  return makeField({
    key: up, vkey: key, group: 'Vorbis', label: COMMENT_FIELDS[up] || key, multi,
    kind: multi || MULTILINE.has(up) ? 'multiline' : 'text', value: values.join('\n'),
    note: multi ? 'Multiple values: one per line.' : null, ...extra,
  });
}

function parsePicture(d) {
  let o = 0;
  const ptype = u32be(d, o); o += 4;
  const ml = u32be(d, o); o += 4;
  const mime = decodeUtf8(d.subarray(o, o + ml)); o += ml;
  const dl = u32be(d, o); o += 4;
  const desc = decodeUtf8(d.subarray(o, o + dl)); o += dl;
  o += 16;
  const len = u32be(d, o); o += 4;
  return { ptype, mime, desc, data: d.slice(o, o + len) };
}

function pictureBlock(v) {
  const info = imageInfo(v.data) || { width: 0, height: 0, depth: 0 };
  const mime = encodeUtf8(v.mime);
  const desc = encodeUtf8(v.desc || '');
  return concat([u32beBytes(v.ptype), u32beBytes(mime.length), mime, u32beBytes(desc.length), desc,
    u32beBytes(info.width), u32beBytes(info.height), u32beBytes(info.depth), u32beBytes(0), u32beBytes(v.data.length), v.data]);
}

export async function load(file) {
  const doc = { format: 'FLAC', file, fields: [], technical: [], notes: [], c2pa: null, readOnly: null, blocks: [], id3End: 0, vorbis: null, newFields: [] };
  let o = 0;
  const head = await readBytes(file, 0, 10);
  const h = id3.readHeader(head);
  if (h) {
    doc.id3End = h.totalSize;
    doc.id3Field = makeField({ cls: 'preserve', kind: 'info', key: 'ID3', label: 'ID3v2 tag (non-standard in FLAC)', display: formatBytes(h.totalSize) });
    o = h.totalSize;
  }
  if (fourcc(await readBytes(file, o, o + 4), 0) !== 'fLaC') throw new Error('Not a FLAC stream');
  o += 4;
  let info = null;
  for (;;) {
    const bh = await readBytes(file, o, o + 4);
    if (bh.length < 4) throw new Error('FLAC metadata truncated');
    const type = bh[0] & 0x7f;
    const last = (bh[0] & 0x80) !== 0;
    const len = (bh[1] << 16) | (bh[2] << 8) | bh[3];
    const b = { type, start: o, dataStart: o + 4, end: o + 4 + len, len };
    if (b.end > file.size) throw new Error('FLAC metadata block exceeds file size');
    doc.blocks.push(b);
    const name = BLOCK_NAMES[type] || `type ${type}`;
    if (type === 0) {
      const d = await readBytes(file, b.dataStart, b.end);
      const sr = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
      const ch = ((d[12] >> 1) & 7) + 1;
      const bits = (((d[12] & 1) << 4) | (d[13] >> 4)) + 1;
      const total = (d[13] & 15) * 2 ** 32 + u32be(d, 14);
      info = { sr, ch, bits, total, md5: hex(d.subarray(18, 34)) };
      b.field = makeField({ cls: 'protected', kind: 'info', key: name, label: 'Stream info', display: `${sr} Hz, ${ch} ch, ${bits}-bit`, deletable: false });
    } else if (type === 4 && !doc.vorbis) {
      const c = parseComments(await readBytes(file, b.dataStart, b.end));
      const groups = new Map();
      for (const e of c.entries) {
        const k = e.key.toUpperCase();
        if (!groups.has(k)) groups.set(k, { key: e.key, values: [] });
        groups.get(k).values.push(e.value);
      }
      doc.vorbis = { block: b, vendor: c.vendor, entries: c.entries, fields: [...groups.values()].map((g) => commentField(g.key, g.values)) };
      b.vorbis = true;
    } else if (type === 6) {
      const p = parsePicture(await readBytes(file, b.dataStart, b.end));
      b.field = makeField({ key: 'PICTURE', label: `Picture: ${PICTURE_TYPES[p.ptype] || 'type ' + p.ptype}`, kind: 'picture', value: p, readOnly: p.ptype !== 3, block: b, validate: pictureValidate });
    } else if (type === 1) {
      b.padding = true;
    } else {
      b.field = makeField({ cls: type === 3 ? 'protected' : 'preserve', kind: 'info', key: name, label: type === 3 ? 'Seek table' : type === 5 ? 'Cue sheet' : type === 2 ? 'Application data' : name, display: formatBytes(len), deletable: type !== 3 });
    }
    o = b.end;
    if (last) break;
  }
  doc.audioStart = o;
  const pad = doc.blocks.filter((b) => b.padding).reduce((n, b) => n + b.len, 0);
  collect(doc);
  doc.technical.push(['Container', 'FLAC']);
  if (info) {
    doc.technical.push(['Sample rate', `${info.sr} Hz`], ['Channels', String(info.ch)], ['Bit depth', String(info.bits)],
      ['Duration', info.total && info.sr ? formatDuration(info.total / info.sr) : 'unknown'],
      ['Bitrate', info.total && info.sr ? `${Math.round(((file.size - o) * 8) / (info.total / info.sr) / 1000)} kbps average` : 'unknown'],
      ['Audio MD5', /^0+$/.test(info.md5) ? 'not set' : info.md5]);
  }
  if (doc.vorbis) doc.technical.push(['Encoder (vendor)', doc.vorbis.vendor || '(empty)']);
  doc.technical.push(['Padding', formatBytes(pad)]);
  doc.summary = `FLAC${info ? ` · ${info.bits}-bit ${info.sr} Hz` : ''} · ${doc.vorbis ? 'Vorbis comments' : 'no tags'}`;
  return doc;
}

function pictureValidate(v) {
  if (!v.data) return 'Choose an image';
  return v.data.length > MAX_BLOCK - 1000 ? 'Image too large for a FLAC block (16 MB)' : null;
}

function collect(doc) {
  const out = [];
  if (doc.id3Field) out.push(doc.id3Field);
  for (const b of doc.blocks) {
    if (b.vorbis) out.push(...doc.vorbis.fields);
    else if (b.field) out.push(b.field);
  }
  if (doc.vorbis && !doc.vorbis.block) out.push(...doc.vorbis.fields);
  out.push(...doc.newFields);
  out.push(makeAudioField(doc));
  doc.fields = out;
}

function makeAudioField(doc) {
  if (!doc.audioField) doc.audioField = makeField({ cls: 'protected', kind: 'info', key: 'audio', label: 'Audio frames', display: formatBytes(doc.file.size - doc.audioStart), deletable: false });
  return doc.audioField;
}

export function addable(doc) {
  const live = doc.vorbis ? doc.vorbis.fields.filter((f) => !f.deleted) : [];
  const out = Object.keys(COMMENT_FIELDS).filter((k) => !live.some((f) => f.key === k)).map((k) => ({ key: k, label: COMMENT_FIELDS[k] }));
  out.push({ key: '*custom', label: 'Custom field…' });
  if (!doc.fields.some((f) => f.key === 'PICTURE' && !f.deleted && f.value && f.value.ptype === 3)) out.push({ key: 'PICTURE', label: 'Front cover' });
  return out;
}

export function addField(doc, key) {
  let f;
  if (key === 'PICTURE') {
    f = makeField({ key: 'PICTURE', label: 'Picture: Front cover', kind: 'picture', value: { mime: '', ptype: 3, desc: '', data: null }, isNew: true, validate: pictureValidate });
    doc.newFields.push(f);
  } else {
    if (!doc.vorbis) doc.vorbis = { block: null, vendor: 'metadata-editor', entries: [], fields: [] };
    if (key === '*custom') {
      f = makeField({ key: '*custom', group: 'Vorbis', label: 'Custom field', kind: 'vorbiskey', value: { name: '', text: '' }, isNew: true,
        validate: (v) => validateKey(v.name) || (doc.vorbis.fields.some((g) => g !== f && !g.deleted && g.key === v.name.toUpperCase()) ? 'That field already exists' : null) });
    } else {
      f = commentField(key, [''], { isNew: true });
    }
    doc.vorbis.fields.push(f);
  }
  collect(doc);
  return f;
}

export function removeNewField(doc, f) {
  for (const list of [doc.newFields, doc.vorbis && doc.vorbis.fields]) if (list && list.includes(f)) list.splice(list.indexOf(f), 1);
  collect(doc);
}

function fieldValues(f) {
  if (f.kind === 'vorbiskey') return { key: f.value.name, values: [f.value.text] };
  const lines = f.multi ? f.value.split('\n').filter((x) => x !== '') : [f.value];
  return { key: f.vkey || f.key, values: lines.length ? lines : [''] };
}

function vorbisBlock(v) {
  const entries = [];
  const done = new Set();
  const byKey = new Map(v.fields.filter((f) => f.kind !== 'vorbiskey').map((f) => [f.key, f]));
  for (const e of v.entries) {
    const k = e.key.toUpperCase();
    if (done.has(k)) continue;
    done.add(k);
    const f = byKey.get(k);
    if (!f || f.deleted) continue;
    const { key, values } = fieldValues(f);
    for (const val of values) entries.push(`${key}=${val}`);
  }
  for (const f of v.fields) {
    if (f.deleted || (f.kind !== 'vorbiskey' && done.has(f.key))) continue;
    const { key, values } = fieldValues(f);
    for (const val of values) entries.push(`${key}=${val}`);
  }
  const vendor = encodeUtf8(v.vendor);
  const parts = [u32leBytes(vendor.length), vendor, u32leBytes(entries.length)];
  for (const e of entries) { const b = encodeUtf8(e); parts.push(u32leBytes(b.length), b); }
  return concat(parts);
}

function header(type, len, last) {
  if (len > MAX_BLOCK) throw new Error(`FLAC ${BLOCK_NAMES[type]} block exceeds 16 MB`);
  return new Uint8Array([(last ? 0x80 : 0) | type, (len >> 16) & 255, (len >> 8) & 255, len & 255]);
}

export async function build(doc) {
  const file = doc.file;
  const vChanged = doc.vorbis && doc.vorbis.fields.some(isChanged);
  // Each entry: { type, data (Uint8Array) | blob }.
  const out = [];
  for (const b of doc.blocks) {
    if (b.padding) continue;
    if (b.vorbis) {
      if (vChanged) out.push({ type: 4, data: vorbisBlock(doc.vorbis) });
      else out.push({ type: 4, blob: file.slice(b.dataStart, b.end), len: b.len });
      continue;
    }
    const f = b.field;
    if (f && f.deleted) continue;
    if (f && f.key === 'PICTURE' && isChanged(f)) { out.push({ type: 6, data: pictureBlock(f.value) }); continue; }
    out.push({ type: b.type, blob: file.slice(b.dataStart, b.end), len: b.len });
  }
  if (doc.vorbis && !doc.vorbis.block && doc.vorbis.fields.some((f) => !f.deleted)) out.push({ type: 4, data: vorbisBlock(doc.vorbis) });
  for (const f of doc.newFields) if (!f.deleted) out.push({ type: 6, data: pictureBlock(f.value) });
  // Keep the audio where it was when padding allows; otherwise add 4 KB of fresh padding.
  const used = out.reduce((n, x) => n + 4 + (x.data ? x.data.length : x.len), 0);
  const target = doc.audioStart - doc.id3End - 4;
  let padLen = target - used - 4;
  if (padLen < 0) padLen = 4096;
  out.push({ type: 1, data: new Uint8Array(padLen) });
  const parts = [];
  if (doc.id3End && !doc.id3Field.deleted) parts.push(file.slice(0, doc.id3End));
  parts.push(new Uint8Array([0x66, 0x4c, 0x61, 0x43]));
  out.forEach((x, i) => {
    const len = x.data ? x.data.length : x.len;
    parts.push(header(x.type, len, i === out.length - 1), x.data || x.blob);
  });
  parts.push(file.slice(doc.audioStart));
  return parts;
}

export function provenance(doc) {
  const out = [];
  if (doc.vorbis) for (const f of doc.vorbis.fields) if (!f.deleted && (f.key === 'COMMENT' || f.key === 'DESCRIPTION')) out.push({ text: f.value, where: `Vorbis ${f.key}` });
  return out;
}

