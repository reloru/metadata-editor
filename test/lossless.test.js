import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find } from './helpers.js';
import { addField, addable, errors, provenance } from '../public/editor.js';
import { extended } from '../public/aiff.js';

const { concat, latin1, enc, u32be, u16be, prng, frame, textData, id3Tag } = F;
const u32le = F.u32le;

// ---- FLAC ----

function block(type, data, last = false) {
  return concat([new Uint8Array([(last ? 0x80 : 0) | type, data.length >> 16, (data.length >> 8) & 255, data.length & 255]), data]);
}
function streaminfo(sr = 44100, ch = 2, bits = 16, total = 441000) {
  const v = (BigInt(sr) << 44n) | (BigInt(ch - 1) << 41n) | (BigInt(bits - 1) << 36n) | BigInt(total);
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(56 - 8 * i)) & 255n);
  return concat([u16be(4096), u16be(4096), new Uint8Array(6), b, prng(50, 16)]);
}
function vorbis(vendor, entries) {
  const v = enc.encode(vendor);
  return concat([u32le(v.length), v, u32le(entries.length), ...entries.map((e) => { const b = enc.encode(e); return concat([u32le(b.length), b]); })]);
}
function picture(ptype, mime, data) {
  const m = latin1(mime);
  return concat([u32be(ptype), u32be(m.length), m, u32be(0), u32be(1), u32be(1), u32be(24), u32be(0), u32be(data.length), data]);
}
const FRAMES = concat([new Uint8Array([0xff, 0xf8]), prng(51, 4000)]);
function flacFixture({ padding = 512, prefix = null } = {}) {
  return concat([prefix || new Uint8Array(0), latin1('fLaC'), block(0, streaminfo()),
    block(4, vorbis('reference libFLAC 1.4.3', ['TITLE=Old', 'ARTIST=A', 'ARTIST=B', 'comment=' + F.SUNO_TEXT, 'MOOD=calm'])),
    block(6, picture(3, 'image/jpeg', F.FAKE_JPEG)), block(3, new Uint8Array(18)), block(1, new Uint8Array(padding), true), FRAMES]);
}
function blocks(b) {
  let o = F.indexOf(b, latin1('fLaC')) + 4;
  const out = [];
  for (;;) {
    const last = (b[o] & 0x80) !== 0;
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    out.push({ type: b[o] & 0x7f, last, len });
    o += 4 + len;
    if (last) return { list: out, audio: o };
  }
}

test('FLAC: stream info, Vorbis comments (multi-value, case-insensitive keys), picture, provenance', async () => {
  const doc = await open(flacFixture());
  assert.equal(doc.format, 'FLAC');
  const tech = Object.fromEntries(doc.technical);
  assert.equal(tech['Sample rate'], '44100 Hz');
  assert.equal(tech['Bit depth'], '16');
  assert.equal(tech.Duration, '0:10.000');
  assert.equal(tech['Encoder (vendor)'], 'reference libFLAC 1.4.3');
  assert.equal(find(doc, 'ARTIST').value, 'A\nB');
  assert.equal(find(doc, 'COMMENT').label, 'Comment');
  assert.equal(find(doc, 'MOOD').label, 'MOOD');
  assert.deepEqual(find(doc, 'PICTURE').value.data, F.FAKE_JPEG);
  assert.equal(find(doc, 'SEEKTABLE').cls, 'protected');
  assert.deepEqual(provenance(doc).map((p) => p.where), ['Vorbis COMMENT']);
});

test('FLAC: edits keep key spelling and order, padding absorbs growth, audio untouched and in place', async () => {
  const before = flacFixture();
  const doc = await open(before);
  find(doc, 'TITLE').value = 'Ünï title';
  find(doc, 'ARTIST').value = 'A\nB\nC';
  addField(doc, 'GENRE').value = 'Synthwave';
  const c = addField(doc, '*custom');
  c.value = { name: 'mood', text: 'x' };
  assert.match(errors(doc)[0].error, /already exists/);
  c.value = { name: 'SOURCE', text: 'suno' };
  assert.deepEqual(errors(doc), []);
  const out = await save(doc);
  const b = blocks(out);
  assert.deepEqual(b.list.map((x) => x.type), [0, 4, 6, 3, 1]);
  assert.deepEqual(b.list.map((x) => x.last), [false, false, false, false, true]);
  assert.equal(b.audio, blocks(before).audio, 'audio offset unchanged');
  assert.deepEqual(out.subarray(b.audio), FRAMES);
  const re = await open(out);
  assert.equal(find(re, 'TITLE').value, 'Ünï title');
  assert.equal(find(re, 'ARTIST').value, 'A\nB\nC');
  assert.equal(find(re, 'GENRE').value, 'Synthwave');
  assert.equal(find(re, 'SOURCE').value, 'suno');
  assert.equal(find(re, 'COMMENT').vkey, 'comment');
});

test('FLAC: growth beyond the padding adds fresh padding; cover replace and delete', async () => {
  const doc = await open(flacFixture({ padding: 16 }));
  const pic = find(doc, 'PICTURE');
  const big = concat([F.FAKE_PNG.subarray(0, 8), u32be(13), latin1('IHDR'), u32be(300), u32be(200), new Uint8Array([8, 6, 0, 0, 0]), prng(52, 3000)]);
  pic.value = { ...pic.value, mime: 'image/png', data: big };
  const out = await save(doc);
  const b = blocks(out);
  assert.equal(b.list[b.list.length - 1].len, 4096);
  assert.deepEqual(out.subarray(b.audio), FRAMES);
  const re = await open(out);
  const p = find(re, 'PICTURE').value;
  assert.equal(p.mime, 'image/png');
  assert.deepEqual(p.data, big);
  const raw = out.subarray(F.indexOf(out, latin1('image/png')) + 9);
  assert.deepEqual([...raw.subarray(4, 16)], [...u32be(300), ...u32be(200), ...u32be(32)], 'width, height, depth from the image');
  find(re, 'PICTURE').deleted = true;
  const re2 = await open(await save(re));
  assert.equal(re2.fields.find((f) => f.key === 'PICTURE'), undefined);
  assert.ok(addable(re2).some((a) => a.key === 'PICTURE'));
});

test('FLAC with a leading ID3v2 tag opens as FLAC and keeps the tag', async () => {
  const tag = id3Tag(4, [frame(4, 'TIT2', textData(4, 'id3'))], 32);
  const before = flacFixture({ prefix: tag });
  const doc = await open(before);
  assert.equal(doc.format, 'FLAC');
  find(doc, 'TITLE').value = 'New';
  const out = await save(doc);
  assert.deepEqual(out.subarray(0, tag.length), tag);
  assert.deepEqual(await save(await open(before)), before, 'no-op save identical');
});

// ---- AIFF ----

function chunk(id, data) {
  return concat([latin1(id), u32be(data.length), data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}
const RATE_44100 = new Uint8Array([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
const SOUND = prng(60, 1001);
function aiffFixture(aifc = false) {
  const comm = concat([u16be(2), u32be(44100), u16be(16), RATE_44100, ...(aifc ? [latin1('sowt'), new Uint8Array([13]), latin1('little endian')] : [])]);
  const chunks = [
    ...(aifc ? [chunk('FVER', u32be(0xa2805140))] : []), chunk('COMM', comm), chunk('NAME', latin1('Old')), chunk('ANNO', latin1(F.SUNO_TEXT)),
    chunk('SSND', concat([u32be(0), u32be(0), SOUND])), chunk('ID3 ', id3Tag(4, [frame(4, 'TIT2', textData(4, 'id3 title'))], 64)),
  ];
  const body = concat(chunks);
  return concat([latin1('FORM'), u32be(body.length + 4), latin1(aifc ? 'AIFC' : 'AIFF'), body]);
}
function aiffChunks(b) {
  const out = [];
  const end = 8 + ((b[4] << 24 | b[5] << 16 | b[6] << 8 | b[7]) >>> 0);
  assert.equal(end, b.length, 'FORM size matches');
  for (let o = 12; o < end;) {
    const id = String.fromCharCode(...b.subarray(o, o + 4));
    const size = (b[o + 4] << 24 | b[o + 5] << 16 | b[o + 6] << 8 | b[o + 7]) >>> 0;
    out.push({ id, data: b.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size & 1);
  }
  return out;
}

test('80-bit extended sample rate', () => {
  assert.equal(extended(RATE_44100, 0), 44100);
  assert.equal(extended(new Uint8Array([0x40, 0x0f, 0xbb, 0x80, 0, 0, 0, 0, 0, 0]), 0), 96000);
});

test('AIFF: format, text chunks and ID3 chunk read; AIFC compression shown', async () => {
  const doc = await open(aiffFixture());
  assert.equal(doc.format, 'AIFF');
  const tech = Object.fromEntries(doc.technical);
  assert.equal(tech['Sample rate'], '44100 Hz');
  assert.equal(tech.Duration, '0:01.000');
  assert.equal(find(doc, 'NAME').value, 'Old');
  assert.equal(find(doc, 'TIT2').value, 'id3 title');
  assert.deepEqual(provenance(doc).map((p) => p.where), ['AIFF ANNO']);
  const c = await open(aiffFixture(true));
  assert.equal(c.format, 'AIFC');
  assert.equal(Object.fromEntries(c.technical).Codec, 'sowt (little endian)');
});

test('AIFF: edit text and ID3, add AUTH; sound data untouched; non-Latin-1 text rejected', async () => {
  const before = aiffFixture();
  const doc = await open(before);
  find(doc, 'NAME').value = 'New ✓';
  assert.match(errors(doc)[0].error, /ISO-8859-1/);
  find(doc, 'NAME').value = 'Néw';
  addField(doc, 'TXT:AUTH').value = 'Me';
  find(doc, 'TIT2').value = 'ID3 ✓';
  const out = await save(doc);
  const ch = aiffChunks(out);
  assert.deepEqual(ch.map((c) => c.id), ['COMM', 'NAME', 'ANNO', 'AUTH', 'SSND', 'ID3 ']);
  assert.deepEqual(ch.find((c) => c.id === 'SSND').data, aiffChunks(before).find((c) => c.id === 'SSND').data);
  const re = await open(out);
  assert.equal(find(re, 'NAME').value, 'Néw');
  assert.equal(find(re, 'AUTH').value, 'Me');
  assert.equal(find(re, 'TIT2').value, 'ID3 ✓');
  assert.deepEqual(await save(await open(before)), before, 'no-op save identical');
});
