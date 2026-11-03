import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find } from './helpers.js';
import { addField, addable, errors, provenance } from '../public/editor.js';
import { parseTag, readHeader } from '../public/id3.js';
import { resolveGenre } from '../public/genres.js';

const { concat, latin1, enc, frame, textData, id3Tag, mpegFrames, bbox, full, dataItem, A9, u32be, u16be, txxxData } = F;

function tagOf(bytes) {
  const h = readHeader(bytes);
  return parseTag(bytes.subarray(0, h.totalSize));
}
function frameData(bytes, id, i = 0) {
  return tagOf(bytes).frames.filter((x) => x.id === id)[i].data;
}
function mp3(major, frames) {
  return concat([id3Tag(major, frames, 256), mpegFrames(4, 7, 4)]);
}

// ---- ID3 multi-value ----

test('ID3v2.4 multi-value text frame: one value per line, second value survives an edit to the first', async () => {
  const bytes = mp3(4, [frame(4, 'TPE1', textData(4, 'Alice\u0000Bob')), frame(4, 'TIT2', textData(4, 'T'))]);
  const doc = await open(bytes);
  const f = find(doc, 'TPE1');
  assert.equal(f.value, 'Alice\nBob');
  assert.equal(f.kind, 'multiline');
  assert.equal(f.multi, true);
  // Untouched multi-value frame is written back byte-for-byte when another field changes.
  find(doc, 'TIT2').value = 'T2';
  const out1 = await save(doc);
  assert.deepEqual(frameData(out1, 'TPE1'), frameData(bytes, 'TPE1'));
  // Editing writes NUL-separated values.
  f.value = 'Alicia\nBob';
  const out2 = await save(doc);
  assert.deepEqual(frameData(out2, 'TPE1'), concat([new Uint8Array([3]), enc.encode('Alicia\u0000Bob')]));
  assert.equal(find(await open(out2), 'TPE1').value, 'Alicia\nBob');
});

test('ID3v2.3 multi-value frame keeps its values separate (UTF-16) and blank lines are dropped', async () => {
  const doc = await open(mp3(3, [frame(3, 'TCOM', textData(3, 'Ünï\u0000Two'))]));
  const f = find(doc, 'TCOM');
  assert.equal(f.value, 'Ünï\nTwo');
  f.value = 'Ünï\n\nTwo\nThree\n';
  const re = await open(await save(doc));
  assert.equal(find(re, 'TCOM').value, 'Ünï\nTwo\nThree');
});

test('multi-value validator applies to each line', async () => {
  const doc = await open(mp3(4, [frame(4, 'TBPM', textData(4, '120\u0000121'))]));
  const f = find(doc, 'TBPM');
  f.value = '120\nabc';
  assert.match(errors(doc)[0].error, /Whole number/);
});

// ---- Genre codes ----

test('resolveGenre handles v2.3 and v2.4 code forms', () => {
  assert.deepEqual(resolveGenre('(13)'), ['Pop']);
  assert.deepEqual(resolveGenre('13'), ['Pop']);
  assert.deepEqual(resolveGenre('(51)(39)'), ['Techno-Industrial', 'Noise']);
  assert.deepEqual(resolveGenre('(4)Eurodisco'), ['Eurodisco']);
  assert.deepEqual(resolveGenre('RX'), ['Remix']);
  assert.deepEqual(resolveGenre('(CR)'), ['Cover']);
  assert.equal(resolveGenre('Synthwave'), null);
  assert.equal(resolveGenre('999'), null);
  assert.deepEqual(resolveGenre('(999)'), ['(999)']);
});

test('ID3 genre codes display as names; unchanged frame keeps the code, an edit writes the name', async () => {
  const bytes = mp3(3, [frame(3, 'TCON', textData(3, '(13)')), frame(3, 'TIT2', textData(3, 'x'))]);
  const doc = await open(bytes);
  const g = find(doc, 'TCON');
  assert.equal(g.value, 'Pop');
  assert.match(g.note, /genre code \(13\)/);
  find(doc, 'TIT2').value = 'y';
  const out = await save(doc);
  assert.deepEqual(frameData(out, 'TCON'), frameData(bytes, 'TCON'));
  g.value = 'Synthpop';
  assert.equal(find(await open(await save(doc)), 'TCON').value, 'Synthpop');
  const v4 = await open(mp3(4, [frame(4, 'TCON', textData(4, '17\u0000Shoegaze'))]));
  assert.equal(find(v4, 'TCON').value, 'Rock\nShoegaze');
});

// ---- TXXX ----

test('TXXX user text: editable, addable, duplicate description rejected', async () => {
  const doc = await open(F.fixture3());
  const t = find(doc, 'TXXX');
  assert.equal(t.cls, 'edit');
  assert.deepEqual(t.value, { desc: 'comment', text: F.SUNO_TEXT });
  t.value = { desc: 'comment', text: 'edited' };
  assert.ok(addable(doc).some((a) => a.key === 'TXXX'));
  const n = addField(doc, 'TXXX');
  n.value = { desc: 'comment', text: 'dup' };
  assert.match(errors(doc)[0].error, /same description/);
  n.value = { desc: 'MOOD', text: 'Calm' };
  assert.deepEqual(errors(doc), []);
  const re = await open(await save(doc));
  const all = re.fields.filter((f) => f.key === 'TXXX').map((f) => f.value);
  assert.deepEqual(all, [{ desc: 'comment', text: 'edited' }, { desc: 'MOOD', text: 'Calm' }]);
});

test('TXXX with several values edits one per line', async () => {
  const bytes = mp3(4, [frame(4, 'TXXX', txxxData(4, 'ARTISTS', 'A\u0000B'))]);
  const doc = await open(bytes);
  const t = find(doc, 'TXXX');
  assert.deepEqual(t.value, { desc: 'ARTISTS', text: 'A\nB' });
  t.value = { desc: 'ARTISTS', text: 'A\nB\nC' };
  const out = await save(doc);
  assert.deepEqual(frameData(out, 'TXXX'), concat([new Uint8Array([3]), enc.encode('ARTISTS\u0000A\u0000B\u0000C')]));
});

// ---- New ID3 fields ----

test('ID3: grouping, sort, compilation and version-specific date fields are addable and round-trip', async () => {
  const v4 = await open(mp3(4, [frame(4, 'TIT1', textData(4, 'G'))]));
  assert.equal(find(v4, 'TIT1').cls, 'edit');
  const keys4 = addable(v4).map((a) => a.key);
  for (const k of ['TSOP', 'TCMP', 'TDRL', 'TDOR', 'TPE4']) assert.ok(keys4.includes(k), k);
  assert.ok(!keys4.includes('TORY') && !keys4.includes('TYER'));
  const vals = { TSOP: 'Beatles, The', TCMP: '1', TDRL: '2024-05-06', TPE4: 'Remixer' };
  for (const [k, v] of Object.entries(vals)) addField(v4, k).value = v;
  const c = find(v4, 'TCMP');
  c.value = 'yes';
  assert.match(errors(v4)[0].error, /1 \(yes\) or 0/);
  c.value = '1';
  const re = await open(await save(v4));
  for (const [k, v] of Object.entries(vals)) assert.equal(find(re, k).value, v, k);
  const v3 = await open(mp3(3, [frame(3, 'TIT2', textData(3, 'x'))]));
  const keys3 = addable(v3).map((a) => a.key);
  assert.ok(keys3.includes('TORY') && keys3.includes('TYER'));
  assert.ok(!keys3.includes('TDRL') && !keys3.includes('TDRC'));
});

// ---- MP3 technical ----

function vbrFrames(count, delay, padding) {
  const frames = mpegFrames(count, 11);
  const xing = concat([latin1('Xing'), u32be(0x0f), u32be(count), u32be(frames.length), new Uint8Array(100), u32be(50), latin1('LAME3.100'),
    new Uint8Array(12), new Uint8Array([delay >> 4, ((delay & 15) << 4) | (padding >> 8), padding & 255])]);
  frames.fill(0, 4, 36);
  frames.set(xing, 36);
  return frames;
}

test('MP3 technical: VBR average bitrate, channel mode, gapless delay and padding from the LAME-format tag', async () => {
  const doc = await open(concat([id3Tag(4, [frame(4, 'TIT2', textData(4, 't'))], 64), vbrFrames(20, 576, 1234)]));
  const tech = Object.fromEntries(doc.technical);
  assert.equal(tech.Bitrate, 'VBR · 128 kbps average');
  assert.equal(tech.Channels, '2 (Stereo)');
  assert.equal(tech.Gapless, '576 samples delay, 1234 samples padding');
  assert.equal(tech['Encoder (LAME-format tag)'], 'LAME3.100');
  assert.equal(find(doc, 'Xing').label, 'Xing header + encoder tag');
});

test('MP3 technical: Info header is reported as CBR', async () => {
  const tech = Object.fromEntries((await open(F.fixture1())).technical);
  assert.equal(tech.Bitrate, 'CBR (Info header) · 128 kbps');
});

test('MP3 technical: VBRI header gives frame count and duration', async () => {
  const frames = mpegFrames(10, 21);
  frames.fill(0, 4, 36);
  frames.set(concat([latin1('VBRI'), u16be(1), u16be(576), u16be(75), u32be(frames.length), u32be(10)]), 36);
  const doc = await open(frames);
  const tech = Object.fromEntries(doc.technical);
  assert.equal(tech.Duration, '0:00.261');
  assert.match(tech.Bitrate, /^VBR · \d+ kbps average$/);
  assert.equal(find(doc, 'VBRI').display, '10 frames, 4.1 KB');
});

// ---- MP4 ----

const hdlr = (t) => full('hdlr', 0, 0, new Uint8Array(4), latin1(t), new Uint8Array(12), new Uint8Array([0]));
const dataBox = (type, payload) => bbox('data', new Uint8Array([0, 0, 0, type]), new Uint8Array(4), payload);

function m4a(items, { rate = 44100, ts = 44100, created = 0, soundVersion = 0 } = {}) {
  const mp4a = bbox('mp4a', new Uint8Array(6), u16be(1), u16be(soundVersion), new Uint8Array(6), u16be(2), u16be(24), u16be(0), u16be(0), u32be(rate >= 65536 ? 0 : rate * 65536));
  const trak = bbox('trak', full('tkhd', 0, 3, new Uint8Array(80)),
    bbox('mdia', full('mdhd', 0, 0, u32be(0), u32be(0), u32be(ts), u32be(ts * 5), new Uint8Array(4)), hdlr('soun'),
      bbox('minf', bbox('stbl', full('stsd', 0, 0, u32be(1), mp4a), full('stco', 0, 0, u32be(0))))));
  const mvhd = full('mvhd', 0, 0, u32be(created), u32be(created), u32be(1000), u32be(5000), new Uint8Array(80));
  const moov = bbox('moov', mvhd, trak, bbox('udta', full('meta', 0, 0, hdlr('mdir'), bbox('ilst', ...items))));
  return concat([bbox('ftyp', latin1('M4A '), u32be(0), latin1('M4A isom')), moov, bbox('mdat', new Uint8Array(16))]);
}

function ilstItem(bytes, type) {
  const re = F.indexOf(bytes, latin1(type));
  const size = (bytes[re - 4] << 24 | bytes[re - 3] << 16 | bytes[re - 2] << 8 | bytes[re - 1]) >>> 0;
  return bytes.subarray(re - 4, re - 4 + size);
}
function countData(item) {
  let n = 0;
  for (let i = 0; (i = F.indexOf(item, latin1('data'), i)) >= 0; i++) n++;
  return n;
}

test('MP4 item with several data boxes: one value per line, edit keeps each as its own data box', async () => {
  const bytes = m4a([bbox(A9 + 'ART', dataBox(1, enc.encode('Alice')), dataBox(1, enc.encode('Bob'))), dataItem(A9 + 'nam', 1, enc.encode('T'))]);
  const doc = await open(bytes);
  const f = find(doc, A9 + 'ART');
  assert.equal(f.value, 'Alice\nBob');
  assert.equal(f.multi, true);
  find(doc, A9 + 'nam').value = 'T2';
  const out1 = await save(doc);
  assert.deepEqual(ilstItem(out1, A9 + 'ART'), ilstItem(bytes, A9 + 'ART'), 'untouched item byte-identical');
  f.value = 'Alicia\nBob\nCarol';
  const out2 = await save(doc);
  assert.equal(countData(ilstItem(out2, A9 + 'ART')), 3);
  assert.equal(find(await open(out2), A9 + 'ART').value, 'Alicia\nBob\nCarol');
});

test('MP4 multi-value lyrics stay read-only rather than being split by line', async () => {
  const doc = await open(m4a([bbox(A9 + 'lyr', dataBox(1, enc.encode('a\nb')), dataBox(1, enc.encode('c')))]));
  const f = find(doc, A9 + 'lyr');
  assert.equal(f.cls, 'preserve');
  assert.match(f.display, /^2 values/);
});

test('MP4 integer items with data type 0: gnre shows the genre name, labels for rtng/stik', async () => {
  const doc = await open(m4a([dataItem('gnre', 0, u16be(14)), dataItem('rtng', 0, new Uint8Array([1])), dataItem('stik', 21, new Uint8Array([1]))]));
  assert.equal(find(doc, 'gnre').display, 'Pop (14)', 'gnre stores the ID3v1 index plus one');
  assert.equal(find(doc, 'rtng').label, 'Content rating (rtng)');
  assert.equal(find(doc, 'rtng').display, '1');
  assert.equal(find(doc, 'stik').label, 'Media kind (stik)');
});

test('MP4: compilation, grouping and sort items are editable and addable', async () => {
  const doc = await open(m4a([dataItem('cpil', 21, new Uint8Array([1]))]));
  const c = find(doc, 'cpil');
  assert.equal(c.cls, 'edit');
  assert.equal(c.value, '1');
  for (const k of [A9 + 'grp', 'soar', 'desc']) assert.ok(addable(doc).some((a) => a.key === k), k);
  c.value = '0';
  addField(doc, A9 + 'grp').value = 'Group';
  addField(doc, 'soar').value = 'Beatles, The';
  const re = await open(await save(doc));
  assert.equal(find(re, 'cpil').value, '0');
  assert.equal(find(re, A9 + 'grp').value, 'Group');
  assert.equal(find(re, 'soar').value, 'Beatles, The');
});

test('MP4 sample rate above 65535 Hz comes from the media timescale', async () => {
  const hi = Object.fromEntries((await open(m4a([], { rate: 96000, ts: 96000 }))).technical);
  assert.match(hi['Track 1'], /96000 Hz/);
  const lo = Object.fromEntries((await open(m4a([], { rate: 44100, ts: 44100 }))).technical);
  assert.match(lo['Track 1'], /44100 Hz/);
  const qt2 = Object.fromEntries((await open(m4a([], { rate: 1, ts: 48000, soundVersion: 2 }))).technical);
  assert.match(qt2['Track 1'], /48000 Hz/);
});

test('MP4 technical: creation date from mvhd', async () => {
  const secs = Math.round((Date.UTC(2024, 4, 6, 7, 8, 9) - Date.UTC(1904, 0, 1)) / 1000);
  const tech = Object.fromEntries((await open(m4a([], { created: secs }))).technical);
  assert.equal(tech['Created (mvhd)'], '2024-05-06T07:08:09Z');
});

// ---- C2PA details ----

function signedMp3() {
  const store = F.manifestStore({ kind: 'bmff' }, {
    signature: F.coseSignature(),
    claim: { claim_generator_info: { name: 'Suno', version: '1.0', 'org.contentauth.c2pa_rs': '0.89.0' }, 'dc:title': 'Song', 'dc:format': 'audio/mpeg' },
    assertions: [['c2pa.soft-binding', { alg: 'com.example.fp.v1', blocks: [] }], ['c2pa.ingredient.v3', { title: 'stem.wav', relationship: 'componentOf' }]],
  });
  const geob = frame(4, 'GEOB', F.geobData('application/c2pa', 'c2pa', 'c2pa manifest store', store));
  return mp3(4, [frame(4, 'COMM', F.commData(4, 'eng', '', F.SUNO_TEXT)), frame(4, 'TXXX', txxxData(4, 'comment', 'made with suno; created=2025-03-04T05:06:00Z; id=' + F.SUNO_ID)), geob]);
}

test('C2PA: claim details, soft binding, ingredients, signer and timestamp (unvalidated)', async () => {
  const s = (await open(signedMp3())).c2pa.summary;
  assert.deepEqual(s.generator, ['Suno 1.0', 'org.contentauth.c2pa_rs 0.89.0']);
  assert.equal(s.instanceID, 'xmp:iid:00000000-0000-0000-0000-000000000001');
  assert.equal(s.title, 'Song');
  assert.equal(s.format, 'audio/mpeg');
  assert.deepEqual(s.softBinding, ['com.example.fp.v1']);
  assert.deepEqual(s.ingredients, ['stem.wav · componentOf']);
  const sig = s.signature;
  assert.equal(sig.alg, 'ES256');
  assert.deepEqual(sig.signer, { CN: 'Test Content Credentials', O: 'Test Org' });
  assert.deepEqual(sig.issuer, { CN: 'Test C2PA Root CA', O: 'Test Org' });
  assert.equal(sig.notBefore, '2026-07-23T15:00:14Z');
  assert.equal(sig.notAfter, '2028-10-25T15:00:14Z');
  assert.equal(sig.timestamp, '2025-03-04T05:06:10Z');
  assert.deepEqual(sig.tsa, { CN: 'Test Timestamp Responder', O: 'Time Co' });
  assert.deepEqual(sig.errors, []);
});

test('C2PA: an unparseable signature yields no signer instead of failing the summary', async () => {
  const s = (await open(F.fixture2().bytes)).c2pa.summary;
  assert.equal(s.signature, null);
  assert.deepEqual(s.generator, ['Suno 1.0']);
});

test('Suno provenance strings are compared with the C2PA createdAt and signing time', async () => {
  const p = provenance(await open(signedMp3()));
  const comm = p.find((x) => x.where === 'COMM');
  const txxx = p.find((x) => x.where === 'TXXX comment');
  assert.deepEqual(comm.relations, ['same as C2PA createdAt', '3 s before C2PA signing time']);
  assert.deepEqual(txxx.relations, ['7 s before C2PA createdAt', '10 s before C2PA signing time']);
  assert.equal(p.differ, true);
});

// ---- Detection ----

test('Unsupported formats get a clear "not supported yet" message', async () => {
  const cases = [
    [concat([latin1('OggS'), new Uint8Array(20)]), /Ogg/],
    [latin1('%PDF-1.7\n' + 'x'.repeat(20)), /PDF/],
  ];
  for (const [bytes, re] of cases) await assert.rejects(open(bytes), re);
});

test('Audio sweep: every ID3 text/URL frame, MP4 text/freeform item and WAV INFO item is editable', async () => {
  const bytes = mp3(4, [frame(4, 'TSSE', textData(4, 'Lavf')), frame(4, 'TENC', textData(4, 'x')), frame(4, 'WCOM', latin1('http://a'))]);
  const d1 = await open(bytes);
  find(d1, 'TSSE').value = 'Edited enc';
  find(d1, 'WCOM').value = 'https://b.example';
  const r1 = await open(await save(d1));
  assert.equal(find(r1, 'TSSE').value, 'Edited enc');
  assert.equal(find(r1, 'WCOM').value, 'https://b.example');
  const ff = bbox('----', full('mean', 0, 0, latin1('com.apple.iTunes')), full('name', 0, 0, latin1('MOOD')), dataBox(1, enc.encode('calm')));
  const d2 = await open(m4a([dataItem(A9 + 'too', 1, enc.encode('Lavf')), ff]));
  find(d2, A9 + 'too').value = 'Tool 2';
  find(d2, '----').value = 'happy';
  const r2 = await open(await save(d2));
  assert.equal(find(r2, A9 + 'too').value, 'Tool 2');
  assert.equal(find(r2, '----').value, 'happy');
  assert.equal(find(r2, '----').label, 'MOOD (freeform)');
  const d3 = await open(F.fixtureWavOdd());
  find(d3, 'ISFT').value = 'New software';
  assert.equal(find(await open(await save(d3)), 'ISFT').value, 'New software');
});
