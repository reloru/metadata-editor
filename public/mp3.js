// MP3 container: leading ID3v2 tag, MPEG audio frames, trailing APEv2 / ID3v1.

import { readBytes, u32be, u32le, formatBytes, formatDuration } from './bytes.js';
import { decodeLatin1 } from './text.js';
import { makeField, isChanged } from './fields.js';
import * as id3 from './id3.js';

const BITRATES = {
  // [versionKey][layer] -> kbps table (index 0 = free, 15 = bad)
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// Decode a 4-byte MPEG audio frame header at b[o].
export function mpegHeader(b, o) {
  if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[o + 1] >> 3) & 3; // 0 = 2.5, 2 = 2, 3 = 1
  const layerBits = (b[o + 1] >> 1) & 3;
  const brIdx = b[o + 2] >> 4;
  const srIdx = (b[o + 2] >> 2) & 3;
  if (ver === 1 || layerBits === 0 || brIdx === 15 || srIdx === 3) return null;
  const layer = 4 - layerBits;
  const padding = (b[o + 2] >> 1) & 1;
  const mode = b[o + 3] >> 6;
  const sampleRate = RATES[ver][srIdx];
  const mpeg1 = ver === 3;
  const bitrate = BITRATES[mpeg1 ? 1 : 2][layer][brIdx];
  const samples = layer === 1 ? 384 : layer === 2 ? 1152 : mpeg1 ? 1152 : 576;
  let frameLength = 0;
  if (bitrate) {
    frameLength = layer === 1
      ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
      : Math.floor(((samples / 8) * bitrate * 1000) / sampleRate) + padding;
  }
  return {
    version: ver === 3 ? '1' : ver === 2 ? '2' : '2.5', mpeg1, layer, bitrate, sampleRate, mode,
    channels: mode === 3 ? 1 : 2, samples, frameLength, crc: (b[o + 1] & 1) === 0,
  };
}

// Xing/Info header in the first frame. Returns null if absent.
export function xingHeader(b, o, h) {
  if (h.layer !== 3) return null;
  const side = h.mpeg1 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17);
  const x = o + 4 + (h.crc ? 2 : 0) + side;
  if (x + 8 > b.length) return null;
  const tag = decodeLatin1(b.subarray(x, x + 4));
  if (tag !== 'Xing' && tag !== 'Info') return null;
  const flags = u32be(b, x + 4);
  let p = x + 8;
  const out = { tag, offset: x, frames: null, bytes: null, encoder: null };
  if (flags & 1) { out.frames = u32be(b, p); p += 4; }
  if (flags & 2) { out.bytes = u32be(b, p); p += 4; }
  if (flags & 4) p += 100;
  if (flags & 8) p += 4;
  if (p + 9 <= b.length) {
    const enc = decodeLatin1(b.subarray(p, p + 9));
    if (/^[A-Za-z][\x20-\x7e]{3,8}$/.test(enc)) out.encoder = enc.trim();
  }
  return out;
}

function findFirstFrame(b) {
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] !== 0xff) continue;
    const h = mpegHeader(b, i);
    if (!h) continue;
    // Require a second consecutive header when the frame length is known and in range.
    if (h.frameLength && i + h.frameLength + 4 <= b.length) {
      const n = mpegHeader(b, i + h.frameLength);
      if (!n || n.layer !== h.layer || n.sampleRate !== h.sampleRate) continue;
    }
    return { offset: i, header: h };
  }
  return null;
}

export async function detect(head) {
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true;
  return mpegHeader(head, 0) !== null;
}

export async function load(file) {
  const head = await readBytes(file, 0, 10);
  const doc = {
    format: 'MP3', file, fields: [], technical: [], notes: [], c2pa: null, readOnly: null,
    tag: null, tagEnd: 0, apeStart: null, v1Start: null, audioEnd: file.size,
  };
  const h = id3.readHeader(head);
  let tagFields = [];
  if (h) {
    if (h.totalSize > file.size) throw new Error('ID3 tag size exceeds file size');
    const bytes = await readBytes(file, 0, h.totalSize);
    doc.tag = id3.parseTag(bytes);
    doc.tagEnd = h.totalSize;
    if (doc.tag.unsupported) {
      doc.fields.push(makeField({ cls: 'preserve', kind: 'info', key: 'ID3', label: `${doc.tag.unsupported} tag`, display: `not editable, ${formatBytes(h.totalSize)}`, deletable: false }));
    } else {
      const r = id3.tagFields(doc.tag);
      tagFields = r.fields;
      if (r.c2pa) doc.c2pa = { where: 'GEOB', jumbf: r.c2pa.jumbf, offset: null };
    }
  }
  doc.tagFieldsRef = tagFields;
  doc.fields.push(...tagFields);

  // Trailing tags.
  let end = file.size;
  if (end - doc.tagEnd >= 128) {
    const v1 = await readBytes(file, end - 128, end);
    if (v1[0] === 0x54 && v1[1] === 0x41 && v1[2] === 0x47) {
      let start = end - 128;
      let ext = false;
      if (start - doc.tagEnd >= 227) {
        const plus = await readBytes(file, start - 227, start - 223);
        if (decodeLatin1(plus) === 'TAG+') { start -= 227; ext = true; }
      }
      const title = decodeLatin1(v1.subarray(3, 33)).replace(/[\u0000 ]+$/, '');
      const artist = decodeLatin1(v1.subarray(33, 63)).replace(/[\u0000 ]+$/, '');
      doc.v1Start = start;
      doc.fields.push(makeField({ cls: 'preserve', kind: 'info', key: 'ID3v1', label: ext ? 'ID3v1 + TAG+ tag' : 'ID3v1 tag', display: [title, artist].filter(Boolean).join(' — ') || '(empty)', trailing: 'v1' }));
      end = start;
    }
  }
  if (end - doc.tagEnd >= 32) {
    const f = await readBytes(file, end - 32, end);
    if (decodeLatin1(f.subarray(0, 8)) === 'APETAGEX') {
      const version = u32le(f, 8);
      const size = u32le(f, 12);
      const items = u32le(f, 16);
      const flags = u32le(f, 20);
      const start = end - size - ((flags & 0x80000000) ? 32 : 0);
      if (start >= doc.tagEnd && size >= 32) {
        doc.apeStart = start;
        doc.fields.push(makeField({ cls: 'preserve', kind: 'info', key: 'APE', label: `APEv${version >= 2000 ? 2 : 1} tag`, display: `${items} item(s), ${formatBytes(end - start)}`, trailing: 'ape' }));
        end = start;
      }
    }
  }
  doc.audioEnd = end;

  // First MPEG frame and Xing/Info header.
  const scan = await readBytes(file, doc.tagEnd, Math.min(end, doc.tagEnd + 65536));
  const first = findFirstFrame(scan);
  let duration = 'unknown';
  let codec = 'unknown';
  if (first) {
    const fh = first.header;
    codec = `MPEG-${fh.version} Layer ${'I'.repeat(fh.layer)}`;
    const x = xingHeader(scan, first.offset, fh);
    if (x) {
      if (x.frames) duration = formatDuration((x.frames * fh.samples) / fh.sampleRate);
      doc.fields.push(makeField({ cls: 'protected', kind: 'info', key: 'Xing', label: `${x.tag} header${x.encoder ? ' + LAME' : ''}`, display: [x.frames !== null ? `${x.frames} frames` : null, x.bytes !== null ? formatBytes(x.bytes) : null, x.encoder].filter(Boolean).join(', '), deletable: false }));
    }
    doc.technical.push(['Codec', codec], ['Sample rate', `${fh.sampleRate} Hz`], ['Channels', String(fh.channels)]);
    if (x && x.encoder) doc.technical.push(['Encoder (LAME header)', x.encoder]);
    doc.audioStart = doc.tagEnd + first.offset;
  } else {
    doc.notes.push('No MPEG audio frame found near the start of the audio data.');
  }
  doc.fields.push(makeField({ cls: 'protected', kind: 'info', key: 'audio', label: 'MPEG audio data', display: formatBytes(end - doc.tagEnd), deletable: false }));
  doc.technical.unshift(['Container', 'MPEG audio (MP3)'], ['Tag', doc.tag ? id3.versionLabel(doc.tag) : 'none']);
  doc.technical.push(['Duration', duration]);
  for (const f of tagFields) if (f.key === 'TSSE' && !f.deleted) doc.technical.push(['Encoder (TSSE)', f.display]);
  doc.summary = `MP3 · ${codec}${doc.tag ? ' · ' + id3.versionLabel(doc.tag) : ' · no ID3v2 tag'}`;
  return doc;
}

export function addable(doc) {
  if (doc.tag && doc.tag.unsupported) return [];
  return id3.addable(doc.tag || id3.emptyTag(4), doc.tagFieldsRef);
}

export function addField(doc, key) {
  if (!doc.tag) {
    doc.tag = id3.emptyTag(4);
    doc.createdTag = true;
  }
  const f = id3.newField(doc.tag, key, doc.tagFieldsRef);
  doc.tagFieldsRef.push(f);
  doc.fields.push(f);
  return f;
}

export function removeNewField(doc, f) {
  doc.tagFieldsRef.splice(doc.tagFieldsRef.indexOf(f), 1);
  doc.fields.splice(doc.fields.indexOf(f), 1);
}

export async function build(doc, opts = {}) {
  const file = doc.file;
  const parts = [];
  const removeC2pa = !!opts.removeC2pa;
  if (doc.tag && !doc.tag.unsupported) {
    const live = doc.tagFieldsRef;
    if (id3.tagChanged(live, removeC2pa) || doc.tagEnd === 0) {
      if (doc.tagEnd === 0 && !live.some((f) => !f.deleted)) {
        // Created then emptied: write nothing.
      } else {
        parts.push(id3.buildTag(doc.tag, live, { removeC2pa }));
      }
    } else {
      parts.push(file.slice(0, doc.tagEnd));
    }
  } else if (doc.tagEnd) {
    parts.push(file.slice(0, doc.tagEnd));
  }
  parts.push(file.slice(doc.tagEnd, doc.audioEnd));
  const ape = doc.fields.find((f) => f.trailing === 'ape');
  const v1 = doc.fields.find((f) => f.trailing === 'v1');
  const apeEnd = doc.v1Start !== null ? doc.v1Start : file.size;
  if (ape && !ape.deleted) parts.push(file.slice(doc.apeStart, apeEnd));
  if (v1 && !v1.deleted) parts.push(file.slice(doc.v1Start, file.size));
  return parts;
}

export function provenance(doc) {
  const out = [];
  for (const f of doc.tagFieldsRef || []) {
    const p = id3.provenanceText(f);
    if (p) out.push(p);
  }
  return out;
}

export function changed(doc) {
  return doc.fields.some(isChanged);
}
