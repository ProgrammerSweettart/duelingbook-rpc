'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeState, toActivity, formatFromCode } = require('../lib/presence');

test('format codes map to names and rated flag', () => {
  assert.deepEqual(formatFromCode('gr'), { name: 'Goat Format', rated: true });
  assert.deepEqual(formatFromCode('eu'), { name: 'Edison Format', rated: false });
  assert.deepEqual(formatFromCode('ar'), { name: 'Advanced', rated: true });
  assert.deepEqual(formatFromCode('yu'), { name: 'Genesys Format', rated: false });
  assert.equal(formatFromCode('zz'), null);
  assert.equal(formatFromCode(undefined), null);
});

test('deck editor activity', () => {
  const a = toActivity(normalizeState({ v: 1, kind: 'deck', deckName: '  Chaos   Turbo ' }), { largeImageKey: 'duelingbook', largeImageText: 'DuelingBook' });
  assert.equal(a.type, 0);
  assert.equal(a.details, 'Deck Editor');
  assert.equal(a.state, 'Editing: Chaos Turbo');
  assert.equal(a.largeImageKey, 'duelingbook');
  assert.equal(a.startTimestamp, undefined);
  assert.equal(toActivity(normalizeState({ kind: 'deck' })).state, 'Building a deck');
});

test('duel activity: format, game N of M, elapsed timer', () => {
  const started = Date.now() - 5 * 60e3;
  const a = toActivity(normalizeState({ kind: 'duel', formatCode: 'gr', game: 2, of: 3, startedAt: started }));
  assert.equal(a.type, 0);
  assert.equal(a.details, 'Dueling · Goat Format (Rated) · Game 2 of 3');
  assert.equal(a.state, 'In a duel'); // no players known yet
  assert.equal(a.startTimestamp, started);
  // explicit formatName wins over code; single game; players without life points
  const b = toActivity(normalizeState({ kind: 'duel', formatName: 'Edison Format', formatCode: 'gr', rated: false, of: 1, players: ['Me', 'Them'] }));
  assert.equal(b.details, 'Dueling · Edison Format · Single game');
  assert.equal(b.state, 'Me vs Them');
  assert.equal(b.startTimestamp, undefined);
  // siding between games of a match, with players and life points
  const c = toActivity(normalizeState({ kind: 'duel', formatCode: 'uu', game: 2, of: 3, siding: true, players: ['Sweettart', 'GalaxiaxD'], lp: [6500, 6000] }));
  assert.equal(c.details, 'Dueling · Unlimited · Siding for game 2 of 3');
  assert.equal(c.state, 'Sweettart (6500) vs GalaxiaxD (6000)');
});

test('watching, browsing, pool/hosting, AFK', () => {
  const w = toActivity(normalizeState({ kind: 'watching', formatCode: 'gr', game: 1, of: 3, players: ['A', 'B'], lp: [8000, 3200], startedAt: Date.now() - 5000 }));
  assert.equal(w.details, 'Watching · Goat Format (Rated) · Game 1 of 3');
  assert.equal(w.state, 'A (8000) vs B (3200)');
  assert.ok(w.startTimestamp);
  const b = toActivity(normalizeState({ kind: 'browsing', screen: 'rankings' }));
  assert.deepEqual([b.details, b.state], ['Browsing', 'Rankings']);
  assert.deepEqual(toActivity(normalizeState({ kind: 'browsing', screen: 'duel_start2' })).state, 'Match over');
  const pool = toActivity(normalizeState({ kind: 'browsing', screen: 'duel_room', pool: { formatCode: 'ar', isMatch: true } }));
  assert.deepEqual([pool.details, pool.state], ['Looking for a duel', 'Advanced (Rated) · Best of 3']);
  const host = toActivity(normalizeState({ kind: 'browsing', screen: 'duel_room', hosting: { formatCode: 'uu', isMatch: false } }));
  assert.deepEqual([host.details, host.state], ['Hosting a duel', 'Unlimited · Single game']);
  const since = Date.now() - 120000;
  const afk = toActivity(normalizeState({ kind: 'deck', deckName: 'Paleo Frog', away: true, awaySince: since }));
  assert.deepEqual([afk.details, afk.state, afk.startTimestamp], ['AFK · Deck Editor', 'Editing: Paleo Frog', since]);
  // AFK never wraps a live duel (the userscript doesn't send it, and the server ignores it if it did)
  const d = toActivity(normalizeState({ kind: 'duel', formatCode: 'uu', game: 1, of: 1, away: true }));
  assert.equal(d.details, 'Dueling · Unlimited · Single game');
});

test('best-of-3 score, series fallback, turn, result card', () => {
  const lab = (b) => toActivity(normalizeState(b)).details;
  assert.equal(lab({ kind: 'duel', formatCode: 'uu', game: 2, of: 3, score: [0, 1, 0] }), 'Dueling · Unlimited · Game 2 of 3 · 0-1');
  assert.equal(lab({ kind: 'duel', formatCode: 'uu', game: 2, of: 3, siding: true, score: [1, 0, 0] }), 'Dueling · Unlimited · Siding for game 2 of 3 · 1-0');
  assert.equal(lab({ kind: 'duel', formatCode: 'uu', game: 1, of: 3, score: [0, 0, 0], turn: 3 }), 'Dueling · Unlimited · Game 1 of 3 · Turn 3');
  assert.equal(lab({ kind: 'watching', formatCode: 'uu', of: 3, seriesGame: 7, seriesScore: [1, 5, 0], turn: 4 }), 'Watching · Unlimited · Series game 7 · 1-5 · Turn 4');
  assert.equal(lab({ kind: 'watching', formatCode: 'uu', of: 3, seriesGame: 8, seriesScore: [1, 6, 0], siding: true }), 'Watching · Unlimited · Siding for series game 8 · 1-6');
  assert.equal(lab({ kind: 'duel', formatCode: 'gu', of: 1, seriesGame: 2, seriesScore: [1, 0, 1] }), 'Dueling · Goat Format · Game 2 · 1-0-1');
  assert.equal(lab({ kind: 'result', won: false, score: [0, 2, 0], formatCode: 'uu' }), 'Match over · Unlimited · Lost 0-2');
  assert.equal(lab({ kind: 'result', won: true }), 'Match over · Won');
  assert.equal(lab({ kind: 'result', winner: 'GalaxiaxD', score: [2, 1, 0], formatCode: 'uu' }), 'Match over · Unlimited · GalaxiaxD won 2-1');
  assert.equal(normalizeState({ kind: 'duel', score: [1, 'x', 0] }).score, undefined);
  const hover = (b) => toActivity(normalizeState(b), { largeImageKey: 'art' }).largeImageText;
  assert.equal(hover({ kind: 'duel', deck: 'Paleo Frog', of: 3, lp: [8000, 6000] }), 'Paleo Frog · ahead on life points, act natural');
  assert.equal(hover({ kind: 'duel', of: 3, lp: [4000, 6000] }), "it's fine. it's fine. it's fine.");
  assert.equal(hover({ kind: 'duel', of: 3, siding: true, deck: 'Frogs' }), 'Frogs · consulting the side deck'); // 1-char deck names are dropped by clampText
  assert.equal(hover({ kind: 'watching', of: 3 }), 'backseat dueling');
  assert.equal(hover({ kind: 'result', won: true }), 'gg');
  assert.equal(hover({ kind: 'deck' }), 'counting to 40 again');
  assert.equal(hover({ kind: 'browsing', screen: 'duel_room', pool: { formatCode: 'ar' } }), 'waiting for a worthy opponent');
  assert.equal(hover({ kind: 'browsing', screen: 'main_menu', away: true }), 'went to touch grass');
});

test('identity: username on hover, DuelingBook-hosted avatar as the small badge', () => {
  const cfg = { largeImageKey: 'art', largeImageText: 'DuelingBook' };
  const a = toActivity(normalizeState({ kind: 'deck', deckName: 'X', me: 'Sweettart', avatar: 'https://images.duelingbook.com/card-pics/15902.jpg' }), cfg);
  assert.equal(a.largeImageText, 'counting to 40 again');
  assert.equal(a.smallImageKey, 'https://images.duelingbook.com/card-pics/15902.jpg');
  assert.equal(a.smallImageText, 'Sweettart');
  assert.equal(normalizeState({ kind: 'deck', avatar: 'https://www.duelingbook.com/images/profile-pics/98475.gif' }).avatar, 'https://www.duelingbook.com/images/profile-pics/98475.gif');
  assert.equal(normalizeState({ kind: 'deck', avatar: 'https://evil.example/x.jpg' }).avatar, undefined);
  assert.equal(normalizeState({ kind: 'deck', avatar: 'http://images.duelingbook.com/x.jpg' }).avatar, undefined);
  assert.equal(toActivity(normalizeState({ kind: 'deck', deckName: 'X' }), cfg).smallImageKey, undefined);
});

test('solo mode', () => {
  assert.deepEqual(formatFromCode('so'), { name: 'Solo mode', rated: false });
  const a = toActivity(normalizeState({ kind: 'solo', deck: 'Paleo Frog', turn: 3, startedAt: Date.now() - 1000 }), { largeImageKey: 'art' });
  assert.equal(a.details, 'Solo mode · Turn 3');
  assert.equal(a.state, 'Testing Paleo Frog');
  assert.equal(a.largeImageText, 'goldfishing');
  assert.ok(a.startTimestamp);
  assert.equal(toActivity(normalizeState({ kind: 'solo' })).state, 'Testing hands');
  assert.equal(toActivity(normalizeState({ kind: 'solo', deck: 'Paleo Frog (default)' })).state, 'Testing Paleo Frog');
  assert.equal(toActivity(normalizeState({ kind: 'deck', deckName: 'Paleo Frog (default)' })).state, 'Editing: Paleo Frog');
  const host = toActivity(normalizeState({ kind: 'browsing', screen: 'duel_room', hosting: { formatCode: 'so' } }));
  assert.equal(host.state, 'Solo mode · Single game');
});

test('last card as art, spectator count, member-list line', () => {
  const cfg = { largeImageKey: 'art' };
  const a = toActivity(normalizeState({ kind: 'duel', of: 3, lastCard: { id: 4137, name: 'Swap Frog' }, watchers: 2, players: ['Me', 'Them'], lp: [8000, 8000] }), cfg);
  assert.equal(a.largeImageKey, 'https://images.duelingbook.com/card-pics/4137.jpg');
  assert.equal(a.largeImageText, 'Swap Frog · the heart of the cards is still deciding');
  const ahead = toActivity(normalizeState({ kind: 'duel', of: 3, lastCard: { id: 1, name: 'Solemn Strike' }, deck: 'Paleo Frog', lp: [8000, 6000] }), cfg);
  assert.equal(ahead.largeImageText, 'Solemn Strike · ahead on life points, act natural');
  assert.equal(a.state, 'Me (8000) vs Them (8000) · 2 watching');
  assert.equal(a.statusDisplayType, 2);
  const b = toActivity(normalizeState({ kind: 'duel', of: 3, lastCard: { id: 'x' } }), cfg);
  assert.equal(b.largeImageKey, 'art', 'bad card refs are ignored');
  assert.equal(toActivity(normalizeState({ kind: 'watching', of: 3, watchers: 3, players: ['A', 'B'] }), cfg).state, 'A vs B · 3 watching');
  assert.equal(toActivity(normalizeState({ kind: 'solo', lastCard: { id: 10631, name: 'Pot of Greed' } }), cfg).largeImageText, 'Pot of Greed · goldfishing');
  assert.equal(toActivity(normalizeState({ kind: 'browsing', screen: 'main_menu' }), cfg).statusDisplayType, undefined);
  assert.equal(toActivity(normalizeState({ kind: 'deck', deckName: 'X' }), cfg).statusDisplayType, undefined);
});

test('garbage is neutralised', () => {
  assert.deepEqual(normalizeState(null), { kind: 'none' });
  assert.deepEqual(normalizeState({ kind: 'weird' }), { kind: 'none' });
  const s = normalizeState({ kind: 'duel', game: 'x', of: -4, startedAt: Date.now() + 1e9, formatName: 'a'.repeat(500) });
  assert.equal(s.game, undefined);
  assert.equal(s.of, 1);
  assert.equal(s.startedAt, undefined);
  assert.equal(s.formatName.length, 128);
  assert.equal(s.players, undefined);
  assert.equal(normalizeState({ kind: 'duel', players: ['only-one'], lp: ['x', 2] }).lp, undefined);
  assert.equal(toActivity({ kind: 'none' }), null);
});
