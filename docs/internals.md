# Internals

How it works and how to change it. Users need none of this — see the [README](../README.md).

## Layout

```
server.js                     HTTP receiver, watchdog, config hot-reload, launchd TMPDIR fix
lib/presence.js               pure: wire state → Discord activity (formats, labels, hover lines)
lib/discord.js                Discord RPC connection manager (retry, coalescing, 4000 diagnosis)
userscripts/db-presence.user.js   the userscript: injected page half + GM_xmlhttpRequest relay
userscripts/db-capture.user.js    recorder used to learn DuelingBook's protocol
scripts/smoke.js              shows both cards on real Discord for 30 s
test/                         node:test; fake-discord.js speaks the real IPC framing,
                              replay.test.js drives the userscript with a recorded match
install.sh / uninstall.sh     one-step installer (bootstraps Node if missing)
launchd/ systemd/ windows/    autostart templates per OS
captures/                     recorded matches (git-ignored: they contain chat and friend lists)
```

## State of the build

Everything below is live and in daily use on macOS + Zen. The duel/watching/solo parsing was written against real captured matches and is regression-tested by replaying them (`npm test` — 16 tests; the replay suite self-skips when `captures/` is empty, e.g. on a fresh clone).

Two caveats worth stating plainly:

* **AFK** is built from DuelingBook's own `Away`/`Back` broadcasts and has never been observed firing in testing — the server decides when you're idle and the threshold is unknown.
* **Linux and Windows autostart** are written but untested by the author; the service itself is plain Node and runs anywhere with `npm start`.

`userscripts/db-capture.user.js` is the tool that produced those captures. Keep it installed but disabled; if DuelingBook changes (`main.js?v=` moves past 932) and a card goes wrong, enable it, play a match, click Download, and the JSON in `captures/` lets the replay test pin the new behaviour.

## Using your own Discord application

Everyone running this shares one application ID — that is how Rich Presence works, one app per
program — so `config.json` is ready to use. For your own: [Developer Portal](https://discord.com/developers/applications)
→ *New Application* (its name is what Discord prints after "Playing") → copy the **Application ID**
into `config.json`, and upload art under *Rich Presence → Art Assets* named to match `largeImageKey`.
The service re-reads `config.json` when you save it.

Developing from a clone: `npm install`, `npm test`, `npm start` (or `./install.sh` to run it from
`~/.duelingbook-rpc` as users do). `npm run smoke` shows both cards on real Discord.

## How the duel state is read (verified from a capture)

`captures/dbcap-2026-09-13T01-41-36-811Z.json` — a quit game-1, then a full best-of-3 lost 0-2:

* **Match start**: inbound `{action:'Accept user', id, format:'uu', type:'m'|'s', rated, tag_duel, rush, player1, player2}` → the site's `startDuel()` sets `duel_active=true`, `duelist=true`, `duelId=id`, `match=(type=='m')`, `rated`; `currentLabel` becomes `rps_start`. The format code lives only in a local variable, so the userscript hooks the socket for that one message (`deckData` holds a copy for a few seconds and is then cleared — it's a fallback only).
* **Game ends**: `Duel/Admit defeat {over:false}` → `Duel/Siding with cards` (`Duel/Siding` for watchers) → `currentLabel='siding'`, `games += 1`. `games` only counts sidings *seen locally* — anyone arriving mid-match (spectator, rejoining player) starts at 0 — so the userscript syncs from the server's series score `(W-L-D)` in the `score` field of `Watch duel`, `Begin next duel` and `Back to RPS` (W+L+D = games completed; from player 1's side, which is you when dueling). The siding message's text carries only the current best-of-3's score and is ignored. Concessions (`Admit defeat {username}`) move the score provisionally until the next server score.
* **Series vs best-of-3**: a "Match" ends at 2 wins, but a rematch (`Back to RPS`, `used_allotted_rematch++`) continues the same duel id and the series score keeps counting — captured: `(0-2-0)` → `(0-3-0)` → `(1-3-0)` → `(1-4-0)`. The card says "of 3" only while still inside the first best-of-3, otherwise `Game 6 · 1-4`.
* **Next game**: `Duel/Begin next duel` → `tp_start*` → `duel_start*`; `turnCount` resets.
* **Match ends**: `Duel/Admit defeat {over:true}` → `duel_active=false` ~0.5 s later, while the result screen stays up until `Quit duel` (or `Back to RPS` for a rematch). The duel presence ends on that final concession / `duel_active`, not on leaving the screen.
* `duel_active` stays true through siding and through an opponent's disconnect/rejoin.
* Solo mode is hosted like any duel with `format: 'so'`; `startDuel()` sets the global `solo = true`, and `duelFormat` (a global) holds the format code for every duel — the socket hook is now only a fallback for it.
* `player1` is always **you** — `Accept user` is personalized per recipient — and `player2` the opponent; both carry `.lifepoints`. For watchers `player1`/`player2` are the server's order, matching the `Watch duel` response (`format`, `type`, `rated`, `score`, `id`, `player1/2.{username,lifepoints}`, `turnCount`, `phase`).
* The site's `away` global latches true forever (`backE` only touches the DOM), so the userscript tracks AFK itself from the `Away` / `Back` broadcasts that name you, and clears it on any local mousedown/keydown.

The elapsed timer is per game (and per siding): one start time per (duel, series game, siding-or-not), kept in `sessionStorage` so a reload mid-game keeps it. Cards without a natural clock (deck editor, browsing) get "since this card first appeared", because Discord's card shows an elapsed time on every Playing activity anyway.

### Capturing again (if DuelingBook changes)

`db-capture.user.js` hooks `window.WebSocket` at document-start (constructor + `send`), records every message both ways (parsed JSON, `action`/`play` hoisted), tracks screen changes, diffs the site's primitive globals every second, and snapshots `deckData`/`player1`/`player2` after each inbound `Duel` message — all appended to IndexedDB so a reload keeps the data. Play a match, **Mark** (Ctrl+Shift+M) the moments you can name, **Download**, drop the file in `captures/`; `npm test` replays the newest capture through the userscript.

Facts verified on the live page, not from console output: `window.duel` is the `<div id="duel">`, not state; state lives in flat `var` globals (`duel_active`, `duelist`, `duelId`, `match`, `games`, `rated`, `speed`, `rush`, `turnCount`, `currentLabel`, `deckName`); the socket is `wss://duel.duelingbook.com:8443/` on the main thread; format codes are two letters — `a`dvanced `c`ustom `e`dison `g`oat `t`raditional `u`nlimited `s`peed `r`ush genes`y`s + `r`ated/`u`nrated.

## Wire format (userscript → service)

```
POST /presence   Content-Type: text/plain (avoids a preflight)   Origin must be duelingbook.com
{ "v": 1, "kind": "none" }
{ "v": 1, "kind": "deck", "deckName": "Chaos Turbo" }
{ "v": 1, "kind": "duel", "formatCode": "gr", "rated": true, "game": 2, "of": 3, "siding": false, "startedAt": 1789232052000, "players": ["Me", "Them"], "lp": [8000, 5400], "score": [0, 1, 0] }
{ "v": 1, "kind": "watching", ...same fields as duel... }
{ "v": 1, "kind": "browsing", "screen": "duel_room", "pool": { "formatCode": "ar", "isMatch": true } }   // or "hosting": {...}
any deck/browsing state may add  "away": true, "awaySince": 1789232052000
GET  /health     JSON: discord status, current state, the activity Discord was given
GET  /           the same, human-readable
```

The userscript posts on every change and heartbeats every 20 s; the service clears presence after 60 s of silence (tab closed, browser quit) and on `pagehide`.

**Chattiness matters for what friends see.** Your own client renders every update instantly, but the copy that reaches other people is throttled and lossy — a burst of five updates in 12 s left a friend stuck on a transient "Browsing · Main menu". So: (1) a lobby screen has to hold for 8 s before it replaces another lobby screen (deliberate waits — pool, hosting — and anything live still switch at once), and (2) the service sends Discord at most one update per 15 s, latest state wins, no-ops skipped.

## How the browser half reaches the service

The userscript is in two halves. `pageMain()` is injected into the page at document-start (it must read DuelingBook's `var` globals and hook `window.WebSocket` before `main.js` loads); the userscript itself stays in Tampermonkey's sandbox and does the POSTing with `GM_xmlhttpRequest`. They talk over a `CustomEvent` on `document`.

That split is not decoration. **A page served over https can no longer fetch `http://127.0.0.1`**: Firefox/Zen shipped Local Network Access (`network.lna.*`) in October 2026 and Chrome has Private Network Access. An extension-context request isn't subject to it, so the relay keeps working on both. This is why the script declares `@grant GM_xmlhttpRequest` and `@connect 127.0.0.1` — on update, Tampermonkey asks you to approve that connect permission once.

If presence silently stops after a browser update, this is the first thing to suspect: the service log simply goes quiet (no rejected-origin lines, nothing), because the request never leaves the browser.

## Troubleshooting

* `npm run status` says `discord: no-client-id` → fill in `config.json`. `invalid-client-id` → the ID is wrong (Discord answered close code 4000). `disconnected` → Discord desktop isn't running / not logged in; the service retries every 5–30 s.
* Presence never changes: in the DB tab's console, `__dbrpc.state()` shows what the userscript thinks (it lives on the page, injected by the sandbox half); `localStorage.setItem('dbrpc.debug','1')` logs each change. A red `[dbrpc] local service unreachable` means the agent is down (`./install.sh`) or uBlock's optional "Block Outsider Intrusion into LAN" list is on (allow `127.0.0.1` for duelingbook.com).
* Port 41337 busy: change `port` in `config.json` **and** `ENDPOINT` in the userscript, then `./install.sh`.
* Logs: `~/Library/Logs/duelingbook-rpc.log`.

