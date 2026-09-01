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
   host signs in ── OAuth (PKCE) ───┐        ┌─ streams game state ──┐
                                    ├ LichessPro                     ▼
  opponent's token ── pasted in ────┘  (the app) ─ POST add-time ► lichess.org
                                                                     │
                       both players play in the normal Lichess UI ◄───┘
```

Only the **host** runs the app. Their opponent installs nothing.

1. The host creates a match and signs in with Lichess.
2. The host sends their opponent a link that opens Lichess's token page with the
   right permissions pre-selected. The opponent creates a token and sends it
   back; the host pastes it in. The opponent never opens this app.
3. The host hits **Create the game**. LichessPro creates the challenge as the
   host and auto-accepts it with the opponent's token, so nobody has to click a
   popup within the 20-second challenge expiry.
4. The arbiter opens the Board API game stream and counts half-moves.
5. When a player completes the control move, the arbiter delivers their bonus and
   verifies it landed on the clock.

### Why two accounts must authorise the app

The Lichess add-time endpoint adds seconds to the **opponent's** clock — you can
never give time to yourself. To give White 30 minutes the app must call the API
with **Black's** token, and vice versa. One token is not enough.

The two credentials arrive by different routes because their owners are in
different positions: the host is at the machine running the app, so they can
complete an OAuth redirect; the opponent generally cannot reach it at all, so
they hand over a token instead.

The app refuses two seats claimed by the same Lichess account, since that
configuration cannot work. The seats are also pinned by route — the host's
sign-in always fills the challenger seat and a pasted token always fills the
opponent seat — so the roles, and the colour choice that follows them, cannot be
inverted by doing the two steps in the other order.

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

## Getting it

### The app (recommended)

Download the installer for your system from the
[releases page](../../releases), open it, and that is the whole setup. No Node,
no terminal, no URL to remember. The app opens its own window and puts a knight
in your menu bar / system tray while a game is running.

- **macOS** — the build is not notarised, so the first open is blocked with
  *"Apple could not verify LichessPro is free of malware"*. Try to open it once,
  then go to **System Settings → Privacy & Security**, scroll to Security, and
  click **Open Anyway** next to the message. On macOS 15 and later the old
  right-click → Open shortcut no longer works.
  Equivalently, from a terminal: `xattr -dr com.apple.quarantine /Applications/LichessPro.app`
- **Windows** — SmartScreen may warn about an unrecognised app. Choose **More
  info**, then **Run anyway**.

Those warnings are what an app without a paid signing identity looks like; they
are not a sign anything is wrong. **Only notarisation removes the macOS one**,
and that needs an Apple Developer account (~$99/yr) — ad-hoc signing, which
these builds use by default, is what lets the app run on Apple Silicon at all,
but it does not satisfy Gatekeeper.

<details>
<summary>Signing and notarising with an Apple Developer account</summary>

Add these repository secrets (Settings → Secrets and variables → Actions) and the
release workflow signs and notarises on its own — no code change:

| Secret | Where it comes from |
| --- | --- |
| `CSC_LINK` | your **Developer ID Application** certificate exported from Keychain Access as `.p12`, then base64: `base64 -i cert.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | developer.apple.com → Membership (10 characters) |

It must be a **Developer ID Application** certificate. "Apple Development" and
"Apple Distribution" are for Xcode and the App Store and will not satisfy
Gatekeeper for a direct download.

With `CSC_LINK` present the workflow stops passing `--config.mac.identity=-`, so
electron-builder signs with the real certificate instead of ad hoc, and
notarisation runs automatically once the three `APPLE_*` values are set. Expect
the macOS job to take several minutes longer while Apple processes it.

Verify a build afterwards with:

```bash
spctl -a -vvv -t install /Applications/LichessPro.app
# accepted / source=Notarized Developer ID
```

</details>

**Closing the window does not stop the arbiter** — that is deliberate, since a
classical game runs for hours. Quit from the tray menu when the game is over. If
you try to quit mid-game the app tells you what is still owed and asks first.

Match data, including both players' access tokens, lives in the app's per-user
folder (`~/Library/Application Support/LichessPro` on macOS,
`%APPDATA%\LichessPro` on Windows).

### From source

Requires **Node.js 20+**. There are **no runtime dependencies**.

```bash
git clone <this repo>
cd LichessPro
npm start          # terminal server, as before
```

Then open <http://localhost:8080>. To run the desktop shell from source instead:

```bash
npm install        # Electron, for development only
npm run app
```

And to build installers yourself — note each platform can only build its own:

```bash
npm run dist:mac   # on a Mac
npm run dist:win   # on Windows
```

### Configuration (source only)

Copy `.env.example` to `.env` and edit it. The file is read at startup on every
platform, so there is no need for shell-specific environment variable syntax:

```ini
PORT=8080
PUBLIC_URL=http://localhost:8080
```

`PUBLIC_URL` must exactly match the address **you** open the app at, because it
builds the OAuth `redirect_uri` for your own sign-in. The desktop app ignores all
of this: it picks a free port at startup and derives the rest.

There is no Lichess app registration step — Lichess accepts any `client_id`.

### Seating your opponent

Your opponent is seated with a Lichess API token, not by signing in. This is the
only way, and it is why the app needs no public URL: an OAuth redirect would have
to come back to a machine they can reach, and generally they cannot reach yours.

Step 2 of the match page walks through it:

1. **Copy link** puts a Lichess link on your clipboard — nothing else — with
   `challenge:write` and `board:play` already ticked, so they cannot pick the
   wrong permissions. Send it however you normally talk to them.
2. They click Create and send you the token privately.
3. You paste it in. Their name appears and the match is ready.
4. After the game they revoke it at *Preferences → API access tokens*.

The token's scopes and expiry are checked with `POST /api/token/test` before the
seat is filled, so a wrongly-scoped token is rejected there and then rather than
failing at move 40. A token that expires within six hours raises a warning, since
a classical game can outlast it.

> **This hands over a credential.** Whoever holds that token can play moves and
> resign games on that account until it is revoked. Only do this with someone who
> trusts you, send it over a private channel, and revoke it afterwards.

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
and in `.data/matches.json` (gitignored). The browser gets an opaque cookie that
proves seat ownership and nothing else. The file is written with mode `0600` and
its directory `0700` — but **file modes are not enforced on Windows**, so there
the file is readable by any account on the machine. Treat `.data/` as secret
regardless, and delete it when you are done.

---

## Limitations and things worth knowing

- **A 30-minute bonus takes ~12 seconds to land in full** (30 calls at the default
  400 ms pacing). The first minute arrives almost instantly, and the recipient's
  clock is frozen while it is their opponent's turn, so this is safe in practice —
  but a player who completes move 40 with seconds left and whose opponent replies
  instantly will briefly see less than the full bonus. Lower
  `ADD_TIME_INTERVAL_MS` to shorten the window, at the cost of more 429s.
- **Both credentials must stay valid** for the whole game. If your opponent
  revokes their token, or it expires mid-game, the arbiter can no longer pay
  *you* your bonus — their token is the one that adds time to your clock.
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
electron/
  main.js         desktop shell: tray, window, quit guard, external links
src/
  cli.js          terminal entry point (`npm start`)
  timecontrol.js  pure spec validation, ply arithmetic, 60s chunking   (unit tested)
  arbiter.js      the engine: watch the game, deliver and verify bonuses
  auth.js         token scope/expiry vetting for the pasted token          (unit tested)
  seating.js      which seat each route may claim                          (unit tested)
  lichess.js      API client: OAuth PKCE, challenges, stream, add-time
  ndjson.js       ndjson stream parsing with keep-alive detection      (unit tested)
  store.js        match persistence (tokens, delivery progress)
  server.js       startServer(): routes, SSE, OAuth callback, static files
public/           single-page front end, no framework: builds once per phase
                  and patches in place, so a live game does not re-render
test/             unit tests + a fake Lichess that reproduces the clamp
```

## License

MIT
