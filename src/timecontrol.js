/**
 * Pure logic for multi-period ("bonus time") control specs.
 *
 * Everything here is deterministic and side-effect free so it can be tested
 * without touching the network. The constants below mirror hard limits that
 * Lichess enforces server-side; see README.md for the source references.
 */

/** lila `Moretimer.maxTime` — a single add-time call is clamped to 60s. */
export const MAX_ADD_TIME_CHUNK = 60;
/** lila `Moretimer.minTime` — a single add-time call is clamped UP to 5s. */
export const MIN_ADD_TIME_CHUNK = 5;
/** Lichess challenge limits. */
export const MAX_CLOCK_LIMIT = 10800;
export const MAX_INCREMENT = 60;

export const COLORS = ['white', 'black'];

export function opposite(color) {
  return color === 'white' ? 'black' : 'white';
}

/**
 * Lichess only accepts these clock base values: 0, 15, 30, 45, or any multiple
 * of 60 up to 10800.
 */
export function isValidClockLimit(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_CLOCK_LIMIT) return false;
  return [0, 15, 30, 45].includes(seconds) || seconds % 60 === 0;
}

/**
 * Validate and normalise a time-control spec.
 *
 * @param {object} input
 * @param {number} input.base       Base clock in seconds (Lichess `clock.limit`).
 * @param {number} input.increment  Fischer increment in seconds (0-60).
 * @param {Array<{afterMove:number, bonus:number}>} [input.periods]
 *        Extra periods. `bonus` seconds are handed to a player at the moment
 *        *that player* completes move `afterMove` — the way a DGT clock adds a
 *        second period, not when the move pair is complete.
 * @returns {{base:number, increment:number, periods:Array<{afterMove:number,bonus:number}>}}
 */
export function normaliseSpec(input) {
  if (!input || typeof input !== 'object') throw new Error('Time control must be an object');

  const base = Number(input.base);
  if (!isValidClockLimit(base)) {
    throw new Error(
      `Base time must be 0, 15, 30, 45 or a multiple of 60 seconds, up to ${MAX_CLOCK_LIMIT} (3h). Got ${input.base}`,
    );
  }
  if (base === 0 && Number(input.increment) === 0) {
    throw new Error('Base time and increment cannot both be zero');
  }

  const increment = Number(input.increment);
  if (!Number.isInteger(increment) || increment < 0 || increment > MAX_INCREMENT) {
    throw new Error(`Increment must be an integer between 0 and ${MAX_INCREMENT} seconds. Got ${input.increment}`);
  }

  const rawPeriods = input.periods ?? [];
  if (!Array.isArray(rawPeriods)) throw new Error('periods must be an array');
  if (rawPeriods.length > 8) throw new Error('At most 8 bonus periods are supported');

  const periods = rawPeriods.map((p) => {
    const afterMove = Number(p?.afterMove);
    const bonus = Number(p?.bonus);
    if (!Number.isInteger(afterMove) || afterMove < 1 || afterMove > 300) {
      throw new Error(`Bonus period "after move" must be an integer between 1 and 300. Got ${p?.afterMove}`);
    }
    if (!Number.isInteger(bonus) || bonus < MIN_ADD_TIME_CHUNK || bonus > MAX_CLOCK_LIMIT) {
      throw new Error(
        `Bonus must be an integer between ${MIN_ADD_TIME_CHUNK} and ${MAX_CLOCK_LIMIT} seconds. Got ${p?.bonus}`,
      );
    }
    return { afterMove, bonus };
  });

  periods.sort((a, b) => a.afterMove - b.afterMove);
  for (let i = 1; i < periods.length; i += 1) {
    if (periods[i].afterMove === periods[i - 1].afterMove) {
      throw new Error(`Duplicate bonus period at move ${periods[i].afterMove}`);
    }
  }

  return { base, increment, periods };
}

/** Human-readable label, e.g. "90+30, +30min after move 40". */
export function describeSpec(spec) {
  const mins = (s) => (s % 60 === 0 ? `${s / 60}min` : `${s}s`);
  const head = `${spec.base / 60}+${spec.increment}`;
  if (spec.periods.length === 0) return head;
  const tail = spec.periods.map((p) => `+${mins(p.bonus)} after move ${p.afterMove}`).join(', ');
  return `${head}, ${tail}`;
}

/**
 * Number of full moves each colour has *completed* after `plies` half-moves.
 * White completes move N on ply 2N-1; Black completes move N on ply 2N.
 */
export function movesCompleted(plies) {
  if (!Number.isInteger(plies) || plies < 0) throw new Error(`plies must be a non-negative integer, got ${plies}`);
  return { white: Math.ceil(plies / 2), black: Math.floor(plies / 2) };
}

/** Colour to move after `plies` half-moves. */
export function sideToMove(plies) {
  return plies % 2 === 0 ? 'white' : 'black';
}

/** Count half-moves in a Lichess `moves` field (space-separated UCI). */
export function countPlies(moves) {
  if (!moves) return 0;
  return moves.trim().split(/\s+/).filter(Boolean).length;
}

/** Stable idempotency key for one player's one bonus period. */
export function deliveryKey(color, afterMove) {
  return `${color}:${afterMove}`;
}

/**
 * Split a bonus into add-time calls that respect the server-side 60s clamp.
 *
 * A remainder below the 5s minimum would be clamped UP by Lichess, so it is
 * raised to 5 here to keep the plan honest about what will actually be added.
 * That means a bonus that is not a multiple of 60 can overshoot by <5s.
 */
export function chunkBonus(totalSeconds, maxChunk = MAX_ADD_TIME_CHUNK) {
  if (!Number.isInteger(totalSeconds) || totalSeconds <= 0) {
    throw new Error(`Bonus must be a positive integer, got ${totalSeconds}`);
  }
  const chunkSize = Math.min(maxChunk, MAX_ADD_TIME_CHUNK);
  const chunks = [];
  let left = totalSeconds;
  while (left > 0) {
    const take = Math.min(chunkSize, left);
    chunks.push(Math.max(take, MIN_ADD_TIME_CHUNK));
    left -= take;
  }
  return chunks;
}

/** Total seconds that `chunkBonus` will actually deliver. */
export function plannedTotal(totalSeconds, maxChunk = MAX_ADD_TIME_CHUNK) {
  return chunkBonus(totalSeconds, maxChunk).reduce((a, b) => a + b, 0);
}

/**
 * Which bonuses are owed right now.
 *
 * @param {object} spec        normalised spec
 * @param {number} plies       half-moves played so far
 * @param {Set<string>|Array<string>} delivered  keys already fully delivered
 * @returns {Array<{color:string, afterMove:number, bonus:number, key:string}>}
 *          Ordered most-urgent first: the player on move burns clock, so they
 *          are served before the player whose clock is frozen.
 */
export function duePeriods(spec, plies, delivered = new Set()) {
  const done = delivered instanceof Set ? delivered : new Set(delivered);
  const completed = movesCompleted(plies);
  const onMove = sideToMove(plies);

  const due = [];
  for (const color of COLORS) {
    for (const period of spec.periods) {
      if (completed[color] < period.afterMove) continue;
      const key = deliveryKey(color, period.afterMove);
      if (done.has(key)) continue;
      due.push({ color, afterMove: period.afterMove, bonus: period.bonus, key });
    }
  }

  due.sort((a, b) => {
    if (a.color !== b.color) {
      if (a.color === onMove) return -1;
      if (b.color === onMove) return 1;
    }
    return a.afterMove - b.afterMove;
  });
  return due;
}
