import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  MAX_ADD_TIME_CHUNK,
  chunkBonus,
  countPlies,
  describeSpec,
  duePeriods,
  isValidClockLimit,
  movesCompleted,
  normaliseSpec,
  plannedTotal,
  sideToMove,
} from '../src/timecontrol.js';

const fide = normaliseSpec({ base: 5400, increment: 30, periods: [{ afterMove: 40, bonus: 1800 }] });

describe('normaliseSpec', () => {
  test('accepts the FIDE classical control', () => {
    assert.deepEqual(fide, { base: 5400, increment: 30, periods: [{ afterMove: 40, bonus: 1800 }] });
  });

  test('sorts periods and rejects duplicates', () => {
    const spec = normaliseSpec({
      base: 3600,
      increment: 30,
      periods: [
        { afterMove: 60, bonus: 900 },
        { afterMove: 40, bonus: 1800 },
      ],
    });
    assert.deepEqual(spec.periods.map((p) => p.afterMove), [40, 60]);

    assert.throws(
      () => normaliseSpec({ base: 3600, increment: 0, periods: [{ afterMove: 40, bonus: 60 }, { afterMove: 40, bonus: 60 }] }),
      /Duplicate bonus period/,
    );
  });

  test('rejects clock limits Lichess will not accept', () => {
    assert.throws(() => normaliseSpec({ base: 5401, increment: 30 }), /Base time must be/);
    assert.throws(() => normaliseSpec({ base: 10860, increment: 30 }), /Base time must be/);
    assert.throws(() => normaliseSpec({ base: 5400, increment: 61 }), /Increment must be/);
    assert.throws(() => normaliseSpec({ base: 0, increment: 0 }), /cannot both be zero/);
  });

  test('allows the short non-multiples of 60 that Lichess special-cases', () => {
    for (const base of [15, 30, 45]) assert.ok(isValidClockLimit(base), `${base} should be valid`);
    assert.ok(!isValidClockLimit(20));
  });

  test('describes a spec readably', () => {
    assert.equal(describeSpec(fide), '90+30, +30min after move 40');
  });
});

describe('move counting', () => {
  test('white completes move N on ply 2N-1, black on ply 2N', () => {
    assert.deepEqual(movesCompleted(0), { white: 0, black: 0 });
    assert.deepEqual(movesCompleted(79), { white: 40, black: 39 });
    assert.deepEqual(movesCompleted(80), { white: 40, black: 40 });
  });

  test('side to move alternates from white', () => {
    assert.equal(sideToMove(0), 'white');
    assert.equal(sideToMove(79), 'black');
    assert.equal(sideToMove(80), 'white');
  });

  test('counts plies from a UCI move string', () => {
    assert.equal(countPlies(''), 0);
    assert.equal(countPlies(undefined), 0);
    assert.equal(countPlies('e2e4 c7c5 f2f4'), 3);
    assert.equal(countPlies('  e2e4   c7c5  '), 2);
  });
});

describe('chunkBonus', () => {
  test('splits 30 minutes into 30 calls of 60s, because Lichess clamps at 60', () => {
    const chunks = chunkBonus(1800);
    assert.equal(chunks.length, 30);
    assert.ok(chunks.every((c) => c === MAX_ADD_TIME_CHUNK));
    assert.equal(plannedTotal(1800), 1800);
  });

  test('handles a remainder', () => {
    assert.deepEqual(chunkBonus(90), [60, 30]);
  });

  test('raises a sub-minimum remainder to 5s, matching the server-side clamp up', () => {
    // Lichess clamps anything under 5s UP to 5s, so the plan must say 5.
    assert.deepEqual(chunkBonus(62), [60, 5]);
    assert.equal(plannedTotal(62), 65);
  });

  test('rejects nonsense', () => {
    assert.throws(() => chunkBonus(0), /positive integer/);
    assert.throws(() => chunkBonus(-60), /positive integer/);
  });
});

describe('duePeriods', () => {
  test('nothing is due before move 40', () => {
    assert.deepEqual(duePeriods(fide, 78), []);
  });

  test('white is paid when white completes move 40, before black has', () => {
    const due = duePeriods(fide, 79);
    assert.equal(due.length, 1);
    assert.equal(due[0].color, 'white');
    assert.equal(due[0].bonus, 1800);
    assert.equal(due[0].key, 'white:40');
  });

  test('black becomes due only once black completes move 40', () => {
    const due = duePeriods(fide, 80, ['white:40']);
    assert.equal(due.length, 1);
    assert.equal(due[0].color, 'black');
  });

  test('already-delivered periods are never repeated', () => {
    assert.deepEqual(duePeriods(fide, 120, ['white:40', 'black:40']), []);
  });

  test('after a reconnect both outstanding bonuses are found, player on move first', () => {
    // Ply 100 => white to move, and neither bonus was paid while we were away.
    const due = duePeriods(fide, 100, []);
    assert.deepEqual(due.map((d) => d.color), ['white', 'black']);
  });

  test('serves the side to move first when both are outstanding', () => {
    const due = duePeriods(fide, 101, []); // black to move
    assert.deepEqual(due.map((d) => d.color), ['black', 'white']);
  });

  test('supports several periods', () => {
    const spec = normaliseSpec({
      base: 7200,
      increment: 0,
      periods: [
        { afterMove: 40, bonus: 3600 },
        { afterMove: 60, bonus: 1800 },
      ],
    });
    const due = duePeriods(spec, 120, []);
    assert.deepEqual(
      due.map((d) => d.key).sort(),
      ['black:40', 'black:60', 'white:40', 'white:60'],
    );
  });
});
