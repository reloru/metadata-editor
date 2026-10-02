import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find } from './helpers.js';
import { addField, addable, errors } from '../public/editor.js';
import { parseTag, readHeader } from '../public/id3.js';

const NON_ASCII = 'Ünïcødé 日本語 ✓';

function tagOf(bytes) {
  const h = readHeader(bytes);
  return parseTag(bytes.subarray(0, h.totalSize));
}

function frameRaw(tag, id, pred = () => true) {
  const f = tag.frames.find((x) => x.id === id && pred(x));
  assert.ok(f, `frame ${id}`);
  return f.raw;
}

async function assertPayloadIntact(before, after) {
  const a = await open(before);
  const b = await open(after);
  assert.deepEqual(after.subarray(b.tagEnd), before.subarray(a.tagEnd), 'audio + trailing bytes identical');
}

const VALUES = (major) => ({
  TIT2: NON_ASCII, TPE1: 'Café', TPE2: NON_ASCII, TALB: 'Álbum', TCON: 'Synthwave', TRCK: '3/12', TPOS: '1/2',
  TBPM: '120', TKEY: 'Abm', TCOM: NON_ASCII, TEXT: 'Lyricist ü', TCOP: '© 2024 Someone', TPUB: 'Label',
  TSRC: 'USABC2400001', [major === 3 ? 'TYER' : 'TDRC']: major === 3 ? '2024' : '2024-05-06',
});

for (const [name, make, major] of [['v2.3 (fixture1)', () => F.fixture1(), 3], ['v2.4 (fixture2)', () => F.fixture2().bytes, 4], ['v2.4 minimal (fixture3)', () => F.fixture3(), 4]]) {
  test(`ID3 ${name}: every editable field round-trips, including non-ASCII`, async () => {
    const before = make();
    const doc = await open(before);
    const vals = VALUES(major);
    for (const [k, v] of Object.entries(vals)) {
      const f = doc.fields.find((x) => x.key === k && !x.deleted) || addField(doc, k);
      f.value = v;
    }
    for (const f of doc.fields.filter((x) => x.key === 'COMM' || x.key === 'USLT')) f.deleted = true;
    const c1 = addField(doc, 'COMM'); c1.value = { lang: 'eng', desc: '', text: NON_ASCII };
    const c2 = addField(doc, 'COMM'); c2.value = { lang: 'deu', desc: 'ü', text: 'zweiter' };
    const l1 = addField(doc, 'USLT'); l1.value = { lang: 'eng', desc: '', text: `Line 1\n${NON_ASCII}\nLine 3` };
    const woas = doc.fields.find((x) => x.key === 'WOAS') || addField(doc, 'WOAS');
    woas.value = 'https://example.com/café';
    let apic = doc.fields.find((x) => x.key === 'APIC');
    const oldDesc = apic ? apic.value.desc : '';
    if (!apic) apic = addField(doc, 'APIC');
    apic.value = { ...apic.value, mime: 'image/png', data: F.FAKE_PNG };
    assert.deepEqual(errors(doc), []);
    if (doc.c2pa) doc.c2pa.choice = 'keep';
    const out = await save(doc);
    const re = await open(out);
    assert.equal(re.tag.major, major, 'written in the version read');
    for (const [k, v] of Object.entries(vals)) assert.equal(find(re, k).value, v, k);
    const comms = re.fields.filter((x) => x.key === 'COMM').map((x) => x.value);
    assert.deepEqual(comms, [{ lang: 'eng', desc: '', text: NON_ASCII }, { lang: 'deu', desc: 'ü', text: 'zweiter' }]);
    assert.deepEqual(find(re, 'USLT').value, { lang: 'eng', desc: '', text: `Line 1\n${NON_ASCII}\nLine 3` });
    assert.equal(find(re, 'WOAS').value, 'https://example.com/café');
    const pic = find(re, 'APIC').value;
    assert.equal(pic.mime, 'image/png');
    assert.equal(pic.ptype, 3);
    assert.equal(pic.desc, oldDesc, 'description kept on replace');
    assert.deepEqual(pic.data, F.FAKE_PNG);
    // Encodings: v2.3 ISO-8859-1 when representable else UTF-16 with BOM; v2.4 UTF-8.
    const tag = tagOf(out);
    const enc = (id) => tag.frames.find((x) => x.id === id).data[0];
    if (major === 3) {
      assert.equal(enc('TPE1'), 0);
      assert.equal(enc('TIT2'), 1);
      const t = tag.frames.find((x) => x.id === 'TIT2').data;
      assert.deepEqual([t[1], t[2]], [0xff, 0xfe]);
    } else {
      assert.equal(enc('TPE1'), 3);
      assert.equal(enc('TIT2'), 3);
    }
    await assertPayloadIntact(before, out);
  });
}

test('ID3: preserve frames are copied byte-for-byte; untouched frames raw', async () => {
  const before = F.fixture2().bytes;
  const doc = await open(before);
  find(doc, 'TIT2').value = 'New title';
  doc.c2pa.choice = 'keep';
  const out = await save(doc);
  const a = tagOf(before);
  const b = tagOf(out);
  for (const id of ['TSSE', 'TXXX', 'GEOB', 'TPE1', 'APIC', 'COMM', 'USLT', 'WOAS']) assert.deepEqual(frameRaw(b, id), frameRaw(a, id), id);
  await assertPayloadIntact(before, out);
});

test('ID3: tag keeps its size when the edit fits in padding, else grows with 2048 bytes padding', async () => {
  const before = F.fixture1();
  const h0 = readHeader(before);
  const doc = await open(before);
  find(doc, 'TIT2').value = 'A slightly longer title';
  const out = await save(doc);
  assert.equal(readHeader(out).size, h0.size);
  assert.equal(out.length, before.length);
  await assertPayloadIntact(before, out);

  const doc2 = await open(before);
  find(doc2, 'USLT').value = { lang: 'eng', desc: '', text: 'x'.repeat(5000) };
  const out2 = await save(doc2);
  const h2 = readHeader(out2);
  const tag2 = tagOf(out2);
  const used = tag2.frames.reduce((n, f) => n + f.raw.length, 0);
  assert.equal(h2.size, used + 2048);
  assert.ok(out2.subarray(10 + used, 10 + h2.size).every((x) => x === 0), 'padding zero-filled');
  await assertPayloadIntact(before, out2);
});

test('ID3: delete fields; padding absorbs the shrink', async () => {
  const before = F.fixture1();
  const doc = await open(before);
  find(doc, 'APIC').deleted = true;
  find(doc, 'WOAS').deleted = true;
  const out = await save(doc);
  assert.equal(out.length, before.length);
  const re = await open(out);
  assert.ok(!re.fields.some((f) => f.key === 'APIC' || f.key === 'WOAS'));
  assert.equal(find(re, 'TIT2').value, 'Ocean Drive');
  await assertPayloadIntact(before, out);
});

test('ID3: COMM uniqueness by (language, description)', async () => {
  const doc = await open(F.fixture1());
  const c = addField(doc, 'COMM');
  assert.equal(c.value.desc, '2', 'new COMM gets a free description');
  c.value = { lang: 'eng', desc: '', text: 'dup' };
  assert.equal(errors(doc).length, 1);
  c.value = { lang: 'eng', desc: 'other', text: 'ok' };
  assert.deepEqual(errors(doc), []);
});

test('ID3: validation of track, BPM, ISRC, year', async () => {
  const doc = await open(F.fixture1());
  for (const [k, bad, good] of [['TRCK', '1/', '1/9'], ['TPOS', 'x', '2'], ['TBPM', '12.5', '125'], ['TSRC', 'US-ABC-24-00001', 'USABC2400001'], ['TYER', '24', '2024']]) {
    const f = doc.fields.find((x) => x.key === k) || addField(doc, k);
    f.value = bad;
    assert.equal(errors(doc).length, 1, k);
    f.value = good;
    assert.deepEqual(errors(doc), [], k);
  }
  const d1 = await open(F.fixture1());
  assert.ok(addable(d1).some((a) => a.key === 'TYER'));
  assert.ok(!addable(d1).some((a) => a.key === 'TDRC'), 'v2.3 offers TYER only');
  assert.ok(!addable(doc).some((a) => a.key === 'TYER'), 'present single-instance fields are not offered');
  const d4 = await open(F.fixture3());
  assert.ok(addable(d4).some((a) => a.key === 'TDRC'));
  assert.ok(!addable(d4).some((a) => a.key === 'TYER'), 'v2.4 offers TDRC only');
});

test('ID3v2.4 footer: read, edit, written back with footer', async () => {
  const before = F.fixtureFooter();
  const doc = await open(before);
  assert.equal(find(doc, 'TIT2').value, 'Footer Song');
  find(doc, 'TIT2').value = NON_ASCII;
  const out = await save(doc);
  const h = readHeader(out);
  assert.ok(h.hasFooter);
  assert.equal(String.fromCharCode(...out.subarray(10 + h.size, 10 + h.size + 3)), '3DI');
  assert.deepEqual(out.subarray(10 + h.size + 6, 10 + h.size + 10), out.subarray(6, 10), 'footer size matches header');
  const re = await open(out);
  assert.equal(find(re, 'TIT2').value, NON_ASCII);
  await assertPayloadIntact(before, out);
});

test('ID3v2.3 unsynchronisation: decoded on read, written without it', async () => {
  const { bytes, unsynced } = F.fixtureUnsync();
  assert.ok(unsynced, 'fixture actually contains unsynchronised bytes');
  const doc = await open(bytes);
  assert.equal(find(doc, 'TIT2').value, 'ÿÿ Unsync');
  assert.deepEqual(find(doc, 'APIC').value.data, F.FAKE_JPEG);
  find(doc, 'TIT2').value = 'Re-synced';
  const out = await save(doc);
  assert.equal(out[5] & 0x80, 0, 'unsync flag cleared');
  const re = await open(out);
  assert.equal(find(re, 'TIT2').value, 'Re-synced');
  assert.deepEqual(find(re, 'APIC').value.data, F.FAKE_JPEG);
  assert.equal(find(re, 'TSSE').display, 'enc');
  await assertPayloadIntact(bytes, out);
});

test('MP3 technical: duration from Xing frame count, otherwise unknown', async () => {
  const d1 = await open(F.fixture1());
  const tech = Object.fromEntries(d1.technical);
  assert.equal(tech.Duration, '0:26.122');
  assert.equal(tech['Sample rate'], '44100 Hz');
  assert.equal(tech.Codec, 'MPEG-1 Layer III');
  assert.ok(d1.fields.some((f) => f.cls === 'protected' && f.key === 'Xing'));
  const d3 = await open(F.fixture3());
  assert.equal(Object.fromEntries(d3.technical).Duration, 'unknown');
});

test('MP3 without a tag: adding a field creates an ID3v2.4 tag', async () => {
  const before = F.mpegFrames(3, 900);
  const doc = await open(before);
  assert.equal(doc.tag, null);
  addField(doc, 'TIT2').value = NON_ASCII;
  const out = await save(doc);
  const re = await open(out);
  assert.equal(re.tag.major, 4);
  assert.equal(find(re, 'TIT2').value, NON_ASCII);
  assert.deepEqual(out.subarray(re.tagEnd), before);
});

test('ID3v1 / APEv2 trailing tags are detected, preserved and deletable', async () => {
  const v1 = new Uint8Array(128);
  v1.set(F.latin1('TAGOld title'));
  const apeFooter = F.concat([F.latin1('APETAGEX'), F.u32le(2000), F.u32le(32 + 10), F.u32le(1), F.u32le(0), new Uint8Array(8)]);
  const ape = F.concat([new Uint8Array(10), apeFooter]);
  const before = F.concat([F.fixture3(), ape, v1]);
  const doc = await open(before);
  const pv1 = find(doc, 'ID3v1');
  const pape = find(doc, 'APE');
  assert.equal(pv1.cls, 'preserve');
  assert.equal(pape.cls, 'preserve');
  find(doc, 'TSSE').deleted = false;
  const out0 = await save(doc);
  assert.deepEqual(out0, before);
  pape.deleted = true;
  const out = await save(doc);
  assert.deepEqual(out.subarray(out.length - 128), v1);
  assert.equal(out.length, before.length - ape.length);
});
