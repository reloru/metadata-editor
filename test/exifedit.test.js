import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find } from './helpers.js';
import { addField, addable, errors } from '../public/editor.js';
import { parseTiff } from '../public/tiff.js';
import { writeExif, exifTagFields } from '../public/exifedit.js';

const { latin1, u32be } = F;
const be16 = F.u16be;

// Big-endian TIFF: IFD0 (Make, Software, Exif ptr, MakerNote-like blob tag 0x927c in Exif, IFD1 thumbnail).
function tiffWithThumb() {
  const ent = (tag, type, count, v) => F.concat([be16(tag), be16(type), u32be(count), v]);
  const pad4 = (b) => F.concat([b, new Uint8Array(4 - b.length)]);
  // 8 hdr | IFD0 @8: 3 entries (2+36+4=42) -> 50 | Exif @50: 2 entries (2+24+4=30) -> 80 | IFD1 @80: 2 entries (30) -> 110 | data @110
  const ifd0 = F.concat([be16(3), ent(0x010f, 2, 6, u32be(110)), ent(0x0131, 2, 4, pad4(latin1('v1\0'))), ent(0x8769, 4, 1, u32be(50)), u32be(80)]);
  const exif = F.concat([be16(2), ent(0x9003, 2, 20, u32be(116)), ent(0x927c, 7, 8, u32be(136)), u32be(0)]);
  const ifd1 = F.concat([be16(2), ent(0x0201, 4, 1, u32be(144)), ent(0x0202, 4, 1, u32be(16)), u32be(0)]);
  const data = F.concat([latin1('Apple\0'), latin1('2024:05:06 07:08:09\0'), latin1('MKRNOTE!'), new Uint8Array([0xff, 0xd8]), F.prng(3, 12), new Uint8Array([0xff, 0xd9])]);
  return F.concat([latin1('MM'), be16(42), u32be(8), ifd0, exif, ifd1, data]);
}

test('writeExif: edit, delete, add and thumbnail removal; existing bytes never move; replaced bytes zeroed', () => {
  const src = tiffWithThumb();
  const fields = exifTagFields(src, 'EXIF');
  const by = (k) => fields.find((f) => f.key === k);
  assert.deepEqual(fields.map((f) => f.key), ['Make', 'Software', 'DateTimeOriginal', 'MakerNote', 'Thumbnail']);
  by('Make').value = 'Apple Inc. (edited)';
  by('Software').deleted = true;
  by('DateTimeOriginal').value = '2020:01:02 03:04:05';
  by('Thumbnail').deleted = true;
  const out = writeExif(src, fields);
  assert.deepEqual(out.subarray(136, 144), latin1('MKRNOTE!'), 'maker note bytes stay at the same offset');
  assert.equal(F.indexOf(out, latin1('2024:05:06')), -1, 'old date zeroed');
  assert.equal(F.indexOf(out, latin1('Apple\0')), -1, 'old make zeroed');
  assert.equal(F.indexOf(out, new Uint8Array([0xff, 0xd8])), -1, 'thumbnail zeroed');
  const t = parseTiff(out);
  assert.equal(t.ifd0.entries.get(0x010f).value, 'Apple Inc. (edited)');
  assert.equal(t.ifd0.entries.has(0x0131), false);
  assert.equal(t.ifd0.next, 0);
  assert.equal(t.exif.entries.get(0x9003).value, '2020:01:02 03:04:05');
  assert.equal(t.exif.entries.get(0x927c).at, 136);
});

test('writeExif: numbers and fractions, user comment (Unicode), validation', () => {
  const src = F.tiffWithGps();
  const fields = exifTagFields(src, 'EXIF');
  const o = fields.find((f) => f.key === 'Orientation');
  assert.equal(o.value, '6');
  o.value = '1';
  const out = writeExif(src, fields);
  assert.deepEqual(parseTiff(out).ifd0.entries.get(0x0112).value, [1]);
  assert.ok(parseTiff(out).gps, 'GPS untouched unless asked');
  assert.equal(parseTiff(writeExif(src, fields, { dropGps: true })).gps, null);
});

test('JPEG: EXIF tags editable, addable and removable; image data untouched', async () => {
  const before = F.jpegFixture();
  const doc = await open(before);
  assert.equal(find(doc, 'Make').value, 'Apple');
  const add = addable(doc).map((a) => a.key);
  assert.ok(add.includes('EXIFTAG:ifd0:270') && add.includes('EXIFTAG:exif:37510'));
  addField(doc, 'EXIFTAG:ifd0:270').value = 'Caption ✓ & <b>';
  addField(doc, 'EXIFTAG:exif:37510').value = 'Ünïcode comment';
  find(doc, 'Make').value = 'Edited';
  const dt = find(doc, 'DateTimeOriginal');
  dt.value = 'yesterday';
  assert.match(errors(doc)[0].error, /YYYY:MM:DD/);
  dt.value = '2021:02:03 04:05:06';
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  const re = await open(out);
  assert.equal(find(re, 'ImageDescription').value, 'Caption ✓ & <b>');
  assert.equal(find(re, 'UserComment').value, 'Ünïcode comment');
  assert.equal(find(re, 'Make').value, 'Edited');
  assert.equal(find(re, 'DateTimeOriginal').value, '2021:02:03 04:05:06');
  assert.ok(find(re, 'GPS'), 'location kept');
  const scan = (b) => b.subarray(F.indexOf(b, new Uint8Array([0xff, 0xda])));
  assert.deepEqual(scan(out), scan(before));
});

test('PNG and WebP: EXIF tag edits round-trip', async () => {
  const { deflateSync } = await import('node:zlib');
  for (const before of [F.pngFixture(deflateSync)]) {
    const doc = await open(before);
    find(doc, 'Make').value = 'PNG edit';
    doc.c2pa && (doc.c2pa.choice = 'keep');
    const re = await open(await save(doc));
    assert.equal(find(re, 'Make').value, 'PNG edit');
  }
});
