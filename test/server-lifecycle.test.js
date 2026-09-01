import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { startServer } from '../src/server.js';
import { FakeLichess } from './helpers/fake-lichess.js';

const dirs = [];
async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lichesspro-test-'));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

/** Start a server on an OS-assigned port, wired to a fake Lichess. */
async function boot(overrides = {}) {
  const fake = new FakeLichess({ tokens: { lip_alice: 'white', lip_bob: 'black' } });
  const host = await fake.start();
  const instance = await startServer({
    port: 0,
    dataDir: await tmpDir(),
    lichessHost: host,
    ...overrides,
  });
  return {
    fake,
    instance,
    async stop() {
      await instance.close();
      await fake.stop();
    },
  };
}

describe('startServer lifecycle', () => {
  test('importing the module starts nothing', async () => {
    // If the import had side effects, this module would already be listening
    // by the time any test ran. Proven by the fact that a fresh instance can
    // take the default port below without a clash.
    const server = await startServer({ port: 0, dataDir: await tmpDir() });
    after(() => server.close());
    assert.ok(server.port > 0);
  });

  test('binds an OS-assigned port and reports it', async () => {
    const h = await boot();
    after(h.stop);
    assert.ok(h.instance.port > 0 && h.instance.port < 65_536);
    assert.equal(h.instance.url, `http://localhost:${h.instance.port}`);
  });

  test('two instances get different ports and do not share state', async () => {
    const a = await boot();
    const b = await boot();
    after(a.stop);
    after(b.stop);

    assert.notEqual(a.instance.port, b.instance.port);

    const created = await fetch(`${a.instance.url}/api/matches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: { base: 5400, increment: 30, periods: [{ afterMove: 40, bonus: 1800 }] } }),
    }).then((r) => r.json());

    // The second instance has its own store and must not see it.
    const missing = await fetch(`${b.instance.url}/api/matches/${created.id}`);
    assert.equal(missing.status, 404);
  });

  test('redirectUri follows the bound port, so OAuth can round-trip', async () => {
    const h = await boot();
    after(h.stop);
    // This is the whole reason config is built after listen(): Lichess compares
    // redirect_uri at the token exchange against the one used to authorize.
    assert.equal(h.instance.config.redirectUri, `http://localhost:${h.instance.port}/auth/callback`);
  });

  test('a port clash rejects instead of crashing the process', async () => {
    const first = await boot();
    after(first.stop);

    // Without an 'error' listener on the server this surfaces as an uncaught
    // exception, which inside a desktop app kills the whole thing silently.
    await assert.rejects(
      () => startServer({ port: first.instance.port, dataDir: '/tmp' }),
      (err) => err.code === 'EADDRINUSE',
    );
  });

  test('close() releases the port', async () => {
    const h = await boot();
    const { port } = h.instance;
    await h.stop();

    const reused = await startServer({ port, dataDir: await tmpDir() });
    after(() => reused.close());
    assert.equal(reused.port, port);
  });

  test('close() is idempotent', async () => {
    const h = await boot();
    await h.instance.close();
    await h.instance.close(); // must not throw or double-close the store
    await h.fake.stop();
  });
});

describe('OAuth cookie handoff', () => {
  /**
   * In the desktop app the consent page opens in the SYSTEM browser, so the
   * callback arrives with a different cookie jar than the app window that
   * started the sign-in. The seat must still end up owned by the app window,
   * because the seat is claimed with the clientId captured at /auth/login.
   */
  test('a callback from a different cookie jar still seats the original client', async () => {
    const h = await boot({ desktop: true });
    after(h.stop);

    const created = await fetch(`${h.instance.url}/api/matches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: { base: 5400, increment: 30, periods: [{ afterMove: 40, bonus: 1800 }] } }),
    });
    const { id } = await created.json();
    const appCookie = created.headers.getSetCookie()[0].split(';')[0];

    // The app window starts the sign-in; this is where the seat's owner is decided.
    const login = await fetch(`${h.instance.url}/auth/login?match=${id}`, {
      headers: { cookie: appCookie },
      redirect: 'manual',
    });
    assert.equal(login.status, 302);
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    assert.ok(state);

    // The system browser completes it, carrying no cookie of ours at all.
    const callback = await fetch(`${h.instance.url}/auth/callback?code=fake-code&state=${state}`, {
      redirect: 'manual',
    });
    assert.equal(callback.status, 200, 'desktop mode renders a page instead of redirecting');
    const html = await callback.text();
    assert.match(html, /close this tab/i);

    // The app window, with its original cookie, owns the seat.
    const view = await fetch(`${h.instance.url}/api/matches/${id}`, { headers: { cookie: appCookie } }).then((r) =>
      r.json(),
    );
    assert.equal(view.you, 'a', 'the app window still controls the match');
    assert.equal(view.match.seats.a.username, 'Alice');

    // A stranger's browser does not.
    const stranger = await fetch(`${h.instance.url}/api/matches/${id}`).then((r) => r.json());
    assert.equal(stranger.you, null);
  });

  test('web mode still redirects into the match', async () => {
    const h = await boot({ desktop: false });
    after(h.stop);

    const created = await fetch(`${h.instance.url}/api/matches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: { base: 300, increment: 3 } }),
    });
    const { id } = await created.json();
    const cookie = created.headers.getSetCookie()[0].split(';')[0];

    const login = await fetch(`${h.instance.url}/auth/login?match=${id}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    const state = new URL(login.headers.get('location')).searchParams.get('state');

    const callback = await fetch(`${h.instance.url}/auth/callback?code=fake-code&state=${state}`, {
      redirect: 'manual',
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), `/m/${id}`);
  });
});
