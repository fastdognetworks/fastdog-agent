import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameBoundary, WS_WINDOW_BYTES } from '../src/ws-frames.js';

test('WebSocket credit window is 256 KiB', () => {
  assert.equal(WS_WINDOW_BYTES, 256 * 1024);
});

for (const length of [0, 5, 126, 65536]) for (const masked of [false, true]) {
  test(`tracks split headers and payloads: length ${length}, masked ${masked}`, () => {
    const extended = length >= 65536 ? 8 : length >= 126 ? 2 : 0;
    const header = Buffer.alloc(2 + extended + (masked ? 4 : 0));
    header[0] = 0x82;
    header[1] = (masked ? 128 : 0) | (extended === 8 ? 127 : extended === 2 ? 126 : length);
    if (extended === 8) header.writeBigUInt64BE(BigInt(length), 2);
    if (extended === 2) header.writeUInt16BE(length, 2);
    const tracker = new FrameBoundary();
    assert.equal(tracker.boundary, true);
    assert.equal(tracker.push(Buffer.alloc(0)), true);
    for (let i = 0; i < header.length; i++) {
      assert.equal(tracker.push(header.subarray(i, i + 1)), true);
      assert.equal(tracker.boundary, i === header.length - 1 && length === 0);
    }
    if (length) {
      tracker.push(Buffer.alloc(length - 1));
      assert.equal(tracker.boundary, false);
      tracker.push(Buffer.alloc(1));
    }
    assert.equal(tracker.boundary, true);
    assert.equal(tracker.closed, false);
    assert.equal(tracker.header.length, 14);
  });
}

test('coalesced frames and close header tracking', () => {
  const tracker = new FrameBoundary();
  tracker.push(Buffer.from([0x81, 1, 65, 0x80, 0, 0x88]));
  assert.equal(tracker.closed, false);
  assert.equal(tracker.boundary, false);
  tracker.push(Buffer.from([2]));
  assert.equal(tracker.closed, true);
  assert.equal(tracker.boundary, false);
  tracker.push(Buffer.from([3, 232]));
  assert.equal(tracker.boundary, true);
});

test('64-bit payload counts remain exact without allocating the payload', () => {
  const tracker = new FrameBoundary();
  const header = Buffer.from([0x82, 127, 0x7f, 255, 255, 255, 255, 255, 255, 255]);
  assert.equal(tracker.push(header), true);
  tracker.push(Buffer.alloc(3));
  assert.equal(tracker.remaining, (1n << 63n) - 4n);
  assert.equal(tracker.boundary, false);
});

test('high bit in a 64-bit length permanently invalidates the tracker', () => {
  const tracker = new FrameBoundary();
  assert.equal(tracker.push(Buffer.from([0x82, 127, 128, 0, 0, 0, 0, 0, 0, 0])), false);
  assert.equal(tracker.invalid, true);
  assert.equal(tracker.boundary, false);
  assert.equal(tracker.push(Buffer.from([0x81, 0])), false);
});
