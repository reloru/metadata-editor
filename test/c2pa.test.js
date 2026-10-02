import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find, checkRiff, checkBmff, chunkPayloads, boxPayload } from './helpers.js';
import { buildOutput, checkC2paHash, needsC2paChoice, isDirty } from '../public/editor.js';
import { parseTag, readHeader } from '../public/id3.js';

test('C2PA summary: assertions, actions + digitalSourceType, Suno provenance, generator', async () => {
  for (const bytes of [F.fixture2().bytes, F.fixture4().bytes, F.fixture5(), F.fixture6()]) {
    const doc = await open(bytes);
    const s = doc.c2pa.summary;
    assert.ok(s.assertions.includes('c2pa.actions.v2'));
    assert.ok(s.assertions.includes('com.suno.provenance'));
    assert.deepEqual(s.actions[0].action, 'c2pa.created');
    assert.match(s.actions[0].digitalSourceType, /trainedAlgorithmicMedia$/);
    assert.deepEqual(s.suno.find(([k]) => k === 'song_id'), ['song_id', F.SUNO_ID]);
    assert.deepEqual(s.generator, ['Suno 1.0']);
  }
});

for (const [name, make] of [['MP3 GEOB', () => F.fixture2()], ['WAV C2PA chunk', () => F.fixture4()]]) {
  test(`C2PA data hash (${name}): matches unmodified, fails after an edit`, async () => {
    const { bytes } = make();
    const doc = await open(bytes);
    assert.equal((await checkC2paHash(doc)).result, 'match');
    const f = doc.fields.find((x) => x.cls === 'edit' && x.kind === 'text') || doc.fields.find((x) => x.key === 'ICMT');
    f.value = f.value + ' edited';
    doc.c2pa.choice = 'keep';
    const out = await save(doc);
    const re = await open(out);
    assert.ok(re.c2pa, 'manifest kept');
    assert.equal((await checkC2paHash(re)).result, 'mismatch');
  });
}

test('C2PA hash check on a tampered payload byte reports mismatch', async () => {
  const { bytes } = F.fixture4();
  const t = bytes.slice();
  const d = checkRiff(t).find((c) => c.id === 'data');
  t[d.start + 8 + 100] ^= 1;
  assert.equal((await checkC2paHash(await open(t))).result, 'mismatch');
});

test('C2PA BMFF hash: "Not checked"', async () => {
  const r = await checkC2paHash(await open(F.fixture5()));
  assert.equal(r.result, 'not-checked');
  assert.match(r.message, /c2pa\.hash\.bmff\.v2/);
});

test('Save rule: an edit with a manifest present needs an explicit choice', async () => {
  const doc = await open(F.fixture2().bytes);
  assert.equal(doc.c2pa.choice, null, 'no preselected option');
  assert.equal(needsC2paChoice(doc), false);
  find(doc, 'TIT2').value = 'x';
  assert.equal(needsC2paChoice(doc), true);
  await assert.rejects(buildOutput(doc), /C2PA/);
  doc.c2pa.choice = 'keep';
  assert.equal(needsC2paChoice(doc), false);
  await buildOutput(doc);
  const d2 = await open(F.fixture2().bytes);
  d2.c2pa.choice = 'remove';
  assert.equal(isDirty(d2), true, 'removal alone is a pending change');
});

test('C2PA removal (MP3): only the GEOB frame is removed', async () => {
  const before = F.fixture2().bytes;
  const doc = await open(before);
  doc.c2pa.choice = 'remove';
  const out = await save(doc);
  const tagOf = (b) => parseTag(b.subarray(0, readHeader(b).totalSize));
  const a = tagOf(before);
  const b = tagOf(out);
  assert.deepEqual(b.frames.map((f) => f.raw), a.frames.filter((f) => f.id !== 'GEOB').map((f) => f.raw));
  assert.equal(readHeader(out).size, readHeader(before).size, 'tag size kept; padding grows');
  assert.equal(out.length, before.length);
  assert.deepEqual(out.subarray(readHeader(out).totalSize), before.subarray(readHeader(before).totalSize));
  const re = await open(out);
  assert.equal(re.c2pa, null);
});

test('C2PA removal (WAV): exactly the C2PA chunk is removed; RIFF size rebuilt', async () => {
  const { bytes: before, exclusion: [start, len] } = F.fixture4();
  const doc = await open(before);
  doc.c2pa.choice = 'remove';
  const out = await save(doc);
  checkRiff(out);
  const expected = F.concat([before.subarray(0, start), before.subarray(start + len)]);
  expected.set(F.u32le(expected.length - 8), 4);
  assert.deepEqual(out, expected);
});

for (const [name, make] of [['M4A, uuid before moov/mdat', () => F.fixture5()], ['MP4, uuid before mdat, moov last', () => F.fixture6()]]) {
  test(`C2PA removal (${name}): only the uuid box removed, offsets fixed`, async () => {
    const before = make();
    const doc = await open(before);
    doc.c2pa.choice = 'remove';
    const out = await save(doc);
    const a = checkBmff(before);
    const b = checkBmff(out);
    const uuid = a.top.find((x) => x.type === 'uuid');
    assert.deepEqual(b.top.map((x) => [x.type, x.size]), a.top.filter((x) => x !== uuid).map((x) => [x.type, x.size]));
    assert.equal(out.length, before.length - uuid.size);
    assert.deepEqual(chunkPayloads(out), chunkPayloads(before));
    assert.deepEqual(boxPayload(out, 'mdat'), boxPayload(before, 'mdat'));
    // Outside of moov, every byte is the original minus the uuid box.
    const strip = (bytes, layout) => F.concat(layout.top.filter((x) => x.type !== 'moov' && x.type !== 'uuid').map((x) => bytes.subarray(x.start, x.start + x.size)));
    assert.deepEqual(strip(out, b), strip(before, a));
    const re = await open(out);
    assert.equal(re.c2pa, null);
  });
}

test('C2PA removal combined with an ilst edit (M4A)', async () => {
  const before = F.fixture5();
  const doc = await open(before);
  find(doc, '©cmt').value = 'x'.repeat(500);
  doc.c2pa.choice = 'remove';
  const out = await save(doc);
  checkBmff(out);
  assert.deepEqual(chunkPayloads(out), chunkPayloads(before));
  const re = await open(out);
  assert.equal(find(re, '©cmt').value, 'x'.repeat(500));
  assert.equal(re.c2pa, null);
});
