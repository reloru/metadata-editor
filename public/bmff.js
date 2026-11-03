// ISO BMFF (M4A / MP4): box tree, iTunes-style ilst metadata, chunk-offset maintenance.

import {
  readBytes, u16be, u32be, u64be, i16be, putU32be, putU64be, fourcc, fourccBytes, concat, uuidString,
  formatBytes, formatDuration, partsSize, u32beBytes,
} from './bytes.js';
import { decodeUtf8, decodeUtf16be, encodeUtf8, validateTrack16, validateBpm16, validateMp4Day, validateBool, parseTrack } from './text.js';
import { gnreName } from './genres.js';
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
  '©grp': { label: 'Grouping' },
  desc: { label: 'Description', kind: 'multiline' },
  cpil: { label: 'Compilation', kind: 'bool', validate: validateBool, placeholder: '1 or 0', inputmode: 'numeric' },
  sonm: { label: 'Title sort' },
  soar: { label: 'Artist sort' },
  soal: { label: 'Album sort' },
  soaa: { label: 'Album artist sort' },
  soco: { label: 'Composer sort' },
};
const ITEM_PRESERVE = {
  '©too': 'Encoder', gnre: 'Genre (ID3v1 index)', '----': 'Freeform', rtng: 'Content rating', stik: 'Media kind', pgap: 'Gapless album',
  ldes: 'Long description', purd: 'Purchase date', '©enc': 'Encoded by', '©st3': 'Subtitle', '©wrk': 'Work', '©mvn': 'Movement name',
  '©mvi': 'Movement number', '©mvc': 'Movement count', shwm: 'Show work and movement', tvsh: 'TV show', tven: 'TV episode ID',
  tvsn: 'TV season', tves: 'TV episode', tvnn: 'TV network', hdvd: 'HD video', apID: 'Account', ownr: 'Owner', '©xyz': 'Location',
};
// Items stored as big-endian integers, often with data type 0 (implicit) rather than 21.
const INT_ITEMS = new Set(['gnre', 'cpil', 'pgap', 'rtng', 'stik', 'tmpo', 'hdvd', 'tves', 'tvsn', 'shwm', '©mvi', '©mvc', 'akID', 'cnID', 'geID', 'plID', 'sfID', 'atID', 'cmID']);
const TEXT_TYPES = new Set([1, 2]);

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
  const decodeItem = (dn) => {
    const d = dataBox(buf, dn);
    return decodeData(d.type === 0 && INT_ITEMS.has(type) ? { ...d, type: 22 } : d);
  };
  if (!def) {
    let val = datas.map(decodeItem).join(' / ');
    if (type === 'gnre' && /^\d+$/.test(val) && gnreName(Number(val))) val = `${gnreName(Number(val))} (${val})`;
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
  const plain = !def.kind || def.kind === 'multiline';
  if (datas.length > 1 && plain) {
    const all = datas.map((dn) => dataBox(buf, dn));
    const shown = `${datas.length} values: ${all.map((x) => decodeData(x)).join(' / ')}`;
    // Multi-line items (lyrics, comment) cannot use one line per value; keep them read-only.
    if (def.kind === 'multiline' || !all.every((x) => TEXT_TYPES.has(x.type))) {
      return [makeField({ ...base, cls: 'preserve', kind: 'info', label: `${def.label} (${type})`, display: shown })];
    }
    return [makeField({
      ...base, label: def.label, kind: 'multiline', multi: true, value: all.map((x) => decodeData(x)).join('\n'),
      note: 'Multiple values: one per line.', validate: null,
    })];
  }
  let value;
  if (def.kind === 'pair') {
    if (d.payload.length >= 6) {
      const n = u16be(d.payload, 2);
      const t = u16be(d.payload, 4);
      value = n || t ? (t ? `${n}/${t}` : String(n)) : '';
    } else value = '';
  } else if (def.kind === 'int' || def.kind === 'bool') {
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

function encodeItemData(f, origData, value = f.value) {
  const def = ITEM_EDIT[f.key];
  const locale = origData ? origData.locale : new Uint8Array(4);
  const v = value;
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
  } else if (def.kind === 'bool') {
    payload = new Uint8Array([Number(v) ? 1 : 0]);
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

// ---- QuickTime keys/mdta metadata (moov/meta with an 'mdta' handler) ----

const LOCATION_KEY = /location/i;

function qtKeys(buf, meta) {
  const keys = child(meta, 'keys');
  const ilst = child(meta, 'ilst');
  if (!keys || !ilst || !ilst.children) return null;
  const p = keys.start + keys.hdr;
  const n = u32be(buf, p + 4);
  const names = [];
  let o = p + 8;
  for (let i = 0; i < n && o + 8 <= keys.start + keys.size; i++) {
    const sz = u32be(buf, o);
    if (sz < 8) break;
    names.push(decodeUtf8(buf.subarray(o + 8, o + sz)));
    o += sz;
  }
  const items = ilst.children.map((it) => {
    const idx = u32be(buf, it.start + 4);
    const d = it.children ? it.children.find((x) => x.type === 'data') : null;
    return { node: it, idx, key: names[idx - 1] || `#${idx}`, value: d ? decodeData(dataBox(buf, d)) : '' };
  });
  return { meta, keys, ilst, names, items };
}

// 3GPP 'loci' (TS 26.244): FullBox, language, name, role, then 16.16 longitude, latitude, altitude.
function lociText(buf, n) {
  const end = n.start + n.size;
  let o = n.start + n.hdr + 6;
  const utf16 = buf[o] === 0xfe && buf[o + 1] === 0xff;
  if (utf16) { o += 2; while (o + 1 < end && (buf[o] || buf[o + 1])) o += 2; o += 2; } else { while (o < end && buf[o]) o++; o++; }
  o += 1;
  if (o + 12 > end) return 'unreadable';
  const fx = (x) => (u32be(buf, x) | 0) / 65536;
  return `${fx(o + 4).toFixed(5)}, ${fx(o).toFixed(5)}${fx(o + 8) ? `, ${fx(o + 8).toFixed(1)} m` : ''}`;
}

// Rebuild moov/meta keeping only the keys `keep` accepts; item indices are renumbered.
function rebuildQtMeta(buf, q, keep) {
  const kept = q.names.map((name, i) => ({ name, idx: i + 1 })).filter((k) => keep(k.name));
  const renum = new Map(kept.map((k, i) => [k.idx, i + 1]));
  const keyEntries = kept.map((k) => { const s = encodeUtf8(k.name); return concat([u32beBytes(8 + s.length), fourccBytes('mdta'), s]); });
  const keysBox = makeBox('keys', buf.subarray(q.keys.start + q.keys.hdr, q.keys.start + q.keys.hdr + 4), u32beBytes(kept.length), ...keyEntries);
  const items = [];
  for (const it of q.items) {
    if (!renum.has(it.idx)) continue;
    const body = buf.subarray(it.node.start + it.node.hdr, it.node.start + it.node.size);
    items.push(concat([u32beBytes(8 + body.length), u32beBytes(renum.get(it.idx)), body]));
  }
  const ilstBox = makeBox('ilst', ...items);
  const parts = q.meta.children.map((c) => (c === q.keys ? keysBox : c === q.ilst ? ilstBox : buf.subarray(c.start, c.start + c.size)));
  return wrapLike(buf, q.meta, concat([buf.subarray(q.meta.start + q.meta.hdr, q.meta.start + q.meta.hdr + q.meta.fb), ...parts]));
}

// ---- load ----

function mdhdTimescale(buf, trak) {
  const m = path(trak, 'mdia', 'mdhd');
  if (!m) return 0;
  const p = m.start + m.hdr;
  const off = buf[p] === 1 ? 20 : 12;
  return p + off + 4 <= m.start + m.size ? u32be(buf, p + off) : 0;
}

// Audio sample rate: the 16.16 field in the sample entry holds only rates below 65536 Hz and is fixed
// at 1.0 in QuickTime version-2 sound descriptions, so fall back to 'srat' or the media timescale.
function soundRate(buf, trak, stsd, e) {
  const end = stsd.start + stsd.size;
  const rate = u16be(buf, e + 32);
  const version = u16be(buf, e + 16);
  const entryEnd = Math.min(end, e + u32be(buf, e));
  const srat = indexOfType(buf, e + 36, entryEnd, 'srat');
  if (srat >= 0 && srat + 16 <= entryEnd) return u32be(buf, srat + 12);
  const ts = mdhdTimescale(buf, trak);
  if (ts && (rate === 0 || ts > 65535 || version === 2)) return ts;
  return rate;
}

// Offset of a child box of the given type within [o, end), or -1.
function indexOfType(buf, o, end, type) {
  while (o + 8 <= end) {
    const size = u32be(buf, o);
    if (fourcc(buf, o + 4) === type) return o;
    if (size < 8) return -1;
    o += size;
  }
  return -1;
}

export function detect(head) {
  if (head.length < 8) return false;
  const t = fourcc(head, 4);
  if (t === 'ftyp') return true;
  return TOP_KNOWN.has(t) && t !== 'meta' && u32be(head, 0) >= 8;
}

export async function load(file) {
  const doc = {
    format: 'MP4', file, fields: [], technical: [], notes: [], c2pa: null, readOnly: null,
    top: [], moovBox: null, moovBuf: null, moov: null, trailingStart: null, udtaLocations: [], qtList: [],
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
      if (handler === 'soun' && e + 36 <= stsd.start + stsd.size) detail = `${u16be(buf, e + 24)} ch, ${soundRate(buf, trak, stsd, e)} Hz, ${u16be(buf, e + 26)}-bit`;
      if (handler === 'vide' && e + 36 <= stsd.start + stsd.size) detail = `${u16be(buf, e + 32)}×${u16be(buf, e + 34)}`;
    }
    if (TIMED_TEXT.has(handler)) timedText = true;
    if (handler === 'vide') hasVideo = true;
    tracks.push({ handler, entry, detail });
  }
  doc.format = hasVideo ? (brands && brands.major === 'qt  ' ? 'MOV' : 'MP4') : 'M4A';
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
  const keysMetaField = (node, where) => {
    const q = node.children ? qtKeys(buf, node) : null;
    if (q) {
      doc.qtList.push(q);
      doc.sections = doc.sections || [];
      doc.sections.push({ title: `QuickTime metadata (${where} keys)`, rows: q.items.map((it) => [it.key.replace(/^com\.apple\.quicktime\./, ''), it.value]) });
    }
    return makeField({ cls: 'preserve', kind: 'info', key: 'meta', label: `QuickTime metadata (${where} keys)`, node,
      display: q ? `${q.items.length} items${q.items.some((it) => LOCATION_KEY.test(it.key)) ? ', includes location' : ''} · ${sizeOf(node)}` : sizeOf(node) });
  };
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
        } else if (u.type === 'meta' && u.children && qtKeys(buf, u)) {
          moovFields.push(keysMetaField(u, 'udta/meta'));
        } else if (u.type === '\u00a9xyz' || u.type === 'loci') {
          const loc = u.type === 'loci' ? lociText(buf, u) : decodeUtf8(buf.subarray(u.start + u.hdr + 4, Math.min(u.start + u.size, u.start + u.hdr + 4 + u16be(buf, u.start + u.hdr))));
          doc.udtaLocations.push({ node: u, value: loc });
          moovFields.push(makeField({ cls: 'preserve', kind: 'info', key: u.type, label: `Location (udta/${u.type})`, display: loc, node: u }));
        } else {
          moovFields.push(makeField({ cls: 'preserve', kind: 'info', key: u.type, label: `udta/${u.type}`, display: sizeOf(u), node: u }));
        }
      }
    } else if (c.type === 'meta') {
      moovFields.push(keysMetaField(c, 'moov/meta'));
    } else {
      moovFields.push(makeField({ cls: 'preserve', kind: 'info', key: c.type, label: `moov/${c.type}`, display: sizeOf(c), node: c }));
    }
  }
  doc.moovFields = moovFields;
  const qtLoc = doc.qtList.flatMap((q) => q.items.filter((it) => LOCATION_KEY.test(it.key)));
  if (qtLoc.length || doc.udtaLocations.length) {
    const iso = qtLoc.find((it) => /ISO6709$/.test(it.key));
    doc.locationField = makeField({ cls: 'edit', kind: 'readonly', key: 'location', label: 'Location', value: '',
      display: (iso && iso.value) || (doc.udtaLocations[0] && doc.udtaLocations[0].value) || qtLoc.map((it) => it.value).join(', '),
      deleteLabel: 'Remove location', note: 'Removing deletes only the location entries; other metadata stays.' });
  }
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
    const created = v === 1 ? u64be(buf, p + 4) : u32be(buf, p + 4);
    if (created) doc.created = new Date(Date.UTC(1904, 0, 1) + created * 1000).toISOString().replace('.000Z', 'Z');
  }
  doc.technical.push(['Container', `ISO BMFF (${doc.format})`]);
  if (brands) doc.technical.push(['Brands', `${brands.major} (${brands.compatible.join(', ')})`]);
  doc.technical.push(['Tags', doc.ilst ? 'iTunes ilst' : 'none']);
  doc.technical.push(['Duration', duration]);
  if (doc.created) doc.technical.push(['Created (mvhd)', doc.created]);
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
  if (doc.locationField) out.push(doc.locationField);
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
    let newData;
    if (f.multi) {
      const lines = f.value.split('\n').filter((x) => x !== '');
      newData = (lines.length ? lines : ['']).map((line, i) => encodeItemData(f, dataBox(buf, datas[Math.min(i, datas.length - 1)]), line));
    } else {
      // Any further data boxes of a single-value item are kept as they were.
      newData = [encodeItemData(f, dataBox(buf, datas[0])), ...datas.slice(1).map((dn) => buf.subarray(dn.start, dn.start + dn.size))];
    }
    parts.push(makeBox(item.type, ...others, ...newData));
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
  if (doc.locationField && doc.locationField.deleted) {
    for (const l of doc.udtaLocations) if (!ctx.replace.has(l.node)) replace(l.node, null);
    for (const q of doc.qtList) {
      if (q.names.some((k) => LOCATION_KEY.test(k)) && !ctx.replace.has(q.meta)) replace(q.meta, rebuildQtMeta(buf, q, (k) => !LOCATION_KEY.test(k)));
    }
  }

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
