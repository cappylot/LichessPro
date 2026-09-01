import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { HOST_SEAT, OPPONENT_SEAT, bothSeatsFilled, seatForOAuth, seatForToken, seatOf } from '../src/seating.js';

const player = (username, clientId, userId = username.toLowerCase()) => ({
  token: `tok_${userId}`,
  userId,
  username,
  clientId,
});

const match = (seats = {}) => ({ seats: { a: null, b: null, ...seats } });

describe('seatOf', () => {
  test('finds the seat a browser owns', () => {
    const m = match({ a: player('Alice', 'host') });
    assert.equal(seatOf(m, 'host'), 'a');
    assert.equal(seatOf(m, 'someone-else'), null);
  });

  test('returns the host seat when one browser owns both', () => {
    // The normal case: the host signs in, then pastes their opponent's token,
    // so their cookie is stamped on both seats.
    const m = match({ a: player('Alice', 'host'), b: player('Bob', 'host') });
    assert.equal(seatOf(m, 'host'), 'a');
  });

  test('is not fooled by a missing client id', () => {
    assert.equal(seatOf(match({ a: player('Alice', 'host') }), undefined), null);
    assert.equal(seatOf(match({ a: player('Alice', 'host') }), null), null);
  });
});

describe('seatForOAuth', () => {
  test('always claims the host seat', () => {
    assert.deepEqual(seatForOAuth(match(), 'host'), { seat: HOST_SEAT });
  });

  test('claims the host seat even when the opponent is already seated', () => {
    // The bug this pinning prevents: with "first empty seat" the host would
    // land in seat b here and become the opponent of their own match.
    const m = match({ b: player('Bob', 'host') });
    assert.deepEqual(seatForOAuth(m, 'host'), { seat: HOST_SEAT });
  });

  test('lets an existing holder re-authenticate into the same seat', () => {
    const m = match({ a: player('Alice', 'host') });
    assert.deepEqual(seatForOAuth(m, 'host'), { seat: 'a' });
  });

  test('refuses a different browser once a challenger exists', () => {
    const m = match({ a: player('Alice', 'host') });
    const result = seatForOAuth(m, 'stranger');
    assert.ok(result.error);
    assert.match(result.error, /already has a challenger/);
    assert.match(result.error, /Alice/);
    assert.equal(result.seat, undefined);
  });
});

describe('seatForToken', () => {
  test('always claims the opponent seat', () => {
    assert.deepEqual(seatForToken(match()), { seat: OPPONENT_SEAT });
  });

  test('claims the opponent seat even when the host seat is still empty', () => {
    // Pasting a token before signing in must not make the opponent the
    // challenger, which is what "first empty seat" used to do.
    assert.deepEqual(seatForToken(match()), { seat: 'b' });
  });

  test('never overwrites the host', () => {
    const m = match({ a: player('Alice', 'host') });
    assert.deepEqual(seatForToken(m), { seat: 'b' });
  });

  test('refuses a second opponent', () => {
    const m = match({ a: player('Alice', 'host'), b: player('Bob', 'host') });
    const result = seatForToken(m);
    assert.ok(result.error);
    assert.match(result.error, /already has an opponent/);
    assert.match(result.error, /Bob/);
  });
});

describe('bothSeatsFilled', () => {
  test('needs a token in each seat', () => {
    assert.equal(bothSeatsFilled(match()), false);
    assert.equal(bothSeatsFilled(match({ a: player('Alice', 'host') })), false);
    assert.equal(bothSeatsFilled(match({ a: player('Alice', 'h'), b: player('Bob', 'h') })), true);
  });

  test('a seat without a token does not count', () => {
    const m = match({ a: player('Alice', 'h'), b: { userId: 'bob', username: 'Bob' } });
    assert.equal(bothSeatsFilled(m), false);
  });
});
