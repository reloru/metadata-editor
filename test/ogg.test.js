import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './fixtures.js';
import { open, save, find } from './helpers.js';
import { addField, provenance } from '../public/editor.js';
import { oggCrc } from '../public/ogg.js';

const { concat, latin1, enc, prng } = F;
const le32 = F.u32le;

function page(type, serial, seq, granule, segs, body) {
  const h = concat([latin1('OggS'), new Uint8Array([0, type]), granule, le32(serial), le32(seq), new Uint8Array(4), new Uint8Array([segs.length]), Uint8Array.from(segs)]);
  const p = concat([h, body]);
  const c = oggCrc(p);
  p.set([c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24], 22);
  return p;
}
function lacing(len) { const s = []; let n = len; while (n >= 255) { s.push(255); n -= 255; } s.push(n); return s; }
const G0 = new Uint8Array(8);
function vorbisComment(vendor, entries) {
  const v = enc.encode(vendor);
  return concat([le32(v.length), v, le32(entries.length), ...entries.map((e) => { const b = enc.encode(e); return concat([le32(b.length), b]); })]);
}
const AUDIO = [page(0, 7, 3, concat([le32(48000), le32(0)]), [200, 100], prng(80, 300)), page(4, 7, 4, concat([le32(96000), le32(0)]), [50], prng(81, 50))];

function opusFile(entries, serial = 7) {
  const head = concat([latin1('OpusHead'), new Uint8Array([1, 2]), F.u16le(312), le32(48000), new Uint8Array(3)]);
  const tags = concat([latin1('OpusTags'), vorbisComment('libopus 1.4', entries)]);
  return concat([page(2, serial, 0, G0, lacing(head.length), head), page(0, serial, 1, G0, lacing(tags.length), tags), ...AUDIO.map((p, i) => renumber(p, 2 + i))]);
}
function renumber(p, seq) {
  const q = p.slice();
  q.set(le32(seq), 18);
  q.fill(0, 22, 26);
  const c = oggCrc(q);
  q.set([c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24], 22);
  return q;
}
function vorbisFile(entries) {
  const id = concat([new Uint8Array([1]), latin1('vorbis'), le32(0), new Uint8Array([2]), le32(44100), le32(0), le32(128000), le32(0), new Uint8Array([0xb8, 1])]);
  const comment = concat([new Uint8Array([3]), latin1('vorbis'), vorbisComment('Xiph.Org libVorbis', entries), new Uint8Array([1])]);
  const setup = concat([new Uint8Array([5]), latin1('vorbis'), prng(82, 3000)]);
  return concat([page(2, 7, 0, G0, lacing(id.length), id), page(0, 7, 1, G0, [...lacing(comment.length), ...lacing(setup.length)], concat([comment, setup])), ...AUDIO.map((p, i) => renumber(p, 2 + i))]);
}
function pages(b) {
  const out = [];
  for (let o = 0; o < b.length;) {
    assert.equal(String.fromCharCode(...b.subarray(o, o + 4)), 'OggS');
    const n = b[o + 26];
    let len = 0;
    for (let i = 0; i < n; i++) len += b[o + 27 + i];
    const p = b.subarray(o, o + 27 + n + len);
    const q = p.slice(); q.fill(0, 22, 26);
    const crc = (p[22] | (p[23] << 8) | (p[24] << 16) | (p[25] << 24)) >>> 0;
    assert.equal(crc, oggCrc(q), 'page CRC');
    out.push({ seq: (p[18] | (p[19] << 8) | (p[20] << 16) | (p[21] << 24)) >>> 0, bytes: p });
    o += p.length;
  }
  return out;
}

test('Ogg Vorbis: comments read and edited in place; page count, sequence numbers and audio pages unchanged', async () => {
  const before = vorbisFile(['TITLE=Old', 'ARTIST=A', 'ARTIST=B', 'COMMENT=' + F.SUNO_TEXT]);
  const doc = await open(before);
  assert.equal(doc.format, 'Ogg Vorbis');
  assert.equal(find(doc, 'ARTIST').value, 'A\nB');
  assert.deepEqual(provenance(doc).map((p) => p.where), ['Vorbis COMMENT']);
  assert.equal(Object.fromEntries(doc.technical)['Sample rate'], '44100 Hz');
  find(doc, 'TITLE').value = 'Ünï new title';
  addField(doc, 'GENRE').value = 'Synthwave';
  const out = await save(doc);
  const a = pages(before);
  const b = pages(out);
  assert.deepEqual(b.map((p) => p.seq), a.map((p) => p.seq));
  assert.deepEqual(b.slice(2).map((p) => p.bytes), a.slice(2).map((p) => p.bytes), 'audio pages byte-identical');
  const re = await open(out);
  assert.equal(find(re, 'TITLE').value, 'Ünï new title');
  assert.equal(find(re, 'GENRE').value, 'Synthwave');
  assert.equal(re.packets[1].length, 3007, 'setup header intact');
});

test('Opus: shrinking pads within the page; oversized edits are refused', async () => {
  const before = opusFile(['TITLE=Old', 'DESCRIPTION=' + 'd'.repeat(600)]);
  const doc = await open(before);
  assert.equal(doc.format, 'Opus');
  find(doc, 'DESCRIPTION').deleted = true;
  const re = await open(await save(doc));
  assert.equal(re.fields.find((f) => f.key === 'DESCRIPTION'), undefined);
  assert.equal(find(re, 'TITLE').value, 'Old');
  find(re, 'TITLE').value = 'x'.repeat(70000);
  await assert.rejects(save(re), /more space than the file's 1 header page/);
});

test('Ogg: other codecs and interleaved streams are rejected with a message', async () => {
  const flac = concat([page(2, 1, 0, G0, [13], concat([new Uint8Array([0x7f]), latin1('FLAC'), new Uint8Array(8)]))]);
  await assert.rejects(open(flac), /Ogg FLAC files are not supported yet/);
  const b = opusFile(['TITLE=x']);
  const other = page(2, 99, 0, G0, [8], latin1('OpusHead'));
  const head = b.subarray(0, pages(b)[0].bytes.length);
  await assert.rejects(open(concat([head, other, b.subarray(head.length)])), /interleaved streams/);
});
