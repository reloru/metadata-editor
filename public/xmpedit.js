// XMP (ISO 16684-1) property editing by splicing: only the changed byte ranges of the packet are replaced.
// Handles rdf:Description attributes, simple elements and rdf:Alt / rdf:Bag / rdf:Seq lists. Structured
// properties are listed and removable only.

import { makeField, isChanged } from './fields.js';
import { xmlText } from './text.js';

export const NS = {
  dc: 'http://purl.org/dc/elements/1.1/', photoshop: 'http://ns.adobe.com/photoshop/1.0/', xmp: 'http://ns.adobe.com/xap/1.0/',
  exif: 'http://ns.adobe.com/exif/1.0/', tiff: 'http://ns.adobe.com/tiff/1.0/', rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
};
const LIST = { 'dc:subject': 'Bag', 'dc:creator': 'Seq', 'dc:description': 'Alt', 'dc:title': 'Alt', 'dc:rights': 'Alt' };
const LABELS = {
  'dc:description': 'Caption', 'dc:subject': 'Keywords', 'dc:title': 'Title', 'dc:creator': 'Creator', 'dc:rights': 'Copyright',
  'photoshop:DateCreated': 'Date created', 'xmp:CreateDate': 'Create date', 'xmp:ModifyDate': 'Modify date', 'xmp:MetadataDate': 'Metadata date',
  'xmp:CreatorTool': 'Creator tool', 'exif:UserComment': 'User comment', 'tiff:Orientation': 'Orientation',
};
export const ADDABLE = ['dc:description', 'dc:subject', 'dc:title', 'dc:creator', 'dc:rights', 'photoshop:DateCreated'];
const DATE_PROPS = new Set(['photoshop:DateCreated', 'xmp:CreateDate', 'xmp:ModifyDate', 'xmp:MetadataDate', 'exif:DateTimeOriginal', 'exif:DateTimeDigitized']);
const SKIP = /^(xmlns|rdf|xml|x):/;

function escText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return escText(s).replace(/"/g, '&quot;'); }

function matchClose(xml, name, from) {
  const open = new RegExp(`<${name.replace(/[.]/g, '\\.')}(?=[\\s/>])`, 'g');
  const close = `</${name}>`;
  let depth = 1;
  let i = from;
  for (;;) {
    const c = xml.indexOf(close, i);
    if (c < 0) return -1;
    open.lastIndex = i;
    let m;
    while ((m = open.exec(xml)) && m.index < c) {
      const gt = xml.indexOf('>', m.index);
      if (xml[gt - 1] !== '/') depth++;
    }
    depth--;
    if (!depth) return c;
    i = c + close.length;
  }
}

// Parse a packet into descriptions and top-level properties with their character ranges.
export function parseXmp(xml) {
  const descs = [];
  const props = [];
  const re = /<rdf:Description\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tagStart = m.index;
    const tagEnd = m.index + m[0].length;
    const self = m[0].endsWith('/>');
    const d = { tagStart, tagEnd, self, closeAt: self ? -1 : matchClose(xml, 'rdf:Description', tagEnd) };
    if (!self && d.closeAt < 0) continue;
    // Skip descriptions nested inside another one's properties (structures).
    if (descs.some((p) => !p.self && tagStart > p.tagEnd && tagStart < p.closeAt)) continue;
    descs.push(d);
    const ar = /(\s+)([A-Za-z][\w.-]*:[\w.-]+)="([^"]*)"/g;
    const tag = m[0];
    let a;
    while ((a = ar.exec(tag))) {
      if (SKIP.test(a[2])) continue;
      const vStart = tagStart + a.index + a[0].length - 1 - a[3].length;
      props.push({ name: a[2], form: 'attr', start: tagStart + a.index, end: tagStart + a.index + a[0].length, vStart, vEnd: vStart + a[3].length, raw: a[3], desc: d });
    }
    if (self) continue;
    let i = tagEnd;
    const er = /<([A-Za-z][\w.-]*:[\w.-]+)(\s[^>]*?)?(\/?)>/y;
    for (;;) {
      while (i < d.closeAt && /\s/.test(xml[i])) i++;
      if (i >= d.closeAt) break;
      er.lastIndex = i;
      const e = er.exec(xml);
      if (!e) break;
      const name = e[1];
      const cStart = i + e[0].length;
      if (e[3] === '/') {
        if (!SKIP.test(name)) props.push({ name, form: 'elem', start: i, end: cStart, vStart: cStart, vEnd: cStart, raw: '', empty: true, desc: d });
        i = cStart;
        continue;
      }
      const c = matchClose(xml, name, cStart);
      if (c < 0) break;
      const end = c + name.length + 3;
      const inner = xml.slice(cStart, c);
      const p = { name, start: i, end, desc: d };
      const lm = /^\s*<rdf:(Alt|Bag|Seq)\b[^>]*>/.exec(inner);
      if (lm) {
        const listOpen = cStart + lm[0].length;
        const listClose = xml.indexOf(`</rdf:${lm[1]}>`, listOpen);
        const items = [];
        const lr = /<rdf:li\b([^>]*?)(?:\/>|>([\s\S]*?)<\/rdf:li>)/g;
        lr.lastIndex = listOpen;
        let li;
        while ((li = lr.exec(xml)) && li.index < listClose) items.push({ attrs: li[1] || '', raw: li[2] || '' });
        if (items.some((x) => /</.test(x.raw) || /parseType/.test(x.attrs))) p.form = 'struct';
        else Object.assign(p, { form: 'list', container: lm[1], cStart: listOpen, cEnd: listClose, items });
      } else if (/</.test(inner)) {
        p.form = 'struct';
      } else {
        Object.assign(p, { form: 'elem', vStart: cStart, vEnd: c, raw: inner });
      }
      if (!SKIP.test(name)) props.push(p);
      i = end;
    }
  }
  return { descs, props };
}

function propValue(p) {
  if (p.form === 'attr' || p.form === 'elem') return xmlText(p.raw);
  if (p.form === 'list') {
    if (p.container === 'Alt') {
      const def = p.items.find((x) => /xml:lang="x-default"/.test(x.attrs)) || p.items[0];
      return def ? xmlText(def.raw) : '';
    }
    return p.items.map((x) => xmlText(x.raw)).join('\n');
  }
  return null;
}

function validateXmp(v, f) {
  if (DATE_PROPS.has(f.xmpProp) && v !== '' && !/^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/.test(v)) return 'Use YYYY-MM-DDTHH:MM:SS±HH:MM';
  return null;
}

// Fields for every property of a packet.
export function xmpFields(xml, group = 'XMP', opts = {}) {
  const { props } = parseXmp(xml);
  return props.map((p, i) => {
    const v = propValue(p);
    const base = { group, key: p.name, label: LABELS[p.name] || p.name, xmpProp: p.name, xmpIndex: i };
    if (v === null || opts.readOnly) {
      return makeField({ ...base, cls: 'edit', kind: 'readonly', value: '', display: v === null ? 'structured value' : v, readOnly: !!opts.readOnly, deletable: !opts.readOnly });
    }
    const multi = p.form === 'list' && p.container !== 'Alt';
    return makeField({ ...base, kind: multi || v.includes('\n') || v.length > 60 ? 'multiline' : 'text', value: v, validate: validateXmp,
      note: multi ? 'One per line.' : null, placeholder: DATE_PROPS.has(p.name) ? 'YYYY-MM-DDTHH:MM:SS' : null });
  });
}

export function xmpAddable(fields) {
  const live = fields.filter((f) => !f.deleted);
  return ADDABLE.filter((n) => !live.some((f) => f.xmpProp === n)).map((n) => ({ key: `XMPPROP:${n}`, label: `${LABELS[n]} (XMP)` }));
}

export function newXmpField(key, group = 'XMP') {
  const name = key.slice('XMPPROP:'.length);
  const multi = LIST[name] && LIST[name] !== 'Alt';
  return makeField({ group, key: name, label: LABELS[name] || name, xmpProp: name, xmpIndex: -1, isNew: true, kind: multi ? 'multiline' : 'text', value: '',
    validate: validateXmp, note: multi ? 'One per line.' : null, placeholder: DATE_PROPS.has(name) ? 'YYYY-MM-DDTHH:MM:SS' : null });
}

export function xmpChanged(fields) {
  return fields.some((f) => isChanged(f));
}

function listBody(container, value) {
  const vals = container === 'Alt' ? [value] : value.split('\n').map((s) => s.trim()).filter(Boolean);
  return vals.map((v) => (container === 'Alt' ? `<rdf:li xml:lang="x-default">${escText(v)}</rdf:li>` : `<rdf:li>${escText(v)}</rdf:li>`)).join('');
}

function newElement(name, value) {
  const c = LIST[name];
  return c ? `<${name}><rdf:${c}>${listBody(c, value)}</rdf:${c}></${name}>` : `<${name}>${escText(value)}</${name}>`;
}

// Apply field edits; extra: [{ name, op: 'delete' }] for properties removed by other actions (location).
export function writeXmp(xml, fields, extraDeletes = []) {
  const { descs, props } = parseXmp(xml);
  const reps = [];
  const del = (p) => {
    let s = p.start;
    while (s > 0 && /[ \t\r\n]/.test(xml[s - 1])) s--;
    reps.push({ s, e: p.end, text: '' });
  };
  const deleted = new Set();
  for (const f of fields) {
    if (f.isNew || !isChanged(f)) continue;
    const p = props[f.xmpIndex];
    if (!p) continue;
    if (f.deleted) { del(p); deleted.add(p); continue; }
    if (p.form === 'attr') reps.push({ s: p.vStart, e: p.vEnd, text: escAttr(f.value) });
    else if (p.form === 'elem' && !p.empty) reps.push({ s: p.vStart, e: p.vEnd, text: escText(f.value) });
    else if (p.form === 'elem') reps.push({ s: p.start, e: p.end, text: newElement(p.name, f.value) });
    else if (p.form === 'list') reps.push({ s: p.cStart, e: p.cEnd, text: listBody(p.container, f.value) });
  }
  for (const x of extraDeletes) for (const p of props) if (!deleted.has(p) && x.test(p.name)) { del(p); deleted.add(p); }
  const added = fields.filter((f) => f.isNew && !f.deleted && f.value !== '');
  if (added.length) {
    const d = descs[0];
    if (!d) throw new Error('XMP has no rdf:Description to add properties to');
    const decl = [...new Set(added.map((f) => f.xmpProp.split(':')[0]))]
      .filter((pfx) => !new RegExp(`xmlns:${pfx}=`).test(xml) && NS[pfx]).map((pfx) => ` xmlns:${pfx}="${NS[pfx]}"`).join('');
    const body = added.map((f) => newElement(f.xmpProp, f.value)).join('');
    const close = d.self ? d.tagEnd - 2 : d.tagEnd - 1;
    if (decl) reps.push({ s: close, e: close, text: decl });
    if (d.self) reps.push({ s: d.tagEnd - 2, e: d.tagEnd, text: `>${body}</rdf:Description>` });
    else reps.push({ s: d.closeAt, e: d.closeAt, text: body });
  }
  reps.sort((a, b) => b.s - a.s || b.e - a.e);
  let out = xml;
  for (const r of reps) out = out.slice(0, r.s) + r.text + out.slice(r.e);
  return out;
}

export const GPS_PROPS = /^exif:GPS/;
