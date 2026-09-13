'use strict';
// Replays a db-capture JSON through the real userscript (userscripts/db-presence.user.js) in a vm
// sandbox: socket messages go through the hooked WebSocket, global changes are applied to the fake
// window, and the sequence of computed states is checked. Skips if no capture is present.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const capDir = path.join(__dirname, '..', 'captures');
const capture = fs.existsSync(capDir) ? fs.readdirSync(capDir).filter((f) => /^dbcap-.*\.json$/.test(f)).sort().pop() : null;

function loadUserscript() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'userscripts', 'db-presence.user.js'), 'utf8');
  const els = {};
  class FakeWS {
    constructor(url) { this.url = url; this.listeners = {}; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    emit(data) { for (const f of this.listeners.message || []) f({ data }); }
    send() {} // patched by the userscript's outbound hook
  }
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  let clock = 0;
  const win = {
    Date: class extends Date { static now() { return clock; } }, // the userscript only calls Date.now()
    setClock: (t) => { clock = t; },
    document: { readyState: 'complete', getElementById: (id) => els[id] || null, addEventListener() {} },
    location: { href: 'https://www.duelingbook.com/' },
    navigator: { sendBeacon() {} },
    localStorage: storage, sessionStorage: storage,
    fetch: async (url, opts) => { win.__lastPost = JSON.parse(opts.body); return { ok: true }; }, // what the service would receive
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    addEventListener() {}, console,
    WebSocket: FakeWS,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(src, win);
  return { win, els };
}

test('replays the captured match through the userscript', { skip: !capture && 'no captures/dbcap-*.json' }, () => {
  const { events } = JSON.parse(fs.readFileSync(path.join(capDir, capture), 'utf8'));
  const { win, els } = loadUserscript();
  const ws = new win.WebSocket('wss://duel.duelingbook.com:8443/'); // goes through the hook
  const transitions = [];
  let last = null;
  const iso = (t) => new Date(t).toISOString().slice(11, 19);
  const step = (t) => {
    win.setClock(t);
    const s = win.__dbrpc.tick(); // what would actually be posted (after browsing settle)
    const key = JSON.stringify(s);
    if (key !== last) { last = key; transitions.push(Object.assign({ at: iso(t) }, s)); }
  };
  // Apply events, but sample the state the way the userscript does (a poll, not per-event): only
  // after all events that landed within the same few ms of site-side work have been applied.
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const next = events[i + 1];
    const sampleAfter = !next || next.t - e.t > 500; // a 1 s poll sees the site only once its handlers have settled
    switch (e.type) {
      case 'globals': Object.assign(win, e.primitives); break;
      case 'globals-diff': for (const [k, v] of Object.entries(e.changed)) { if (v.to === '[deleted]') delete win[k]; else win[k] = v.to; } break;
      case 'duel':
        if ('deckData' in e.snap) win.deckData = e.snap.deckData && typeof e.snap.deckData === 'object' ? e.snap.deckData : undefined;
        for (const k of ['player1', 'player2']) if (e.snap[k] && typeof e.snap[k] === 'object') win[k] = { username: e.snap[k].username, lifepoints: e.snap[k].lifepoints };
        break;
      case 'screen': win.currentLabel = e.currentLabel; els.decklist_cb = { selectedOptions: e.deckName ? [{ textContent: e.deckName }] : [] }; break;
      case 'ws-in':
        // mirror how main.js maintains window.decks: the login list, then single-deck responses upsert by id
        if (e.json && e.json.action === 'Connected' && Array.isArray(e.json.decks)) win.decks = e.json.decks.map((d) => ({ id: d.id, label: d.name }));
        if (e.json && e.json.action === 'Load decks' && e.json.id && e.json.name) win.decks = (win.decks || []).filter((d) => d.id !== e.json.id).concat([{ id: e.json.id, label: e.json.name }]);
        if (e.json) ws.emit(JSON.stringify(e.json)); else if (e.raw) ws.emit(e.raw);
        break;
      case 'ws-out': if (e.json) ws.send(JSON.stringify(e.json)); break;
      default: break;
    }
    win.setClock(e.t);
    if (sampleAfter) step(e.t);
  }
  // eslint-disable-next-line no-console
  console.log('  transitions:\n' + transitions.map((t) => '    ' + JSON.stringify(t)).join('\n'));

  const duels = transitions.filter((t) => t.kind === 'duel');
  const decks = transitions.filter((t) => t.kind === 'deck');
  const browsing = transitions.filter((t) => t.kind === 'browsing');
  assert.ok(browsing.some((b) => b.screen === 'main_menu') && browsing.some((b) => b.screen === 'duel_room'), 'browsing states for lobby screens');
  assert.ok(!browsing.some((b) => b.screen === 'profile_viewer' && b.at >= '01:57:30' && b.at < '01:57:45'), 'the 4-second pass through a profile at 01:57:32 is never reported');
  assert.ok(browsing.some((b) => b.pool && b.pool.formatCode === 'ar' && b.pool.isMatch), 'pool wait state with format from the outbound Join pool');
  assert.ok(browsing.some((b) => b.hosting && b.hosting.formatCode === 'uu' && b.hosting.isMatch), 'hosting wait state with format from the outbound Host duel');
  // spectating (second capture): series score from 'Watch duel', concessions applied between syncs
  const watching = transitions.filter((t) => t.kind === 'watching');
  assert.ok(watching.length > 0, 'watching states present');
  assert.ok(watching.every((w) => w.formatCode), 'watch format always known (from the Watch duel response)');
  // the capture snapshots player objects ~50 ms after 'Watch duel' (the site fills them synchronously), so allow one nameless sample per join
  for (let i = 0; i < watching.length; i++) if (!watching[i].players) assert.ok(watching[i + 1] && watching[i + 1].players && watching[i + 1].at <= watching[i].at.replace(/\d\d$/, (ss) => String(+ss + 5).padStart(2, '0')), `players known within seconds of joining at ${watching[i].at}`);
  // joined a series past its first best-of-3 → only the series is known
  const w3 = watching.find((w) => w.at >= '01:57:36' && w.at < '01:58:00');
  assert.equal(w3.game, undefined); assert.equal(String(w3.seriesScore), '0,2,0'); assert.equal(w3.seriesGame, 3);
  // first witnessed siding → exact best-of-3 from then on ("(0-1-0)" in the siding text at 02:03:10)
  const w2s = watching.find((w) => w.at >= '02:03:10' && w.siding);
  assert.equal(String(w2s.score), '0,1,0'); assert.equal(w2s.game, 2);
  // rejoined at series 0-3; GalaxiaxD's concession at 02:06:17 → bo3 text "(1-1-0)" → siding for game 3 of 3
  const w5s = watching.find((w) => w.at >= '02:06:17' && w.siding);
  assert.equal(String(w5s.score), '1,1,0'); assert.equal(w5s.game, 3); assert.equal(String(w5s.seriesScore), '1,3,0', 'series moved provisionally by the concession');
  // final concession then 'Back to RPS' (1-4-0): a fresh best-of-3, series game 6
  const w6 = watching.filter((w) => w.at >= '02:13:03').pop();
  assert.equal(w6.game, 1); assert.equal(String(w6.score), '0,0,0'); assert.equal(w6.seriesGame, 6); assert.equal(String(w6.seriesScore), '1,4,0');
  assert.ok(watching.some((w) => w.turn > 1), 'turn counter present while watching');
  assert.ok(!transitions.some((t) => t.away), 'never AFK in this capture');
  assert.ok(duels.filter((d) => d.players).every((d) => d.players[0] === 'Sweettart'), 'player1 is always me');
  assert.ok(duels.some((d) => d.lp && d.lp[0] !== d.lp[1]), 'life points tracked');
  assert.ok(decks.some((d) => d.deckName === '!Solder was here'), 'deck editor with a real deck name');
  // match 1: Advanced rated, quit during game 1
  const m1 = duels.filter((d) => d.startedAt === duels[0].startedAt);
  assert.equal(m1[0].formatCode, 'ar');
  assert.equal(m1[0].rated, true);
  assert.deepEqual([m1[0].game, m1[0].of, m1[0].siding], [1, 3, false]);
  assert.ok(m1.every((d) => d.formatCode === 'ar'), 'format never blanks during match 1');
  // match 2: Unlimited unrated, game 1 → siding → game 2 → over
  const m2 = duels.filter((d) => d.startedAt !== duels[0].startedAt);
  assert.ok(m2.length >= 3, 'match 2 has game1/siding/game2 states');
  assert.ok(m2.every((d) => d.formatCode === 'uu' && d.rated === false && d.of === 3), 'match 2 facts stable');
  const phases = m2.map((d) => `${d.game}${d.siding ? 's' : ''}`).filter((v, i, a) => v !== a[i - 1]);
  assert.deepEqual(phases, ['1', '2s', '2'], 'game 1 → siding for game 2 → game 2');
  assert.equal(String(m2.find((d) => d.siding).score), '0,1,0', 'my concession shows as a loss before Begin next duel confirms it');
  assert.equal(String(m2[m2.length - 1].lp), '4300,6000', 'life points at the end of game 2'); // String(): the array comes from the vm realm
  assert.equal(m2[m2.length - 1].deck, 'Paleo Frog', 'deck in use from the outbound Host duel');
  assert.ok(m2.some((d) => d.turn === 4), 'turn counter');
  win.__dbrpc.tick();
  assert.equal(win.__lastPost.me, 'Sweettart');
  assert.equal(win.__lastPost.avatar, 'https://images.duelingbook.com/card-pics/15902.jpg', 'pic 15902.jpg resolves to card art, as getAvatarStart() does');
  assert.equal(new Set(m2.map((d) => d.startedAt)).size, 3, 'per-phase timer: game 1, siding, game 2');
  // card art: only my own public plays, never a set. In the capture I Normal Summoned Swap Frog (4137) and Set ST several times.
  const withCard = m2.filter((d) => d.lastCard);
  assert.ok(withCard.length > 0, 'a face-up play of mine shows as the card art');
  assert.ok(withCard.some((d) => d.lastCard.name === 'Swap Frog' && d.lastCard.id === 4137));
  const setIds = new Set(events.filter((e) => e.type === 'ws-in' && e.json && e.json.action === 'Duel' && /^Set /.test(e.json.play) && e.json.username === 'Sweettart').map((e) => e.json.id));
  assert.ok(setIds.size > 0 && !withCard.some((d) => setIds.has(d.lastCard.id)), 'nothing I set face-down ever becomes the art');
  const drawn = events.filter((e) => e.type === 'ws-in' && e.json && e.json.action === 'Duel' && (e.json.play === 'Draw card' || e.json.play === 'To hand') && e.json.username === 'Sweettart' && e.json.card).map((e) => e.json.card.id);
  const shownIds = new Set(withCard.map((d) => d.lastCard.id));
  const summoned = new Set(events.filter((e) => e.type === 'ws-in' && e.json && e.json.action === 'Duel' && ['Normal Summon', 'SS ATK', 'SS DEF', 'Activate ST', 'To ST', 'OL ATK', 'OL DEF', 'Declare'].includes(e.json.play) && e.json.username === 'Sweettart' && e.json.card).map((e) => e.json.card.id));
  for (const id of shownIds) assert.ok(summoned.has(id), `card ${id} shown only because of a public play`);
  assert.ok(watching.some((w) => w.watchers >= 1), 'spectator count while watching');
  // J's Back conceded the deciding game at 02:12:57 while I watched → result card naming the winner, gone once Back to RPS restarts the duel
  const wres = transitions.find((t) => t.kind === 'result' && t.winner);
  assert.ok(wres && wres.at >= '02:12:57' && wres.at < '02:13:03', 'spectator result card right after the final concession');
  assert.equal(wres.winner, 'GalaxiaxD');
  assert.equal(wres.score, undefined, 'rejoined mid-best-of-3 with no siding witnessed → no score to claim');
  assert.equal(transitions[transitions.indexOf(wres) + 1].kind, 'watching', 'back to watching on the rematch');
  const res = transitions.find((t) => t.kind === 'result');
  assert.ok(res && res.at >= '01:40:49' && res.at < '01:41:01', 'result card right after the final concession');
  assert.equal(res.won, false); assert.equal(String(res.score), '0,2,0');

  // after the final Admit defeat {over:true} the duel state ends (result screen → browsing 'Match over'), before Quit duel
  const lastDuelIdx = transitions.lastIndexOf(m2[m2.length - 1]);
  assert.notEqual(transitions[lastDuelIdx + 1].kind, 'duel');
  assert.ok(transitions[lastDuelIdx + 1].at < '01:41:01', 'duel ended at match end (01:40:50), not at Quit duel (01:41:01)');
});
