// C2PA manifest store reading (JUMBF, ISO/IEC 19566-5) and data-hash checking.
// Signatures and certificates are not validated.

import { u32be, u64be, fourcc, uuidString, indexOfSeq } from './bytes.js';
import { decodeCbor, CborTag, CborSimple, CBOR_UNDEFINED } from './cbor.js';
import { decodeUtf8 } from './text.js';

export const C2PA_MIME = 'application/c2pa';
export const C2PA_BMFF_UUID = 'd8fec3d6-1b0e-483c-9297-5828877ec481';

// Parse a sequence of boxes in b[start, end).
function parseBoxes(b, start, end, depth) {
  if (depth > 32) throw new Error('JUMBF nesting too deep');
  const boxes = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32be(b, o);
    const type = fourcc(b, o + 4);
    let hdr = 8;
    if (size === 1) {
      if (o + 16 > end) throw new Error('JUMBF: truncated XLBox');
      size = u64be(b, o + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < hdr || o + size > end) throw new Error(`JUMBF: invalid size for box '${type}'`);
    const box = { type, start: o, size, payloadStart: o + hdr, payloadEnd: o + size };
    if (type === 'jumb') {
      box.children = parseBoxes(b, box.payloadStart, box.payloadEnd, depth + 1);
      const d = box.children[0];
      if (d && d.type === 'jumd') Object.assign(box, parseJumd(b, d.payloadStart, d.payloadEnd));
    }
    boxes.push(box);
    o += size;
  }
  return boxes;
}

// Description box: 16-byte type UUID, toggles byte, optional label/ID/hash/private.
function parseJumd(b, s, e) {
  if (e - s < 17) throw new Error('JUMBF: short description box');
  const out = { jumbfType: uuidString(b, s), toggles: b[s + 16], label: null };
  let o = s + 17;
  if (out.toggles & 0x02) {
    let z = o;
    while (z < e && b[z] !== 0) z++;
    out.label = decodeUtf8(b.subarray(o, z));
    o = z + 1;
  }
  return out;
}

function contentOf(b, box) {
  const c = box.children.find((x) => x.type !== 'jumd');
  if (!c) return { kind: 'empty' };
  const raw = b.subarray(c.payloadStart, c.payloadEnd);
  if (c.type === 'cbor') {
    try { return { kind: 'cbor', value: decodeCbor(raw) }; }
    catch (err) { return { kind: 'error', error: 'CBOR: ' + err.message }; }
  }
  if (c.type === 'json') {
    try { return { kind: 'json', value: JSON.parse(decodeUtf8(raw)) }; }
    catch (err) { return { kind: 'error', error: 'JSON: ' + err.message }; }
  }
  return { kind: 'box', boxType: c.type, size: raw.length };
}

function baseLabel(label) {
  return (label || '').replace(/__\d+$/, '');
}

// Parse a C2PA Manifest Store from JUMBF bytes.
export function parseManifestStore(bytes) {
  const top = parseBoxes(bytes, 0, bytes.length, 0);
  const store = top.find((x) => x.type === 'jumb');
  if (!store) throw new Error('No JUMBF superbox found');
  const manifests = [];
  for (const m of store.children) {
    if (m.type !== 'jumb') continue;
    const manifest = { label: m.label, assertions: [], claim: null, claimLabel: null };
    for (const part of m.children) {
      if (part.type !== 'jumb') continue;
      const bl = baseLabel(part.label);
      if (bl === 'c2pa.assertions') {
        for (const a of part.children) {
          if (a.type !== 'jumb') continue;
          manifest.assertions.push({ label: a.label, base: baseLabel(a.label), ...contentOf(bytes, a) });
        }
      } else if (bl === 'c2pa.claim.v2' || bl === 'c2pa.claim') {
        const c = contentOf(bytes, part);
        manifest.claimLabel = part.label;
        manifest.claim = c.kind === 'cbor' ? c.value : null;
      }
    }
    manifests.push(manifest);
  }
  return { label: store.label, manifests, active: manifests[manifests.length - 1] || null, length: store.size };
}

// Locate the JUMBF inside a BMFF C2PA uuid box payload (bytes after the 16-byte usertype).
export function jumbfFromBmffUuidPayload(p) {
  let purpose = null;
  if (p.length > 4) {
    let z = 4;
    while (z < p.length && p[z] !== 0) z++;
    purpose = decodeUtf8(p.subarray(4, z));
  }
  const at = indexOfSeq(p, [0x6a, 0x75, 0x6d, 0x62]); // 'jumb'
  if (at < 4) return { purpose, jumbf: null };
  const start = at - 4;
  let size = u32be(p, start);
  if (size === 0) size = p.length - start;
  else if (size === 1) size = u64be(p, start + 8);
  return { purpose, jumbf: p.subarray(start, Math.min(p.length, start + size)) };
}

// ---- display helpers ----

export function displayValue(v, depth = 0) {
  if (depth > 6) return '…';
  if (v === null) return 'null';
  if (v === CBOR_UNDEFINED) return 'undefined';
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (v instanceof CborTag) return v.tag === 0 || v.tag === 1 ? displayValue(v.value, depth) : `tag(${v.tag}) ${displayValue(v.value, depth + 1)}`;
  if (v instanceof CborSimple) return `simple(${v.value})`;
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return '[' + v.map((x) => displayValue(x, depth + 1)).join(', ') + ']';
  if (v instanceof Map) return '{' + [...v].map(([k, x]) => `${displayValue(k, depth + 1)}: ${displayValue(x, depth + 1)}`).join(', ') + '}';
  if (typeof v === 'object') return '{' + Object.keys(v).map((k) => `${k}: ${displayValue(v[k], depth + 1)}`).join(', ') + '}';
  return String(v);
}

// Flatten an object into [path, value] rows.
export function flatten(v, prefix = '', out = [], depth = 0) {
  const isObj = v && typeof v === 'object' && !(v instanceof Uint8Array) && !(v instanceof CborTag) && !(v instanceof Map) && !(v instanceof CborSimple);
  if (isObj && depth < 6) {
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    if (keys.length === 0) out.push([prefix || '(empty)', Array.isArray(v) ? '[]' : '{}']);
    for (const k of keys) flatten(v[k], prefix === '' ? String(k) : `${prefix}.${k}`, out, depth + 1);
  } else {
    out.push([prefix || '(value)', displayValue(v, depth)]);
  }
  return out;
}

function nameOf(info) {
  if (!info) return null;
  if (typeof info === 'string') return info;
  if (typeof info === 'object' && typeof info.name === 'string') return info.version ? `${info.name} ${info.version}` : info.name;
  return displayValue(info);
}

// Summary of a parsed store for display.
export function summarize(store) {
  const m = store.active;
  const out = { manifestCount: store.manifests.length, activeLabel: m ? m.label : null, assertions: [], actions: [], suno: [], generator: [], hashes: [] };
  if (!m) return out;
  out.assertions = m.assertions.map((a) => a.label);
  const claim = m.claim;
  if (claim && typeof claim === 'object') {
    const gi = claim.claim_generator_info;
    if (Array.isArray(gi)) for (const g of gi) out.generator.push(nameOf(g));
    else if (gi) out.generator.push(nameOf(gi));
    if (typeof claim.claim_generator === 'string' && !out.generator.length) out.generator.push(claim.claim_generator);
  }
  for (const a of m.assertions) {
    if ((a.base === 'c2pa.actions.v2' || a.base === 'c2pa.actions') && a.value && Array.isArray(a.value.actions)) {
      for (const act of a.value.actions) {
        out.actions.push({
          action: act.action,
          digitalSourceType: act.digitalSourceType || (act.parameters && act.parameters.digitalSourceType) || null,
          softwareAgent: nameOf(act.softwareAgent),
          when: act.when instanceof CborTag ? displayValue(act.when) : act.when || null,
        });
      }
    }
    if (a.base === 'com.suno.provenance') {
      if (a.value !== undefined) out.suno.push(...flatten(a.value));
      else if (a.error) out.suno.push(['error', a.error]);
    }
    if (a.base.startsWith('c2pa.hash.')) out.hashes.push(a.base);
  }
  return out;
}

const ALGS = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

// Find the hard-binding hash assertion in the active manifest.
export function hashBinding(store) {
  const m = store.active;
  if (!m) return { kind: 'none' };
  const data = m.assertions.find((a) => a.base === 'c2pa.hash.data');
  if (data) return { kind: 'data', assertion: data.value, claimAlg: m.claim && m.claim.alg };
  const other = m.assertions.find((a) => a.base.startsWith('c2pa.hash.'));
  if (other) return { kind: 'other', label: other.base };
  return { kind: 'none' };
}

function toNum(x) {
  if (typeof x === 'bigint') {
    if (x > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('exclusion out of range');
    return Number(x);
  }
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) throw new Error('invalid exclusion value');
  return x;
}

// SHA-2 over the whole file minus the exclusion ranges. Reads the whole file into memory.
export async function checkDataHash(blob, assertion, claimAlg) {
  if (!assertion || !(assertion.hash instanceof Uint8Array)) return { result: 'error', message: 'Malformed c2pa.hash.data assertion' };
  const algName = assertion.alg || claimAlg;
  const alg = ALGS[algName];
  if (!alg) return { result: 'error', message: `Unsupported or missing hash algorithm: ${algName || '(none)'}` };
  let ranges;
  try {
    ranges = (assertion.exclusions || []).map((r) => ({ start: toNum(r.start), length: toNum(r.length) }));
  } catch (err) {
    return { result: 'error', message: err.message };
  }
  ranges.sort((a, b) => a.start - b.start);
  const all = new Uint8Array(await blob.arrayBuffer());
  for (const r of ranges) if (r.start + r.length > all.length) return { result: 'mismatch', alg: algName, message: 'Exclusion range lies beyond end of file' };
  let keep = all.length;
  let last = 0;
  for (const r of ranges) {
    if (r.start < last) return { result: 'error', message: 'Overlapping exclusion ranges' };
    keep -= r.length;
    last = r.start + r.length;
  }
  const buf = new Uint8Array(keep);
  let o = 0;
  let pos = 0;
  for (const r of ranges) {
    buf.set(all.subarray(pos, r.start), o);
    o += r.start - pos;
    pos = r.start + r.length;
  }
  buf.set(all.subarray(pos), o);
  const digest = new Uint8Array(await crypto.subtle.digest(alg, buf));
  const expected = assertion.hash;
  const match = digest.length === expected.length && digest.every((x, i) => x === expected[i]);
  return { result: match ? 'match' : 'mismatch', alg: algName };
}
