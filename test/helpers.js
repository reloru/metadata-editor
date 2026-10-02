import assert from 'node:assert/strict';
import { openFile, buildOutput } from '../public/editor.js';
import { parseMoov, readChunkOffsets } from '../public/bmff.js';
import { toFile } from './fixtures.js';

export async function open(bytes, name = 'x.bin') {
  return openFile(toFile(bytes, name));
}

export async function save(doc) {
  const blob = await buildOutput(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

export function find(doc, key, pred = () => true) {
  const f = doc.fields.find((x) => x.key === key && pred(x));
  assert.ok(f, `field ${key} not found`);
  return f;
}

export function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
export function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
export function str(b, o, n) { return String.fromCharCode(...b.subarray(o, o + n)); }

// Walk RIFF chunks and assert size/pad consistency. Returns chunk list.
export function checkRiff(b) {
  assert.equal(str(b, 0, 4), 'RIFF');
  assert.equal(u32le(b, 4), b.length - 8, 'RIFF size');
  const chunks = [];
  let o = 12;
  while (o < b.length) {
    assert.ok(o + 8 <= b.length, 'chunk header within file');
    const id = str(b, o, 4);
    const size = u32le(b, o + 4);
    const pad = size & 1;
    assert.ok(o + 8 + size + pad <= b.length, `chunk ${id} within file`);
    if (pad) assert.equal(b[o + 8 + size], 0, `pad byte after ${id}`);
    const data = b.subarray(o + 8, o + 8 + size);
    if (id === 'LIST' && str(data, 0, 4) === 'INFO') {
      let p = 4;
      while (p < data.length) {
        const s = u32le(data, p + 4);
        assert.ok(p + 8 + s + (s & 1) <= data.length, 'INFO subchunk within LIST');
        if (s & 1) assert.equal(data[p + 8 + s], 0, 'INFO pad byte');
        p += 8 + s + (s & 1);
      }
      assert.equal(p, data.length, 'INFO subchunks fill LIST');
    }
    chunks.push({ id, start: o, size, data });
    o += 8 + size + pad;
  }
  assert.equal(o, b.length);
  return chunks;
}

// Assert top-level boxes tile the file and every parsed container is exactly filled.
export function checkBmff(b) {
  const top = [];
  let o = 0;
  while (o < b.length) {
    let size = u32be(b, o);
    const type = str(b, o + 4, 4);
    let hdr = 8;
    if (size === 1) { size = u32be(b, o + 8) * 4294967296 + u32be(b, o + 12); hdr = 16; }
    else if (size === 0) size = b.length - o;
    assert.ok(size >= 8 && o + size <= b.length, `box ${type} size`);
    top.push({ type, start: o, size, hdr });
    o += size;
  }
  assert.equal(o, b.length, 'top-level boxes tile the file');
  const m = top.find((x) => x.type === 'moov');
  const moovBytes = b.subarray(m.start, m.start + m.size);
  const root = parseMoov(moovBytes);
  const walk = (n) => {
    if (!n.children) return;
    assert.equal(n.tail, n.start + n.size, `children of ${n.type} fill it exactly`);
    n.children.forEach(walk);
  };
  walk(root);
  return { top, moov: root, moovBytes, moovStart: m.start };
}

// 16 bytes at every stco/co64 entry.
export function chunkPayloads(b) {
  const { moov, moovBytes } = checkBmff(b);
  return readChunkOffsets(moovBytes, moov).flatMap((t) => t.offsets.map((off) => Buffer.from(b.subarray(off, off + 16)).toString('hex')));
}

export function boxPayload(b, type) {
  const { top } = checkBmff(b);
  const x = top.find((t) => t.type === type);
  return b.subarray(x.start + x.hdr, x.start + x.size);
}
