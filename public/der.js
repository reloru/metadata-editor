// Minimal DER (ITU-T X.690) reader: enough to show X.509 names/validity and RFC 3161 timestamp times.
// Nothing here validates signatures, chains or revocation.

import { decodeUtf8, decodeLatin1, decodeUtf16be } from './text.js';

// Read one TLV at b[o]. Returns { tag, cls, constructed, num, start, hdr, len, end }.
export function tlv(b, o, end = b.length) {
  if (o + 2 > end) throw new Error('DER: truncated header');
  const tag = b[o];
  let p = o + 1;
  let num = tag & 0x1f;
  if (num === 0x1f) {
    num = 0;
    for (let i = 0; ; i++) {
      if (p >= end || i > 4) throw new Error('DER: bad tag');
      const x = b[p++];
      num = num * 128 + (x & 0x7f);
      if (!(x & 0x80)) break;
    }
  }
  if (p >= end) throw new Error('DER: truncated length');
  let len = b[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > end) throw new Error('DER: unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (p + len > end) throw new Error('DER: length exceeds data');
  return { tag, cls: tag >> 6, constructed: (tag & 0x20) !== 0, num, start: o, hdr: p - o, len, end: p + len };
}

export function children(b, node) {
  const out = [];
  let o = node.start + node.hdr;
  while (o < node.end) {
    const c = tlv(b, o, node.end);
    out.push(c);
    o = c.end;
  }
  return out;
}

function body(b, n) { return b.subarray(n.start + n.hdr, n.end); }

export function oid(b, n) {
  const d = body(b, n);
  if (!d.length) return '';
  const parts = [Math.min(2, Math.floor(d[0] / 40)), d[0] - Math.min(2, Math.floor(d[0] / 40)) * 40];
  let v = 0;
  for (let i = 1; i < d.length; i++) {
    v = v * 128 + (d[i] & 0x7f);
    if (!(d[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join('.');
}

function str(b, n) {
  const d = body(b, n);
  if (n.tag === 0x0c) return decodeUtf8(d); // UTF8String
  if (n.tag === 0x1e) return decodeUtf16be(d); // BMPString
  return decodeLatin1(d); // Printable, IA5, Teletex, Visible
}

// UTCTime / GeneralizedTime -> ISO 8601 string (UTC when 'Z').
export function time(b, n) {
  const s = decodeLatin1(body(b, n));
  let m;
  if (n.tag === 0x17) {
    m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s);
    if (!m) return s;
    const y = +m[1] >= 50 ? '19' + m[1] : '20' + m[1];
    return `${y}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}Z`;
  }
  m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(\.\d+)?Z$/.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5] || '00'}:${m[6] || '00'}${m[7] || ''}Z`;
}

const NAME_KEYS = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST' };

// X.501 Name -> { CN, O, OU, C, L, ST } (first value of each).
export function name(b, n) {
  const out = {};
  for (const set of children(b, n)) {
    for (const atv of children(b, set)) {
      const [t, v] = children(b, atv);
      if (!t || !v || t.tag !== 0x06) continue;
      const k = NAME_KEYS[oid(b, t)];
      if (k && !(k in out)) out[k] = str(b, v);
    }
  }
  return out;
}

export function nameString(n) {
  if (!n) return '';
  const parts = [];
  if (n.CN) parts.push(n.CN);
  if (n.O && n.O !== n.CN) parts.push(n.O);
  if (n.C) parts.push(n.C);
  return parts.join(', ');
}

// X.509 certificate -> { subject, issuer, notBefore, notAfter }.
export function parseCertificate(b) {
  const cert = tlv(b, 0);
  const [tbs] = children(b, cert);
  const f = children(b, tbs);
  let i = 0;
  if (f[i] && f[i].tag === 0xa0) i++; // [0] version
  i += 2; // serialNumber, signature algorithm
  const issuer = name(b, f[i++]);
  const validity = children(b, f[i++]);
  const subject = name(b, f[i++]);
  return { subject, issuer, notBefore: time(b, validity[0]), notAfter: time(b, validity[1]) };
}

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';

// RFC 3161 TimeStampToken (CMS ContentInfo/SignedData wrapping TSTInfo) -> { genTime, tsa }.
// tsa is the subject of the embedded certificate that issued no other embedded certificate (the responder).
export function parseTimestampToken(b) {
  const ci = tlv(b, 0);
  const [type, wrap] = children(b, ci);
  if (oid(b, type) !== OID_SIGNED_DATA) throw new Error('not a CMS SignedData');
  const [sd] = children(b, wrap);
  const parts = children(b, sd);
  const eci = parts[2];
  const [, ex] = children(b, eci);
  const [octet] = children(b, ex);
  const tst = tlv(b, octet.start + octet.hdr, octet.end);
  const tf = children(b, tst);
  const gen = tf.find((x) => x.tag === 0x18);
  const out = { genTime: gen ? time(b, gen) : null, tsa: null };
  const certSet = parts.find((x) => x.tag === 0xa0);
  if (certSet) {
    const certs = [];
    for (const c of children(b, certSet)) {
      try { certs.push(parseCertificate(b.subarray(c.start, c.end))); } catch { /* skip non-X.509 entries */ }
    }
    const key = (n) => nameString(n);
    const leaf = certs.find((c) => !certs.some((o) => o !== c && key(o.issuer) === key(c.subject))) || certs[0];
    if (leaf) out.tsa = leaf.subject;
  }
  return out;
}
