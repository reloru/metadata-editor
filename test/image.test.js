import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import * as F from './fixtures.js';
import { open, save, find } from './helpers.js';
import { addField, addable, checkC2paHash, isDirty } from '../public/editor.js';
import { parseTiff, removeGps } from '../public/tiff.js';

const { latin1, u32be } = F;

function pngChunks(b) {
  assert.deepEqual(b.subarray(0, 8), F.PNG_SIG);
  const out = [];
  let o = 8;
  while (o < b.length) {
    const len = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    const crc = ((b[o + 8 + len] << 24) | (b[o + 9 + len] << 16) | (b[o + 10 + len] << 8) | b[o + 11 + len]) >>> 0;
    assert.equal(crc, crc32(b.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    out.push({ type, data: b.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

function tail(b, marker) {
  const i = F.indexOf(b, marker);
  assert.ok(i >= 0);
  return b.subarray(i);
}

test('TIFF: GPS removed in place, everything else intact', () => {
  const t = F.tiffWithGps();
  const before = parseTiff(t);
  assert.ok(before.gps);
  const out = removeGps(t);
  assert.equal(out.length, t.length);
  const after = parseTiff(out);
  assert.equal(after.gps, null);
  assert.equal(after.ifd0.entries.get(0x010f).value, 'Apple');
  assert.deepEqual(after.ifd0.entries.get(0x0112).value, [6]);
  assert.equal(after.exif.entries.get(0x9003).value, '2024:05:06 07:08:09');
  assert.equal(F.indexOf(out, u32be(1234)), -1, 'GPS rational values zeroed');
  assert.equal(removeGps(out), null);
});

test('JPEG: EXIF, XMP, comment and C2PA read; GPS shown', async () => {
  const doc = await open(F.jpegFixture());
  assert.equal(doc.format, 'JPEG');
  assert.match(find(doc, 'GPS').display, /^29\.936761° N, 95\.055833° W/);
  const exif = doc.sections.find((s) => s.title === 'EXIF (APP1)').rows;
  assert.deepEqual(exif.find((r) => r[0] === 'Camera'), ['Camera', 'Apple']);
  assert.deepEqual(exif.find((r) => r[0] === 'Orientation'), ['Orientation', 'Rotated 90° CW']);
  assert.deepEqual(doc.sections.find((s) => s.title === 'XMP').rows[0], ['xmp:CreatorTool', 'Camera 1.0']);
  assert.ok(doc.notes.some((n) => /XMP also records a location/.test(n)));
  assert.equal(find(doc, 'COM').value, 'old comment');
  assert.equal(doc.c2pa.where, 'APP11 JUMBF (2 segments)');
  assert.equal(doc.c2pa.summary.manifestCount, 1);
  assert.equal((await checkC2paHash(doc)).result, 'match');
  const tech = Object.fromEntries(doc.technical);
  assert.equal(tech.Dimensions, '64×48');
  assert.equal(tech.Coding, 'Baseline, 8-bit');
});

test('JPEG: remove location keeps size, EXIF and image data; C2PA removal drops both APP11 segments', async () => {
  const before = F.jpegFixture();
  const doc = await open(before);
  find(doc, 'GPS').deleted = true;
  assert.ok(isDirty(doc));
  doc.c2pa.choice = 'remove';
  const out = await save(doc);
  const re = await open(out);
  assert.equal(re.fields.find((f) => f.key === 'GPS'), undefined);
  assert.deepEqual(re.sections.find((s) => s.title === 'EXIF (APP1)').rows.find((r) => r[0] === 'Camera'), ['Camera', 'Apple']);
  assert.equal(re.c2pa, null);
  assert.equal(F.indexOf(out, latin1('JP\0\x01')), -1);
  assert.deepEqual(tail(out, new Uint8Array([0xff, 0xda])), tail(before, new Uint8Array([0xff, 0xda])), 'scan data identical');
});

test('JPEG: comment edit and delete', async () => {
  const doc = await open(F.jpegFixture());
  find(doc, 'COM').value = 'new ✓';
  doc.c2pa.choice = 'keep';
  const re = await open(await save(doc));
  assert.equal(find(re, 'COM').value, 'new ✓');
  assert.equal((await checkC2paHash(re)).result, 'mismatch');
  find(re, 'COM').deleted = true;
  re.c2pa.choice = 'keep';
  const re2 = await open(await save(re));
  assert.equal(re2.fields.find((f) => f.key === 'COM'), undefined);
  assert.deepEqual(addable(re2), [{ key: 'COM', label: 'Comment (COM)' }]);
});

test('JPEG with MPF: blocks after the index are fixed; new comment goes before the index; trailing image kept', async () => {
  const before = F.jpegMpfFixture();
  const doc = await open(before);
  assert.equal(find(doc, 'APP2').cls, 'protected');
  const xmp = doc.fields.find((f) => f.label === 'XMP');
  assert.equal(xmp.deletable, false);
  assert.equal(find(doc, 'APP1', (f) => f.label === 'EXIF').deletable, true);
  addField(doc, 'COM').value = 'hi';
  find(doc, 'GPS').deleted = true;
  const out = await save(doc);
  const com = F.indexOf(out, new Uint8Array([0xff, 0xfe]));
  const mpf = F.indexOf(out, latin1('MPF\0'));
  assert.ok(com > 0 && com < mpf, 'comment inserted before MPF');
  const mpfTiffBefore = F.indexOf(before, latin1('MPF\0')) + 4;
  const mpfTiffAfter = mpf + 4;
  assert.deepEqual(out.subarray(mpfTiffAfter), before.subarray(mpfTiffBefore), 'everything from the MPF header on is unchanged, so its offsets still hold');
});

test('PNG: text, EXIF, zTXt and C2PA read', async () => {
  const doc = await open(F.pngFixture(deflateSync));
  assert.equal(doc.format, 'PNG');
  assert.equal(find(doc, 'tEXt').value, F.SUNO_TEXT);
  assert.equal(find(doc, 'iTXt').value, 'Ünï title');
  assert.equal(find(doc, 'zTXt').display, 'Zed');
  assert.match(find(doc, 'GPS').display, /N, .* W/);
  assert.equal(doc.c2pa.where, 'caBX chunk');
  assert.deepEqual(doc.mod.provenance(doc).map((p) => p.where), ['PNG Comment']);
  const tech = Object.fromEntries(doc.technical);
  assert.equal(tech.Dimensions, '64×48');
  assert.equal(tech.Colour, 'RGBA, 8-bit');
});

test('PNG: edits rewrite chunks with valid CRCs; non-Latin-1 tEXt becomes iTXt; new text goes before IDAT', async () => {
  const before = F.pngFixture(deflateSync);
  const doc = await open(before);
  find(doc, 'tEXt').value = 'plain';
  find(doc, 'iTXt').value = 'Neu ✓';
  addField(doc, 'Author').value = 'Author ✓';
  find(doc, 'GPS').deleted = true;
  doc.c2pa.choice = 'remove';
  const out = await save(doc);
  const chunks = pngChunks(out);
  const types = chunks.map((c) => c.type);
  assert.deepEqual(types, ['IHDR', 'eXIf', 'tEXt', 'iTXt', 'zTXt', 'iTXt', 'IDAT', 'IDAT', 'IEND']);
  const re = await open(out);
  assert.equal(find(re, 'tEXt').value, 'plain');
  assert.deepEqual(re.fields.filter((f) => f.key === 'iTXt').map((f) => [f.keyword, f.value]), [['Title', 'Neu ✓'], ['Author', 'Author ✓']]);
  assert.equal(re.fields.find((f) => f.key === 'GPS'), undefined);
  assert.equal(re.c2pa, null);
  const idat = (b) => pngChunks(b).filter((c) => c.type === 'IDAT').map((c) => c.data);
  assert.deepEqual(idat(out), idat(before));
});

test('PNG and JPEG: no-op save returns the original bytes', async () => {
  for (const b of [F.pngFixture(deflateSync), F.jpegFixture(), F.jpegMpfFixture()]) {
    const doc = await open(b);
    assert.deepEqual(await save(doc), b);
  }
});

test('PNG: corrupt chunk length is rejected', async () => {
  const b = F.pngFixture(deflateSync).slice();
  b[8 + 3] = 0xff;
  await assert.rejects(open(b), /PNG: invalid chunk/);
});

test('JPEG XMP property extraction ignores namespace declarations', async () => {
  const { xmpInfo } = await import('../public/image.js');
  const x = xmpInfo('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" xmlns:dc="d" dc:format="image/jpeg"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Hello</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>');
  assert.deepEqual(x.rows, [['dc:format', 'image/jpeg'], ['dc:title', 'Hello']]);
  assert.equal(x.hasGps, false);
});

function webpChunk(id, d) {
  return F.concat([latin1(id), F.u32le(d.length), d, d.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}
function webpFixture() {
  const vp8x = webpChunk('VP8X', new Uint8Array([0x2c, 0, 0, 0, 63, 0, 0, 47, 0, 0]));
  const vp8 = webpChunk('VP8 ', F.concat([new Uint8Array([0, 0, 0, 0x9d, 0x01, 0x2a, 64, 0, 48, 0]), F.prng(90, 301)]));
  const body = F.concat([latin1('WEBP'), vp8x, webpChunk('ICCP', new Uint8Array(132)), vp8, webpChunk('EXIF', F.tiffWithGps()), webpChunk('XMP ', F.enc.encode('<x:xmpmeta/>'))]);
  return F.concat([latin1('RIFF'), F.u32le(body.length), body]);
}

test('WebP: EXIF/XMP/ICC read; location removed in place; deleting chunks clears VP8X flags and fixes the RIFF size', async () => {
  const before = webpFixture();
  const doc = await open(before);
  assert.equal(doc.format, 'WebP');
  assert.equal(Object.fromEntries(doc.technical).Dimensions, '64×48');
  assert.deepEqual(doc.sections[0].rows.find((r) => r[0] === 'Camera'), ['Camera', 'Apple']);
  find(doc, 'GPS').deleted = true;
  const out1 = await save(doc);
  assert.equal(out1.length, before.length);
  assert.equal((await open(out1)).fields.find((f) => f.key === 'GPS'), undefined);
  const d2 = await open(before);
  find(d2, 'XMP').deleted = true;
  find(d2, 'ICCP').deleted = true;
  const out2 = await save(d2);
  assert.equal(((out2[4] | (out2[5] << 8) | (out2[6] << 16) | (out2[7] << 24)) >>> 0) + 8, out2.length);
  assert.equal(out2[20], 0x08, 'only the EXIF flag remains');
  const re = await open(out2);
  assert.equal(Object.fromEntries(re.technical).Metadata, 'EXIF');
  assert.deepEqual(await save(await open(before)), before);
});

test('Images: notes when EXIF lacks camera, date and location, or is missing', async () => {
  const be = (v) => F.u16be(v);
  const tiff = F.concat([latin1('MM'), be(42), u32be(8), be(1), be(0x0112), be(3), u32be(1), be(1), be(0), u32be(0)]);
  const stripped = F.concat([new Uint8Array([0xff, 0xd8]), F.jpegSeg(0xe1, F.concat([latin1('Exif\0\0'), tiff])), F.jpegSeg(0xc0, F.concat([new Uint8Array([8]), be(8), be(8), new Uint8Array([1, 1, 0x11, 0])])), F.JPEG_SCAN]);
  assert.ok((await open(stripped)).notes.some((n) => /no camera, date or location/.test(n)));
  const none = F.concat([new Uint8Array([0xff, 0xd8]), F.jpegSeg(0xc0, F.concat([new Uint8Array([8]), be(8), be(8), new Uint8Array([1, 1, 0x11, 0])])), F.JPEG_SCAN]);
  assert.ok((await open(none)).notes.some((n) => /^No EXIF in this file/.test(n)));
  const full = await open(F.jpegFixture());
  assert.ok(!full.notes.some((n) => /no camera, date or location|^No EXIF/.test(n)));
});
