// GIF (GIF89a spec): comment extensions (editable), application extensions (XMP, ICC, NETSCAPE loop),
// frames and plain-text extensions passed through byte for byte.

import { readBytes, formatBytes, concat } from './bytes.js';
import { decodeLatin1, decodeUtf8, decodeUtf8OrLatin1, encodeUtf8 } from './text.js';
import { makeField, isChanged } from './fields.js';
import { xmpInfo } from './image.js';

export function detect(head) {
  return head.length >= 6 && /^GIF8[79]a$/.test(decodeLatin1(head.subarray(0, 6)));
}

const WINDOW = 1048576;

// Sequential reader over a Blob holding one 1 MB window at a time (GIF has no lengths above sub-block level,
// so the file must be walked, but it is never held in memory whole).
class Reader {
  constructor(file) { this.file = file; this.size = file.size; this.base = 0; this.buf = new Uint8Array(0); }
  async ensure(o, n) {
    if (o >= this.base && o + n <= this.base + this.buf.length) return;
    this.base = o;
    this.buf = await readBytes(this.file, o, Math.min(this.size, o + Math.max(WINDOW, n)));
  }
  async byte(o) {
    if (o >= this.size) throw new Error('GIF: unexpected end of file');
    await this.ensure(o, 1);
    return this.buf[o - this.base];
  }
  async bytes(o, n) {
    await this.ensure(o, n);
    return this.buf.subarray(o - this.base, o - this.base + n);
  }
}

// Collect sub-blocks starting at o (metadata only, so small). Returns { data, end }.
async function subBlocks(r, o) {
  const parts = [];
  for (;;) {
    const n = await r.byte(o);
    if (n === 0) return { data: concat(parts), end: o + 1 };
    if (o + 1 + n > r.size) throw new Error('GIF: truncated data block');
    parts.push((await r.bytes(o + 1, n)).slice());
    o += 1 + n;
  }
}

// Skip sub-blocks without collecting them (image data).
async function skipBlocks(r, o) {
  for (;;) {
    const n = await r.byte(o);
    if (n === 0) return o + 1;
    o += 1 + n;
  }
}

function toBlocks(data) {
  const parts = [];
  for (let o = 0; o < data.length; o += 255) {
    const chunk = data.subarray(o, Math.min(data.length, o + 255));
    parts.push(new Uint8Array([chunk.length]), chunk);
  }
  parts.push(new Uint8Array([0]));
  return concat(parts);
}

function commentBlock(text) {
  return concat([new Uint8Array([0x21, 0xfe]), toBlocks(encodeUtf8(text))]);
}

export async function load(file) {
  const r = new Reader(file);
  const b = await r.bytes(0, 13);
  const doc = { format: 'GIF', file, fields: [], technical: [], notes: [], sections: [], c2pa: null, readOnly: null, blocks: [], newComments: [] };
  const version = decodeLatin1(b.subarray(0, 6));
  const width = b[6] | (b[7] << 8);
  const height = b[8] | (b[9] << 8);
  const flags = b[10];
  let o = 13 + (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0);
  doc.headerEnd = o;
  let frames = 0;
  let loop = null;
  while (o < r.size) {
    const t = await r.byte(o);
    if (t === 0x3b) { doc.trailerAt = o; break; }
    const start = o;
    if (t === 0x2c) {
      const lf = await r.byte(o + 9);
      o += 10 + (lf & 0x80 ? 3 * (2 << (lf & 7)) : 0);
      o = await skipBlocks(r, o + 1);
      frames++;
      doc.blocks.push({ kind: 'image', start, end: o });
      continue;
    }
    if (t !== 0x21) throw new Error(`GIF: unexpected block 0x${t.toString(16)} at byte ${o}`);
    const label = await r.byte(o + 1);
    if (label === 0xfe) {
      const sb = await subBlocks(r, o + 2);
      const text = decodeUtf8OrLatin1(sb.data);
      const blk = { kind: 'comment', start, end: sb.end };
      blk.field = makeField({ key: 'comment', label: 'Comment', kind: 'multiline', value: text, block: blk });
      doc.blocks.push(blk);
      o = sb.end;
    } else if (label === 0xff && (await r.byte(o + 2)) === 11) {
      const id = decodeLatin1(await r.bytes(o + 3, 11));
      const blk = { kind: 'app', start, id };
      if (id === 'XMP DataXMP') {
        // XMP is stored raw (UTF-8, no NUL bytes) followed by a 257-byte "magic trailer" (0x01, 0xFF..0x00)
        // and a block terminator, so the first NUL ends the trailer.
        let z = o + 14;
        while ((await r.byte(z)) !== 0) z++;
        if ((await r.byte(z + 1)) !== 0) throw new Error('GIF: malformed XMP block');
        const xml = decodeUtf8((await r.bytes(o + 14, Math.max(0, z - 256 - (o + 14)))).slice());
        z += 2;
        blk.end = z;
        const x = xmpInfo(xml);
        doc.sections.push({ title: 'XMP', rows: x.rows.length ? x.rows : [['', 'No simple properties']] });
        if (x.hasGps) doc.notes.push('XMP records a location; delete the XMP block to remove it.');
        blk.field = makeField({ cls: 'preserve', kind: 'info', key: 'XMP', label: 'XMP', display: `${x.rows.length} properties${x.hasGps ? ', includes location' : ''} · ${formatBytes(z - start)}`, block: blk });
      } else {
        const sb = await subBlocks(r, o + 14);
        blk.end = sb.end;
        if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') {
          if (sb.data[0] === 1) loop = sb.data[1] | (sb.data[2] << 8);
          blk.field = makeField({ cls: 'protected', kind: 'info', key: 'loop', label: 'Animation loop', display: loop === 0 ? 'loops forever' : loop === null ? id : `plays ${loop + 1} times`, deletable: false });
        } else if (id === 'ICCRGBG1012') {
          blk.field = makeField({ cls: 'preserve', kind: 'info', key: 'ICC', label: 'ICC colour profile', display: `${formatBytes(sb.data.length)} · deleting changes how colours display`, block: blk });
        } else {
          blk.field = makeField({ cls: 'preserve', kind: 'info', key: 'app', label: `Application data (${id.trim()})`, display: formatBytes(sb.data.length), block: blk });
        }
      }
      doc.blocks.push(blk);
      o = blk.end;
    } else {
      // Graphic control (0xF9), plain text (0x01) and unknown extensions pass through.
      o = await skipBlocks(r, o + 2);
      doc.blocks.push({ kind: 'ext', start, end: o });
    }
  }
  if (doc.trailerAt === undefined) {
    doc.trailerAt = o;
    doc.notes.push('This GIF has no end marker; it is written back as found.');
  }
  collect(doc);
  doc.technical.push(['Container', `GIF (${version})`], ['Dimensions', `${width}×${height}`], ['Frames', String(frames)]);
  if (loop !== null) doc.technical.push(['Loop', loop === 0 ? 'forever' : `${loop + 1} times`]);
  const kinds = [doc.blocks.some((x) => x.kind === 'comment') && 'comment', doc.sections.length && 'XMP', doc.blocks.some((x) => x.field && x.field.key === 'ICC') && 'ICC'].filter(Boolean);
  doc.technical.push(['Metadata', kinds.join(', ') || 'none']);
  doc.summary = `GIF · ${width}×${height}${frames > 1 ? ` · ${frames} frames` : ''}${kinds.length ? ' · ' + kinds.join(', ') : ''}`;
  return doc;
}

function collect(doc) {
  const out = [];
  for (const x of doc.blocks) if (x.field) out.push(x.field);
  out.push(...doc.newComments);
  const frames = doc.blocks.filter((x) => x.kind === 'image').length;
  if (!doc.imageField) doc.imageField = makeField({ cls: 'protected', kind: 'info', key: 'frames', label: 'Image frames', deletable: false, display: `${frames} frame${frames === 1 ? '' : 's'}` });
  out.push(doc.imageField);
  doc.fields = out;
}

export function addable() {
  return [{ key: 'comment', label: 'Comment' }];
}

export function addField(doc) {
  const f = makeField({ key: 'comment', label: 'Comment', kind: 'multiline', value: '', isNew: true });
  doc.newComments.push(f);
  collect(doc);
  return f;
}

export function removeNewField(doc, f) {
  doc.newComments.splice(doc.newComments.indexOf(f), 1);
  collect(doc);
}

export async function build(doc) {
  const file = doc.file;
  const parts = [file.slice(0, doc.headerEnd)];
  const added = doc.newComments.filter((f) => !f.deleted).map((f) => commentBlock(f.value));
  let inserted = false;
  for (const x of doc.blocks) {
    // New comments go before the first frame (and its graphic control extension).
    if (!inserted && (x.kind === 'image' || x.kind === 'ext')) { parts.push(...added); inserted = true; }
    const f = x.field;
    if (f && f.deleted) continue;
    if (f && x.kind === 'comment' && isChanged(f)) { parts.push(commentBlock(f.value)); continue; }
    parts.push(file.slice(x.start, x.end));
  }
  if (!inserted) parts.push(...added);
  parts.push(file.slice(doc.trailerAt));
  return parts;
}

export function provenance(doc) {
  const out = [];
  for (const f of doc.fields) if (f.key === 'comment' && !f.deleted && typeof f.value === 'string') out.push({ text: f.value, where: 'GIF comment' });
  return out;
}
