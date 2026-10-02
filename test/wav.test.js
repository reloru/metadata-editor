import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find, checkRiff } from './helpers.js';
import { addField, addable, errors } from '../public/editor.js';

const NON_ASCII = 'Ünïcødé 日本語 ✓';

function dataChunk(b) {
  return checkRiff(b).find((c) => c.id === 'data').data;
}

test('WAV: every INFO field round-trips, including non-ASCII; sizes and pads consistent', async () => {
  const before = F.fixture4().bytes;
  const doc = await open(before);
  const vals = {
    INAM: NON_ASCII, IART: 'Café', ICMT: 'odd', IPRD: 'Album ü', IGNR: 'Synth', ICRD: '2024-05-06',
    ICOP: '© 2024', IENG: 'Eng', IKEY: 'k1; k2',
  };
  for (const [k, v] of Object.entries(vals)) {
    const f = doc.fields.find((x) => x.key === k) || addField(doc, 'INFO:' + k);
    f.value = v;
  }
  assert.deepEqual(errors(doc), []);
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  checkRiff(out);
  const re = await open(out);
  for (const [k, v] of Object.entries(vals)) assert.equal(find(re, k).value, v, k);
  assert.equal(find(re, 'IPRD').label, 'Product / Album');
  assert.deepEqual(dataChunk(out), dataChunk(before), 'payload identical');
  assert.equal(find(re, 'ISFT').display, 'Lavf60.3.100');
});

test('WAV: ICRD validation (YYYY-MM-DD)', async () => {
  const doc = await open(F.fixture4().bytes);
  const f = addField(doc, 'INFO:ICRD');
  f.value = '2024';
  assert.equal(errors(doc).length, 1);
  f.value = '2024-02-30';
  assert.equal(errors(doc).length, 1);
  f.value = '2024-02-29';
  assert.deepEqual(errors(doc), []);
});

test('WAV: INFO ISRC is "Source" (Preserve), never an ISRC code field', async () => {
  const doc = await open(F.fixtureWavOdd());
  const f = find(doc, 'ISRC');
  assert.equal(f.cls, 'preserve');
  assert.match(f.label, /^Source/);
  assert.ok(!addable(doc).some((a) => a.key === 'INFO:ISRC'));
});

test('WAV: odd-length INFO strings and odd data chunk keep pad bytes; preserve items byte-identical', async () => {
  const before = F.fixtureWavOdd();
  const doc = await open(before);
  find(doc, 'INAM').value = 'abcd'; // 5 bytes with NUL -> odd
  find(doc, 'IART').value = 'xyz!'; // odd
  const out = await save(doc);
  const chunks = checkRiff(out);
  const list = chunks.find((c) => c.id === 'LIST').data;
  const origList = checkRiff(before).find((c) => c.id === 'LIST').data;
  const sub = (d, id) => {
    let p = 4;
    while (p < d.length) {
      const s = d[p + 4] | (d[p + 5] << 8);
      if (String.fromCharCode(...d.subarray(p, p + 4)) === id) return d.subarray(p, p + 8 + s + (s & 1));
      p += 8 + s + (s & 1);
    }
    return null;
  };
  assert.deepEqual(sub(list, 'ISRC'), sub(origList, 'ISRC'));
  assert.deepEqual(sub(list, 'ISFT'), sub(origList, 'ISFT'));
  assert.deepEqual(dataChunk(out), dataChunk(before));
  const re = await open(out);
  assert.equal(find(re, 'INAM').value, 'abcd');
  assert.equal(find(re, 'IART').value, 'xyz!');
});

test('WAV: existing id3 chunk edited with the ID3 module', async () => {
  const before = F.fixtureWavOdd();
  const doc = await open(before);
  const t = doc.fields.find((f) => f.group === 'ID3' && f.key === 'TIT2');
  t.value = NON_ASCII;
  const pic = addField(doc, 'ID3:APIC');
  pic.value = { ...pic.value, mime: 'image/jpeg', data: F.FAKE_JPEG };
  const lyr = addField(doc, 'ID3:USLT');
  lyr.value = { lang: 'eng', desc: '', text: 'a\nb' };
  const out = await save(doc);
  const chunks = checkRiff(out);
  assert.ok(chunks.some((c) => c.id === 'id3 '));
  const re = await open(out);
  assert.equal(re.fields.find((f) => f.group === 'ID3' && f.key === 'TIT2').value, NON_ASCII);
  assert.deepEqual(re.fields.find((f) => f.group === 'ID3' && f.key === 'APIC').value.data, F.FAKE_JPEG);
  assert.equal(re.fields.find((f) => f.group === 'ID3' && f.key === 'TXXX').cls, 'preserve');
  assert.deepEqual(dataChunk(out), dataChunk(before));
});

test('WAV: "Add ID3 chunk" writes an id3 chunk (v2.4) before the trailing C2PA chunk', async () => {
  const before = F.fixture4().bytes;
  const doc = await open(before);
  assert.ok(addable(doc).some((a) => a.key === 'ID3CHUNK'));
  addField(doc, 'ID3CHUNK');
  addField(doc, 'ID3:APIC').value = { mime: 'image/png', ptype: 3, desc: '', data: F.FAKE_PNG };
  addField(doc, 'ID3:USLT').value = { lang: 'eng', desc: '', text: NON_ASCII };
  addField(doc, 'ID3:TIT2').value = NON_ASCII;
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  const chunks = checkRiff(out);
  assert.deepEqual(chunks.map((c) => c.id), ['fmt ', 'LIST', 'data', 'id3 ', 'C2PA']);
  const id3 = chunks.find((c) => c.id === 'id3 ').data;
  assert.equal(id3[3], 4, 'ID3v2.4');
  const re = await open(out);
  assert.equal(re.fields.find((f) => f.group === 'ID3' && f.key === 'TIT2').value, NON_ASCII);
  assert.deepEqual(re.fields.find((f) => f.group === 'ID3' && f.key === 'USLT').value.text, NON_ASCII);
  assert.deepEqual(dataChunk(out), dataChunk(before));
});

test('WAV: LIST/INFO inserted before data when absent', async () => {
  const before = F.riff([F.fmtPcm(), F.chunk('data', F.prng(3, 400))]);
  const doc = await open(before);
  addField(doc, 'INFO:INAM').value = 'Inserted';
  const out = await save(doc);
  const chunks = checkRiff(out);
  assert.deepEqual(chunks.map((c) => c.id), ['fmt ', 'LIST', 'data']);
  assert.equal(find(await open(out), 'INAM').value, 'Inserted');
});

test('WAV: RF64/BW64 rejected with a message', async () => {
  const b = F.riff([F.fmtPcm()]);
  b.set(F.latin1('RF64'), 0);
  await assert.rejects(open(b), /RF64.*not supported/);
  b.set(F.latin1('BW64'), 0);
  await assert.rejects(open(b), /BW64.*not supported/);
});

test('WAV technical: duration from data size / byte rate', async () => {
  const doc = await open(F.fixture4().bytes);
  const t = Object.fromEntries(doc.technical);
  assert.equal(t.Duration, '0:00.025'); // 4800 / 192000
  assert.equal(t['Bit depth'], '16');
  assert.equal(t['Sample rate'], '48000 Hz');
  assert.equal(t.Channels, '2');
});
