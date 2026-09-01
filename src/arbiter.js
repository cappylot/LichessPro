import { LichessError } from './lichess.js';
import { logger } from './log.js';
import { COLORS, chunkBonus, countPlies, duePeriods, opposite, plannedTotal, sideToMove } from './timecontrol.js';

const STREAM_IDLE_TIMEOUT_MS = 30_000; // Lichess keep-alives arrive every ~7s.
const MAX_CHUNK_ATTEMPTS = 20;

const sleepDefault = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });

/**
 * Watches one Lichess game and hands out bonus time at the configured moves.
 *
 * Two facts drive the whole design:
 *
 *  1. `POST /api/round/{id}/add-time/{s}` adds time to the *opponent's* clock,
 *     so giving White 30 minutes requires Black's token, and vice versa. Both
 *     players must therefore have authorised the app.
 *  2. Lichess clamps every add-time call to 60 seconds server-side and still
 *     answers 200 OK. A 30-minute bonus is 30 sequential calls, paced to stay
 *     inside the API rate limit.
 *
 * Delivery is idempotent and resumable: progress is recorded per
 * (colour, move) key after every single chunk, so a crash mid-bonus resumes
 * where it left off instead of double-paying.
 */
export class Arbiter {
  /** Pending deliveries, processed strictly one at a time. */
  #queue = [];
  #pumping = false;
  /**
   * Keys currently being delivered. A delivery is off the queue but not yet
   * `done` for the ~15s it takes to make 30 calls, and every one of those
   * calls pushes a fresh gameState — without this guard, reconciling on those
   * events would queue the same bonus again and pay it twice.
   */
  #inFlight = new Set();

  /**
   * @param {object} opts
   * @param {import('./lichess.js').LichessClient} opts.client
   * @param {string} opts.gameId
   * @param {object} opts.spec              normalised time-control spec
   * @param {object} opts.seats             { a: {token,userId,username}, b: {...} }
   * @param {object} opts.record            mutable persisted record (see server/store)
   * @param {() => void} opts.onChange      called whenever `record` changes
   * @param {number} [opts.intervalMs]      pacing between add-time calls
   */
  constructor({ client, gameId, spec, seats, record, onChange, intervalMs = 400, sleep = sleepDefault }) {
    this.client = client;
    this.gameId = gameId;
    this.spec = spec;
    this.seats = seats;
    this.record = record;
    this.onChange = onChange ?? (() => {});
    this.intervalMs = intervalMs;
    this.sleep = sleep;
    this.log = logger(`arbiter:${gameId}`);

    /** colour -> seat key ('a' | 'b'), learned from the gameFull event. */
    this.colorSeat = record.colorSeat ?? null;
    this.plies = 0;
    this.clocks = { white: null, black: null };
    this.finished = false;
  }

  get deliveries() {
    this.record.deliveries ??= {};
    return this.record.deliveries;
  }

  /** Token belonging to the player of `color`. */
  #tokenFor(color) {
    const seat = this.colorSeat?.[color];
    return seat ? this.seats[seat]?.token : null;
  }

  #touch(patch) {
    Object.assign(this.record, patch);
    this.onChange();
  }

  #note(level, message, extra) {
    this.log[level](message, extra);
    this.record.events ??= [];
    this.record.events.push({ at: new Date().toISOString(), level, message, ...extra });
    if (this.record.events.length > 300) this.record.events.splice(0, this.record.events.length - 300);
    this.onChange();
  }

  /**
   * Connect to the game stream and keep it alive until the game ends or
   * `signal` aborts. Reconnects with backoff; on every reconnect the fresh
   * `gameFull` event re-synchronises state, so a bonus missed while
   * disconnected is delivered as soon as the stream is back.
   */
  async run(signal) {
    let attempt = 0;
    const seatKeys = Object.keys(this.seats);

    while (!this.finished && !signal.aborted) {
      // Alternate tokens across reconnects: if one player's token has been
      // revoked, the other can still carry the stream.
      const seatKey = seatKeys[attempt % seatKeys.length];
      const token = this.seats[seatKey]?.token;
      if (!token) throw new Error(`No token for seat ${seatKey}`);

      try {
        await this.#consumeStream(token, signal);
        attempt = 0;
      } catch (err) {
        if (signal.aborted) break;
        if (this.finished) break;
        attempt += 1;
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        this.#note('warn', `Game stream dropped (${err.message}); reconnecting in ${Math.round(wait / 1000)}s`, {
          attempt,
        });
        try {
          await this.sleep(wait, signal);
        } catch {
          break;
        }
      }
    }
  }

  async #consumeStream(token, signal) {
    const streamAbort = new AbortController();
    const onOuterAbort = () => streamAbort.abort(signal.reason);
    signal.addEventListener('abort', onOuterAbort, { once: true });

    // Watchdog: Lichess sends a newline every ~7s. Silence means a dead socket
    // that would otherwise hang forever without an error.
    let idleTimer = null;
    const kick = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => streamAbort.abort(new Error('stream idle')), STREAM_IDLE_TIMEOUT_MS);
    };
    kick();

    try {
      const events = this.client.streamGame(token, this.gameId, {
        signal: streamAbort.signal,
        onActivity: kick,
      });
      for await (const event of events) {
        kick();
        await this.#onEvent(event);
        if (this.finished) break;
      }
    } finally {
      clearTimeout(idleTimer);
      signal.removeEventListener('abort', onOuterAbort);
      streamAbort.abort(new Error('stream closed'));
    }
  }

  async #onEvent(event) {
    switch (event.type) {
      case 'gameFull':
        this.#learnColors(event);
        this.#applyState(event.state);
        break;
      case 'gameState':
        this.#applyState(event);
        break;
      default:
        return; // chatLine / opponentGone are not our business
    }
    await this.#reconcile();
  }

  /** Map colours to seats using the immutable player info in `gameFull`. */
  #learnColors(full) {
    const mapping = {};
    for (const color of COLORS) {
      const playerId = full[color]?.id;
      const seat = Object.keys(this.seats).find((k) => this.seats[k]?.userId === playerId);
      if (seat) mapping[color] = seat;
    }
    if (Object.keys(mapping).length !== 2) {
      this.#note('error', 'Could not match both Lichess players to authorised seats', {
        white: full.white?.id,
        black: full.black?.id,
      });
      return;
    }
    this.colorSeat = mapping;
    this.#touch({
      colorSeat: mapping,
      players: {
        white: { username: full.white?.name ?? full.white?.id, seat: mapping.white },
        black: { username: full.black?.name ?? full.black?.id, seat: mapping.black },
      },
    });
  }

  #applyState(state) {
    if (!state) return;
    this.plies = countPlies(state.moves);
    this.clocks = { white: state.wtime ?? null, black: state.btime ?? null };

    this.#touch({
      plies: this.plies,
      movesCompleted: { white: Math.ceil(this.plies / 2), black: Math.floor(this.plies / 2) },
      sideToMove: sideToMove(this.plies),
      clocks: this.clocks,
      gameStatus: state.status ?? this.record.gameStatus,
      winner: state.winner ?? null,
    });

    // Verify deliveries against the clock. A player who is not to move has a
    // frozen clock, so while the ply count is unchanged any increase is
    // exactly what we added.
    //
    // This is recomputed on every state rather than once at the end of a
    // delivery: the 200 OK for the final add-time call can arrive before the
    // gameState it triggered, so the last chunk is often still unobserved at
    // the moment delivery finishes.
    for (const rec of Object.values(this.deliveries)) {
      if (rec.baselinePlies === undefined) continue;
      if (rec.baselinePlies === this.plies && rec.baselineFrozen) {
        // Recomputed from the baseline, not accumulated, so a coalesced or
        // missed event self-corrects on the next one.
        rec.observedGainMs = (this.clocks[rec.color] ?? 0) - rec.baselineClockMs;
        if (rec.done && !rec.verified) rec.verified = rec.observedGainMs >= rec.planned * 1000 * 0.95;
      } else if (rec.baselinePlies !== this.plies && rec.verified !== true) {
        rec.observable = false; // a move was played; the clock is no longer frozen
      }
    }

    if (state.status && state.status !== 'started' && state.status !== 'created') {
      this.finished = true;
      this.#note('info', `Game finished: ${state.status}${state.winner ? ` (${state.winner} wins)` : ''}`);
    }
  }

  /** Queue any bonus that is now owed and not yet fully delivered. */
  async #reconcile() {
    if (this.finished || !this.colorSeat) return;

    const doneKeys = new Set(Object.entries(this.deliveries).filter(([, r]) => r.done).map(([k]) => k));
    for (const due of duePeriods(this.spec, this.plies, doneKeys)) {
      this.#enqueue({
        key: due.key,
        color: due.color,
        target: due.bonus,
        reason: `move ${due.afterMove}`,
      });
    }
    this.#startPump();
  }

  /** Manually give a player extra time outside the schedule. */
  requestTopUp(color, seconds, reason = 'manual top-up') {
    const key = `${color}:manual:${Date.now()}`;
    this.#enqueue({ key, color, target: seconds, reason });
    this.#startPump();
    return key;
  }

  /**
   * Kick the queue without blocking the stream reader. Deliveries take tens of
   * seconds; the stream must keep flowing meanwhile so clock observations and
   * game-over detection stay live.
   */
  #startPump() {
    this.#pump().catch((err) => this.#note('error', `Delivery queue crashed: ${err.message}`));
  }

  #enqueue(job) {
    if (this.#inFlight.has(job.key) || this.#queue.some((queued) => queued.key === job.key)) return;

    const rec = (this.deliveries[job.key] ??= {
      color: job.color,
      target: job.target,
      planned: plannedTotal(job.target),
      reason: job.reason,
      deliveredSeconds: 0,
      calls: 0,
      done: false,
      observable: null,
      error: null,
    });
    if (rec.done) return;
    this.#queue.push(job);
    this.#note('info', `Bonus owed: ${job.color} +${job.target}s (${job.reason})`, { key: job.key });
  }

  /** Process the queue one delivery at a time — never parallel API calls. */
  async #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length > 0 && !this.finished) {
        const job = this.#queue.shift();
        this.#inFlight.add(job.key);
        try {
          await this.#deliver(job);
        } catch (err) {
          const rec = this.deliveries[job.key];
          if (rec) {
            rec.error = err.message;
            this.onChange();
          }
          this.#note('error', `Failed to deliver ${job.color} bonus: ${err.message}`, { key: job.key });
        } finally {
          this.#inFlight.delete(job.key);
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #deliver(job) {
    const rec = this.deliveries[job.key];
    if (!rec || rec.done) return;

    const giverToken = this.#tokenFor(opposite(job.color));
    if (!giverToken) throw new Error(`No token for ${opposite(job.color)} to give time with`);

    // Baseline for verification. The clock of a player who is NOT to move is
    // frozen, so any increase while the ply count is unchanged is exactly what
    // we added. That is the normal case: a bonus fires as the player completes
    // their move, handing the turn over.
    if (rec.baselinePlies === undefined) {
      rec.baselinePlies = this.plies;
      rec.baselineClockMs = this.clocks[job.color] ?? 0;
      rec.baselineFrozen = sideToMove(this.plies) !== job.color;
      rec.observable = rec.baselineFrozen;
      rec.startedAt = new Date().toISOString();
      this.onChange();
    }

    const allChunks = chunkBonus(rec.target);
    const alreadyPaid = rec.calls;
    const remaining = allChunks.slice(alreadyPaid);

    this.#note('info', `Adding ${rec.target}s to ${job.color} in ${remaining.length} calls of <=60s`, {
      key: job.key,
    });

    for (const seconds of remaining) {
      if (this.finished) {
        this.#note('warn', `Game ended mid-bonus; ${job.color} received ${rec.deliveredSeconds}s of ${rec.target}s`, {
          key: job.key,
        });
        this.onChange();
        return;
      }
      await this.#addTimeWithRetry(giverToken, seconds, job);
      rec.calls += 1;
      rec.deliveredSeconds += seconds;
      this.onChange();
      if (rec.calls < allChunks.length) await this.sleep(this.intervalMs);
    }

    rec.done = true;
    rec.finishedAt = new Date().toISOString();
    // May still flip to true when the gameState for the final call arrives.
    rec.verified = rec.observable === true && (rec.observedGainMs ?? 0) >= rec.planned * 1000 * 0.95;
    this.onChange();

    this.#note('info', `Delivered ${rec.deliveredSeconds}s to ${job.color} in ${rec.calls} calls`, { key: job.key });
  }

  async #addTimeWithRetry(token, seconds, job) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await this.client.addTime(token, this.gameId, seconds);
        return;
      } catch (err) {
        const rateLimited = err instanceof LichessError && err.isRateLimit;
        const transient = rateLimited || !(err instanceof LichessError);

        if (!transient) {
          // 4xx other than 429 means Lichess refuses: game over, time odds not
          // allowed, token revoked. Retrying will not help.
          throw new Error(`add-time rejected (${err.status}): ${JSON.stringify(err.body)}`);
        }
        if (attempt >= MAX_CHUNK_ATTEMPTS) throw new Error(`add-time failed after ${attempt} attempts: ${err.message}`);

        const wait = rateLimited
          ? Math.min(60_000, 2000 * 2 ** Math.min(attempt - 1, 4))
          : Math.min(10_000, 500 * 2 ** Math.min(attempt - 1, 4));
        this.#note('warn', `add-time ${rateLimited ? 'rate limited' : 'failed'}, retrying in ${wait}ms`, {
          key: job.key,
          attempt,
        });
        await this.sleep(wait);
      }
    }
  }
}
