import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find } from './helpers.js';
import { addable, buildOutput } from '../public/editor.js';
import { parseMoov, readChunkOffsets } from '../public/bmff.js';

const { concat, latin1, enc, u32be, u16be, bbox, full, prng } = F;

// HEIC: ftyp, meta (hdlr, pitm, iinf with hvc1 + Exif, iloc, iprp/ipco/ispe), mdat holding the Exif item and image bytes.
function heic(brand = 'heic') {
  const exifPayload = concat([u32be(6), latin1('Exif\0\0'), F.tiffWithGps()]);
  const image = prng(70, 400);
  const build = (exifOff, imageOff) => {
    const infe = (id, type) => full('infe', 2, 0, u16be(id), u16be(0), latin1(type), new Uint8Array([0]));
    const iloc = full('iloc', 0, 0, new Uint8Array([0x44, 0x00]), u16be(2),
      u16be(1), u16be(0), u16be(1), u32be(imageOff), u32be(image.length),
      u16be(2), u16be(0), u16be(1), u32be(exifOff), u32be(exifPayload.length));
    const meta = full('meta', 0, 0, full('hdlr', 0, 0, u32be(0), latin1('pict'), new Uint8Array(13)), full('pitm', 0, 0, u16be(1)),
      full('iinf', 0, 0, u16be(2), infe(1, 'hvc1'), infe(2, 'Exif')), iloc,
      bbox('iprp', bbox('ipco', full('ispe', 0, 0, u32be(4032), u32be(3024)))));
    const ftyp = bbox('ftyp', latin1(brand), u32be(0), latin1('mif1heic'));
    const head = concat([ftyp, meta]);
    return { file: concat([head, bbox('mdat', exifPayload, image)]), exifAt: head.length + 8, imageAt: head.length + 8 + exifPayload.length };
  };
  const a = build(0, 0);
  return build(a.exifAt, a.imageAt).file;
}

test('HEIC: EXIF item read through iinf/iloc; dimensions from ispe; view-only', async () => {
  const doc = await open(heic());
  assert.equal(doc.format, 'HEIC');
  assert.equal(Object.fromEntries(doc.technical).Dimensions, '4032×3024');
  assert.deepEqual(doc.sections[0].rows.find((r) => r[0] === 'Camera'), ['Camera', 'Apple']);
  assert.match(find(doc, 'GPS').display, /N, .* W/);
  assert.equal(find(doc, 'Exif').deletable, false);
  assert.deepEqual(addable(doc), []);
  assert.equal((await open(heic('avif'))).format, 'AVIF');
});

test('HEIC: remove location rewrites only the GPS bytes; same length; image bytes untouched', async () => {
  const before = heic();
  const doc = await open(before);
  find(doc, 'GPS').deleted = true;
  const out = await save(doc);
  assert.equal(out.length, before.length);
  let diffs = 0;
  for (let i = 0; i < out.length; i++) if (out[i] !== before[i]) diffs++;
  assert.ok(diffs > 0 && diffs < 120, `changed ${diffs} bytes`);
  const re = await open(out);
  assert.equal(re.fields.find((f) => f.key === 'GPS'), undefined);
  assert.deepEqual(re.sections[0].rows.find((r) => r[0] === 'Camera'), ['Camera', 'Apple']);
  assert.deepEqual(out.subarray(out.length - 400), before.subarray(before.length - 400));
  assert.deepEqual(await save(await open(before)), before);
});

// MOV with QuickTime keys metadata (location, make) in moov/meta and a udta/©xyz location.
function mov() {
  const keys = full('keys', 0, 0, u32be(2), bbox('mdta', latin1('com.apple.quicktime.location.ISO6709')), bbox('mdta', latin1('com.apple.quicktime.make')));
  const item = (idx, s) => concat([u32be(8 + 16 + enc.encode(s).length), u32be(idx), bbox('data', new Uint8Array([0, 0, 0, 1]), new Uint8Array(4), enc.encode(s))]);
  const meta = bbox('meta', full('hdlr', 0, 0, u32be(0), latin1('mdta'), new Uint8Array(13)), keys, bbox('ilst', item(1, '+29.9367-095.0558+012.000/'), item(2, 'Apple')));
  const xyz = bbox('©xyz', u16be(18), u16be(0x15c7), latin1('+29.9367-095.0558/'));
  const payload = prng(71, 1024);
  const build = (off) => {
    const avc1 = bbox('avc1', new Uint8Array(6), u16be(1), new Uint8Array(16), u16be(320), u16be(240), new Uint8Array(50));
    const trak = bbox('trak', full('tkhd', 0, 3, new Uint8Array(80)), bbox('mdia', full('mdhd', 0, 0, new Uint8Array(20)),
      full('hdlr', 0, 0, u32be(0), latin1('vide'), new Uint8Array(13)), bbox('minf', bbox('stbl', full('stsd', 0, 0, u32be(1), avc1), full('stco', 0, 0, u32be(1), u32be(off))))));
    const ftyp = bbox('ftyp', latin1('qt  '), u32be(0), latin1('qt  '));
    const mdat = bbox('mdat', payload);
    const moov = bbox('moov', full('mvhd', 0, 0, new Uint8Array(96)), trak, bbox('udta', xyz), meta);
    return { file: concat([ftyp, mdat, moov]), off: ftyp.length + 8 };
  };
  return build(build(0).off).file;
}

test('MOV: QuickTime keys and udta location shown; remove location keeps the other keys and chunk offsets', async () => {
  const before = mov();
  const doc = await open(before);
  assert.equal(doc.format, 'MOV');
  assert.equal(find(doc, 'location').display, '+29.9367-095.0558+012.000/');
  assert.deepEqual(doc.sections[0].rows, [['location.ISO6709', '+29.9367-095.0558+012.000/'], ['make', 'Apple']]);
  find(doc, 'location').deleted = true;
  const blob = await buildOutput(doc);
  const out = new Uint8Array(await blob.arrayBuffer());
  const re = await open(out);
  assert.equal(re.fields.find((f) => f.key === 'location'), undefined);
  assert.deepEqual(re.sections[0].rows, [['make', 'Apple']]);
  assert.equal(F.indexOf(out, latin1('+29.9367')), -1, 'no location text left');
  const at = F.indexOf(out, latin1('moov')) - 4;
  const moov = out.subarray(at);
  const offs = readChunkOffsets(moov, parseMoov(moov))[0].offsets;
  assert.deepEqual(out.subarray(offs[0], offs[0] + 1024), prng(71, 1024), 'chunk offset still points at the payload');
});
