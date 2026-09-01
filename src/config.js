import path from 'node:path';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

const port = int('PORT', 8080);
const publicUrl = trimSlash(process.env.PUBLIC_URL || `http://localhost:${port}`);

export const config = {
  port,
  publicUrl,
  redirectUri: `${publicUrl}/auth/callback`,
  oauthClientId: process.env.OAUTH_CLIENT_ID || 'lichesspro',
  lichessHost: trimSlash(process.env.LICHESS_HOST || 'https://lichess.org'),
  dataDir: path.resolve(process.env.DATA_DIR || './.data'),
  addTimeIntervalMs: int('ADD_TIME_INTERVAL_MS', 400),

  // OAuth scopes we request from each player.
  //   challenge:write - create/accept the challenge AND call /api/round/.../add-time
  //   board:play      - stream the game state in real time
  scopes: ['challenge:write', 'board:play'],
};
