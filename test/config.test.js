import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { parseEnv } from '../src/config.js';

describe('parseEnv', () => {
  test('reads simple key=value pairs', () => {
    assert.deepEqual(parseEnv('PORT=8080\nPUBLIC_URL=http://localhost:8080'), {
      PORT: '8080',
      PUBLIC_URL: 'http://localhost:8080',
    });
  });

  test('handles Windows CRLF line endings', () => {
    // A .env edited in Notepad has \r\n; without this the value keeps a \r and
    // the OAuth redirect_uri silently stops matching.
    assert.deepEqual(parseEnv('PORT=8080\r\nPUBLIC_URL=http://x.test\r\n'), {
      PORT: '8080',
      PUBLIC_URL: 'http://x.test',
    });
  });

  test('ignores comments and blank lines', () => {
    assert.deepEqual(parseEnv('# a comment\n\n  \nPORT=1\n   # indented comment'), { PORT: '1' });
  });

  test('strips matching surrounding quotes', () => {
    assert.deepEqual(parseEnv('A="quoted"\nB=\'single\'\nC=bare'), { A: 'quoted', B: 'single', C: 'bare' });
  });

  test('keeps mismatched or inner quotes as-is', () => {
    assert.deepEqual(parseEnv(`A="unbalanced\nB=say "hi"`), { A: '"unbalanced', B: 'say "hi"' });
  });

  test('keeps = inside values, which URLs and tokens contain', () => {
    assert.deepEqual(parseEnv('URL=https://x.test/cb?a=1&b=2'), { URL: 'https://x.test/cb?a=1&b=2' });
  });

  test('trims incidental whitespace around key and value', () => {
    assert.deepEqual(parseEnv('  PORT  =  8080  '), { PORT: '8080' });
  });

  test('allows empty values', () => {
    assert.deepEqual(parseEnv('EMPTY='), { EMPTY: '' });
  });

  test('skips malformed lines rather than throwing', () => {
    assert.deepEqual(parseEnv('no-equals-here\n=novalue\n9BAD=x\nGOOD=y'), { GOOD: 'y' });
  });
});
