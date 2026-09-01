import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('store');

/**
 * Tiny JSON-file store for matches.
 *
 * The file contains Lichess OAuth access tokens, so it is written with 0600
 * permissions and the directory with 0700. `.data/` is gitignored.
 *
 * Persistence exists for one reason: a 90+30 game runs for hours, and a
 * restart in the middle must not lose the tokens or forget which bonuses were
 * already paid out.
 */
export class Store extends EventEmitter {
  #writeTimer = null;
  #writing = Promise.resolve();

  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'matches.json');
    this.matches = new Map();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      for (const match of JSON.parse(raw)) this.matches.set(match.id, match);
      log.info(`Loaded ${this.matches.size} match(es) from ${this.file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Could not read ${this.file}: ${err.message}`);
    }
  }

  get(id) {
    return this.matches.get(id) ?? null;
  }

  all() {
    return [...this.matches.values()];
  }

  put(match) {
    this.matches.set(match.id, match);
    this.touch(match.id);
    return match;
  }

  /** Mark a match dirty: schedule a flush and notify SSE subscribers. */
  touch(id) {
    this.emit('change', id);
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.flush().catch((err) => log.error(`Failed to persist matches: ${err.message}`));
    }, 250);
    this.#writeTimer.unref?.();
  }

  /** Serialise writes so concurrent flushes cannot interleave. */
  flush() {
    this.#writing = this.#writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      const body = JSON.stringify(this.all(), null, 2);
      await fs.writeFile(tmp, body, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    return this.#writing;
  }

  async close() {
    clearTimeout(this.#writeTimer);
    this.#writeTimer = null;
    await this.flush();
  }
}

/** Strip secrets before anything reaches a browser. */
export function publicView(match) {
  const seat = (s) =>
    s ? { username: s.username, userId: s.userId, title: s.title ?? null, joinedAt: s.joinedAt } : null;

  return {
    id: match.id,
    createdAt: match.createdAt,
    status: match.status,
    spec: match.spec,
    specLabel: match.specLabel,
    rated: match.rated,
    color: match.color,
    seats: { a: seat(match.seats.a), b: seat(match.seats.b) },
    gameId: match.gameId ?? null,
    gameUrl: match.gameUrl ?? null,
    gameStatus: match.gameStatus ?? null,
    winner: match.winner ?? null,
    players: match.players ?? null,
    plies: match.plies ?? 0,
    movesCompleted: match.movesCompleted ?? { white: 0, black: 0 },
    sideToMove: match.sideToMove ?? 'white',
    clocks: match.clocks ?? { white: null, black: null },
    deliveries: match.deliveries ?? {},
    events: (match.events ?? []).slice(-60),
    error: match.error ?? null,
  };
}
