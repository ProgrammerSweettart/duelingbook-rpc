'use strict';
// Integration test of lib/discord.js against the fake IPC server (test/fake-discord.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DiscordPresence } = require('../lib/discord');
const fake = require('./fake-discord');

// Isolate the socket dir so we never touch a real Discord instance.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrpc-'));
process.env.TMPDIR = dir;
delete process.env.XDG_RUNTIME_DIR;

const GOOD = '123456789012345678';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

test('connects, applies latest desired activity once, coalesces bursts, clears', async () => {
  const srv = await fake.start({ acceptClientIds: [GOOD] });
  const logs = [];
  const d = new DiscordPresence({ clientId: GOOD, log: (m) => logs.push(m), minUpdateMs: 4000 });
  try {
    d.setActivity({ type: 0, details: 'Deck Editor', state: 'Editing: A' }); // before connect → applied on ready
    d.start();
    await until(() => srv.activities.length === 1);
    assert.equal(d.status, 'connected');
    assert.equal(srv.activities[0].activity.details, 'Deck Editor');
    assert.equal(srv.activities[0].activity.type, 0);
    // burst of 3 changes inside the throttle window → exactly one more SET_ACTIVITY, with the last value
    d.setActivity({ type: 0, details: 'Deck Editor', state: 'Editing: B' });
    d.setActivity({ type: 0, details: 'Deck Editor', state: 'Editing: C' });
    d.setActivity({ type: 0, details: 'Dueling · Goat Format', state: 'Game 1 of 3', startTimestamp: 1700000000000 });
    await sleep(4300);
    assert.equal(srv.activities.length, 2);
    assert.equal(srv.activities[1].activity.state, 'Game 1 of 3');
    assert.equal(srv.activities[1].activity.timestamps.start, 1700000000000);
    // identical desired state → no extra call
    d.setActivity({ type: 0, details: 'Dueling · Goat Format', state: 'Game 1 of 3', startTimestamp: 1700000000000 });
    await sleep(4300);
    assert.equal(srv.activities.length, 2);
    // clear
    d.setActivity(null);
    await until(() => srv.activities.length === 3, 6000);
    assert.equal(srv.activities[2].activity, null);
  } finally {
    await d.stop();
    await srv.close();
  }
});

test('a headline change jumps the queue; a routine change waits', async () => {
  const srv = await fake.start({ acceptClientIds: [GOOD] });
  const d = new DiscordPresence({ clientId: GOOD, log: () => {}, minUpdateMs: 8000 });
  try {
    d.setActivity({ type: 0, details: 'Browsing', state: 'Main menu' });
    d.start();
    await until(() => srv.activities.length === 1);
    d.setActivity({ type: 0, details: 'Browsing', state: 'Duel room' }); // routine: same headline → waits the full window
    await sleep(4500);
    assert.equal(srv.activities.length, 1);
    d.setActivity({ type: 0, details: 'Dueling · Unlimited · Game 1 of 3', state: 'Me vs Them' }); // urgent: reschedules to the 4 s floor (already elapsed)
    await until(() => srv.activities.length === 2, 1500);
    assert.equal(srv.activities[1].activity.details, 'Dueling · Unlimited · Game 1 of 3');
  } finally {
    await d.stop();
    await srv.close();
  }
});

test('diagnoses Invalid Client ID (close 4000) instead of a generic timeout', async () => {
  const srv = await fake.start({ acceptClientIds: [GOOD] });
  const logs = [];
  const d = new DiscordPresence({ clientId: '999999999999999999', log: (m) => logs.push(m) });
  try {
    d.start();
    await until(() => d.status === 'invalid-client-id', 12000);
    assert.match(logs.join('\n'), /rejected the client ID "999999999999999999"/);
  } finally {
    await d.stop();
    await srv.close();
  }
});

test('reconnects after Discord goes away and comes back, re-applying presence', async () => {
  let srv = await fake.start({ acceptClientIds: [GOOD] });
  const d = new DiscordPresence({ clientId: GOOD, log: () => {}, minUpdateMs: 4000 });
  try {
    d.setActivity({ type: 0, details: 'Deck Editor', state: 'Editing: X' });
    d.start();
    await until(() => srv.activities.length === 1);
    await srv.close(); // Discord quits
    await until(() => d.status !== 'connected', 3000);
    srv = await fake.start({ acceptClientIds: [GOOD] }); // Discord relaunched
    await until(() => srv.activities.length === 1, 12000); // presence re-applied on the new connection
    assert.equal(d.status, 'connected');
    assert.equal(srv.activities[0].activity.state, 'Editing: X');
  } finally {
    await d.stop();
    await srv.close();
  }
});

test('no client ID configured → does not attempt to connect', async () => {
  const logs = [];
  const d = new DiscordPresence({ clientId: 'REPLACE_WITH_DISCORD_APPLICATION_ID', log: (m) => logs.push(m) });
  d.start();
  await sleep(50);
  assert.equal(d.status, 'no-client-id');
  assert.match(logs[0], /no Discord client ID configured/);
  await d.stop();
});
