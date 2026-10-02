// ISO BMFF (M4A / MP4): box tree, iTunes-style ilst metadata, chunk-offset maintenance.

import {
  readBytes, u16be, u32be, u64be, i16be, putU32be, putU64be, fourcc, fourccBytes, concat, uuidString,
  formatBytes, formatDuration, partsSize,
} from './bytes.js';
import { decodeUtf8, decodeUtf16be, encodeUtf8, validateTrack16, validateBpm16, validateMp4Day, parseTrack } from './text.js';
import { makeField, isChanged, detectImageMime } from './fields.js';
import { C2PA_BMFF_UUID, jumbfFromBmffUuidPayload } from './c2pa.js';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'mvex', 'ilst']);
const TOP_KNOWN = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'pdin', 'meta', 'styp', 'sidx']);

export const ITEM_EDIT = {
  '©nam': { label: 'Title' },
  '©ART': { label: 'Artist' },
  aART: { label: 'Album artist' },
  '©alb': { label: 'Album' },
  '©gen': { label: 'Genre' },
  '©day': { label: 'Date', validate: validateMp4Day, placeholder: 'YYYY or YYYY-MM-DD' },
  trkn: { label: 'Track', kind: 'pair', validate: validateTrack16, placeholder: 'n or n/total' },
  disk: { label: 'Disc', kind: 'pair', validate: validateTrack16, placeholder: 'n or n/total' },
  tmpo: { label: 'BPM', kind: 'int', validate: validateBpm16, inputmode: 'numeric' },
  '©wrt': { label: 'Composer' },
  '©lyr': { label: 'Lyrics', kind: 'multiline' },
  '©cmt': { label: 'Comment', kind: 'multiline' },
  cprt: { label: 'Copyright' },
  covr: { label: 'Cover', kind: 'picture' },
};
const ITEM_PRESERVE = { '©too': 'Encoder', gnre: 'Genre (ID3v1 index)', '----': 'Freeform' };

const TIMED_TEXT = new Set(['sbtl', 'text']);

// ---- box parsing ----

function boxAt(buf, o, end) {
  if (o + 8 > end) throw new Error('truncated box header');
  const s32 = u32be(buf, o);
  const type = fourcc(buf, o + 4);
  let hdr = 8;
  let size = s32;
  let large = false;
  if (s32 === 1) {
    if (o + 16 > end) throw new Error('truncated largesize');
    size = u64be(buf, o + 8);
    hdr = 16;
    large = true;
  } else if (s32 === 0) {
    size = end - o;
  }
  if (type === 'uuid') hdr += 16;
  if (size < hdr || o + size > end) throw new Error(`invalid size for box '${type}'`);
  return { type, start: o, size, hdr, large, fb: 0, children: null, parent: null, tail: 0 };
}

function isQtMeta(buf, n) {
  const p = n.start + n.hdr;
  return p + 8 <= n.start + n.size && fourcc(buf, p + 4) === 'hdlr';
}

function parseChildren(buf, parent, depth) {
  const kids = [];
  const end = parent.start + parent.size;
  let o = parent.start + parent.hdr + parent.fb;
  while (o + 8 <= end) {
    const n = boxAt(buf, o, end);
    n.parent = parent;
    if (depth < 16) {
      const inIlst = parent.type === 'ilst';
      if (CONTAINERS.has(n.type) || inIlst || n.type === 'meta') {
        if (n.type === 'meta') n.fb = isQtMeta(buf, n) ? 0 : 4;
        try {
          n.children = parseChildren(buf, n, depth + 1);
        } catch (err) {
          if (!inIlst && n.type !== 'udta' && n.type !== 'meta' && n.type !== 'ilst') throw err;
          n.children = null;
          n.unparsed = true;
        }
      }
    }
    kids.push(n);
    o += n.size;
  }
  parent.tail = o;
  return kids;
}

export function parseMoov(buf) {
  const root = boxAt(buf, 0, buf.length);
  if (root.type !== 'moov') throw new Error('not a moov box');
  root.children = parseChildren(buf, root, 0);
  return root;
}

function child(n, type) { return n && n.children ? n.children.find((c) => c.type === type) || null : null; }
function path(n, ...types) { for (const t of types) n = child(n, t); return n; }

function walk(n, fn) {
  fn(n);
  if (n.children) for (const c of n.children) walk(c, fn);
}

// Chunk offsets of every stco/co64 in moov, in tree order.
export function readChunkOffsets(buf, root) {
  const out = [];
  walk(root, (n) => {
    if (n.type !== 'stco' && n.type !== 'co64') return;
    const p = n.start + n.hdr;
    const count = u32be(buf, p + 4);
    const w = n.type === 'stco' ? 4 : 8;
    if (p + 8 + count * w > n.start + n.size) throw new Error(`${n.type} entry count exceeds box size`);
    const list = new Array(count);
    for (let i = 0; i < count; i++) list[i] = w === 4 ? u32be(buf, p + 8 + i * 4) : u64be(buf, p + 8 + i * 8);
    out.push({ node: n, offsets: list });
  });
  return out;
}

// ---- box writing ----

export function makeBox(type, ...payload) {
  const body = concat(payload);
  const total = body.length + 8;
  if (total > 0xffffffff) {
    const h = new Uint8Array(16);
    putU32be(h, 0, 1); h.set(fourccBytes(type), 4); putU64be(h, 8, total + 8);
    return concat([h, body]);
  }
  const h = new Uint8Array(8);
  putU32be(h, 0, total); h.set(fourccBytes(type), 4);
  return concat([h, body]);
}

function wrapLike(buf, node, body) {
  const userType = node.type === 'uuid' ? buf.subarray(node.start + node.hdr - 16, node.start + node.hdr) : new Uint8Array(0);
  const large = node.large || body.length + userType.length + 8 > 0xffffffff;
  const hlen = (large ? 16 : 8) + userType.length;
  const total = hlen + body.length;
  const out = new Uint8Array(total);
  if (large) { putU32be(out, 0, 1); putU64be(out, 8, total); }
  else putU32be(out, 0, total);
  out.set(fourccBytes(node.type), 4);
  out.set(userType, large ? 16 : 8);
  out.set(body, hlen);
  return out;
}

function serialize(buf, node, ctx) {
  if (ctx.replace.has(node)) return ctx.replace.get(node);
  if ((node.type === 'stco' || node.type === 'co64') && ctx.map) return patchOffsets(buf, node, ctx.map);
  if (!ctx.affected.has(node)) return buf.subarray(node.start, node.start + node.size);
  const body = [buf.subarray(node.start + node.hdr, node.start + node.hdr + node.fb)];
  for (const c of node.children || []) {
    const s = serialize(buf, c, ctx);
    if (s) body.push(s);
  }
  for (const a of ctx.add.get(node) || []) body.push(a);
  if (node.children) body.push(buf.subarray(node.tail, node.start + node.size));
  return wrapLike(buf, node, concat(body));
}

function patchOffsets(buf, node, map) {
  const out = buf.slice(node.start, node.start + node.size);
  const p = node.hdr;
  const count = u32be(out, p + 4);
  for (let i = 0; i < count; i++) {
    if (node.type === 'stco') {
      const v = map(u32be(out, p + 8 + i * 4));
      if (v > 0xffffffff) throw new Error('Chunk offset exceeds 32 bits (stco); cannot grow file this far');
      putU32be(out, p + 8 + i * 4, v);
    } else {
      putU64be(out, p + 8 + i * 8, map(u64be(out, p + 8 + i * 8)));
    }
  }
  return out;
}

function markAffected(ctx, node) {
  for (let p = node; p; p = p.parent) ctx.affected.add(p);
}

// ---- ilst items ----

function dataBox(buf, d) {
  const p = d.start + d.hdr;
  return { type: (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3], locale: buf.slice(p + 4, p + 8), payload: buf.subarray(p + 8, d.start + d.size) };
}

function stringBox(buf, n) {
  // mean / name: FullBox + UTF-8 string
  return decodeUtf8(buf.subarray(n.start + n.hdr + 4, n.start + n.size));
}

function decodeData(d) {
  if (d.type === 1) return decodeUtf8(d.payload);
  if (d.type === 2) return decodeUtf16be(d.payload);
  if (d.type === 21 || d.type === 22) {
    const b = d.payload;
    if (b.length === 1) return String(d.type === 21 && b[0] > 127 ? b[0] - 256 : b[0]);
    if (b.length === 2) return String(d.type === 21 ? i16be(b, 0) : u16be(b, 0));
    if (b.length === 4) return String(d.type === 21 ? u32be(b, 0) | 0 : u32be(b, 0));
    if (b.length === 8) return String(u64be(b, 0));
  }
  return `type ${d.type}, ${formatBytes(d.payload.length)}`;
}

function pictureMime(d) {
  if (d.type === 13) return 'image/jpeg';
  if (d.type === 14) return 'image/png';
  if (d.type === 27) return 'image/bmp';
  return detectImageMime(d.payload) || 'application/octet-stream';
}

function itemFields(buf, item, timedText) {
  const type = item.type;
  const def = ITEM_EDIT[type];
  const base = { key: type, item, group: 'ilst' };
  const datas = item.children ? item.children.filter((c) => c.type === 'data') : [];
  if (!item.children || (def && datas.length === 0)) {
    return [makeField({ ...base, cls: 'preserve', kind: 'info', label: `Item ${type}`, display: `unparsed, ${formatBytes(item.size)}` })];
  }
  if (type === '----') {
    const mean = child(item, 'mean');
    const name = child(item, 'name');
    const val = datas[0] ? decodeData(dataBox(buf, datas[0])) : '';
    const m = mean ? stringBox(buf, mean) : '';
    const nm = name ? stringBox(buf, name) : '';
    return [makeField({ ...base, cls: 'preserve', kind: 'info', label: `Freeform: ${nm}`, display: `${m} · ${nm} = ${val}`, freeform: { mean: m, name: nm, value: val } })];
  }
  if (!def) {
    const val = datas.map((d) => decodeData(dataBox(buf, d))).join(' / ');
    return [makeField({ ...base, cls: 'preserve', kind: 'info', label: `${ITEM_PRESERVE[type] || 'Item'} (${type})`, display: val })];
  }
  if (def.kind === 'picture') {
    return datas.map((dn, i) => {
      const d = dataBox(buf, dn);
      const mime = pictureMime(d);
      const editable = d.type === 13 || d.type === 14;
      return makeField({ ...base, label: datas.length > 1 ? `Cover ${i + 1}` : 'Cover', kind: 'picture', value: { mime, data: d.payload.slice(), desc: '', ptype: 3 }, readOnly: !editable, dataIndex: i });
    });
  }
  const d = dataBox(buf, datas[0]);
  let value;
  if (def.kind === 'pair') {
    if (d.payload.length >= 6) {
      const n = u16be(d.payload, 2);
      const t = u16be(d.payload, 4);
      value = n || t ? (t ? `${n}/${t}` : String(n)) : '';
    } else value = '';
  } else if (def.kind === 'int') {
    value = decodeData(d.type === 0 ? { ...d, type: 21 } : d);
  } else {
    value = decodeData(d);
  }
  return [makeField({
    ...base, label: def.label, kind: def.kind === 'multiline' ? 'multiline' : 'text', value,
    validate: def.validate || null, placeholder: def.placeholder, inputmode: def.inputmode,
    note: type === '©lyr' && timedText ? 'This file has a timed-text track; its timed lyrics will not update.' : null,
  })];
}

function encodeItemData(f, origData) {
  const def = ITEM_EDIT[f.key];
  const locale = origData ? origData.locale : new Uint8Array(4);
  const v = f.value;
  let type;
  let payload;
  if (def.kind === 'pair') {
    const { n, total } = parseTrack(v);
    payload = new Uint8Array(f.key === 'trkn' ? 8 : 6);
    payload[2] = n >> 8; payload[3] = n & 255; payload[4] = total >> 8; payload[5] = total & 255;
    type = 0;
  } else if (def.kind === 'int') {
    const n = Number(v);
    payload = new Uint8Array([(n >> 8) & 255, n & 255]);
    type = 21;
  } else if (def.kind === 'picture') {
    type = v.mime === 'image/png' ? 14 : 13;
    payload = v.data;
  } else {
    type = 1;
    payload = encodeUtf8(v);
  }
  const head = new Uint8Array(8);
  head[1] = (type >> 16) & 255; head[2] = (type >> 8) & 255; head[3] = type & 255;
  head.set(locale, 4);
  return makeBox('data', head, payload);
}

// ---- load ----

export function detect(head) {
  if (head.length < 8) return false;
  const t = fourcc(head, 4);
  if (t === 'ftyp') return true;
  return TOP_KNOWN.has(t) && t !== 'meta' && u32be(head, 0) >= 8;
}

export async function load(file) {
  const doc = {
    format: 'MP4', file, fields: [], technical: [], notes: [], c2pa: null, readOnly: null,
    top: [], moovBox: null, moovBuf: null, moov: null, trailingStart: null,
  };
  let o = 0;
  let brands = null;
  while (o + 8 <= file.size) {
    const h = await readBytes(file, o, o + 32);
    const s32 = u32be(h, 0);
    const type = fourcc(h, 4);
    let size = s32;
    let hdr = 8;
    let large = false;
    if (s32 === 1) { size = u64be(h, 8); hdr = 16; large = true; }
    else if (s32 === 0) size = file.size - o;
    const userType = type === 'uuid' ? uuidString(h, hdr) : null;
    if (type === 'uuid') hdr += 16;
    if (size < hdr || o + size > file.size) throw new Error(`Box '${type}' at ${o} has an invalid size (file truncated?)`);
    const box = { type, start: o, size, hdr, large, userType, field: null };
    doc.top.push(box);
    const sizeStr = formatBytes(size);
    if (type === 'ftyp') {
      const b = await readBytes(file, o, o + Math.min(size, 256));
      brands = { major: fourcc(b, 8), minor: u32be(b, 12), compatible: [] };
      for (let p = 16; p + 4 <= b.length; p += 4) brands.compatible.push(fourcc(b, p));
      box.field = makeField({ cls: 'protected', kind: 'info', key: type, label: 'File type (ftyp)', deletable: false, display: `${brands.major.trim()} · ${brands.compatible.map((x) => x.trim()).join(', ')}` });
    } else if (type === 'moov' && !doc.moovBox) {
      doc.moovBox = box;
      doc.moovBuf = await readBytes(file, o, o + size);
      doc.moov = parseMoov(doc.moovBuf);
    } else if (type === 'mdat') {
      box.field = makeField({ cls: 'protected', kind: 'info', key: type, label: 'Media data (mdat)', deletable: false, display: sizeStr + (large ? ' (64-bit size)' : '') });
    } else if (type === 'uuid' && userType === C2PA_BMFF_UUID) {
      const payload = await readBytes(file, o + hdr, o + size);
      const { purpose, jumbf } = jumbfFromBmffUuidPayload(payload);
      const isStore = jumbf && purpose !== 'merkle';
      if (isStore && !doc.c2pa) doc.c2pa = { where: 'uuid box', jumbf, box };
      box.c2pa = isStore && doc.c2pa.box === box;
      box.field = makeField({ cls: 'protected', kind: 'info', key: 'uuid', label: `C2PA ${isStore ? 'manifest' : 'auxiliary'} (uuid${purpose ? ', ' + purpose : ''})`, deletable: false, display: sizeStr, c2pa: box.c2pa });
    } else if (type === 'moof' || type === 'mfra' || type === 'sidx' || type === 'styp') {
      doc.readOnly = 'Fragmented MP4 (moof/mvex): read-only.';
      box.field = makeField({ cls: 'protected', kind: 'info', key: type, label: `Fragment box (${type})`, deletable: false, display: sizeStr });
    } else {
      box.field = makeField({ cls: 'preserve', kind: 'info', key: type, label: type === 'uuid' ? `Box uuid ${userType}` : `Box '${type}'`, display: sizeStr, topBox: box });
    }
    o += size;
  }
  if (o < file.size) {
    doc.trailingStart = o;
    doc.trailingField = makeField({ cls: 'preserve', kind: 'info', key: 'trailing', label: 'Trailing bytes', display: formatBytes(file.size - o) });
  }
  if (!doc.moov) throw new Error('No moov box found');
  const buf = doc.moovBuf;
  const moov = doc.moov;
  if (child(moov, 'mvex')) doc.readOnly = 'Fragmented MP4 (moof/mvex): read-only.';

  // Tracks.
  const tracks = [];
  let timedText = false;
  let hasVideo = false;
  for (const trak of moov.children.filter((c) => c.type === 'trak')) {
    const hdlr = path(trak, 'mdia', 'hdlr');
    const handler = hdlr ? fourcc(buf, hdlr.start + hdlr.hdr + 8) : '????';
    const stsd = path(trak, 'mdia', 'minf', 'stbl', 'stsd');
    let entry = '????';
    let detail = '';
    if (stsd && stsd.size >= stsd.hdr + 16) {
      const e = stsd.start + stsd.hdr + 8;
      entry = fourcc(buf, e + 4);
      if (handler === 'soun' && e + 36 <= stsd.start + stsd.size) detail = `${u16be(buf, e + 24)} ch, ${u16be(buf, e + 32)} Hz, ${u16be(buf, e + 26)}-bit`;
      if (handler === 'vide' && e + 36 <= stsd.start + stsd.size) detail = `${u16be(buf, e + 32)}×${u16be(buf, e + 34)}`;
    }
    if (TIMED_TEXT.has(handler)) timedText = true;
    if (handler === 'vide') hasVideo = true;
    tracks.push({ handler, entry, detail });
  }
  doc.format = hasVideo ? 'MP4' : 'M4A';
  doc.timedText = timedText;

  // Metadata path.
  const udta = child(moov, 'udta');
  let meta = null;
  if (udta && udta.children) {
    for (const m of udta.children) {
      if (m.type !== 'meta' || !m.children) continue;
      const h = child(m, 'hdlr');
      if (h && fourcc(buf, h.start + h.hdr + 8) === 'mdir') { meta = m; break; }
    }
  }
  const ilst = meta ? child(meta, 'ilst') : null;
  doc.udta = udta;
  doc.meta = meta;
  doc.ilst = ilst && ilst.children ? ilst : null;
  doc.ilstFields = [];
  if (ilst && !ilst.children) doc.readOnly = doc.readOnly || 'ilst box could not be parsed: read-only.';
  if (udta && udta.unparsed) doc.readOnly = doc.readOnly || 'udta box could not be parsed: read-only.';
  if (doc.ilst) for (const item of doc.ilst.children) doc.ilstFields.push(...itemFields(buf, item, timedText));

  // moov-level fields.
  const moovFields = [];
  const sizeOf = (n) => formatBytes(n.size);
  for (const c of moov.children) {
    if (c.type === 'mvhd') moovFields.push(makeField({ cls: 'protected', kind: 'info', key: c.type, label: 'Movie header (mvhd)', deletable: false, display: sizeOf(c) }));
    else if (c.type === 'trak') {
      const t = tracks[moov.children.filter((x) => x.type === 'trak').indexOf(c)];
      moovFields.push(makeField({ cls: 'protected', kind: 'info', key: 'trak', label: `Track (${t.handler})`, deletable: false, display: `${t.entry}${t.detail ? ', ' + t.detail : ''}${TIMED_TEXT.has(t.handler) ? ' — timed text, read-only' : ''}` }));
    } else if (c.type === 'mvex') moovFields.push(makeField({ cls: 'protected', kind: 'info', key: c.type, label: 'Movie extends (mvex)', deletable: false, display: sizeOf(c) }));
    else if (c.type === 'udta' && c.children) {
      for (const u of c.children) {
        if (u === meta) {
          for (const mc of meta.children) {
            if (mc === ilst) continue;
            if (mc.type === 'hdlr') moovFields.push(makeField({ cls: 'protected', kind: 'info', key: 'hdlr', label: 'Metadata handler (meta/hdlr mdir)', deletable: false, display: sizeOf(mc) }));
            else moovFields.push(makeField({ cls: 'preserve', kind: 'info', key: mc.type, label: `meta/${mc.type}`, display: sizeOf(mc), node: mc }));
          }
        } else {
          moovFields.push(makeField({ cls: 'preserve', kind: 'info', key: u.type, label: `udta/${u.type}`, display: sizeOf(u), node: u }));
        }
      }
    } else if (c.type === 'meta') {
      moovFields.push(makeField({ cls: 'preserve', kind: 'info', key: 'meta', label: 'moov/meta (QuickTime keys/mdta)', display: sizeOf(c), node: c }));
    } else {
      moovFields.push(makeField({ cls: 'preserve', kind: 'info', key: c.type, label: `moov/${c.type}`, display: sizeOf(c), node: c }));
    }
  }
  doc.moovFields = moovFields;
  rebuildFieldList(doc);

  // Technical.
  const mvhd = child(moov, 'mvhd');
  let duration = 'unknown';
  if (mvhd) {
    const p = mvhd.start + mvhd.hdr;
    const v = buf[p];
    const ts = v === 1 ? u32be(buf, p + 20) : u32be(buf, p + 12);
    const du = v === 1 ? u64be(buf, p + 24) : u32be(buf, p + 16);
    if (ts) duration = formatDuration(du / ts);
  }
  doc.technical.push(['Container', `ISO BMFF (${doc.format})`]);
  if (brands) doc.technical.push(['Brands', `${brands.major} (${brands.compatible.join(', ')})`]);
  doc.technical.push(['Tags', doc.ilst ? 'iTunes ilst' : 'none']);
  doc.technical.push(['Duration', duration]);
  tracks.forEach((t, i) => doc.technical.push([`Track ${i + 1}`, `${t.handler} · ${t.entry}${t.detail ? ' · ' + t.detail : ''}`]));
  for (const f of doc.ilstFields) if (f.key === '©too') doc.technical.push(['Encoder (©too)', f.display]);
  const mdats = doc.top.filter((b) => b.type === 'mdat');
  const layout = doc.top.map((b) => b.type).join(' · ');
  doc.technical.push(['Layout', layout]);
  if (doc.readOnly) doc.notes.push(doc.readOnly);
  if (!mdats.length) doc.notes.push('No mdat box found.');
  doc.summary = `${doc.format} · ${tracks.map((t) => t.entry).join(' + ') || 'no tracks'} · ${doc.ilst ? 'iTunes metadata' : 'no ilst'}`;
  return doc;
}

function rebuildFieldList(doc) {
  const out = [];
  for (const b of doc.top) {
    if (b === doc.moovBox) out.push(...doc.ilstFields, ...doc.moovFields);
    else if (b.field) out.push(b.field);
  }
  if (doc.trailingField) out.push(doc.trailingField);
  doc.fields.length = 0;
  doc.fields.push(...out);
}

export function addable(doc) {
  if (doc.readOnly) return [];
  const live = doc.ilstFields.filter((f) => !f.deleted);
  return Object.keys(ITEM_EDIT).filter((k) => !live.some((f) => f.key === k)).map((k) => ({ key: k, label: ITEM_EDIT[k].label }));
}

export function addField(doc, key) {
  const def = ITEM_EDIT[key];
  const f = makeField({
    key, group: 'ilst', isNew: true, label: def.label,
    kind: def.kind === 'picture' ? 'picture' : def.kind === 'multiline' ? 'multiline' : 'text',
    value: def.kind === 'picture' ? { mime: '', data: null, desc: '', ptype: 3 } : '',
    validate: def.kind === 'picture' ? (v) => (v.data ? null : 'Choose an image') : def.validate || null,
    placeholder: def.placeholder, inputmode: def.inputmode,
    note: key === '©lyr' && doc.timedText ? 'This file has a timed-text track; its timed lyrics will not update.' : null,
  });
  doc.ilstFields.push(f);
  rebuildFieldList(doc);
  return f;
}

export function removeNewField(doc, f) {
  doc.ilstFields.splice(doc.ilstFields.indexOf(f), 1);
  rebuildFieldList(doc);
}

// ---- build ----

const MDIR_HDLR = concat([new Uint8Array(8), fourccBytes('mdir'), fourccBytes('appl'), new Uint8Array(9)]);

function buildIlstChildren(doc) {
  const buf = doc.moovBuf;
  const parts = [];
  const byItem = new Map();
  for (const f of doc.ilstFields) {
    if (!f.item) continue;
    if (!byItem.has(f.item)) byItem.set(f.item, []);
    byItem.get(f.item).push(f);
  }
  for (const item of doc.ilst ? doc.ilst.children : []) {
    const fs = byItem.get(item) || [];
    if (!fs.some(isChanged)) { parts.push(buf.subarray(item.start, item.start + item.size)); continue; }
    if (item.type === 'covr') {
      const datas = item.children.filter((c) => c.type === 'data');
      const keep = [];
      for (const f of fs) {
        if (f.deleted) continue;
        const dn = datas[f.dataIndex];
        keep.push(isChanged(f) ? encodeItemData(f, dataBox(buf, dn)) : buf.subarray(dn.start, dn.start + dn.size));
      }
      if (keep.length) {
        const others = item.children.filter((c) => c.type !== 'data').map((c) => buf.subarray(c.start, c.start + c.size));
        parts.push(makeBox('covr', ...others, ...keep));
      }
      continue;
    }
    const f = fs[0];
    if (f.deleted) continue;
    const datas = item.children.filter((c) => c.type === 'data');
    const others = item.children.filter((c) => c.type !== 'data').map((c) => buf.subarray(c.start, c.start + c.size));
    parts.push(makeBox(item.type, ...others, encodeItemData(f, dataBox(buf, datas[0]))));
  }
  for (const f of doc.ilstFields) {
    if (!f.isNew || f.deleted) continue;
    parts.push(makeBox(f.key, encodeItemData(f, null)));
  }
  return parts;
}

function findFree(doc, ctx) {
  const usable = (n) => n && n.type === 'free' && !ctx.replace.has(n);
  for (const scope of [doc.meta, doc.udta]) {
    if (!scope || !scope.children) continue;
    const f = scope.children.find(usable);
    if (f) return f;
  }
  return null;
}

function freeBox(size) {
  const b = new Uint8Array(size);
  putU32be(b, 0, size);
  b.set(fourccBytes('free'), 4);
  return b;
}

// Returns { parts, verify } where verify describes the chunk-offset remap.
export async function build(doc, opts = {}) {
  if (doc.readOnly) throw new Error(doc.readOnly);
  const file = doc.file;
  const buf = doc.moovBuf;
  const ctx = { replace: new Map(), add: new Map(), affected: new Set(), map: null };
  const replace = (n, v) => { ctx.replace.set(n, v); markAffected(ctx, n.parent); };
  const add = (parent, bytes) => {
    if (!ctx.add.has(parent)) ctx.add.set(parent, []);
    ctx.add.get(parent).push(bytes);
    markAffected(ctx, parent);
  };

  for (const f of doc.moovFields) if (f.node && f.deleted) replace(f.node, null);

  if (doc.ilstFields.some(isChanged)) {
    const items = buildIlstChildren(doc);
    if (doc.ilst) {
      replace(doc.ilst, wrapLike(buf, doc.ilst, concat(items)));
    } else if (items.length) {
      const ilstBox = makeBox('ilst', ...items);
      if (doc.meta) add(doc.meta, ilstBox);
      else {
        const metaBox = makeBox('meta', new Uint8Array(4), makeBox('hdlr', MDIR_HDLR), ilstBox);
        if (doc.udta && doc.udta.children) add(doc.udta, metaBox);
        else add(doc.moov, makeBox('udta', metaBox));
      }
    }
  }

  let moovBytes = ctx.affected.size ? serialize(buf, doc.moov, ctx) : null;
  if (moovBytes && moovBytes.length !== doc.moov.size) {
    const delta = moovBytes.length - doc.moov.size;
    const free = findFree(doc, ctx);
    if (free) {
      const n = free.size - delta;
      if (n >= 8 || n === 0) {
        replace(free, n ? freeBox(n) : null);
        moovBytes = serialize(buf, doc.moov, ctx);
      }
    }
  }

  // Top-level layout.
  const removeC2pa = !!opts.removeC2pa;
  let pos = 0;
  for (const b of doc.top) {
    const removed = (removeC2pa && b.c2pa) || (b.field && b.field.deleted);
    if (removed) { b.newStart = null; continue; }
    b.newStart = pos;
    pos += b === doc.moovBox && moovBytes ? moovBytes.length : b.size;
  }
  const moovRebuilt = !!moovBytes;
  const map = (off) => {
    for (const b of doc.top) {
      if (off >= b.start && off < b.start + b.size) {
        if (b.newStart === null) throw new Error(`A chunk offset points into a removed '${b.type}' box`);
        if (b === doc.moovBox && moovRebuilt) throw new Error('A chunk offset points into the rewritten moov box');
        return off - b.start + b.newStart;
      }
    }
    throw new Error('A chunk offset points outside the file');
  };
  const offsets = readChunkOffsets(buf, doc.moov);
  const moved = doc.top.some((b) => b.newStart !== null && b.newStart !== b.start);
  let verify = { entries: 0, remapped: false };
  if (moved && offsets.length) {
    ctx.map = map;
    for (const o of offsets) markAffected(ctx, o.node.parent);
    moovBytes = serialize(buf, doc.moov, ctx);
    // Verify: the rebuilt moov's offsets equal the mapped originals.
    const check = readChunkOffsets(moovBytes, parseMoov(moovBytes));
    if (check.length !== offsets.length) throw new Error('Offset verification failed: table count changed');
    for (let t = 0; t < offsets.length; t++) {
      const a = offsets[t].offsets;
      const b = check[t].offsets;
      if (a.length !== b.length) throw new Error('Offset verification failed: entry count changed');
      for (let i = 0; i < a.length; i++) if (b[i] !== map(a[i])) throw new Error('Offset verification failed');
    }
    verify = { entries: offsets.reduce((n, o) => n + o.offsets.length, 0), remapped: true, pairs: offsets.map((o, t) => ({ old: o.offsets, now: check[t].offsets })) };
  }

  const parts = [];
  for (const b of doc.top) {
    if (b.newStart === null) continue;
    if (b === doc.moovBox && moovBytes) parts.push(moovBytes);
    else parts.push(file.slice(b.start, b.start + b.size));
  }
  if (doc.trailingStart !== null && !(doc.trailingField && doc.trailingField.deleted)) parts.push(file.slice(doc.trailingStart));
  if (partsSize(parts) !== pos + (doc.trailingStart !== null && !(doc.trailingField && doc.trailingField.deleted) ? file.size - doc.trailingStart : 0)) {
    throw new Error('Internal size mismatch');
  }
  doc.lastVerify = verify;
  return parts;
}

// Compare payload bytes at old and new chunk offsets (sampled). Returns number of mismatches.
export async function verifyPayload(file, out, verify, maxSamples = 64) {
  if (!verify || !verify.remapped) return 0;
  let bad = 0;
  for (const p of verify.pairs) {
    const n = p.old.length;
    const step = Math.max(1, Math.floor(n / maxSamples));
    for (let i = 0; i < n; i += step) {
      const a = await readBytes(file, p.old[i], p.old[i] + 16);
      const b = await readBytes(out, p.now[i], p.now[i] + 16);
      if (a.length !== b.length || a.some((x, j) => x !== b[j])) bad++;
    }
  }
  return bad;
}

export function provenance(doc) {
  const out = [];
  for (const f of doc.ilstFields) if (f.key === '©cmt' && !f.deleted) out.push({ text: f.value, where: 'ilst ©cmt' });
  return out;
}
