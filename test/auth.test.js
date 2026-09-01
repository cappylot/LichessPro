import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { describeTokenProblem, expiryWarning, missingScopes, parseScopes, tokenCreateUrl } from '../src/auth.js';

const NOW = Date.UTC(2026, 0, 1);
const good = { userId: 'bob', scopes: 'challenge:write,board:play', expires: null };

describe('parseScopes', () => {
  test('splits the comma-separated list Lichess returns', () => {
    assert.deepEqual(parseScopes('challenge:write,board:play'), ['challenge:write', 'board:play']);
  });

  test('treats no scopes as none, not as a crash', () => {
    assert.deepEqual(parseScopes(''), []);
    assert.deepEqual(parseScopes(undefined), []);
    assert.deepEqual(parseScopes(null), []);
  });
});

describe('missingScopes', () => {
  test('accepts a token holding both required scopes', () => {
    assert.deepEqual(missingScopes('challenge:write,board:play'), []);
  });

  test('ignores extra scopes', () => {
    assert.deepEqual(missingScopes('preference:read,challenge:write,board:play,email:read'), []);
  });

  test('spots the one that breaks the game at move 40', () => {
    // board:play alone streams the game perfectly and then cannot add time.
    assert.deepEqual(missingScopes('board:play'), ['challenge:write']);
  });

  test('spots a missing stream scope', () => {
    assert.deepEqual(missingScopes('challenge:write'), ['board:play']);
  });

  test('reports both when a bare token is pasted', () => {
    assert.deepEqual(missingScopes(''), ['challenge:write', 'board:play']);
  });
});

describe('describeTokenProblem', () => {
  test('passes a good token', () => {
    assert.equal(describeTokenProblem(good, NOW), null);
  });

  test('rejects a token Lichess does not know', () => {
    assert.match(describeTokenProblem(null, NOW), /does not recognise/);
    assert.match(describeTokenProblem({}, NOW), /does not recognise/);
  });

  test('rejects an expired token', () => {
    const expired = { ...good, expires: NOW - 1000 };
    assert.match(describeTokenProblem(expired, NOW), /expired/);
  });

  test('accepts a token that expires in the future', () => {
    assert.equal(describeTokenProblem({ ...good, expires: NOW + 86_400_000 }, NOW), null);
  });

  test('names the missing scope and why it matters', () => {
    const problem = describeTokenProblem({ ...good, scopes: 'board:play' }, NOW);
    assert.match(problem, /challenge:write/);
    assert.match(problem, /add bonus time/);
  });
});

describe('expiryWarning', () => {
  test('says nothing for a token that never expires', () => {
    assert.equal(expiryWarning(good, undefined, NOW), null);
  });

  test('says nothing for a token good for days', () => {
    assert.equal(expiryWarning({ ...good, expires: NOW + 7 * 86_400_000 }, undefined, NOW), null);
  });

  test('warns when a token would lapse mid-game', () => {
    const warning = expiryWarning({ ...good, expires: NOW + 2 * 3_600_000 }, undefined, NOW);
    assert.match(warning, /expires in about 2 hours/);
  });
});

describe('tokenCreateUrl', () => {
  test('pre-selects exactly the scopes the arbiter needs', () => {
    const url = new URL(tokenCreateUrl('https://lichess.org'));
    assert.equal(url.origin + url.pathname, 'https://lichess.org/account/oauth/token/create');
    assert.deepEqual(url.searchParams.getAll('scopes[]'), ['challenge:write', 'board:play']);
    assert.ok(url.searchParams.get('description'));
  });
});
