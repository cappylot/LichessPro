import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arbiter } from './arbiter.js';
import { describeTokenProblem, expiryWarning, tokenCreateUrl } from './auth.js';
import { config } from './config.js';
import { LichessClient, LichessError, createPkcePair, randomToken } from './lichess.js';
import { logger } from './log.js';
import { bothSeatsFilled, seatForOAuth, seatForToken, seatOf } from './seating.js';
import { Store, publicView } from './store.js';
import { describeSpec, normaliseSpec } from './timecontrol.js';

const log = logger('server');
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const store = new Store(config.dataDir);
const client = new LichessClient({
  host: config.lichessHost,
  clientId: config.oauthClientId,
  redirectUri: config.redirectUri,
});

/** In-flight OAuth attempts: state -> { verifier, matchId, clientId, expiresAt }. */
const pendingAuth = new Map();
/** Running arbiters: matchId -> { arbiter, abort }. */
const running = new Map();

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8' });
}

function redirect(res, location) {
  send(res, 302, '', { Location: location });
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

/** Stable per-browser identifier, used to prove seat ownership. */
function clientIdFor(req, res) {
  const existing = parseCookies(req).lp_client;
  if (existing) return existing;
  const fresh = randomToken(18);
  res.setHeader('Set-Cookie', `lp_client=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return fresh;
}

/**
 * Fill a seat with an authorised Lichess account.
 * @returns {'same-account'|null} a refusal reason, or null on success
 */
function claimSeat(match, seat, { token, account, clientId }) {
  // Guard against one person filling both seats, which would make the whole
  // exercise pointless: you cannot add time to your own clock.
  const otherSeat = seat === 'a' ? 'b' : 'a';
  if (match.seats[otherSeat]?.userId === account.id) return 'same-account';

  match.seats[seat] = {
    token,
    userId: account.id,
    username: account.username,
    title: account.title ?? null,
    clientId,
    joinedAt: new Date().toISOString(),
  };
  if (bothSeatsFilled(match) && match.status === 'awaiting-players') match.status = 'ready';
  store.touch(match.id);
  return null;
}

function matchPayload(match, clientId) {
  return {
    match: publicView(match),
    you: seatOf(match, clientId),
    tokenCreateUrl: tokenCreateUrl(config.lichessHost),
  };
}

function requireMatch(id) {
  const match = store.get(id);
  if (!match) throw new HttpError(404, 'Match not found');
  return match;
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

function createMatch({ spec, rated, color }) {
  const match = {
    id: randomToken(18),
    createdAt: new Date().toISOString(),
    status: 'awaiting-players',
    spec,
    specLabel: describeSpec(spec),
    rated: Boolean(rated),
    color: color ?? 'random',
    seats: { a: null, b: null },
    deliveries: {},
    events: [],
  };
  return store.put(match);
}

/**
 * Create the challenge as seat A, accept it as seat B, then hand the game to
 * the arbiter. The game id equals the challenge id.
 */
async function startGame(match) {
  if (!bothSeatsFilled(match)) throw new HttpError(409, 'Both players must be seated before the game can start');
  if (match.gameId) throw new HttpError(409, 'This match already has a game');

  const [a, b] = [match.seats.a, match.seats.b];
  let challenge;
  try {
    challenge = await client.createChallenge(a.token, b.username, {
      base: match.spec.base,
      increment: match.spec.increment,
      rated: match.rated,
      color: match.color,
    });
  } catch (err) {
    throw new HttpError(502, `Lichess refused the challenge: ${describeLichessError(err)}`);
  }

  const challengeId = challenge?.id ?? challenge?.challenge?.id;
  if (!challengeId) throw new HttpError(502, 'Lichess did not return a challenge id');

  try {
    await client.acceptChallenge(b.token, challengeId);
  } catch (err) {
    // A challenge nobody accepts expires in 20s, but cancel it explicitly so
    // the opponent does not see a stray popup.
    await client.cancelChallenge(a.token, challengeId).catch(() => {});
    throw new HttpError(502, `Could not auto-accept the challenge: ${describeLichessError(err)}`);
  }

  match.gameId = challengeId;
  match.gameUrl = `${config.lichessHost}/${challengeId}`;
  match.status = 'live';
  match.startedAt = new Date().toISOString();
  store.touch(match.id);

  launchArbiter(match);
  return match;
}

function describeLichessError(err) {
  if (err instanceof LichessError) {
    const body = typeof err.body === 'object' ? (err.body.error ?? JSON.stringify(err.body)) : err.body;
    return `${err.status} ${body}`;
  }
  return err.message;
}

function launchArbiter(match) {
  if (running.has(match.id)) return running.get(match.id).arbiter;

  const controller = new AbortController();
  const arbiter = new Arbiter({
    client,
    gameId: match.gameId,
    spec: match.spec,
    seats: {
      a: { token: match.seats.a.token, userId: match.seats.a.userId },
      b: { token: match.seats.b.token, userId: match.seats.b.userId },
    },
    record: match,
    onChange: () => store.touch(match.id),
    intervalMs: config.addTimeIntervalMs,
  });

  running.set(match.id, { arbiter, abort: () => controller.abort() });

  arbiter
    .run(controller.signal)
    .catch((err) => {
      if (!controller.signal.aborted) {
        match.error = err.message;
        log.error(`Arbiter for ${match.id} stopped: ${err.message}`);
      }
    })
    .finally(() => {
      running.delete(match.id);
      if (arbiter.finished) match.status = 'finished';
      store.touch(match.id);
    });

  return arbiter;
}

/** Re-attach arbiters to games that were still running when we last stopped. */
function resumeLiveMatches() {
  for (const match of store.all()) {
    if (match.status === 'live' && match.gameId && bothSeatsFilled(match)) {
      log.info(`Resuming arbiter for match ${match.id} (game ${match.gameId})`);
      launchArbiter(match);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const clientId = clientIdFor(req, res);
  const segments = url.pathname.split('/').filter(Boolean); // ['api', 'matches', ...]

  if (req.method === 'POST' && url.pathname === '/api/matches') {
    const body = await readJsonBody(req);
    let spec;
    try {
      spec = normaliseSpec(body.spec ?? {});
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    if (!['random', 'white', 'black'].includes(body.color ?? 'random')) {
      throw new HttpError(400, 'color must be random, white or black');
    }
    const match = createMatch({ spec, rated: body.rated, color: body.color });
    log.info(`Match ${match.id} created: ${match.specLabel}`);
    return sendJson(res, 201, { id: match.id, url: `${config.publicUrl}/m/${match.id}` });
  }

  if (segments[0] === 'api' && segments[1] === 'matches' && segments[2]) {
    const match = requireMatch(segments[2]);
    const action = segments[3];

    if (req.method === 'GET' && !action) {
      return sendJson(res, 200, matchPayload(match, clientId));
    }

    if (req.method === 'GET' && action === 'stream') {
      return streamMatch(req, res, match, clientId);
    }

    if (req.method === 'POST' && action === 'start') {
      if (!seatOf(match, clientId)) throw new HttpError(403, 'Only a player in this match can start it');
      await startGame(match);
      return sendJson(res, 200, matchPayload(match, clientId));
    }

    // Seat the opponent from a pasted personal access token. This is the only
    // way seat 'b' is filled: OAuth would require the app to be reachable from
    // the opponent's browser, which it generally is not.
    if (req.method === 'POST' && action === 'token') {
      if (match.gameId) throw new HttpError(409, 'This match already has a game');

      const body = await readJsonBody(req);
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!token) throw new HttpError(400, 'Paste a Lichess API token first');

      const { seat, error: seatError } = seatForToken(match);
      if (seatError) throw new HttpError(409, seatError);

      let info;
      try {
        info = await client.testToken(token);
      } catch (err) {
        throw new HttpError(502, `Could not check that token with Lichess: ${describeLichessError(err)}`);
      }

      const problem = describeTokenProblem(info);
      if (problem) throw new HttpError(400, problem);

      let account;
      try {
        account = await client.account(token);
      } catch (err) {
        throw new HttpError(502, `Could not read that account from Lichess: ${describeLichessError(err)}`);
      }

      if (claimSeat(match, seat, { token, account, clientId }) === 'same-account') {
        throw new HttpError(
          409,
          'That token belongs to your own Lichess account. Time can only be added to an opponent, so the two seats must be different accounts — paste the token your opponent generated.',
        );
      }

      log.info(`Match ${match.id}: seat ${seat} claimed by ${account.username} via pasted token`);
      return sendJson(res, 200, { ...matchPayload(match, clientId), warning: expiryWarning(info) });
    }

    if (req.method === 'POST' && action === 'topup') {
      const seat = seatOf(match, clientId);
      if (!seat) throw new HttpError(403, 'Only a player in this match can add time');
      const arbiter = running.get(match.id)?.arbiter;
      if (!arbiter) throw new HttpError(409, 'No live game to add time to');
      const body = await readJsonBody(req);
      const seconds = Number.parseInt(body.seconds, 10);
      if (!['white', 'black'].includes(body.color)) throw new HttpError(400, 'color must be white or black');
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 10800) {
        throw new HttpError(400, 'seconds must be between 5 and 10800');
      }
      arbiter.requestTopUp(body.color, seconds);
      return sendJson(res, 202, { ok: true });
    }

    if (req.method === 'POST' && action === 'stop') {
      if (!seatOf(match, clientId)) throw new HttpError(403, 'Only a player in this match can stop it');
      running.get(match.id)?.abort();
      match.status = 'finished';
      store.touch(match.id);
      return sendJson(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Unknown API route');
}

/** Server-sent events: push the sanitised match state on every change. */
function streamMatch(req, res, match, clientId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const push = () => {
    const current = store.get(match.id);
    if (!current) return;
    res.write(`data: ${JSON.stringify(matchPayload(current, clientId))}\n\n`);
  };

  const onChange = (id) => {
    if (id === match.id) push();
  };

  push();
  store.on('change', onChange);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    store.off('change', onChange);
  });
}

// --- OAuth ---------------------------------------------------------------

function handleLogin(req, res, url) {
  const clientId = clientIdFor(req, res);
  const matchId = url.searchParams.get('match');
  const match = requireMatch(matchId);

  const { seat, error: seatError } = seatForOAuth(match, clientId);
  if (seatError) throw new HttpError(409, seatError);

  const { verifier, challenge } = createPkcePair();
  const state = randomToken(24);
  pendingAuth.set(state, { verifier, matchId, seat, clientId, expiresAt: Date.now() + 10 * 60_000 });

  redirect(res, client.authorizeUrl({ challenge, state, scopes: config.scopes }));
}

async function handleCallback(req, res, url) {
  const state = url.searchParams.get('state');
  const pending = state ? pendingAuth.get(state) : null;
  if (!pending || pending.expiresAt < Date.now()) {
    pendingAuth.delete(state);
    throw new HttpError(400, 'This sign-in link expired or was already used. Please try again.');
  }
  pendingAuth.delete(state);

  const error = url.searchParams.get('error');
  if (error) {
    return redirect(res, `/m/${pending.matchId}?error=${encodeURIComponent(error)}`);
  }

  const code = url.searchParams.get('code');
  if (!code) throw new HttpError(400, 'Lichess did not return an authorization code');

  const match = requireMatch(pending.matchId);

  let token;
  let account;
  try {
    const grant = await client.exchangeCode({ code, verifier: pending.verifier });
    token = grant.access_token;
    account = await client.account(token);
  } catch (err) {
    throw new HttpError(502, `Lichess sign-in failed: ${describeLichessError(err)}`);
  }

  const refusal = claimSeat(match, pending.seat, { token, account, clientId: pending.clientId });
  if (refusal) return redirect(res, `/m/${match.id}?error=${encodeURIComponent(refusal)}`);

  log.info(`Match ${match.id}: seat ${pending.seat} claimed by ${account.username}`);
  redirect(res, `/m/${match.id}`);
}

// --- Static files ---------------------------------------------------------

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' || url.pathname.startsWith('/m/') ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Forbidden');

  try {
    const body = await fs.readFile(filePath);
    return send(res, 200, body, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, config.publicUrl);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/auth/login') return handleLogin(req, res, url);
    if (url.pathname === '/auth/callback') return await handleCallback(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) log.error(`${req.method} ${url.pathname} -> ${status}: ${err.stack ?? err.message}`);
    if (res.headersSent) return res.end();
    if (url.pathname.startsWith('/api/')) return sendJson(res, status, { error: err.message });
    return send(res, status, err.message, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

// Drop expired OAuth attempts so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [state, pending] of pendingAuth) if (pending.expiresAt < now) pendingAuth.delete(state);
}, 60_000).unref();

async function main() {
  await store.init();
  resumeLiveMatches();
  server.listen(config.port, () => {
    log.info(`LichessPro listening on ${config.publicUrl}`);
    if (config.lichessHost !== 'https://lichess.org') log.warn(`Using Lichess host ${config.lichessHost}`);
  });
}

async function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  for (const { abort } of running.values()) abort();
  server.close();
  await store.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  log.error(`Failed to start: ${err.stack ?? err.message}`);
  process.exit(1);
});

export { server, store };
