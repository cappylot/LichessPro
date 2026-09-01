import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readNdjson } from '../src/ndjson.js';

/** Build a ReadableStream that emits the given string pieces as bytes. */
function streamOf(...pieces) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

const collect = async (stream, opts) => {
  const out = [];
  for await (const value of readNdjson(stream, opts)) out.push(value);
  return out;
};

describe('readNdjson', () => {
  test('parses one object per line', async () => {
    const out = await collect(streamOf('{"type":"gameFull"}\n{"type":"gameState"}\n'));
    assert.deepEqual(out, [{ type: 'gameFull' }, { type: 'gameState' }]);
  });

  test('reassembles objects split across chunks', async () => {
    const out = await collect(streamOf('{"typ', 'e":"game', 'State","moves":"e2e4"}\n'));
    assert.deepEqual(out, [{ type: 'gameState', moves: 'e2e4' }]);
  });

  test('skips the blank keep-alive lines Lichess sends', async () => {
    const out = await collect(streamOf('\n', '{"a":1}\n', '\n\n', '{"a":2}\n'));
    assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
  });

  test('yields a final line that has no trailing newline', async () => {
    const out = await collect(streamOf('{"a":1}\n{"a":2}'));
    assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
  });

  test('reports activity for keep-alives so a dead socket can be detected', async () => {
    let beats = 0;
    await collect(streamOf('\n', '{"a":1}\n'), { onActivity: () => (beats += 1) });
    assert.equal(beats, 2, 'both the keep-alive and the data chunk count as activity');
  });
});
