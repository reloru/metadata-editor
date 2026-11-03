// Ogg Vorbis / Opus (RFC 3533, Vorbis I spec, RFC 7845): comment header editing.
// The comment packet is re-laced into exactly the pages it used before, so page count and sequence numbers
// stay the same and every audio page passes through untouched. Edits that do not fit are refused.

import { readBytes, u16le, u32le, fourcc, concat, formatBytes, formatDuration } from './bytes.js';
import { decodeLatin1 } from './text.js';
import { makeField, isChanged } from './fields.js';
import { parseComments, commentField, vorbisBlock, commentAddable, newCommentField } from './flac.js';

export function detect(head) {
  return head.length >= 4 && fourcc(head, 0) === 'OggS';
}

let crcTable = null;
export function oggCrc(b) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      crcTable[i] = r >>> 0;
    }
  }
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) ^ crcTable[((c >>> 24) ^ b[i]) & 255]) >>> 0;
  return c;
}

async function readPage(file, o) {
  const h = await readBytes(file, o, o + 27);
  if (h.length < 27 || fourcc(h, 0) !== 'OggS') throw new Error(`Ogg: no page at byte ${o}`);
  const nseg = h[26];
  const lacing = await readBytes(file, o + 27, o + 27 + nseg);
  let body = 0;
  for (const l of lacing) body += l;
  const end = o + 27 + nseg + body;
  if (end > file.size) throw new Error('Ogg page exceeds file size');
  return { start: o, type: h[5], granule: h.subarray(6, 14), serial: u32le(h, 14), seq: u32le(h, 18), lacing, bodyStart: o + 27 + nseg, end };
}

// Total byte length of the Vorbis comment structure starting at d[0].
function commentsLength(d) {
  let o = 4 + u32le(d, 0);
  const n = u32le(d, o);
  o += 4;
  for (let i = 0; i < n; i++) o += 4 + u32le(d, o);
  return o;
}

export async function load(file) {
  const doc = { format: 'Ogg', file, fields: [], technical: [], notes: [], c2pa: null, readOnly: null, vorbis: null };
  const first = await readPage(file, 0);
  if (!(first.type & 0x02)) throw new Error('Ogg: first page is not a stream start');
  const id = await readBytes(file, first.bodyStart, first.end);
  let codec;
  if (id[0] === 1 && decodeLatin1(id.subarray(1, 7)) === 'vorbis') codec = 'Vorbis';
  else if (decodeLatin1(id.subarray(0, 8)) === 'OpusHead') codec = 'Opus';
  else {
    const name = id[0] === 0x7f && decodeLatin1(id.subarray(1, 5)) === 'FLAC' ? 'FLAC' : decodeLatin1(id.subarray(0, 8)).startsWith('Speex') ? 'Speex' : decodeLatin1(id.subarray(1, 7)) === 'theora' ? 'Theora video' : 'this codec';
    throw new Error(`Ogg ${name} files are not supported yet.`);
  }
  doc.format = codec === 'Opus' ? 'Opus' : 'Ogg Vorbis';
  doc.codec = codec;
  const need = codec === 'Vorbis' ? 2 : 1;
  const pages = [];
  const packets = [];
  let cur = [];
  let o = first.end;
  while (packets.length < need) {
    const p = await readPage(file, o);
    if (p.serial !== first.serial) throw new Error('Ogg files with several interleaved streams are not supported yet.');
    pages.push(p);
    const body = await readBytes(file, p.bodyStart, p.end);
    let at = 0;
    for (let i = 0; i < p.lacing.length; i++) {
      cur.push(body.subarray(at, at + p.lacing[i]));
      at += p.lacing[i];
      if (p.lacing[i] < 255) {
        packets.push(concat(cur));
        cur = [];
        if (packets.length === need && i !== p.lacing.length - 1) doc.readOnly = 'The comment header shares a page with audio data: read-only.';
      }
    }
    o = p.end;
  }
  doc.pages = pages;
  doc.regionStart = pages[0].start;
  doc.regionEnd = o;
  doc.packets = packets;
  const c = packets[0];
  const prefix = codec === 'Vorbis' ? 7 : 8;
  if (codec === 'Vorbis' ? !(c[0] === 3 && decodeLatin1(c.subarray(1, 7)) === 'vorbis') : decodeLatin1(c.subarray(0, 8)) !== 'OpusTags') throw new Error('Ogg: comment header not found');
  const body = c.subarray(prefix);
  const parsed = parseComments(body);
  doc.commentTail = body.subarray(commentsLength(body));
  const groups = new Map();
  for (const e of parsed.entries) {
    const k = e.key.toUpperCase();
    if (!groups.has(k)) groups.set(k, { key: e.key, values: [] });
    groups.get(k).values.push(e.value);
  }
  doc.vorbis = { block: true, vendor: parsed.vendor, entries: parsed.entries, fields: [...groups.values()].map((g) => commentField(g.key, g.values)) };
  doc.headerField = makeField({ cls: 'protected', kind: 'info', key: 'id', label: `${codec} identification header`, deletable: false, display: formatBytes(id.length) });
  if (codec === 'Vorbis') doc.setupField = makeField({ cls: 'protected', kind: 'info', key: 'setup', label: 'Vorbis setup header', deletable: false, display: formatBytes(packets[1].length) });
  doc.audioField = makeField({ cls: 'protected', kind: 'info', key: 'audio', label: 'Audio pages', deletable: false, display: formatBytes(file.size - o) });
  collect(doc);

  // Duration from the last page's granule position.
  const tail = await readBytes(file, Math.max(0, file.size - 65536), file.size);
  let granule = null;
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53 && u32le(tail, i + 14) === first.serial) {
      granule = u32le(tail, i + 6) + u32le(tail, i + 10) * 2 ** 32;
      break;
    }
  }
  doc.technical.push(['Container', 'Ogg'], ['Codec', codec]);
  if (codec === 'Vorbis') {
    const rate = u32le(id, 12);
    doc.technical.push(['Sample rate', `${rate} Hz`], ['Channels', String(id[11])]);
    if (u32le(id, 20)) doc.technical.push(['Nominal bitrate', `${Math.round(u32le(id, 20) / 1000)} kbps`]);
    if (granule !== null && rate) doc.technical.push(['Duration', formatDuration(granule / rate)]);
  } else {
    const preskip = u16le(id, 10);
    doc.technical.push(['Channels', String(id[9])], ['Input sample rate', `${u32le(id, 12)} Hz`], ['Pre-skip', `${preskip} samples`]);
    if (granule !== null) doc.technical.push(['Duration', formatDuration((granule - preskip) / 48000)]);
  }
  doc.technical.push(['Encoder (vendor)', parsed.vendor || '(empty)'], ['Header pages', String(pages.length + 1)]);
  doc.notes.push('Tag edits must fit in the existing header pages; very large additions (such as cover art) are refused so the audio is never rewritten.');
  doc.summary = `${doc.format} · Vorbis comments`;
  return doc;
}

function collect(doc) {
  doc.fields = [...doc.vorbis.fields, doc.headerField, ...(doc.setupField ? [doc.setupField] : []), doc.audioField];
}

export function addable(doc) {
  return doc.readOnly ? [] : commentAddable(doc.vorbis);
}

export function addField(doc, key) {
  const f = newCommentField(doc.vorbis, key);
  collect(doc);
  return f;
}

export function removeNewField(doc, f) {
  doc.vorbis.fields.splice(doc.vorbis.fields.indexOf(f), 1);
  collect(doc);
}

function lace(packets) {
  const segs = [];
  packets.forEach((p) => {
    let o = 0;
    for (;;) {
      const n = Math.min(255, p.length - o);
      segs.push({ data: p.subarray(o, o + n), end: n < 255 });
      o += n;
      if (n < 255) break;
    }
  });
  return segs;
}

export async function build(doc) {
  if (doc.readOnly) throw new Error(doc.readOnly);
  if (!doc.vorbis.fields.some(isChanged)) return [doc.file];
  const head = doc.codec === 'Vorbis' ? new Uint8Array([3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]) : new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);
  let comment = concat([head, vorbisBlock(doc.vorbis), doc.codec === 'Vorbis' ? new Uint8Array([1]) : doc.commentTail]);
  const n = doc.pages.length;
  let packets = doc.codec === 'Vorbis' ? [comment, doc.packets[1]] : [comment];
  let segs = lace(packets);
  if (segs.length < n && doc.codec === 'Opus') {
    // RFC 7845 allows padding after the comment list; pad so every original page carries data.
    comment = concat([comment, new Uint8Array((n - segs.length) * 255)]);
    packets = [comment];
    segs = lace(packets);
  }
  if (segs.length < n) throw new Error('The new tags are too small to fill the existing header pages; keep at least some of the current text.');
  if (segs.length > n * 255) throw new Error(`The new tags need more space than the file's ${n} header page${n === 1 ? '' : 's'} hold. Remove some text (or cover art) and try again.`);
  const out = [];
  let k = 0;
  let continued = false;
  for (let i = 0; i < n; i++) {
    const take = Math.min(255, segs.length - k - (n - 1 - i));
    const pageSegs = segs.slice(k, k + take);
    k += take;
    const ends = pageSegs.some((s) => s.end);
    const orig = doc.pages[i];
    const hdr = new Uint8Array(27 + take);
    hdr.set([0x4f, 0x67, 0x67, 0x53, 0, continued ? 1 : 0], 0);
    hdr.set(ends ? new Uint8Array(8) : new Uint8Array(8).fill(0xff), 6);
    hdr.set([orig.serial & 255, (orig.serial >>> 8) & 255, (orig.serial >>> 16) & 255, orig.serial >>> 24], 14);
    hdr.set([orig.seq & 255, (orig.seq >>> 8) & 255, (orig.seq >>> 16) & 255, orig.seq >>> 24], 18);
    hdr[26] = take;
    pageSegs.forEach((s, j) => { hdr[27 + j] = s.data.length; });
    const page = concat([hdr, ...pageSegs.map((s) => s.data)]);
    const crc = oggCrc(page);
    page.set([crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24], 22);
    out.push(page);
    continued = !pageSegs[pageSegs.length - 1].end;
  }
  return [doc.file.slice(0, doc.regionStart), ...out, doc.file.slice(doc.regionEnd)];
}

export function provenance(doc) {
  const out = [];
  for (const f of doc.vorbis.fields) if (!f.deleted && (f.key === 'COMMENT' || f.key === 'DESCRIPTION')) out.push({ text: f.value, where: `Vorbis ${f.key}` });
  return out;
}
