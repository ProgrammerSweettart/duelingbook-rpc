#!/usr/bin/env node
'use strict';
// Smoke test against the REAL Discord desktop client: connects with config.json's clientId,
// shows the deck-editor presence for 15 s, then a duel presence with a running timer for 15 s,
// then clears. Watch your own profile in Discord while it runs.
//   npm run smoke
const path = require('node:path');
const { execSync } = require('node:child_process');
const { DiscordPresence } = require('../lib/discord');
const { toActivity, normalizeState } = require('../lib/presence');

if (process.platform === 'darwin' && !process.env.TMPDIR) process.env.TMPDIR = execSync('getconf DARWIN_USER_TEMP_DIR', { encoding: 'utf8' }).trim();
const cfg = require(path.join(__dirname, '..', 'config.json'));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const d = new DiscordPresence({ clientId: String(cfg.clientId), log });
  d.start();
  const t = Date.now();
  while (d.status !== 'connected') {
    if (d.status === 'no-client-id' || d.status === 'invalid-client-id') { log(`cannot continue: ${d.status}`); process.exit(2); }
    if (Date.now() - t > 20000) { log(`Discord not reachable after 20 s (status: ${d.status}). Is the desktop app running and logged in?`); await d.stop(); process.exit(1); }
    await sleep(200);
  }
  log('1/3 deck editor presence (15 s) — check your profile card in Discord');
  d.setActivity(toActivity(normalizeState({ kind: 'deck', deckName: 'Smoke Test Deck' }), cfg));
  await sleep(15000);
  log('2/3 duel presence with elapsed timer (15 s) — the timer should be counting up from ~3:00');
  d.setActivity(toActivity(normalizeState({ kind: 'duel', formatCode: 'gr', game: 2, of: 3, startedAt: Date.now() - 3 * 60e3 }), cfg));
  await sleep(15000);
  log('3/3 clearing');
  d.setActivity(null);
  await sleep(5000);
  await d.stop();
  log('done');
  process.exit(0);
})();
