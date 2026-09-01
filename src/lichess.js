import crypto from 'node:crypto';
import { readNdjson } from './ndjson.js';

export class LichessError extends Error {
  constructor(status, body, message) {
    super(message || `Lichess API ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'LichessError';
    this.status = status;
    this.body = body;
  }

  get isRateLimit() {
    return this.status === 429;
  }
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a PKCE verifier/challenge pair (RFC 7636, S256). */
export function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomToken(bytes = 24) {
  return base64url(crypto.randomBytes(bytes));
}

export class LichessClient {
  /**
   * @param {object} opts
   * @param {string} opts.host        e.g. https://lichess.org
   * @param {string} opts.clientId    arbitrary OAuth client identifier
   * @param {string} opts.redirectUri absolute callback URL
   * @param {typeof fetch} [opts.fetchImpl] injectable for tests
   */
  constructor({ host, clientId, redirectUri, fetchImpl = fetch }) {
    this.host = host.replace(/\/+$/, '');
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    this.fetch = fetchImpl;
  }

  authorizeUrl({ challenge, state, scopes }) {
    const url = new URL(`${this.host}/oauth`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async #request(path, { token, method = 'GET', form, signal, stream = false } = {}) {
    const headers = { Accept: stream ? 'application/x-ndjson' : 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }

    const res = await this.fetch(`${this.host}${path}`, { method, headers, body, signal });

    if (!res.ok) {
      let payload;
      try {
        payload = await res.json();
      } catch {
        payload = await res.text().catch(() => '');
      }
      throw new LichessError(res.status, payload);
    }
    return res;
  }

  /** Exchange an authorization code for an access token. */
  async exchangeCode({ code, verifier }) {
    const res = await this.#request('/api/token', {
      method: 'POST',
      form: {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
      },
    });
    return res.json();
  }

  async revokeToken(token) {
    await this.#request('/api/token', { method: 'DELETE', token });
  }

  /** The profile of the token's owner. */
  async account(token) {
    const res = await this.#request('/api/account', { token });
    return res.json();
  }

  /**
   * Challenge `username`. Returns the challenge object; its `id` is also the
   * game id once the challenge is accepted.
   */
  async createChallenge(token, username, { base, increment, rated, color, variant = 'standard' }) {
    const res = await this.#request(`/api/challenge/${encodeURIComponent(username)}`, {
      method: 'POST',
      token,
      form: {
        'clock.limit': String(base),
        'clock.increment': String(increment),
        rated: rated ? 'true' : 'false',
        color,
        variant,
      },
    });
    return res.json();
  }

  async acceptChallenge(token, challengeId) {
    await this.#request(`/api/challenge/${encodeURIComponent(challengeId)}/accept`, { method: 'POST', token });
  }

  async cancelChallenge(token, challengeId) {
    await this.#request(`/api/challenge/${encodeURIComponent(challengeId)}/cancel`, { method: 'POST', token });
  }

  /**
   * Add `seconds` to the OPPONENT's clock.
   *
   * Requires the `challenge:write` scope. Lichess clamps the value server-side
   * to [5, 60] seconds and still answers 200, so callers must chunk larger
   * bonuses themselves — see `chunkBonus`.
   */
  async addTime(token, gameId, seconds, { signal } = {}) {
    await this.#request(`/api/round/${encodeURIComponent(gameId)}/add-time/${seconds}`, {
      method: 'POST',
      token,
      signal,
    });
  }

  /**
   * Stream a game's state as it is played. Yields `gameFull`, `gameState`,
   * `chatLine` and `opponentGone` events. Requires the `board:play` scope.
   */
  async *streamGame(token, gameId, { signal, onActivity } = {}) {
    const res = await this.#request(`/api/board/game/stream/${encodeURIComponent(gameId)}`, {
      token,
      signal,
      stream: true,
    });
    yield* readNdjson(res.body, { onActivity });
  }
}
