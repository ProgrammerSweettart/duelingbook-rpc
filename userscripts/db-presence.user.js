// ==UserScript==
// @name         DuelingBook → Discord Rich Presence
// @namespace    duelingbook-rpc
// @version      0.7.1
// @description  Sends deck-editor / duel / watching / browsing / AFK state to the local duelingbook-rpc service, which mirrors it to Discord.
// @author       duelingbook-rpc
// @match        https://www.duelingbook.com/*
// @match        https://duelingbook.com/*
// @run-at       document-start
// @updateURL    http://127.0.0.1:41337/userscripts/db-presence.user.js
// @downloadURL  http://127.0.0.1:41337/userscripts/db-presence.user.js
// @grant        none
// ==/UserScript==

/*
  Runs in the page context (@grant none) so it can read DuelingBook's own state, which lives in
  plain `var` globals on window (verified on the live page and in a captured match): currentLabel,
  username, duel_active, duelist, duelId, match, games, rated, inPool, hosting, player1/player2
  (.username, .lifepoints — player1 is always you), deckName… plus a few hooked socket messages:
    in  'Accept user'  → format code for the match you're in (the site keeps it only in a local var)
    in  'Watch duel'   → same, for a duel you're spectating (best effort)
    in  'Away'/'Back'  → your own AFK state (the site's `away` global latches and never resets)
    out 'Join pool' / 'Host duel' → format/type shown while you wait
  Nothing here depends on console.log output or on the obfuscated internals of main.js.

  Precedence: duel > watching > deck editor > browsing; AFK wraps deck/browsing (never a live duel).

  Debug: localStorage.setItem('dbrpc.debug', '1')  → logs every state change to the console.
         window.__dbrpc.state()                    → current computed state
*/

(() => {
  'use strict';
  if (window.__dbrpc) return;

  const VERSION = '0.7.1';
  const ENDPOINT = 'http://127.0.0.1:41337/presence';
  const POLL_MS = 1000;
  const HEARTBEAT_MS = 20000; // the service clears presence after 60 s without one
  const BROWSING_SETTLE_MS = 8000; // a lobby screen you merely pass through never reaches Discord

  const DUEL_FRAMES = new Set(['rps_start', 'tp_start', 'tp_start2', 'duel_start', 'duel_start1', 'duel_start2', 'duel_start3', 'duel_start4', 'siding']);
  const NOT_LOGGED_IN = new Set(['', 'start', 'front_page', 'connecting', 'lost_conn', 'lost_conn2', 'closed', 'banned', 'already_logged_in', 'over_limit', 'rejected', 'kicked', 'timed_out', 'terminated']);

  const debug = () => { try { return localStorage.getItem('dbrpc.debug') === '1'; } catch { return false; } };
  const g = (name) => { try { return window[name]; } catch { return undefined; } };
  const str = (v) => (typeof v === 'string' && v ? v : undefined);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  function isVisible(el) {
    if (!el) return false;
    try { return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0; } catch { return false; }
  }

  // ---------------- socket-derived facts ----------------
  const matchStarts = new Map(); // duelId → { formatCode, rated, isMatch }
  let watchInfo = null;          // { formatCode, isMatch } from the last 'Watch duel' response
  let lastPool = null;           // { formatCode, isMatch } from the last outbound 'Join pool'
  let lastHost = null;           // { formatCode, isMatch } from the last outbound 'Host duel'
  let awaySince = null;          // ms epoch while the server says we're away

  const me = () => str(g('username'));
  const names = (u) => (Array.isArray(u) ? u : [u]).filter((x) => typeof x === 'string');
  const codeOf = (m) => (typeof m.format === 'string' && /^[a-z]{2}$/.test(m.format) ? m.format : undefined);

  // Game counting, verified from two captures (captures/dbcap-*.json):
  //  - the client's `games` only increments locally at each siding and starts at 0 for anyone
  //    arriving mid-match (spectator, or a player rejoining), and a rematch keeps counting on the
  //    same duelId (Back to RPS: duel_active false→true, used_allotted_rematch++)
  //  - the server sends a series score "(W-L-D)" — from player1's side, which is always you when
  //    dueling and the listed first player when watching — as the `score` field of 'Watch duel',
  //    'Begin next duel' and 'Back to RPS'. W+L+D = games completed in the whole series.
  //    (The siding message's text also has a score, but for the current best-of-3 only; ignored.)
  //  - a best-of-3 ends at 2 wins ('Admit defeat' {over:true}); a rematch continues the series.
  // completed = series total at the last sync + sidings seen since; concessions between syncs
  // move the score provisionally until the next server score arrives.
  // Two scores, both from player 1's side (you when dueling; the first-listed player when watching):
  //   series — the running total for the whole room, in the `score` field of 'Watch duel', 'Begin next duel', 'Back to RPS'
  //   bo3    — the current best-of-3, in the text of the siding message ("… has begun (1-1-0)"); a match ends at 2 wins
  //            ('Admit defeat' {over:true}) and 'Back to RPS' starts the next one at 0-0-0.
  // The bo3 score is exact from the start of a match you were present for, and from the first siding you witness
  // otherwise; while it is unknown (joined a series mid-match) the card falls back to the series count.
  const SCORE_RE = /\((\d+)-(\d+)-(\d+)\)/;
  let series = null; // { duelId, w, l, d, gamesAtSync, pendingW, pendingL, over }
  let bo3 = null;    // { duelId, w, l, d }  (only while known)
  let result = null; // { until, won, score, players } — shown briefly after your own match ends
  let deckInUse = null; // deck id from your last outbound 'Join pool' / 'Host duel' / 'Join duel'

  // Last card YOU played face-up, for the card art. Two independent gates, both required:
  //  1. the play is on this allowlist of public, face-up plays — never Set ST / Set monster, and never the
  //     own-hand messages (Draw card, To hand) that also carry a card object;
  //  2. the server included the full `card` object. It omits it for face-down plays even to the card's owner
  //     (Set ST / Set monster carry only the per-duel instance id), so hidden information never has an id here.
  const PUBLIC_PLAYS = new Set(['Normal Summon', 'SS ATK', 'SS DEF', 'Activate ST', 'To ST', 'OL ATK', 'OL DEF', 'Declare', 'Flip', 'Flip summon', 'Fusion Summon', 'Synchro Summon', 'Xyz Summon', 'Link Summon', 'Ritual Summon', 'Pendulum Summon']);
  const LAST_CARD_MS = 90000;
  let lastCard = null; // { id, name, at }
  function noteCardPlay(m) {
    if (!PUBLIC_PLAYS.has(m.play) || m.username !== me()) return;
    const c = m.card;
    if (!c || typeof c !== 'object' || !Number.isInteger(c.id) || c.id <= 0 || Number(c.custom) !== 0) return; // official cards only (customs live elsewhere)
    lastCard = { id: c.id, name: str(c.name) || str(m.name), at: Date.now() };
  }
  function recentCard() {
    if (lastCard && Date.now() - lastCard.at < LAST_CARD_MS) return { id: lastCard.id, name: lastCard.name };
    return undefined;
  }

  // Spectators of the duel you're in or watching: seeded by 'Watch duel', kept by Add/Remove watcher.
  const watchers = new Set();
  function noteWatchers(m) {
    if (m.action === 'Watch duel') { watchers.clear(); (Array.isArray(m.watchers) ? m.watchers : []).forEach((w) => { const u = w && (typeof w === 'string' ? w : w.username); if (u) watchers.add(u); }); }
    else if (m.play === 'Add watcher' && typeof m.username === 'string') watchers.add(m.username);
    else if (m.play === 'Remove watcher' && typeof m.username === 'string') watchers.delete(m.username);
  }

  function currentDuelId() { return Number(g('duelId')) || 0; }
  function noteScore(m) {
    if (typeof m.score !== 'string') return;
    const mm = SCORE_RE.exec(m.score);
    if (!mm) return;
    const id = Number(m.id) || currentDuelId();
    const w = Number(mm[1]), l = Number(mm[2]), d = Number(mm[3]);
    series = { duelId: id, w, l, d, gamesAtSync: Number(g('games')) || 0, pendingW: 0, pendingL: 0 };
    if (m.play === 'Back to RPS') bo3 = { duelId: id, w: 0, l: 0, d: 0 };         // a rematch is a fresh best-of-3
    else if (m.action === 'Watch duel' && w < 2 && l < 2 && w + l + d < 3) bo3 = { duelId: id, w, l, d }; // still the first best-of-3 → identical
  }
  function noteSidingScore(m) {
    const mm = typeof m.message === 'string' && SCORE_RE.exec(m.message);
    if (mm) bo3 = { duelId: currentDuelId(), w: Number(mm[1]), l: Number(mm[2]), d: Number(mm[3]) };
  }
  function noteConcession(m) {
    if (typeof m.username !== 'string') return;
    const p = players().players;
    if (!p) return;
    const p1Lost = m.username === p[0];
    if (!p1Lost && m.username !== p[1]) return;
    if (series) { if (p1Lost) series.pendingL++; else series.pendingW++; }
    if (bo3 && bo3.duelId === currentDuelId()) { if (p1Lost) bo3.l++; else bo3.w++; }
    if (m.over === true) {
      if (series) series.over = true;
      const sc = bo3 && bo3.duelId === currentDuelId() ? [bo3.w, bo3.l, bo3.d] : undefined; // player-1 side
      const formatCode = duel.formatCode || codeOf({ format: g('duelFormat') }) || (watchInfo && watchInfo.formatCode);
      if (g('duelist') === true && p[0] === me()) result = { until: Date.now() + 30000, won: !p1Lost, score: sc, players: p, formatCode };
      else result = { until: Date.now() + 30000, winner: p1Lost ? p[1] : p[0], score: sc && (p1Lost ? [sc[1], sc[0], sc[2]] : sc), players: p, formatCode }; // watching: winner's side
    }
  }
  function deckName(id) {
    const decks = g('decks');
    if (!Array.isArray(decks)) return undefined;
    const d = decks.find((x) => x && Number(x.id) === Number(id));
    return d ? str(d.label) || str(d.name) : undefined;
  }
  function onInbound(text) {
    if (typeof text !== 'string' || text.length > 65536) return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.action === 'Duel' || m.action === 'Watch duel') { noteScore(m); noteWatchers(m); }
    if (m.action === 'Duel') noteCardPlay(m);
    if (m.action === 'Duel' && (m.play === 'Siding' || m.play === 'Siding with cards')) noteSidingScore(m);
    if (m.action === 'Duel' && m.play === 'Admit defeat') noteConcession(m);
    switch (m.action) {
      case 'Accept user':
        if (m.id) {
          matchStarts.set(String(m.id), { formatCode: codeOf(m), rated: !!m.rated, isMatch: m.type === 'm' });
          if (matchStarts.size > 8) matchStarts.delete(matchStarts.keys().next().value);
          series = { duelId: Number(m.id), w: 0, l: 0, d: 0, gamesAtSync: 0, pendingW: 0, pendingL: 0 }; // a match starts at 0-0-0
          bo3 = { duelId: Number(m.id), w: 0, l: 0, d: 0 };
          result = null;
        }
        break;
      case 'Watch duel':
        watchInfo = { formatCode: codeOf(m), isMatch: m.type === 'm', rated: !!m.rated, at: Date.now() };
        break;
      case 'Away':
        if (me() && names(m.username).includes(me()) && !awaySince) awaySince = Date.now();
        break;
      case 'Back':
        if (me() && names(m.username).includes(me())) awaySince = null;
        break;
      default:
    }
  }
  function onOutbound(text) {
    if (typeof text !== 'string' || text.length > 4096 || text.indexOf('"action"') === -1) return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.action === 'Join pool') lastPool = { formatCode: codeOf(m), isMatch: m.type === 'm' };
    else if (m.action === 'Host duel') lastHost = { formatCode: codeOf(m), isMatch: m.type === 'm' };
    if ((m.action === 'Join pool' || m.action === 'Host duel' || m.action === 'Join duel') && m.deck) deckInUse = Number(m.deck) || null;
  }
  (function hookWebSocket() {
    try {
      const Native = window.WebSocket;
      window.WebSocket = new Proxy(Native, {
        construct(target, args) {
          const ws = Reflect.construct(target, args);
          try { ws.addEventListener('message', (e) => onInbound(e.data)); } catch { /* ignore */ }
          return ws;
        },
      });
      const send = Native.prototype.send;
      Native.prototype.send = function (data) {
        try { onOutbound(data); } catch { /* never break the site */ }
        return send.call(this, data);
      };
    } catch (e) { if (debug()) console.warn('[dbrpc] WebSocket hook failed', e); }
  })();
  // Local input is a stronger "not AFK" signal than waiting for the server's Back broadcast.
  const notAway = () => { awaySince = null; };
  for (const evt of ['mousedown', 'keydown', 'touchstart']) window.addEventListener(evt, notAway, { capture: true, passive: true });

  // ---------------- players ----------------
  function players() {
    const p1 = g('player1'), p2 = g('player2');
    const n1 = p1 && str(p1.username), n2 = p2 && str(p2.username);
    if (!n1 || !n2) return {};
    const lp1 = num(p1.lifepoints), lp2 = num(p2.lifepoints);
    return { players: [n1, n2], lp: lp1 !== undefined && lp2 !== undefined ? [lp1, lp2] : undefined };
  }

  // ---------------- duel ----------------
  // Verified against a captured best-of-3 (captures/dbcap-2026-09-13T01-41-36-811Z.json):
  //   match start : inbound 'Accept user' → startDuel(): duel_active=true, duelist=true, duelId, match=(type=='m'), rated
  //   game ends   : 'Admit defeat' {over:false} → 'Siding with cards' → currentLabel='siding', games += 1
  //   next game   : 'Begin next duel' → tp_start* → duel_start*
  //   match ends  : 'Admit defeat' {over:true} → duel_active=false (result screen stays up until 'Quit duel')
  //   duel_active stays true through siding and opponent disconnect/rejoin. `games` = games completed so far.
  const duel = { id: null, formatCode: undefined };
  const storeKey = (id) => `dbrpc.duel.${id}`;
  function rememberStart(id) {
    try { const v = Number(sessionStorage.getItem(storeKey(id))); if (v > 0) return v; } catch { /* ignore */ }
    const now = Date.now();
    try { sessionStorage.setItem(storeKey(id), String(now)); } catch { /* ignore */ }
    return now;
  }
  function gameInfo() {
    const isMatch = g('match') === true;
    const id = currentDuelId();
    const games = Number(g('games')) || 0;
    const sr = series && series.duelId === id ? series : null;
    const b = bo3 && bo3.duelId === id ? bo3 : null;
    let seriesCompleted = games;
    let seriesScore;
    if (sr) {
      const synced = sr.w + sr.l + sr.d;
      seriesCompleted = Math.max(games, synced + Math.max(games - sr.gamesAtSync, sr.pendingW + sr.pendingL));
      seriesScore = [sr.w + sr.pendingW, sr.l + sr.pendingL, sr.d];
    }
    const info = { of: isMatch ? 3 : 1, siding: g('currentLabel') === 'siding', seriesGame: seriesCompleted + 1, seriesScore };
    if (b) { info.game = b.w + b.l + b.d + 1; info.score = [b.w, b.l, b.d]; }
    else if (!isMatch || !sr) { info.game = seriesCompleted + 1; info.score = seriesScore; }
    // else: a match joined in progress → game/score unknown; the server shows the series count
    const turn = Number(g('turnCount'));
    if (turn > 0 && !info.siding) info.turn = turn;
    return info;
  }
  // Per-game timer: one start time per (duel, series game, siding-or-not), kept in sessionStorage across reloads.
  const phaseClock = { key: null, startedAt: null };
  function phaseStart(id, info) {
    const key = `${id}:${info.seriesGame}:${info.siding ? 's' : 'g'}`;
    if (key !== phaseClock.key) { phaseClock.key = key; phaseClock.startedAt = rememberStart(key); }
    return phaseClock.startedAt;
  }
  function duelState() {
    const id = Number(g('duelId')) || 0;
    const over = series && series.duelId === id && series.over === true; // final concession lands ~0.5 s before duel_active drops
    if (g('duel_active') !== true || !id || g('duelist') !== true || over) { duel.id = null; duel.formatCode = undefined; if (!id) { series = null; bo3 = null; phaseClock.key = null; lastCard = null; watchers.clear(); } return null; }
    if (id !== duel.id) { duel.id = id; duel.formatCode = undefined; }
    if (!duel.formatCode) {
      const fromSocket = matchStarts.get(String(id));
      const data = g('deckData'); // the same message, while the site still holds it
      const code = codeOf({ format: g('duelFormat') }) || (fromSocket && fromSocket.formatCode) || (data && Number(data.id) === id ? codeOf(data) : undefined); // duelFormat: set by startDuel()
      if (code) duel.formatCode = code;
    }
    const info = gameInfo();
    const deck = deckInUse ? deckName(deckInUse) : undefined;
    return Object.assign({ kind: 'duel', formatCode: duel.formatCode, rated: g('rated') === true, startedAt: phaseStart(id, info), deck, lastCard: recentCard(), watchers: watchers.size || undefined }, info, players());
  }

  // Solo mode ("test hands"): hosted with format 'so'; startDuel() sets solo=true. Keyed on that global and the
  // duel screen only, since solo skips parts of the normal duel bookkeeping (no opponent, no duel id to rely on).
  const soloClock = { startedAt: null };
  function soloState() {
    if (g('solo') !== true) { if (soloClock.startedAt) lastCard = null; soloClock.startedAt = null; return null; }
    const onDuelScreen = DUEL_FRAMES.has(g('currentLabel')) || isVisible(document.getElementById('duel'));
    if (!onDuelScreen) { soloClock.startedAt = null; return null; }
    if (!soloClock.startedAt) soloClock.startedAt = Date.now();
    const turn = Number(g('turnCount'));
    const deck = deckInUse ? deckName(deckInUse) : undefined;
    return { kind: 'solo', deck, turn: turn > 0 ? turn : undefined, startedAt: soloClock.startedAt, lastCard: recentCard() };
  }

  // Shown for 30 s after a match ends — yours (Won/Lost) or one you're watching (who won).
  function resultState() {
    if (!result || Date.now() > result.until) { result = null; return null; }
    if (currentDuelId() !== 0 && g('duel_active') === true) return null; // a rematch already started
    return { kind: 'result', won: result.won, winner: result.winner, score: result.score, players: result.players, formatCode: result.formatCode, startedAt: result.until - 30000 };
  }

  // ---------------- watching (best effort — not in the capture yet) ----------------
  const watch = { key: null };
  function watchingState() {
    if (g('duelist') === true) return null;
    let watching = DUEL_FRAMES.has(g('currentLabel')) || isVisible(document.getElementById('duel'));
    try { if (typeof window.isWatching === 'function') watching = watching || window.isWatching() === true; } catch { /* ignore */ }
    if (!watching) { if (watch.key) { series = null; bo3 = null; phaseClock.key = null; watchers.clear(); } watch.key = null; return null; }
    if (result && Date.now() < result.until && g('duel_active') !== true) return null; // match decided → the result card takes over
    const p = players();
    const id = currentDuelId();
    watch.key = `${id}:${p.players ? p.players.join('|') : ''}`;
    const info = watchInfo && Date.now() - watchInfo.at < 3 * 3600e3 ? watchInfo : null;
    const gi = gameInfo();
    return Object.assign({ kind: 'watching', formatCode: info ? info.formatCode : undefined, rated: info ? info.rated : undefined, startedAt: phaseStart(id || watch.key, gi), watchers: watchers.size || undefined }, gi, p);
  }

  // ---------------- deck editor ----------------
  function deckState() {
    const inEditor = g('currentLabel') === 'deck_constructor' || isVisible(document.getElementById('deck_constructor'));
    if (!inEditor) return null;
    let name;
    try {
      const sel = document.getElementById('decklist_cb'); // native <select>, opacity:0 under the custom UI, moved between screens by main.js
      name = sel && sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.trim() : '';
    } catch { name = ''; }
    if (!name && typeof g('deckName') === 'string') name = g('deckName').trim();
    return { kind: 'deck', deckName: name || undefined };
  }

  // ---------------- browsing (anything else while logged in) ----------------
  function browsingState() {
    const label = str(g('currentLabel')) || '';
    if (NOT_LOGGED_IN.has(label) || !me()) return null;
    const s = { kind: 'browsing', screen: label };
    if (g('inPool') === true) s.pool = lastPool || {};
    else if (g('hosting') === true) s.hosting = lastHost || {};
    return s;
  }

  function computeState() {
    try {
      const live = soloState() || duelState() || watchingState() || resultState();
      if (live) return live;
      const s = deckState() || browsingState() || { kind: 'none' };
      if (s.kind !== 'none' && awaySince) { s.away = true; s.awaySince = awaySince; }
      return s;
    } catch (e) { if (debug()) console.warn('[dbrpc] state error', e); return { kind: 'none' }; }
  }

  // ---------------- transport ----------------
  let lastJson = null;
  let lastSentAt = 0;
  let lastWarnAt = 0;
  async function post(payload, { force = false } = {}) {
    const json = JSON.stringify(payload);
    const now = Date.now();
    const unchanged = json === lastJson;
    if (!force && unchanged && (payload.kind === 'none' || now - lastSentAt < HEARTBEAT_MS)) return;
    if (!unchanged && debug()) console.info('[dbrpc] →', payload);
    lastJson = json;
    lastSentAt = now;
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'text/plain' }, body: json, keepalive: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastJson = null; // retry on next tick
      if (now - lastWarnAt > 60000) {
        lastWarnAt = now;
        console.warn(`[dbrpc] local service unreachable at ${ENDPOINT} (${e && e.message}). Is the launchd agent running? (npm run status)`);
      }
    }
  }

  // Moving between lobby screens (main menu → duel room → a profile …) is noise to friends: a new
  // browsing screen only replaces a previous browsing screen once it has held for BROWSING_SETTLE_MS.
  // Anything live (duel, watching, deck editor, leaving/entering the lobby) still switches at once.
  let stable = null;  // { json, state } last state reported
  let pending = null; // { json, state, since } candidate browsing screen waiting to settle
  function settle(s) {
    const json = JSON.stringify(s);
    if (stable && json === stable.json) { pending = null; return s; }
    const transient = (x) => x.kind === 'browsing' && !x.pool && !x.hosting; // waiting for an opponent is deliberate, not passing through
    if (stable && transient(stable.state) && transient(s)) {
      if (!pending || pending.json !== json) pending = { json, state: s, since: Date.now() };
      if (Date.now() - pending.since < BROWSING_SETTLE_MS) return stable.state;
    }
    pending = null;
    stable = { json, state: s };
    return s;
  }

  // Who you are on DuelingBook: username for the hover text, profile picture as the card's small badge.
  // Same rule as the site's getAvatarStart(): a number under 20000 is card artwork (card-pics/), anything
  // else is an upload (profile-pics/, .gif served from the www host). Getting this wrong shows a stranger.
  function avatarUrl(pic) {
    if (typeof pic !== 'string' || !pic) return undefined;
    if (pic.indexOf('http') !== -1) return /^https:\/\/(images|www)\.duelingbook\.com\//.test(pic) ? pic : undefined;
    const n = parseInt(pic.slice(0, pic.indexOf('.')), 10);
    const base = n < 20000 ? str(g('CARD_IMAGES_START')) : str(g('PROFILE_PIC_START'));
    if (!base) return undefined;
    let url = base + pic;
    if (url.includes('.gif')) url = url.replace('images.duelingbook.com', 'www.duelingbook.com/images');
    return url;
  }
  function identity() {
    const out = {};
    const name = me();
    if (name) out.me = name;
    const avatar = avatarUrl(g('default_pic'));
    if (avatar) out.avatar = avatar;
    return out;
  }

  function tick() {
    const s = settle(computeState());
    post(Object.assign({ v: 1, source: `userscript@${VERSION}` }, s.kind === 'none' ? s : Object.assign(identity(), s)));
    return s;
  }

  window.__dbrpc = { version: VERSION, state: computeState, tick, endpoint: ENDPOINT };

  const start = () => {
    setInterval(tick, POLL_MS);
    tick();
    window.addEventListener('pagehide', () => {
      try { navigator.sendBeacon(ENDPOINT, JSON.stringify({ v: 1, kind: 'none', source: `userscript@${VERSION}/pagehide` })); } catch { /* ignore */ }
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
