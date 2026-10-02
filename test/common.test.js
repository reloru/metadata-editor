import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save } from './helpers.js';
import { decodeCbor, CborTag } from '../public/cbor.js';
import {
  validateTrack, validateBpm, validateIsrc, validateIsoDay, validateId3Timestamp, validateMp4Day, parseSuno,
} from '../public/text.js';
import { openFile, provenance } from '../public/editor.js';

const ALL = {
  'fixture1 ID3v2.3 UTF-16 + Xing': () => F.fixture1(),
  'fixture2 ID3v2.4 + GEOB C2PA': () => F.fixture2().bytes,
  'fixture3 ID3v2.4 minimal': () => F.fixture3(),
  'fixture4 WAV + C2PA chunk': () => F.fixture4().bytes,
  'fixture5 M4A moov before mdat': () => F.fixture5(),
  'fixture6 MP4 moov after mdat': () => F.fixture6(),
  'WAV odd INFO + id3 chunk': () => F.fixtureWavOdd(),
  'M4A 64-bit mdat size': () => F.fixture5({ large: true }),
  'ID3v2.4 footer': () => F.fixtureFooter(),
  'ID3v2.3 unsynchronised': () => F.fixtureUnsync().bytes,
};

for (const [name, make] of Object.entries(ALL)) {
  test(`no edits → byte-identical output: ${name}`, async () => {
    const bytes = make();
    const doc = await open(bytes);
    const out = await save(doc);
    assert.deepEqual(out, bytes);
  });
  test(`format build with no edits → byte-identical: ${name}`, async () => {
    const bytes = make();
    const doc = await open(bytes);
    const parts = await doc.mod.build(doc, {});
    const out = new Uint8Array(await new Blob(parts).arrayBuffer());
    assert.deepEqual(out, bytes);
  });
}

test('format detection uses magic bytes, not extension', async () => {
  const wav = await open(F.fixture4().bytes, 'song.mp3');
  assert.equal(wav.format, 'WAV');
  const mp3 = await open(F.fixture1(), 'song.m4a');
  assert.equal(mp3.format, 'MP3');
  const m4a = await open(F.fixture5(), 'song.wav');
  assert.equal(m4a.format, 'M4A');
  const mp4 = await open(F.fixture6(), 'clip.mp3');
  assert.equal(mp4.format, 'MP4');
  await assert.rejects(open(F.latin1('fLaC\0\0\0\0\0\0\0\0\0\0\0\0')), /FLAC/);
  await assert.rejects(open(new Uint8Array(32)), /Unrecognized/);
});

test('reading never loads the payload: only small regions are sliced', async () => {
  const bytes = F.fixture5();
  let maxRead = 0;
  const file = F.toFile(bytes);
  const origSlice = file.slice.bind(file);
  file.slice = (a, b) => {
    const s = origSlice(a, b);
    const ab = s.arrayBuffer.bind(s);
    s.arrayBuffer = () => { maxRead = Math.max(maxRead, s.size); return ab(); };
    return s;
  };
  await openFile(file);
  const mdatSize = 6 * 512 + 8;
  assert.ok(maxRead < mdatSize, `largest read ${maxRead} < mdat ${mdatSize}`);
});

test('Suno provenance parsed from COMM, TXXX comment, INFO ICMT, ©cmt', async () => {
  const d1 = await open(F.fixture1());
  assert.deepEqual(provenance(d1), [{ where: 'COMM', created: '2025-03-04T05:06:07.000Z', id: F.SUNO_ID }]);
  const d2 = await open(F.fixture2().bytes);
  assert.deepEqual(provenance(d2).map((p) => p.where).sort(), ['COMM', 'TXXX comment']);
  const d3 = await open(F.fixture3());
  assert.deepEqual(provenance(d3).map((p) => p.where), ['TXXX comment']);
  const d4 = await open(F.fixture4().bytes);
  assert.deepEqual(provenance(d4).map((p) => p.where), ['INFO ICMT']);
  const d5 = await open(F.fixture5());
  assert.deepEqual(provenance(d5).map((p) => p.where), ['ilst ©cmt']);
  const odd = await open(F.fixtureWavOdd());
  assert.deepEqual(provenance(odd).map((p) => p.where), ['ID3 chunk TXXX comment']);
  assert.equal(parseSuno('hello'), null);
});

test('validators', () => {
  assert.equal(validateTrack('3'), null);
  assert.equal(validateTrack('3/12'), null);
  assert.ok(validateTrack('3/'));
  assert.ok(validateTrack('a'));
  assert.equal(validateBpm('120'), null);
  assert.ok(validateBpm('120.5'));
  assert.equal(validateIsrc('USABC2400001'), null);
  assert.ok(validateIsrc('US-ABC-24-00001'));
  assert.ok(validateIsrc('usabc2400001'));
  assert.ok(validateIsrc('USABC240000'));
  assert.equal(validateIsoDay('2024-02-29'), null);
  assert.ok(validateIsoDay('2023-02-29'));
  assert.ok(validateIsoDay('2024'));
  assert.equal(validateId3Timestamp('2024'), null);
  assert.equal(validateId3Timestamp('2024-05-06T07:08:09'), null);
  assert.ok(validateId3Timestamp('2024-13'));
  assert.equal(validateMp4Day('2024'), null);
  assert.equal(validateMp4Day('2024-05-06T07:08:09Z'), null);
  assert.ok(validateMp4Day('May 2024'));
});

test('CBOR decoder: all major types, tags, indefinite lengths, floats', () => {
  const hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
  // RFC 8949 Appendix A examples
  assert.equal(decodeCbor(hex('1903e8')), 1000);
  assert.equal(decodeCbor(hex('3863')), -100);
  assert.equal(decodeCbor(hex('1bffffffffffffffff')), 18446744073709551615n);
  assert.equal(decodeCbor(hex('3bffffffffffffffff')), -18446744073709551616n);
  assert.deepEqual(decodeCbor(hex('4401020304')), new Uint8Array([1, 2, 3, 4]));
  assert.equal(decodeCbor(hex('62c3bc')), 'ü');
  assert.deepEqual(decodeCbor(hex('83010203')), [1, 2, 3]);
  assert.deepEqual({ ...decodeCbor(hex('a26161016162820203')) }, { a: 1, b: [2, 3] });
  assert.deepEqual([...decodeCbor(hex('a201020304'))], [[1, 2], [3, 4]]);
  assert.deepEqual(decodeCbor(hex('9f018202039f0405ffff')), [1, [2, 3], [4, 5]]);
  assert.deepEqual(decodeCbor(hex('5f42010243030405ff')), new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(decodeCbor(hex('7f657374726561646d696e67ff')), 'streaming');
  assert.deepEqual({ ...decodeCbor(hex('bf61610161629f0203ffff')) }, { a: 1, b: [2, 3] });
  const t = decodeCbor(hex('c074323031332d30332d32315432303a30343a30305a'));
  assert.ok(t instanceof CborTag);
  assert.equal(t.tag, 0);
  assert.equal(t.value, '2013-03-21T20:04:00Z');
  assert.equal(decodeCbor(hex('f93c00')), 1);
  assert.equal(decodeCbor(hex('f97bff')), 65504);
  assert.equal(decodeCbor(hex('fa47c35000')), 100000);
  assert.equal(decodeCbor(hex('fb3ff199999999999a')), 1.1);
  assert.equal(decodeCbor(hex('f4')), false);
  assert.equal(decodeCbor(hex('f6')), null);
  assert.throws(() => decodeCbor(hex('ff')));
  assert.throws(() => decodeCbor(hex('62c3')));
});
