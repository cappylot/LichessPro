import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';
import { Arbiter } from '../src/arbiter.js';
import { LichessClient } from '../src/lichess.js';
import { normaliseSpec } from '../src/timecontrol.js';
import { FakeLichess, waitFor } from './helpers/fake-lichess.js';

const SPEC = normaliseSpec({ base: 5400, increment: 30, periods: [{ afterMove: 40, bonus: 1800 }] });
const TOKENS = { 'token-alice': 'white', 'token-bob': 'black' };
const SEATS = {
  a: { token: 'token-alice', userId: 'alice' },
  b: { token: 'token-bob', userId: 'bob' },
};

/** Boot a fake Lichess with an arbiter attached, and tear both down after. */
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function harness({ plies = 0, record = {}, intervalMs = 0, sleep = async () => {} } = {}) {
  const fake = new FakeLichess({ tokens: TOKENS, plies });
  const host = await fake.start();
  const client = new LichessClient({ host, clientId: 'test', redirectUri: `${host}/cb` });

  const controller = new AbortController();
  const arbiter = new Arbiter({
    client,
    gameId: fake.gameId,
    spec: SPEC,
    seats: SEATS,
    record,
    intervalMs,
    sleep,
  });

  const runPromise = arbiter.run(controller.signal).catch(() => {});
  // Wait for the gameFull event to be consumed so colours are resolved.
  await waitFor(() => arbiter.colorSeat !== null, { label: 'colour mapping' });

  const stop = async () => {
    controller.abort();
    await runPromise;
    await fake.stop();
  };
  return { fake, arbiter, record, stop };
}

describe('the constraint that shapes the whole design', () => {
  test('a single add-time call of 1800s only adds 60s', async () => {
    const fake = new FakeLichess({ tokens: TOKENS });
    const host = await fake.start();
    after(() => fake.stop());
    const client = new LichessClient({ host, clientId: 'test', redirectUri: `${host}/cb` });

    const before = fake.state.wtime;
    await client.addTime('token-bob', fake.gameId, 1800); // Black gives White 30 min... allegedly

    assert.equal(fake.addTimeCalls[0].requested, 1800);
    assert.equal(fake.addTimeCalls[0].applied, 60, 'Lichess clamps to 60s and still returns 200 OK');
    assert.equal(fake.state.wtime - before, 60_000, 'only one minute actually arrives');
  });
});

describe('Arbiter bonus delivery', () => {
  test('pays White the moment White completes move 40, using Black token', async () => {
    const h = await harness({ plies: 78 });
    after(h.stop);

    const whiteBefore = h.fake.state.wtime;
    h.fake.playMove(); // ply 79: White completes move 40

    await waitFor(() => h.record.deliveries?.['white:40']?.done, { label: 'white bonus' });

    const rec = h.record.deliveries['white:40'];
    assert.equal(rec.target, 1800);
    assert.equal(rec.deliveredSeconds, 1800);
    assert.equal(rec.calls, 30, '30 minutes must be delivered as 30 calls of 60s');
    assert.equal(rec.error, null);

    assert.equal(h.fake.state.wtime - whiteBefore, 1_800_000, 'White gained exactly 30 minutes');
    assert.equal(h.fake.addTimeCalls.length, 30);
    assert.ok(
      h.fake.addTimeCalls.every((c) => c.giver === 'black' && c.receiver === 'white'),
      'time can only be given to an opponent, so Black token pays White',
    );

    // Black is still on move 39 and must not have been paid.
    assert.equal(h.record.deliveries['black:40'], undefined);
  });

  test('verifies delivery against the frozen clock', async () => {
    const h = await harness({ plies: 78 });
    after(h.stop);

    h.fake.playMove();
    // Observation trails delivery: the 200 OK for the final add-time call can
    // beat the gameState it triggers.
    await waitFor(() => h.record.deliveries?.['white:40']?.observedGainMs === 1_800_000, {
      label: 'clock to show the full bonus',
    });

    const rec = h.record.deliveries['white:40'];
    assert.equal(rec.done, true);
    assert.equal(rec.observable, true, "White's clock is frozen while Black is on move");
    assert.equal(rec.verified, true);
  });

  test('pays Black on ply 80 using the White token', async () => {
    const h = await harness({ plies: 79 });
    after(h.stop);

    const blackBefore = h.fake.state.btime;
    h.fake.playMove(); // ply 80: Black completes move 40

    await waitFor(() => h.record.deliveries?.['black:40']?.done, { label: 'black bonus' });
    await waitFor(() => h.record.deliveries?.['white:40']?.done, { label: 'white catch-up' });

    assert.equal(h.fake.state.btime - blackBefore, 1_800_000);
    const blackCalls = h.fake.addTimeCalls.filter((c) => c.receiver === 'black');
    assert.equal(blackCalls.length, 30);
    assert.ok(blackCalls.every((c) => c.giver === 'white'));
  });

  test('is idempotent: a takeback back past move 40 does not pay twice', async () => {
    const h = await harness({ plies: 78 });
    after(h.stop);

    h.fake.playMove();
    await waitFor(() => h.record.deliveries?.['white:40']?.done, { label: 'white bonus' });
    const callsAfterFirst = h.fake.addTimeCalls.length;

    // Takeback of move 40, then White plays it again: back to ply 79, where
    // the bonus is due once more by the schedule but was already paid.
    h.fake.state.moves.pop();
    h.fake.playMove();

    await realSleep(150);
    assert.equal(h.fake.addTimeCalls.length, callsAfterFirst, 'no second payout');
    assert.equal(h.record.deliveries['white:40'].deliveredSeconds, 1800);
  });

  test('resumes a half-delivered bonus instead of restarting it', async () => {
    // Simulates a restart: 10 of the 30 calls were already made and persisted.
    const record = {
      deliveries: {
        'white:40': {
          color: 'white',
          target: 1800,
          planned: 1800,
          reason: 'move 40',
          deliveredSeconds: 600,
          calls: 10,
          done: false,
          observable: null,
          error: null,
        },
      },
    };
    const h = await harness({ plies: 79, record });
    after(h.stop);

    await waitFor(() => h.record.deliveries['white:40'].done, { label: 'resumed bonus' });

    assert.equal(h.fake.addTimeCalls.length, 20, 'only the 20 outstanding calls are made');
    assert.equal(h.record.deliveries['white:40'].deliveredSeconds, 1800);
  });

  test('catches up on a bonus missed while disconnected', async () => {
    // The arbiter connects at ply 100: both players are past move 40 already.
    const h = await harness({ plies: 100 });
    after(h.stop);

    await waitFor(
      () => h.record.deliveries?.['white:40']?.done && h.record.deliveries?.['black:40']?.done,
      { label: 'both bonuses', timeout: 10_000 },
    );

    assert.equal(h.fake.addTimeCalls.filter((c) => c.receiver === 'white').length, 30);
    assert.equal(h.fake.addTimeCalls.filter((c) => c.receiver === 'black').length, 30);
  });

  test('pays both colours concurrently, since each is paid by a different token', async () => {
    // Real pacing, so a serial queue would be plainly visible in the ordering.
    const h = await harness({ plies: 100, intervalMs: 25, sleep: realSleep });
    after(h.stop);

    await waitFor(
      () => h.record.deliveries?.['white:40']?.done && h.record.deliveries?.['black:40']?.done,
      { label: 'both bonuses', timeout: 10_000 },
    );

    // One shared queue would put all 30 of one colour's calls before the first
    // of the other's. Independent lanes interleave from the very start.
    const openers = h.fake.addTimeCalls.slice(0, 10).map((c) => c.receiver);
    assert.ok(openers.includes('white'), 'White is being paid within the first ten calls');
    assert.ok(openers.includes('black'), 'Black is being paid within the first ten calls');

    assert.equal(h.fake.addTimeCalls.filter((c) => c.receiver === 'white').length, 30);
    assert.equal(h.fake.addTimeCalls.filter((c) => c.receiver === 'black').length, 30);
  });

  test('retries through rate limiting without losing time', async () => {
    const h = await harness({ plies: 78 });
    after(h.stop);

    h.fake.rateLimitNext = 3; // first three calls get a 429
    const whiteBefore = h.fake.state.wtime;
    h.fake.playMove();

    await waitFor(() => h.record.deliveries?.['white:40']?.done, { label: 'white bonus', timeout: 10_000 });

    assert.equal(h.fake.state.wtime - whiteBefore, 1_800_000, 'the full bonus still lands');
    assert.equal(h.record.deliveries['white:40'].calls, 30);
  });

  test('stops paying once the game is over and records the shortfall', async () => {
    // Paced delivery so the game can end mid-bonus deterministically.
    const h = await harness({ plies: 78, intervalMs: 25, sleep: realSleep });
    after(h.stop);

    h.fake.playMove();
    await waitFor(() => (h.record.deliveries?.['white:40']?.calls ?? 0) > 0, { label: 'delivery start' });
    h.fake.finish('resign', 'black');

    await waitFor(() => h.arbiter.finished, { label: 'game over' });
    const callsAtFinish = h.fake.addTimeCalls.length;
    await realSleep(200);

    assert.ok(callsAtFinish < 30, 'delivery was cut short by the game ending');
    assert.equal(h.fake.addTimeCalls.length, callsAtFinish, 'no calls after the game ended');
    assert.equal(h.record.deliveries['white:40'].done, false);
  });
});
