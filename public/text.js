// Text encodings, Suno provenance parsing and field validators.

const utf8Dec = new TextDecoder('utf-8');
const utf8DecFatal = new TextDecoder('utf-8', { fatal: true });
const utf8Enc = new TextEncoder();

export function decodeUtf8(b) { return utf8Dec.decode(b); }
export function encodeUtf8(s) { return utf8Enc.encode(s); }

export function decodeLatin1(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
export function isLatin1(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return false;
  return true;
}
export function encodeLatin1(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 255) throw new Error('not representable in ISO-8859-1');
    b[i] = c;
  }
  return b;
}

// UTF-16 with optional BOM; no BOM means big-endian.
export function decodeUtf16(b, defaultLE = false) {
  let le = defaultLE;
  let o = 0;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { le = true; o = 2; }
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { le = false; o = 2; }
  let s = '';
  for (; o + 1 < b.length; o += 2) s += String.fromCharCode(le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  return s;
}
export function decodeUtf16be(b) { return decodeUtf16(b, false); }

// UTF-16LE with BOM FF FE.
export function encodeUtf16Bom(s) {
  const b = new Uint8Array(2 + s.length * 2);
  b[0] = 0xff; b[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[2 + i * 2] = c & 255;
    b[3 + i * 2] = c >>> 8;
  }
  return b;
}

// UTF-8 if the bytes are valid UTF-8, else ISO-8859-1.
export function decodeUtf8OrLatin1(b) {
  try { return utf8DecFatal.decode(b); } catch { return decodeLatin1(b); }
}

export function stripTrailingNulls(s) { return s.replace(/\u0000+$/, ''); }

// Suno provenance: "made with suno; created=<timestamp>; id=<uuid>"
const SUNO_RE = /made with suno;\s*created=([^;]*?)\s*;\s*id=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/i;
export function parseSuno(s) {
  if (typeof s !== 'string') return null;
  const m = SUNO_RE.exec(s);
  if (!m) return null;
  return { created: m[1].trim(), id: m[2].toLowerCase() };
}

// ---- validators: return an error string or null ----

export function validateTrack(v) {
  if (v === '') return null;
  const m = /^(\d+)(?:\/(\d+))?$/.exec(v);
  if (!m) return 'Use "n" or "n/total"';
  return null;
}
export function validateTrack16(v) {
  const e = validateTrack(v);
  if (e) return e;
  if (v === '') return null;
  for (const p of v.split('/')) if (Number(p) > 65535) return 'Numbers must be ≤ 65535';
  return null;
}
export function parseTrack(v) {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(v);
  if (!m) return { n: 0, total: 0 };
  return { n: Number(m[1]), total: m[2] ? Number(m[2]) : 0 };
}

export function validateBpm(v) {
  if (v === '') return null;
  return /^\d+$/.test(v) ? null : 'Whole number';
}
export function validateBpm16(v) {
  const e = validateBpm(v);
  if (e) return e;
  return v !== '' && Number(v) > 32767 ? 'Must be ≤ 32767' : null;
}

// ISO 3901: 2-letter country code, 3 alphanumeric registrant, 2-digit year, 5-digit designation.
export function validateIsrc(v) {
  if (v === '') return null;
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v) ? null : '12 characters: CC XXX YY NNNNN (uppercase, no hyphens)';
}

function validDate(y, mo, d) {
  if (mo < 1 || mo > 12) return false;
  if (d === undefined) return true;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d >= 1 && d <= dim;
}

export function validateYear(v) {
  if (v === '') return null;
  return /^\d{4}$/.test(v) ? null : 'YYYY';
}

// ID3v2.4 timestamp: yyyy[-MM[-dd[THH[:mm[:ss]]]]]
export function validateId3Timestamp(v) {
  if (v === '') return null;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2}))?)?)?)?)?$/.exec(v);
  if (!m) return 'yyyy, yyyy-MM, yyyy-MM-dd or yyyy-MM-ddTHH:mm:ss';
  if (m[2] && !validDate(+m[1], +m[2], m[3] ? +m[3] : undefined)) return 'Invalid date';
  if (m[4] && +m[4] > 23) return 'Invalid hour';
  if (m[5] && +m[5] > 59) return 'Invalid minute';
  if (m[6] && +m[6] > 59) return 'Invalid second';
  return null;
}

export function validateIsoDay(v) {
  if (v === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return 'YYYY-MM-DD';
  return validDate(+m[1], +m[2], +m[3]) ? null : 'Invalid date';
}

// MP4 ©day: year, date, or ISO 8601 date-time.
export function validateMp4Day(v) {
  if (v === '') return null;
  const m = /^(\d{4})(?:-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)?$/.exec(v);
  if (!m) return 'YYYY, YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ';
  if (m[2] && !validDate(+m[1], +m[2], +m[3])) return 'Invalid date';
  if (m[4] && (+m[4] > 23 || +m[5] > 59 || (m[6] && +m[6] > 59))) return 'Invalid time';
  return null;
}

// ID3 language: 3 ISO-8859-1 characters (ISO 639-2 code, or "XXX" for unknown).
export function validateLang(v) {
  return v.length === 3 && isLatin1(v) ? null : '3-letter ISO 639-2 code (e.g. eng)';
}
