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
    