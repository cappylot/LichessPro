# LichessPro

Play games on Lichess with **multi-period, FIDE-style time controls** — the kind
Lichess itself does not offer.

The canonical example is the FIDE classical control:

> **90 minutes for the first 40 moves, then +30 minutes, with a 30-second
> increment from move one.**

Lichess challenges only accept `base + increment`. This app fills the gap: it
starts a normal 90+30 game between you and a friend, watches it live, and hands
each player their extra 30 minutes the instant they complete move 40.

You play the game in the **normal Lichess web or mobile interface**. This app is
only the arbiter standing next to the board.

---

## How it works

```
  Player A browser ─┐                            ┌─ streams game state ──┐
                    ├─ OAuth (PKCE) ─► LichessPro ─┤                       ▼
  Player B browser ─┘                  (arbiter)  └─ POST add-time ──► lichess.org
                                                                          │
                            both players play in the normal Lichess UI ◄───┘
```

1. Player A creates a match and signs in with Lichess.
2. Player A sends the match link to Player B, who signs in with their own account.
   (Or, if B cannot reach the app at all, B sends A an API token to paste —
   see [Playing without a public URL](#playing-without-a-public-url).)
3. Either player hits **Create the game**. LichessPro creates the challenge as A
   and auto-accepts it as B, so nobody has to click a popup within the 20-second
   challenge expiry.
4. The arbiter opens the Board API game stream and counts half-moves.
5. When a player completes the control move, the arbiter delivers their bonus and
   verifies it landed on the clock.

### Why both players must authorise the app

The Lichess add-time endpoint adds seconds to the **opponent's** clock — you can
never give time to yourself. To give White 30 minutes the app must call the API
with **Black's** token, and vice versa. One token is not enough; each player must
sign in.

The app refuses two seats claimed by the same Lichess account, since that
configuration cannot work.

---

## The constraint that shapes this project

> `POST /api/round/{gameId}/add-time/{seconds}` **silently clamps `seconds` to
> 60.** A single call asking for 1800 returns `200 OK` and adds **one minute**.

This is not documented as a runtime behaviour anywhere obvious — the OpenAPI spec
lists `maximum: 60` on the path parameter, and the server enforces it by clamping
rather than rejecting. From
[`lila/modules/round/src/main/Moretimer.scala`](https://github.com/lichess-org/lila/blob/master/modules/round/src/main/Moretimer.scala):

```scala
private val minTime = 5.seconds
private val maxTime = 60.seconds

val duration =
  if unchecked < minTime then minTime
  else if unchecked > maxTime then maxTime
  else unchecked
```

So the obvious implementation — "when move 40 is reached, POST add-time/1800" —
appears to succeed and quietly delivers 1 minute instead of 30. Getting this
wrong is worse than failing loudly, because you find out three hours into a
classical game.

**LichessPro therefore delivers a 30-minute bonus as 30 sequential 60-second
calls**, paced to stay under the API rate limit, retried on 429, resumable after
a crash, and verified against the recipient's clock afterwards.

### Verified API facts

Everything below was checked against the
[Lichess OpenAPI spec](https://github.com/lichess-org/api) and the
[lila source](https://github.com/lichess-org/lila) rather than assumed.

| Question | Answer |
| --- | --- |
| Add-time endpoint | `POST /api/round/{gameId}/add-time/{seconds}` (**not** under `/api/board/`) |
| Scope required | `challenge:write` |
| Who receives the time | the **opponent** of the token owner |
| Max per call | **60s**, clamped server-side, still `200 OK` |
| Min per call | 5s, clamped up |
| Works in rated games? | Yes — the API path passes `force = true`, bypassing the players' "give more time" preference and the `noGiveTime` rule |
| Blocked when? | tournament, simul or Swiss games (`canTakebackOrAddTime = !isMandatory`); a direct challenge is fine |
| Does the game stream report it? | Yes — `GameStateStream` handles `BoardMoretime` and pushes a fresh `gameState` with updated clocks, which is how delivery is verified |
| Game stream | `GET /api/board/game/stream/{gameId}`, scope `board:play`, ndjson |
| Public game stream | delayed by 3 moves, so unusable for this |
| Must players move via the API? | **No.** `isBoardCompatible` is a property of the game (source `Api`, speed ≥ blitz), not of how moves are entered |
| Challenge clock limits | `clock.limit` ∈ {0,15,30,45} ∪ multiples of 60, ≤ 10800; `clock.increment` ≤ 60 |
| Game id | equals the challenge id |

---

## Running it

Requires **Node.js 20+**. There are **no dependencies** — nothing to install.

```bash
git clone <this repo>
cd LichessPro
npm start
```

Then open <http://localhost:8080>.

To play with someone not on your machine, the app must be reachable at a URL both
of you can open, and `PUBLIC_URL` must match it exactly (it is used to build the
OAuth redirect URI):

```bash
PUBLIC_URL=https://chess.example.com PORT=8080 npm start
```

Copy `.env.example` to `.env` for the full list of settings. There is no Lichess
app registration step — Lichess accepts any `client_id`.

### Playing without a public URL

Signing in with Lichess needs the app to be reachable by both players' browsers,
because the OAuth redirect has to come back to it. If you would rather not expose
anything — no tunnel, no port forwarding, just `localhost` — use the token path
instead:

1. On the match page, open **"Or add a player with an API token"**.
2. Send your opponent the Lichess link shown there. It opens the token form with
   `challenge:write` and `board:play` already ticked, so they cannot pick the
   wrong permissions.
3. They create the token and send it to you privately. You paste it in.
4. After the game they revoke it at *Preferences → API access tokens*.

The app checks the token's scopes and expiry with `POST /api/token/test` before
accepting it, so a wrongly-scoped token is rejected immediately rather than
failing at move 40.

> **This hands over a credential.** Whoever holds that token can play moves and
> resign games on that account until it is revoked. Only do this with someone who
> trusts you, over a private channel, and revoke it afterwards. The OAuth flow
> exists precisely so this is not necessary — prefer it when you can.

### Tests

```bash
npm test
```

The suite includes a fake Lichess server that reproduces the 60-second clamp and
the `BoardMoretime` state push, so the chunked delivery, the idempotency, the
crash-resume and the rate-limit retry are all exercised end to end.

---

## Design notes

**Bonuses are per player, not per move pair.** White receives the bonus on ply 79
(completing move 40) and Black on ply 80 — the way a DGT clock rolls into a new
period, and half a move earlier for White than a naive "wait for move 40 to be
complete" implementation. It also makes verification exact: the recipient's clock
is frozen at that moment, so any observed increase is precisely what was added.

**Delivery is idempotent and resumable.** Progress is recorded per
`(colour, move)` key after every single call and persisted, so a restart mid-bonus
continues from call 11 of 30 rather than paying twice. A takeback that rewinds
past the control move does not trigger a second payout.

**The stream is treated as unreliable.** It reconnects with backoff, alternates
between the two players' tokens, and has a 30-second idle watchdog (Lichess sends
keep-alives every ~7s). On every reconnect the `gameFull` event re-synchronises
state, so a bonus that came due while disconnected is paid as soon as the stream
returns.

**Verification, not optimism.** A `200 OK` from add-time does not prove time was
added: the endpoint dispatches asynchronously and answers before the round actor
has acted. The arbiter instead measures the recipient's clock across the delivery
window and marks the bonus verified only when the clock actually moved. Anything
short is surfaced in the UI, and there is a manual top-up control as an escape
hatch.

**Tokens never reach the browser.** OAuth access tokens live only on the server
and in `.data/matches.json` (mode `0600`, gitignored). The browser gets an opaque
cookie that proves seat ownership and nothing else.

---

## Limitations and things worth knowing

- **A 30-minute bonus takes ~12 seconds to land in full** (30 calls at the default
  400 ms pacing). The first minute arrives almost instantly, and the recipient's
  clock is frozen while it is their opponent's turn, so this is safe in practice —
  but a player who completes move 40 with seconds left and whose opponent replies
  instantly will briefly see less than the full bonus. Lower
  `ADD_TIME_INTERVAL_MS` to shorten the window, at the cost of more 429s.
- **Both players must keep their Lichess accounts authorised** for the whole game.
  Revoking the app — or a pasted token expiring — mid-game stops the arbiter from
  paying that player's opponent.
- **The app must stay running for the whole game.** It is the arbiter; if it is
  down at move 40, the bonus is late (it is paid on reconnect, not skipped).
- **Rated games work**, but consider whether a game whose clock is manipulated by
  a third-party tool belongs in your rating history. Casual is the default.
- **Not a substitute for a real arbiter.** Lichess's own clock, flag detection and
  result are authoritative. If the bonus fails to land, a player can flag — watch
  the delivery panel.
- This project talks to Lichess but is **not affiliated with or endorsed by
  Lichess**. Be considerate with the API; it is a free service run on donations.

---

## Project layout

```
src/
  timecontrol.js  pure spec validation, ply arithmetic, 60s chunking   (unit tested)
  arbiter.js      the engine: watch the game, deliver and verify bonuses
  auth.js         token scope/expiry vetting for the paste-a-token path (unit tested)
  lichess.js      API client: OAuth PKCE, challenges, stream, add-time
  ndjson.js       ndjson stream parsing with keep-alive detection      (unit tested)
  store.js        match persistence (tokens, delivery progress)
  server.js       HTTP routes, SSE, OAuth callback, static files
public/           single-page front end, no framework
test/             unit tests + a fake Lichess that reproduces the clamp
```

## License

MIT
