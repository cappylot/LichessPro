import http from 'node:http';

/**
 * A stand-in for the parts of the Lichess API this app depends on.
 *
 * It deliberately reproduces the behaviour that makes the naive approach fail:
 * `POST /api/round/{id}/add-time/{s}` CLAMPS s to [5, 60] and still answers
 * 200 OK, exactly like lila's `Moretimer.give`:
 *
 *   if unchecked < minTime then minTime
 *   else if unchecked > maxTime then maxTime
 *   else unchecked
 *
 * It also mirrors `GameStateStream`, which pushes a fresh `gameState` (with
 * updated clocks) whenever moretime is given.
 */
export class FakeLichess {
  constructor({ tokens, accounts, gameId = 'testgame', wtime = 5_400_000, btime = 5_400_000, plies = 0 }) {
    this.tokens = tokens; // token -> 'white' | 'black'
    // token -> { userId, username, scopes, expires }, for /api/token/test and
    // /api/account. Defaults to fully-scoped accounts matching `tokens`.
    this.accounts =
      accounts ??
      Object.fromEntries(
        Object.entries(tokens).map(([token, color]) => [
          token,
          {
            userId: color === 'white' ? 'alice' : 'bob',
            username: color === 'white' ? 'Alice' : 'Bob',
            scopes: 'challenge:write,board:play',
            expires: null,
          },
        ]),
      );
    this.gameId = gameId;
    this.state = {
      moves: Array.from({ length: plies }, (_, i) => (i % 2 === 0 ? 'e2e4' : 'e7e5')),
      wtime,
      btime,
      winc: 30_000,
      binc: 30_000,
      status: 'started',
    };
    this.addTimeCalls = [];
    this.challenges = [];
    this.tokenExchanges = [];
    this.grantToken = 'lip_alice'; // token handed back by the OAuth code exchange
    this.streams = new Set();
    this.rateLimitNext = 0; // answer 429 for the next N add-time calls
  }

  async start() {
    this.server = http.createServer((req, res) => this.#route(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  async stop() {
    for (const res of this.streams) res.end();
    this.streams.clear();
    await new Promise((resolve) => this.server.close(resolve));
  }

  get plies() {
    return this.state.moves.length;
  }

  /** Append a half-move and notify listeners, like a real move would. */
  playMove(uci = 'a2a3') {
    this.state.moves.push(uci);
    this.#broadcast();
  }

  playMoves(count) {
    for (let i = 0; i < count; i += 1) this.playMove();
  }

  finish(status = 'mate', winner = 'white') {
    this.state.status = status;
    this.state.winner = winner;
    this.#broadcast();
  }

  #gameFull() {
    return {
      type: 'gameFull',
      id: this.gameId,
      white: { id: 'alice', name: 'Alice' },
      black: { id: 'bob', name: 'Bob' },
      state: this.#gameState(),
    };
  }

  #gameState() {
    return { ...this.state, type: 'gameState', moves: this.state.moves.join(' ') };
  }

  #broadcast() {
    const line = `${JSON.stringify(this.#gameState())}\n`;
    for (const res of this.streams) res.write(line);
  }

  #route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');

    // OAuth2 code exchange. Any code is accepted; the point under test is the
    // redirect_uri round trip and which cookie ends up owning the seat.
    if (req.method === 'POST' && url.pathname === '/api/token') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        this.tokenExchanges.push(Object.fromEntries(form));
        this.#json(res, 200, { token_type: 'Bearer', access_token: this.grantToken, expires_in: 31_536_000 });
      });
      return undefined;
    }

    if (req.method === 'POST' && url.pathname === '/api/token/test') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const pasted = Buffer.concat(chunks).toString('utf8').trim();
        const info = this.accounts[pasted];
        this.#json(res, 200, {
          [pasted]: info ? { userId: info.userId, scopes: info.scopes, expires: info.expires } : null,
        });
      });
      return undefined;
    }

    if (req.method === 'GET' && url.pathname === '/api/account') {
      const info = this.accounts[token];
      if (!info) return this.#json(res, 401, { error: 'no such token' });
      return this.#json(res, 200, { id: info.userId, username: info.username, title: info.title ?? null });
    }

    // Challenge creation: the game id equals the challenge id on Lichess.
    const challengeMatch = url.pathname.match(/^\/api\/challenge\/([^/]+)$/);
    if (req.method === 'POST' && challengeMatch) {
      if (!this.tokens[token]) return this.#json(res, 401, { error: 'no such token' });
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        this.challenges.push({ from: this.tokens[token], to: challengeMatch[1], params: Object.fromEntries(params) });
        this.#json(res, 200, { id: this.gameId, url: `http://lichess.test/${this.gameId}` });
      });
      return undefined;
    }

    const acceptMatch = url.pathname.match(/^\/api\/challenge\/([^/]+)\/(accept|cancel)$/);
    if (req.method === 'POST' && acceptMatch) {
      if (!this.tokens[token]) return this.#json(res, 401, { error: 'no such token' });
      this.challenges.push({ action: acceptMatch[2], by: this.tokens[token] });
      return this.#json(res, 200, { ok: true });
    }

    const streamMatch = url.pathname.match(/^\/api\/board\/game\/stream\/(.+)$/);
    if (req.method === 'GET' && streamMatch) {
      if (!this.tokens[token]) return this.#json(res, 401, { error: 'no such token' });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify(this.#gameFull())}\n`);
      this.streams.add(res);
      req.on('close', () => this.streams.delete(res));
      return undefined;
    }

    const addMatch = url.pathname.match(/^\/api\/round\/(.+)\/add-time\/(\d+)$/);
    if (req.method === 'POST' && addMatch) {
      const giver = this.tokens[token];
      if (!giver) return this.#json(res, 401, { error: 'no such token' });
      if (this.state.status !== 'started') {
        return this.#json(res, 400, { error: "This game doesn't allow giving time" });
      }
      if (this.rateLimitNext > 0) {
        this.rateLimitNext -= 1;
        return this.#json(res, 429, { error: 'Please only run 1 request at a time' });
      }

      const requested = Number.parseInt(addMatch[2], 10);
      const applied = Math.min(60, Math.max(5, requested)); // the lila clamp
      const receiver = giver === 'white' ? 'black' : 'white';
      this.state[receiver === 'white' ? 'wtime' : 'btime'] += applied * 1000;
      this.addTimeCalls.push({ giver, receiver, requested, applied });

      this.#broadcast(); // GameStateStream: case BoardMoretime(g) => pushState(g)
      return this.#json(res, 200, { ok: true });
    }

    return this.#json(res, 404, { error: 'not found' });
  }

  #json(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}

/** Poll until `predicate()` is true, or fail after `timeout` ms. */
export async function waitFor(predicate, { timeout = 5000, interval = 5, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
