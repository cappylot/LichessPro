import fs from 'node:fs';
import path from 'node:path';

/**
 * Configuration.
 *
 * This is a factory rather than a module-level singleton because the app is
 * started two ways. From a terminal the port is known up front. Inside the
 * desktop app it is not: the server binds port 0 so it cannot clash with
 * whatever else is on 8080, and the real port is only known after `listen`.
 * Since `redirectUri` is derived from the port and must match byte-for-byte
 * between the authorize request and the token exchange, config has to be built
 * *after* binding.
 */

/**
 * Parse the contents of a `.env` file.
 *
 * Exists so settings can be changed the same way on every platform. Prefixing a
 * command with `PUBLIC_URL=...` is a POSIX shell feature that does not work in
 * Windows cmd or PowerShell.
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

/**
 * Apply a `.env` file if present. Real environment variables win.
 *
 * Only the CLI calls this: it resolves against the working directory, which is
 * meaningless for a double-clicked desktop app (the cwd there is `/` or the
 * install folder), so the desktop path passes its settings explicitly instead.
 */
export function loadEnvFile(file = process.env.ENV_FILE || '.env') {
  let text;
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch {
    return {}; // no .env is the normal case
  }
  const values = parseEnv(text);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

function int(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(value)}`);
  return n;
}

const trimSlash = (url) => url.replace(/\/+$/, '');

/**
 * Build a config object.
 *
 * @param {object} [overrides] Values that win over the environment. The desktop
 *   app passes `port`, `publicUrl` and `dataDir` explicitly.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(overrides = {}, env = process.env) {
  const port = overrides.port ?? int('PORT', env.PORT, 8080);
  const publicUrl = trimSlash(overrides.publicUrl ?? env.PUBLIC_URL ?? `http://localhost:${port}`);

  return {
    port,
    host: overrides.host ?? env.HOST ?? '127.0.0.1',
    publicUrl,
    redirectUri: `${publicUrl}/auth/callback`,
    oauthClientId: overrides.oauthClientId ?? env.OAUTH_CLIENT_ID ?? 'lichesspro',
    lichessHost: trimSlash(overrides.lichessHost ?? env.LICHESS_HOST ?? 'https://lichess.org'),
    dataDir: path.resolve(overrides.dataDir ?? env.DATA_DIR ?? './.data'),
    addTimeIntervalMs: overrides.addTimeIntervalMs ?? int('ADD_TIME_INTERVAL_MS', env.ADD_TIME_INTERVAL_MS, 200),

    // In the desktop app the OAuth round trip finishes in the system browser,
    // so the callback shows a "you can close this" page rather than redirecting
    // that browser into a match it does not own.
    desktop: overrides.desktop ?? false,

    // OAuth scopes we request from the host.
    //   challenge:write - create the challenge AND call /api/round/.../add-time
    //   board:play      - stream the game state in real time
    scopes: ['challenge:write', 'board:play'],
  };
}
