import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find } from './helpers.js';
import { addable, addField, buildOutput } from '../public/editor.js';
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

test('HEIC: EXIF item read through iinf/iloc; dimensions from ispe; EXIF addable', async () => {
  const doc = await open(heic());
  assert.equal(doc.format, 'HEIC');
  assert.equal(Object.fromEntries(doc.technical).Dimensions, '4032×3024');
  assert.deepEqual(doc.sections[0].rows.find((r) => r[0] === 'Camera'), ['Camera', 'Apple']);
  assert.match(find(doc, 'GPS').display, /N, .* W/);
  assert.equal(find(doc, 'Exif').deletable, false);
  assert.ok(addable(doc).some((x) => x.key === 'EXIFTAG:ifd0:270'));
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
  assert.equal(doc.sections[0].title, 'QuickTime metadata (moov/meta keys)');
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

test('MP4 udta text boxes (Apple date, 3GPP auth, QuickTime ©mak) and per-track frame rate and bitrate', async () => {
  const udta = bbox('udta', bbox('date', latin1('2026-11-03T04:07:57.669-06:00')),
    full('auth', 0, 0, u16be(0x55c4), latin1('ReplayKitRecording\0')), bbox('©mak', u16be(5), u16be(0x55c4), latin1('Apple')));
  const sizes = Array.from({ length: 60 }, () => 1000);
  const trak = bbox('trak', full('tkhd', 0, 3, new Uint8Array(80)), bbox('mdia', full('mdhd', 0, 0, u32be(0), u32be(0), u32be(600), u32be(1200), new Uint8Array(4)),
    full('hdlr', 0, 0, u32be(0), latin1('vide'), new Uint8Array(12), latin1('Core Media Video\0')),
    bbox('minf', bbox('stbl', full('stsd', 0, 0, u32be(1), bbox('hvc1', new Uint8Array(6), u16be(1), new Uint8Array(16), u16be(1290), u16be(2796), new Uint8Array(50))),
      full('stsz', 0, 0, u32be(0), u32be(60), ...sizes.map(u32be)), full('stco', 0, 0, u32be(0))))));
  const file = concat([bbox('ftyp', latin1('mp42'), u32be(1), latin1('isommp42')), bbox('moov', full('mvhd', 0, 0, new Uint8Array(96)), trak, udta), bbox('mdat', new Uint8Array(8))]);
  const doc = await open(file);
  assert.equal(find(doc, 'date').display, '2026-11-03T04:07:57.669-06:00');
  assert.equal(find(doc, 'date').label, 'Recording date (udta/date)');
  assert.equal(find(doc, 'auth').display, 'ReplayKitRecording');
  assert.equal(find(doc, '©mak').display, 'Apple');
  assert.equal(Object.fromEntries(doc.technical)['Track 1'], 'vide · hvc1 (HEVC) · 1290×2796 · 30 fps average · 240 kbps · Core Media Video');
});

test('MOV: rotation from the tkhd matrix; face-detection track offered for removal', async () => {
  const matrix = concat([u32be(0), u32be(0x10000), u32be(0), u32be(0xffff0000), u32be(0), u32be(0), u32be(0), u32be(0), u32be(0x40000000)]);
  const tkhd = full('tkhd', 0, 3, new Uint8Array(36), matrix, new Uint8Array(8));
  const hdlrB = (t) => full('hdlr', 0, 0, u32be(0), latin1(t), new Uint8Array(13));
  const vtrak = bbox('trak', tkhd, bbox('mdia', full('mdhd', 0, 0, new Uint8Array(20)), hdlrB('vide'),
    bbox('minf', bbox('stbl', full('stsd', 0, 0, u32be(1), bbox('avc1', new Uint8Array(6), u16be(1), new Uint8Array(16), u16be(1920), u16be(1080), new Uint8Array(50))), full('stco', 0, 0, u32be(0))))));
  const key = (id, name) => bbox(id, bbox('keyd', latin1('mdta'), latin1(name)), bbox('dtyp', u32be(0), u32be(0)));
  const mebx = bbox('mebx', new Uint8Array(6), u16be(1), bbox('keys', key('\0\0\0\x01', 'com.apple.quicktime.detected-face'), key('\0\0\0\x02', 'com.apple.quicktime.detected-face.bounds')));
  const mtrak = bbox('trak', full('tkhd', 0, 3, new Uint8Array(80)), bbox('mdia', full('mdhd', 0, 0, new Uint8Array(20)), hdlrB('meta'),
    bbox('minf', bbox('stbl', full('stsd', 0, 0, u32be(1), mebx), full('stco', 0, 0, u32be(0))))));
  const doc = await open(concat([bbox('ftyp', latin1('qt  '), u32be(0), latin1('qt  ')), bbox('moov', full('mvhd', 0, 0, new Uint8Array(96)), vtrak, mtrak), bbox('mdat', new Uint8Array(8))]));
  const tracks = doc.fields.filter((f) => f.key === 'trak').map((f) => [f.label, f.display]);
  assert.deepEqual(tracks, [['Track (vide)', 'avc1, 1920×1080, rotated 90° (shows as 1080×1920)']]);
  assert.equal(find(doc, 'faces').deleteLabel, 'Remove face data');
});

test('M4A: iTunSMPB gapless info decoded; JPEG APP10 AROT labelled', async () => {
  const ff = bbox('----', full('mean', 0, 0, latin1('com.apple.iTunes')), full('name', 0, 0, latin1('iTunSMPB')),
    bbox('data', new Uint8Array([0, 0, 0, 1]), new Uint8Array(4), latin1(' 00000000 00000800 0000028B 00000000002B0575 00000000')));
  const trak = bbox('trak', full('tkhd', 0, 3, new Uint8Array(80)), bbox('mdia', full('mdhd', 0, 0, new Uint8Array(20)), full('hdlr', 0, 0, u32be(0), latin1('soun'), new Uint8Array(13)),
    bbox('minf', bbox('stbl', full('stsd', 0, 0, u32be(1), bbox('mp4a', new Uint8Array(6), u16be(1), new Uint8Array(8), u16be(2), u16be(16), u16be(0), u16be(0), u32be(48000 * 65536))), full('stco', 0, 0, u32be(0))))));
  const meta = full('meta', 0, 0, full('hdlr', 0, 0, u32be(0), latin1('mdir'), new Uint8Array(13)), bbox('ilst', ff));
  const doc = await open(concat([bbox('ftyp', latin1('M4A '), u32be(0), latin1('M4A ')), bbox('moov', full('mvhd', 0, 0, new Uint8Array(96)), trak, bbox('udta', meta)), bbox('mdat', new Uint8Array(8))]));
  assert.equal(Object.fromEntries(doc.technical)['Gapless (iTunSMPB)'], '2048 samples delay, 651 samples padding, 2819445 samples');
  const jpg = concat([new Uint8Array([0xff, 0xd8]), F.jpegSeg(0xea, concat([latin1('AROT'), new Uint8Array(20)])), F.jpegSeg(0xc0, concat([new Uint8Array([8]), u16be(8), u16be(8), new Uint8Array([1, 1, 0x11, 0])])), F.JPEG_SCAN]);
  assert.equal((await open(jpg)).fields.find((f) => f.key === 'APP10').label, 'Restart-marker index (APP10 AROT)');
});

// MOV: video track (2 chunks) and a face-detection mebx track (3 samples in 2 chunks) interleaved in mdat.
function movWithFaces() {
  const hdlrB = (t) => full('hdlr', 0, 0, u32be(0), latin1(t), new Uint8Array(13));
  const key = (id, name) => bbox(id, bbox('keyd', latin1('mdta'), latin1(name)), bbox('dtyp', u32be(0), u32be(0)));
  const v1 = prng(120, 300); const f1 = latin1('FACEAAAAFACEBBBB'); const v2 = prng(121, 200); const f2 = latin1('FACECCCC');
  const build = (base) => {
    const o = (n) => u32be(base + n);
    const vtrak = bbox('trak', full('tkhd', 0, 3, new Uint8Array(80)), bbox('mdia', full('mdhd', 0, 0, u32be(0), u32be(0), u32be(600), u32be(1200), new Uint8Array(4)), hdlrB('vide'),
      bbox('minf', bbox('stbl', full('stsd', 0, 0, u32be(1), bbox('avc1', new Uint8Array(6), u16be(1), new Uint8Array(16), u16be(64), u16be(48), new Uint8Array(50))),
        full('stsc', 0, 0, u32be(1), u32be(1), u32be(1), u32be(1)), full('stsz', 0, 0, u32be(0), u32be(2), u32be(300), u32be(200)), full('stco', 0, 0, u32be(2), o(0), o(316))))));
    const mebx = bbox('mebx', new Uint8Array(6), u16be(1), bbox('keys', key('\0\0\0\x01', 'com.apple.quicktime.detected-face')));
    const ftrak = bbox('trak', full('tkhd', 0, 3, new Uint8Array(80)), bbox('mdia', full('mdhd', 0, 0, new Uint8Array(20)), hdlrB('meta'),
      bbox('minf', bbox('stbl', full('stsd', 0, 0, u32be(1), mebx),
        full('stsc', 0, 0, u32be(2), u32be(1), u32be(2), u32be(1), u32be(2), u32be(1), u32be(1)), full('stsz', 0, 0, u32be(8), u32be(3)), full('stco', 0, 0, u32be(2), o(300), o(516))))));
    return bbox('moov', full('mvhd', 0, 0, new Uint8Array(96)), vtrak, ftrak, bbox('udta', bbox('free', new Uint8Array(8))));
  };
  const ftyp = bbox('ftyp', latin1('qt  '), u32be(0), latin1('qt  '));
  const body = concat([v1, f1, v2, f2]);
  const m0 = build(0);
  const base = ftyp.length + m0.length + 8;
  return { file: concat([ftyp, build(base), bbox('mdat', body)]), v1, v2 };
}

test('MOV: removing face data drops the track and blanks every face sample; video samples stay intact', async () => {
  const { file: before, v1, v2 } = movWithFaces();
  const doc = await open(before);
  assert.match(find(doc, 'faces').display, /3 samples, 24 B/);
  find(doc, 'faces').deleted = true;
  const out = await save(doc);
  assert.equal(F.indexOf(out, latin1('FACE')), -1, 'no face sample bytes left');
  const re = await open(out);
  assert.equal(re.fields.find((f) => f.key === 'faces'), undefined);
  assert.equal(re.technical.filter((t) => t[0].startsWith('Track')).length, 1);
  assert.ok(F.indexOf(out, v1) > 0 && F.indexOf(out, v2) > 0, 'video samples present');
});

test('MOV: repeated QuickTime keys are numbered and differing values flagged', async () => {
  const keys = full('keys', 0, 0, u32be(2), bbox('mdta', latin1('com.apple.quicktime.creationdate')), bbox('mdta', latin1('com.apple.quicktime.creationdate')));
  const item = (idx, s) => concat([u32be(8 + 16 + enc.encode(s).length), u32be(idx), bbox('data', new Uint8Array([0, 0, 0, 1]), new Uint8Array(4), enc.encode(s))]);
  const meta = bbox('meta', full('hdlr', 0, 0, u32be(0), latin1('mdta'), new Uint8Array(13)), keys, bbox('ilst', item(1, '2026-11-03T15:16:00-06:00'), item(2, '2026-11-06T21:25:00Z')));
  const doc = await open(concat([bbox('ftyp', latin1('qt  '), u32be(0), latin1('qt  ')), bbox('moov', full('mvhd', 0, 0, new Uint8Array(96)), meta), bbox('mdat', new Uint8Array(8))]));
  assert.deepEqual(doc.sections[0].rows.map((r) => r[0]), ['creationdate (1 of 2)', 'creationdate (2 of 2)']);
  assert.ok(doc.notes.some((n) => /2 different creationdate values/.test(n)));
});

test('HEIC: EXIF edits go into an appended item; iloc patched; old item zeroed; image bytes untouched', async () => {
  const before = heic();
  const doc = await open(before);
  addField(doc, 'EXIFTAG:ifd0:270').value = 'HEIC caption ✓';
  find(doc, 'Make').value = 'Edited';
  find(doc, 'GPS').deleted = true;
  const out = await save(doc);
  assert.ok(out.length > before.length);
  assert.deepEqual(out.subarray(before.length - 400, before.length), before.subarray(before.length - 400), 'image item bytes unchanged');
  assert.equal(F.indexOf(out.subarray(0, before.length), latin1('Apple\0')), -1, 'old EXIF zeroed');
  const re = await open(out);
  assert.equal(find(re, 'ImageDescription').value, 'HEIC caption ✓');
  assert.equal(find(re, 'Make').value, 'Edited');
  assert.equal(re.fields.find((f) => f.key === 'GPS'), undefined);
  assert.equal(Object.fromEntries(re.technical).Dimensions, '4032×3024');
});

test('HEIC: Photo info caption and date written to the EXIF item', async () => {
  const doc = await open(heic());
  find(doc, 'caption').value = 'From HEIC';
  find(doc, 'taken').value = '2026-11-03 14:12:55 -06:00';
  const re = await open(await save(doc));
  assert.equal(find(re, 'ImageDescription').value, 'From HEIC');
  assert.equal(find(re, 'DateTimeOriginal').value, '2026:11:03 14:12:55');
  assert.equal(find(re, 'taken').value, '2026-11-03 14:12:55 -06:00');
});

test('MOV: QuickTime keys editable/removable/addable; Video info writes caption, keywords, date and the movie header', async () => {
  const doc = await open(mov());
  assert.equal(find(doc, 'make').value, 'Apple');
  find(doc, 'make').deleted = true;
  find(doc, 'caption').value = 'Hello & bye';
  find(doc, 'keywords').value = 'a,b';
  find(doc, 'taken').value = '2025-07-04T12:00:00-05:00';
  addField(doc, 'QTKEY:com.apple.quicktime.title').value = 'T1';
  find(doc, 'location').deleted = true;
  const re = await open(await buildOutput(doc).then((b) => b.arrayBuffer()).then((a) => new Uint8Array(a)));
  assert.equal(re.fields.find((f) => f.key === 'make'), undefined);
  assert.equal(re.fields.find((f) => f.key === 'location'), undefined);
  assert.equal(find(re, 'caption').value, 'Hello & bye');
  assert.equal(find(re, 'keywords').value, 'a,b');
  assert.equal(find(re, 'taken').value, '2025-07-04T12:00:00-05:00');
  assert.equal(find(re, 'title').value, 'T1');
  assert.equal(Object.fromEntries(re.technical)['Created (mvhd)'], '2025-07-04T17:00:00Z');
});
