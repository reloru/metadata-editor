// Field model shared by all formats.
//
// cls:  'edit' | 'preserve' | 'protected'
// kind: 'text' | 'multiline' | 'url' | 'comment' | 'lyrics' | 'picture' | 'info'
//   comment/lyrics value: { lang, desc, text }  (ID3 COMM / USLT)
//   picture value:        { mime, data, desc, ptype }

let nextUid = 1;

export function cloneValue(v) {
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) return { ...v };
  return v;
}

export function valueEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export function makeField(props) {
  const f = {
    uid: nextUid++,
    cls: 'edit',
    kind: 'text',
    key: '',
    label: '',
    group: null,
    value: '',
    display: null,
    deletable: true,
    readOnly: false,
    deleted: false,
    isNew: false,
    validate: null,
    note: null,
    ...props,
  };
  f.orig = cloneValue(f.value);
  return f;
}

export function isChanged(f) {
  if (f.isNew) return !f.deleted;
  if (f.deleted) return true;
  if (f.cls !== 'edit' || f.readOnly) return false;
  return !valueEqual(f.value, f.orig);
}

export function revertField(f) {
  f.value = cloneValue(f.orig);
  f.deleted = false;
}

export function fieldError(f) {
  if (f.deleted || f.cls !== 'edit' || f.readOnly) return null;
  if (!isChanged(f)) return null;
  return f.validate ? f.validate(f.value, f) : null;
}

export function detectImageMime(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
      data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png';
  return null;
}

export const PICTURE_TYPES = [
  'Other', '32x32 file icon', 'Other file icon', 'Front cover', 'Back cover', 'Leaflet page', 'Media',
  'Lead artist', 'Artist', 'Conductor', 'Band', 'Composer', 'Lyricist', 'Recording location',
  'During recording', 'During performance', 'Video screen capture', 'Bright coloured fish', 'Illustration',
  'Band logotype', 'Publisher logotype',
];
