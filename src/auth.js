/**
 * Token vetting for the "paste a personal access token" flow.
 *
 * This exists so two people can play without the app being reachable from the
 * internet: instead of each player completing an OAuth redirect, one of them
 * pastes a token the other generated at lichess.org.
 *
 * The scope check matters more than it looks. A token missing `challenge:write`
 * streams the game perfectly and then fails at move 40, three hours in, which is
 * the worst possible moment to find out. Both scopes are verified up front.
 */

/** Scopes the arbiter cannot work without. */
export const REQUIRED_SCOPES = ['challenge:write', 'board:play'];

const SCOPE_PURPOSE = {
  'challenge:write': 'create the game and add bonus time',
  'board:play': 'follow the game in real time',
};

/** Lichess returns scopes as a comma-separated string. */
export function parseScopes(scopeString) {
  return String(scopeString ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Which required scopes this token is missing. */
export function missingScopes(scopeString) {
  const held = new Set(parseScopes(scopeString));
  return REQUIRED_SCOPES.filter((scope) => !held.has(scope));
}

/**
 * A link that opens Lichess's token form with the right boxes already ticked,
 * so the other player cannot pick the wrong permissions.
 */
export function tokenCreateUrl(host, description = 'LichessPro arbiter') {
  const scopes = REQUIRED_SCOPES.map((s) => `scopes[]=${encodeURIComponent(s)}`).join('&');
  return `${host}/account/oauth/token/create?${scopes}&description=${encodeURIComponent(description)}`;
}

/**
 * Human-readable reason a token cannot be used, or null if it is fine.
 *
 * @param {null|{userId?:string, scopes?:string, expires?:number|null}} info
 *        the `/api/token/test` result for this token
 * @param {number} [now] current epoch ms, injectable for tests
 */
export function describeTokenProblem(info, now = Date.now()) {
  if (!info || !info.userId) {
    return 'Lichess does not recognise that token. Check it was copied whole, and that it has not been revoked.';
  }

  if (typeof info.expires === 'number' && info.expires <= now) {
    return 'That token has already expired. Generate a new one.';
  }

  const missing = missingScopes(info.scopes);
  if (missing.length > 0) {
    const detail = missing.map((s) => `"${s}" (needed to ${SCOPE_PURPOSE[s]})`).join(' and ');
    return `That token is missing permission ${detail}. Generate a new token using the link below, which pre-selects both.`;
  }

  return null;
}

/**
 * Warn about a token that is valid now but will lapse during a long game.
 * Classical games run for hours; a token expiring mid-game strands the bonus.
 */
export function expiryWarning(info, minimumMs = 6 * 60 * 60 * 1000, now = Date.now()) {
  if (typeof info?.expires !== 'number') return null;
  const remaining = info.expires - now;
  if (remaining >= minimumMs) return null;
  const hours = Math.max(1, Math.round(remaining / 3_600_000));
  return `Heads up: that token expires in about ${hours} hour${hours === 1 ? '' : 's'}, which may be before a long game finishes.`;
}
