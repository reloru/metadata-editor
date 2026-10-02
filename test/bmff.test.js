import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find, checkBmff, chunkPayloads, boxPayload } from './helpers.js';
import { addField, addable, errors, buildOutput } from '../public/editor.js';

const NON_ASCII = 'Ünïcødé 日本語 ✓';
const A9 = '©';

const VALUES = {
  [A9 + 'nam']: NON_ASCII, [A9 + 'ART']: 'Café', aART: NON_ASCII, [A9 + 'alb']: 'Álbum', [A9 + 'gen']: 'Synth',
  [A9 + 'day']: '2024-05-06', trkn: '3/12', disk: '1/2', tmpo: '128', [A9 + 'wrt']: NON_ASCII,
  [A9 + 'lyr']: `Line 1\n${NON_ASCII}`, [A9 + 'cmt']: NON_ASCII, cprt: '© 2024',
};

for (const [name, make] of [['fixture5 (moov before mdat)', () => F.fixture5()], ['fixture6 (moov after mdat)', () => F.fixture6()], ['64-bit mdat', () => F.fixture5({ large: true })], ['no udta (path created)', () => F.fixture6({ noUdta: true })]]) {
  test(`MP4 ${name}: every ilst field round-trips; offsets and payload intact`, async () => {
    const before = make();
    const doc = await open(before);
    for (const [k, v] of Object.entries(VALUES)) {
      const f = doc.fields.find((x) => x.key === k) || addField(doc, k);
      f.value = v;
    }
    const cov = doc.fields.find((x) => x.key === 'covr') || addField(doc, 'covr');
    cov.value = { ...cov.value, mime: 'image/png', data: F.FAKE_PNG };
    assert.deepEqual(errors(doc), []);
    if (doc.c2pa) doc.c2pa.choice = 'keep';
    const out = await save(doc);
    checkBmff(out);
    const re = await open(out);
    for (const [k, v] of Object.entries(VALUES)) assert.equal(find(re, k).value, v, k);
    const pic = find(re, 'covr').value;
    assert.equal(pic.mime, 'image/png');
    assert.deepEqual(pic.data, F.FAKE_PNG);
    assert.deepEqual(chunkPayloads(out), chunkPayloads(before), 'stco/co64 point at the same payload bytes');
    assert.deepEqual(boxPayload(out, 'mdat'), boxPayload(before, 'mdat'), 'mdat identical');
    const trkn = re.fields.find((f) => f.key === 'trkn');
    assert.ok(trkn);
    // trkn: 8-byte payload, disk: 6-byte payload, tmpo: type 21, 16-bit
    const raw = out;
    const ilstAt = F.indexOf(raw, F.latin1('trkn'));
    assert.equal(F.indexOf(raw, F.concat([F.u32be(8 + 8 + 8), F.latin1('data'), new Uint8Array([0, 0, 0, 0])]), ilstAt), ilstAt + 4);
    const diskAt = F.indexOf(raw, F.latin1('disk'));
    assert.equal(F.indexOf(raw, F.concat([F.u32be(8 + 8 + 6), F.latin1('data')]), diskAt), diskAt + 4);
    const tmpoAt = F.indexOf(raw, F.latin1('tmpo'));
    assert.equal(F.indexOf(raw, F.concat([F.u32be(8 + 8 + 2), F.latin1('data'), new Uint8Array([0, 0, 0, 21])]), tmpoAt), tmpoAt + 4);
  });
}

test('MP4: preserve items (©too) byte-identical after edits', async () => {
  const before = F.fixture5();
  const doc = await open(before);
  find(doc, A9 + 'cmt').value = 'changed';
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  const item = (b) => {
    const at = F.indexOf(b, F.latin1(A9 + 'too')) - 4;
    const size = (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
    return b.subarray(at, at + size);
  };
  assert.deepEqual(item(out), item(before));
});

test('MP4: small growth absorbed by meta/free → moov size and all offsets unchanged', async () => {
  const before = F.fixture5();
  const doc = await open(before);
  find(doc, A9 + 'cmt').value = find(doc, A9 + 'cmt').value + ' (20 more bytes!!!)';
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  assert.equal(out.length, before.length);
  const a = checkBmff(before);
  const b = checkBmff(out);
  assert.deepEqual(b.top.map((x) => [x.type, x.start, x.size]), a.top.map((x) => [x.type, x.start, x.size]));
  assert.deepEqual(chunkPayloads(out), chunkPayloads(before));
});

test('MP4: moov growth beyond free → stco shifted, payload pointers intact', async () => {
  const before = F.fixture5();
  const doc = await open(before);
  find(doc, A9 + 'lyr').value = 'L'.repeat(3000);
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  assert.ok(out.length > before.length);
  assert.notDeepEqual(checkBmff(out).top.find((x) => x.type === 'mdat').start, checkBmff(before).top.find((x) => x.type === 'mdat').start);
  assert.deepEqual(chunkPayloads(out), chunkPayloads(before));
  assert.deepEqual(boxPayload(out, 'mdat'), boxPayload(before, 'mdat'));
});

test('MP4: moov shrink without free → stco shifted, payload pointers intact', async () => {
  const before = F.fixture5({ metaFree: 0 });
  const doc = await open(before);
  find(doc, A9 + 'lyr').deleted = true;
  find(doc, A9 + 'cmt').deleted = true;
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  assert.ok(out.length < before.length);
  assert.deepEqual(chunkPayloads(out), chunkPayloads(before));
  assert.deepEqual(boxPayload(out, 'mdat'), boxPayload(before, 'mdat'));
});

test('MP4: moov shrink with free → free grows, layout unchanged', async () => {
  const before = F.fixture5();
  const doc = await open(before);
  find(doc, A9 + 'lyr').deleted = true;
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  assert.equal(out.length, before.length);
  assert.deepEqual(chunkPayloads(out), chunkPayloads(before));
});

test('MP4: 64-bit size box parsed and preserved in its 64-bit form', async () => {
  const before = F.fixture5({ large: true });
  const doc = await open(before);
  find(doc, A9 + 'lyr').value = 'L'.repeat(3000);
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  const m = checkBmff(out).top.find((x) => x.type === 'mdat');
  assert.equal(m.hdr, 16);
  assert.deepEqual(chunkPayloads(out), chunkPayloads(before));
});

test('MP4: ©lyr edit warns about timed-text track; tracks listed', async () => {
  const doc = await open(F.fixture5());
  assert.match(find(doc, A9 + 'lyr').note, /timed-text/);
  const tech = Object.fromEntries(doc.technical);
  assert.equal(tech['Track 1'], 'soun · mp4a · 2 ch, 44100 Hz, 16-bit');
  assert.equal(tech['Track 2'], 'sbtl · tx3g');
  assert.equal(tech.Duration, '0:05.000');
  const d6 = await open(F.fixture6());
  assert.equal(addField(d6, A9 + 'lyr').note, null);
});

test('MP4: validation for trkn, disk, tmpo, ©day', async () => {
  const doc = await open(F.fixture6());
  for (const [k, bad, good] of [['trkn', '1/x', '1/2'], ['disk', '70000', '2'], ['tmpo', '1.5', '90'], [A9 + 'day', '06/05/2024', '2024']]) {
    const f = addField(doc, k);
    f.value = bad;
    assert.equal(errors(doc).length, 1, k);
    f.value = good;
    assert.deepEqual(errors(doc), [], k);
  }
  assert.ok(!addable(doc).some((a) => a.key === 'trkn'));
});

test('MP4: fragmented files are read-only', async () => {
  const frag = F.concat([F.bbox('ftyp', F.latin1('iso6'), F.u32be(0)), F.bbox('moov', F.bbox('mvex', F.bbox('trex', new Uint8Array(24)))), F.bbox('moof', new Uint8Array(16)), F.bbox('mdat', new Uint8Array(16))]);
  const doc = await open(frag);
  assert.match(doc.readOnly, /Fragmented/);
  assert.deepEqual(addable(doc), []);
  await assert.rejects(buildOutput(doc), /Fragmented/);
});
