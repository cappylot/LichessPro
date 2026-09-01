import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse the contents of a `.env` file.
 *
 * Exists so settings can be changed the same way on every platform. Prefixing a
 * command with `PUBLIC_URL=...` is a POSIX shell feature that does not work in
 * Windows cmd or PowerShell, which would leave Windows users with no way to set
 * a public URL short of editing source.
 *
 * Deliberately small: `KEY=value`, `#` comments, optional surrounding quotes.
 * No variable interpolation, no multi-line values.
 */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) value = value.slice(1, -1);

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/** Apply a `.env` file if present. Real environment variables win. */
function loadEnvFile(file = process.env.ENV_FILE || '.env') {
  let text;
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch {
    return; // no .env is the normal case
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

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
