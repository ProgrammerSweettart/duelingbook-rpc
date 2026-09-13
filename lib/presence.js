'use strict';

// Pure mapping: userscript state → Discord activity. No I/O, no timers — see test/presence.test.js.
//
// Wire format (userscript → POST /presence), version 1:
//   { v:1, kind:'none' }
//   { v:1, kind:'deck',     deckName?, away?, awaySince? }
//   { v:1, kind:'duel',     formatCode?, formatName?, rated?, of?, siding?, startedAt?, players?:[me, opp], lp?:[a, b], turn?, deck?,
//                           lastCard?:{id, name?} (last face-up play → card art), watchers?: number,
//                           game?, score?:[w, l, d]            — the current best-of-3, when known
//                           seriesGame?, seriesScore?:[w, l, d] — the room's running series (fallback when the best-of-3 isn't known) }
//   { v:1, kind:'watching', ...same as duel... }
//   { v:1, kind:'result',   won?: boolean | winner?: string, score?:[w, l, d], players?, formatCode?, startedAt? }   30 s after a match (yours, or one you watched)
//   { v:1, kind:'solo',     deck?, turn?, startedAt? }                                              solo mode (test hands)
//   { v:1, kind:'browsing', screen?, pool?:{formatCode?, isMatch?}, hosting?:{formatCode?, isMatch?}, away?, awaySince? }
//   any non-'none' state may carry  me?: string (DuelingBook username), avatar?: https://images.duelingbook.com/card-pics/15902.jpg (as the site resolves it)

const ACTIVITY_TYPE_PLAYING = 0; // Discord ActivityType.Playing — the only type that renders the elapsed timer on desktop
const TEXT_MAX = 128; // Discord: details/state 2..128 chars

// DuelingBook format codes (from main.js getFormat()): first letter = format, second = r(ated)/u(nrated).
const FORMAT_NAMES = {
  a: 'Advanced',
  c: 'Custom Cards',
  e: 'Edison Format',
  g: 'Goat Format',
  t: 'Traditional',
  u: 'Unlimited',
  s: 'Speed Duel',
  r: 'Rush Duel',
  y: 'Genesys Format',
};

// currentLabel → what to call the screen (from the page's #frames children)
const SCREEN_LABELS = {
  main_menu: 'Main menu',
  duel_room: 'Duel room',
  deck_constructor: 'Deck editor',
  profile_viewer: 'Viewing a profile',
  profile_viewer2: 'Viewing a profile',
  my_profile: 'My profile',
  rankings: 'Rankings',
  tournaments: 'Tournaments',
  tournament_locator: 'Tournament locator',
  duel_records: 'Duel records',
  friends: 'Friends',
  friend_requests: 'Friend requests',
  followed_users: 'Following',
  blocked_users: 'Blocked users',
  browse_users: 'Browsing users',
  all_messages: 'Messages',
  comments: 'Comments',
  settings: 'Settings',
  change_password: 'Settings',
  confirm_email: 'Settings',
  custom_cards: 'Custom cards',
  customs: 'Custom cards',
  journal: 'Journal',
  notes: 'Notes',
  donations: 'Donations',
  beginners: 'Beginner tips',
  // duel frames reached while not in a live duel: the post-match result/rematch screen
  rps_start: 'Match over', tp_start: 'Match over', tp_start2: 'Match over', siding: 'Match over',
  duel_start: 'Match over', duel_start1: 'Match over', duel_start2: 'Match over', duel_start3: 'Match over', duel_start4: 'Match over',
};

const FORMAT_CODES = { so: 'Solo mode' }; // whole-code overrides (solo would otherwise read as 's' = Speed Duel)

function formatFromCode(code) {
  if (typeof code !== 'string' || code.length < 1) return null;
  if (FORMAT_CODES[code.toLowerCase()]) return { name: FORMAT_CODES[code.toLowerCase()], rated: false };
  const name = FORMAT_NAMES[code[0].toLowerCase()];
  if (!name) return null;
  return { name, rated: code[1] === 'r' };
}

function clampText(s) {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length < 2) return undefined;
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX - 1) + '…' : t;
}

// DuelingBook labels the default deck "Name (default)" in its lists; that's a flag, not part of the name.
function deckText(s) {
  return clampText(typeof s === 'string' ? s.replace(/\s*\(default\)\s*$/i, '') : s);
}

function toInt(n, { min = 0, max = 99 } = {}) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  return Math.min(max, Math.max(min, Math.round(x)));
}

function validTimestamp(v) {
  const t = toInt(v, { min: 0, max: Number.MAX_SAFE_INTEGER });
  // ignore timestamps in the future or absurdly old (> 2 days) — clock skew / garbage
  return t && t <= Date.now() + 5000 && t > Date.now() - 2 * 86400e3 ? t : undefined;
}

function pair(v, map) {
  if (!Array.isArray(v) || v.length < 2) return undefined;
  const a = map(v[0]), b = map(v[1]);
  return a !== undefined && b !== undefined ? [a, b] : undefined;
}

function formatFields(body) {
  const fromCode = formatFromCode(body.formatCode);
  return {
    formatName: clampText(body.formatName) || (fromCode && fromCode.name) || undefined,
    rated: typeof body.rated === 'boolean' ? body.rated : (fromCode ? fromCode.rated : undefined),
  };
}

function liveFields(body) {
  return Object.assign(formatFields(body), {
    game: toInt(body.game, { min: 1 }),
    of: toInt(body.of, { min: 1 }),
    siding: body.siding === true,
    startedAt: validTimestamp(body.startedAt),
    players: pair(body.players, (s) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, 40) : undefined)),
    lp: pair(body.lp, (n) => toInt(n, { min: 0, max: 999999 })),
    score: triple(body.score),
    seriesGame: toInt(body.seriesGame, { min: 1, max: 999 }),
    seriesScore: triple(body.seriesScore),
    turn: toInt(body.turn, { min: 1, max: 999 }),
    deck: deckText(body.deck),
    lastCard: cardRef(body.lastCard),
    watchers: toInt(body.watchers, { min: 1, max: 9999 }),
  });
}

function cardRef(v) {
  if (!v || typeof v !== 'object') return undefined;
  const id = toInt(v.id, { min: 1, max: 99999999 });
  return id ? { id, name: clampText(v.name) } : undefined;
}
const cardArtUrl = (id) => `https://images.duelingbook.com/card-pics/${id}.jpg`; // as the site's getAvatarStart() resolves card ids

function triple(v) {
  return Array.isArray(v) && v.length === 3 && v.every((n) => toInt(n, { min: 0, max: 999 }) !== undefined) ? v.map((n) => toInt(n, { min: 0, max: 999 })) : undefined;
}

function awayFields(body) {
  if (body.away !== true) return {};
  return { away: true, awaySince: validTimestamp(body.awaySince) };
}

function waitFields(v) {
  if (!v || typeof v !== 'object') return {};
  const f = formatFromCode(v.formatCode);
  return { formatName: f ? f.name : undefined, rated: f ? f.rated : undefined, isMatch: v.isMatch === true };
}

function identityFields(body) {
  const out = {};
  if (typeof body.me === 'string' && body.me.trim()) out.me = body.me.trim().slice(0, 40);
  // DuelingBook-hosted images only (card art or uploads), as the userscript resolves them the way the site does
  if (typeof body.avatar === 'string' && body.avatar.length <= 200 && /^https:\/\/(images\.duelingbook\.com|www\.duelingbook\.com\/images)\/[\w./-]+\.(jpg|jpeg|png|gif|webp)$/.test(body.avatar)) out.avatar = body.avatar;
  return out;
}

// Validate/normalize an incoming body. Returns { kind: 'none' } for anything unusable.
function normalizeState(body) {
  const s = normalizeKind(body);
  return s.kind === 'none' ? s : Object.assign(s, identityFields(body));
}

function normalizeKind(body) {
  if (!body || typeof body !== 'object') return { kind: 'none' };
  switch (body.kind) {
    case 'deck':
      return Object.assign({ kind: 'deck', deckName: deckText(body.deckName) }, awayFields(body));
    case 'duel':
      return Object.assign({ kind: 'duel' }, liveFields(body));
    case 'watching':
      return Object.assign({ kind: 'watching' }, liveFields(body));
    case 'solo':
      return { kind: 'solo', deck: deckText(body.deck), turn: toInt(body.turn, { min: 1, max: 999 }), startedAt: validTimestamp(body.startedAt), lastCard: cardRef(body.lastCard) };
    case 'result':
      return Object.assign({ kind: 'result', won: body.won === true, winner: clampText(body.winner) }, formatFields(body), {
        score: triple(body.score),
        players: pair(body.players, (s) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, 40) : undefined)),
        startedAt: validTimestamp(body.startedAt),
      });
    case 'browsing': {
      const s = { kind: 'browsing', screen: typeof body.screen === 'string' ? body.screen.slice(0, 40) : undefined };
      if (body.pool) s.pool = waitFields(body.pool);
      else if (body.hosting) s.hosting = waitFields(body.hosting);
      return Object.assign(s, awayFields(body));
    }
    default:
      return { kind: 'none' };
  }
}

function formatLabel(s) {
  return s.formatName ? `${s.formatName}${s.rated ? ' (Rated)' : ''}` : undefined;
}

// A DuelingBook "Match" is a best-of-3; a rematch starts another on the same duel. `game`/`score` describe the
// current best-of-3 when the userscript knows it; otherwise the room's running series is all there is.
function scoreText(sc) {
  if (!sc) return '';
  const [w, l, d] = sc;
  return w + l + d > 0 ? ` · ${w}-${l}${d ? `-${d}` : ''}` : '';
}
function gameLabel(s) {
  let label;
  if (s.of > 1) {
    if (s.game) label = `Game ${s.game} of ${s.of}${scoreText(s.score)}`;
    else label = `Series game ${s.seriesGame || 1}${scoreText(s.seriesScore)}`;
  } else {
    const n = s.game || s.seriesGame || 1;
    label = n > 1 ? `Game ${n}${scoreText(s.score || s.seriesScore)}` : 'Single game';
  }
  if (s.siding) label = label.replace(/^(Series )?[Gg]ame/, (m) => (m.startsWith('Series') ? 'Siding for series game' : 'Siding for game'));
  if (s.turn) label += ` · Turn ${s.turn}`;
  return label;
}

function playersLabel(s) {
  if (!s.players) return undefined;
  const [a, b] = s.players;
  const line = s.lp ? `${a} (${s.lp[0]}) vs ${b} (${s.lp[1]})` : `${a} vs ${b}`;
  return s.watchers ? `${line} · ${s.watchers} watching` : line;
}

// Which line Discord puts under your name in member lists: 0 = the app name, 1 = state, 2 = details.
const STATUS_DISPLAY = { duel: 2, watching: 2, solo: 2, result: 2 };

// Tooltip on the card art. The badge already carries the username, so this is flavor: dry, state-aware,
// and the deck name while dueling. Edit freely — nothing depends on these strings.
function hoverText(s) {
  let quip;
  switch (s.kind) {
    case 'duel': {
      if (s.siding) quip = 'consulting the side deck';
      else if (s.lp && s.lp[0] > s.lp[1]) quip = 'ahead on life points, act natural';
      else if (s.lp && s.lp[0] < s.lp[1]) quip = "it's fine. it's fine. it's fine.";
      else quip = 'the heart of the cards is still deciding';
      return s.deck ? `${s.deck} · ${quip}` : quip;
    }
    case 'watching': return 'backseat dueling';
    case 'solo': return 'goldfishing';
    case 'result': return s.winner ? 'gg from the cheap seats' : (s.won ? 'gg' : 'gg (the other kind)');
    case 'deck': return 'counting to 40 again';
    case 'browsing':
      if (s.away) return 'went to touch grass';
      if (s.pool) return 'waiting for a worthy opponent';
      if (s.hosting) return 'hosting. waiting. hosting.';
      return s.screen === 'duel_room' ? 'lurking the duel room' : 'deciding whether to duel';
    default: return undefined;
  }
}

// Build the activity Discord will show, or null to clear presence.
function toActivity(state, cfg = {}) {
  if (!state || state.kind === 'none') return null;
  const act = { type: ACTIVITY_TYPE_PLAYING, instance: false };
  if (cfg.largeImageKey) {
    act.largeImageKey = cfg.largeImageKey;
    act.largeImageText = hoverText(state) || cfg.largeImageText || undefined;
    if (state.lastCard) { // the last face-up play becomes the art; its name leads the hover, the one-liner stays
      act.largeImageKey = cardArtUrl(state.lastCard.id);
      const quip = hoverText(Object.assign({}, state, { deck: undefined })); // the deck name would crowd the card name out
      act.largeImageText = [state.lastCard.name || 'last card played', quip].filter(Boolean).join(' · ').slice(0, TEXT_MAX);
    }
    if (state.avatar) { act.smallImageKey = state.avatar; act.smallImageText = state.me || 'DuelingBook'; } // the small badge needs a large image to sit on
  }
  if (STATUS_DISPLAY[state.kind] !== undefined && !state.away) act.statusDisplayType = STATUS_DISPLAY[state.kind];
  switch (state.kind) {
    case 'deck':
      act.details = 'Deck Editor';
      act.state = state.deckName ? `Editing: ${state.deckName}` : 'Building a deck';
      break;
    case 'duel':
    case 'watching': {
      const verb = state.kind === 'duel' ? 'Dueling' : 'Watching';
      act.details = [verb, formatLabel(state), gameLabel(state)].filter(Boolean).join(' · ');
      act.state = playersLabel(state) || (state.kind === 'duel' ? 'In a duel' : 'Spectating a duel');
      if (state.startedAt) act.startTimestamp = state.startedAt;
      break;
    }
    case 'solo':
      act.details = `Solo mode${state.turn ? ` · Turn ${state.turn}` : ''}`;
      act.state = state.deck ? `Testing ${state.deck}` : 'Testing hands';
      if (state.startedAt) act.startTimestamp = state.startedAt;
      break;
    case 'result': {
      const [w, l, d] = state.score || [];
      const sc = state.score ? ` ${w}-${l}${d ? `-${d}` : ''}` : '';
      act.details = ['Match over', formatLabel(state), state.winner ? `${state.winner} won${sc}` : `${state.won ? 'Won' : 'Lost'}${sc}`].filter(Boolean).join(' · ');
      act.state = playersLabel(state) || 'DuelingBook';
      if (state.startedAt) act.startTimestamp = state.startedAt;
      break;
    }
    case 'browsing': {
      const wait = state.pool || state.hosting;
      if (wait) {
        act.details = state.pool ? 'Looking for a duel' : 'Hosting a duel';
        act.state = [formatLabel(wait), wait.isMatch ? 'Best of 3' : 'Single game'].filter(Boolean).join(' · ');
      } else {
        act.details = 'Browsing';
        act.state = SCREEN_LABELS[state.screen] || 'DuelingBook';
      }
      break;
    }
    default:
      return null;
  }
  if (state.away) {
    act.details = `AFK · ${act.details}`;
    if (state.awaySince) act.startTimestamp = state.awaySince;
    if (act.largeImageKey) act.largeImageText = 'went to touch grass';
  }
  act.details = act.details.slice(0, TEXT_MAX);
  act.state = act.state.slice(0, TEXT_MAX);
  return act;
}

module.exports = { normalizeState, toActivity, formatFromCode, FORMAT_NAMES, SCREEN_LABELS, ACTIVITY_TYPE_PLAYING };
