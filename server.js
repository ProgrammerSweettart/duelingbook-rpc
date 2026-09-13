#!/usr/bin/env node
'use strict';

// DuelingBook → Discord Rich Presence bridge.
// Receives state from the Tampermonkey userscript over localhost and mirrors it to Discord.
//
//   POST /presence   { v:1, kind:'none'|'deck'|'duel', ... }   (see lib/presence.js)
//   GET  /health     JSON status
//   GET  /           human-readable status
//   GET  /userscripts/<name>.user.js   serves the userscripts so Tampermonkey can install/update from a URL
//
// Runs under launchd (see install.sh); logs go to stdout → ~/Library/Logs/duelingbook-rpc.log

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { DiscordPresence } = require('./lib/discord');
const { normalizeState, toActivity } = require('./lib/presence');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const MAX_BODY = 64 * 1024;
const STARTED_AT = Date.now();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// launchd agents don't always inherit the per-user TMPDIR, and that's where Discord's IPC socket
// lives on macOS (discord-ipc-N). Pin it from the confstr so the lookup is identical to a shell.
if (process.platform === 'darwin' && !process.env.TMPDIR) {
  try {
    process.env.TMPDIR = execSync('getconf DARWIN_USER_TEMP_DIR', { encoding: 'utf8' }).trim();
    log(`TMPDIR was unset; using ${process.env.TMPDIR}`);
  } catch (e) {
    log(`could not resolve DARWIN_USER_TEMP_DIR: ${e.message}`);
  }
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return {
    clientId: String(raw.clientId || ''),
    port: Number(raw.port) || 41337,
    host: raw.host || '127.0.0.1',
    largeImageKey: raw.largeImageKey || undefined,
    largeImageText: raw.largeImageText || undefined,
    staleAfterMs: (Number(raw.staleAfterSeconds) || 60) * 1000,
    allowedOrigins: Array.isArray(raw.allowedOrigins) && raw.allowedOrigins.length
      ? raw.allowedOrigins
      : ['https://www.duelingbook.com', 'https://duelingbook.com'],
  };
}

let cfg = loadConfig();
const discord = new DiscordPresence({ clientId: cfg.clientId, log });

// ---- presence state ----
let state = { kind: 'none' };
let stateAt = 0;
let lastActivityJson = null;

// Discord's card shows an elapsed time on every Playing activity (from the update time when no timestamp is
// given), so cards without their own clock get one that means "since this card first appeared".
let cardSince = { key: null, at: 0 };
function withClock(activity) {
  if (!activity || activity.startTimestamp) return activity;
  const key = `${activity.details}|${activity.state}`;
  if (key !== cardSince.key) cardSince = { key, at: Date.now() };
  return Object.assign({}, activity, { startTimestamp: cardSince.at });
}

function applyState(next, source) {
  state = next;
  stateAt = Date.now();
  const activity = withClock(toActivity(state, cfg));
  const json = JSON.stringify(activity);
  if (json !== lastActivityJson) {
    lastActivityJson = json;
    log(`state ← ${source}: ${describe(state)}`);
  }
  discord.setActivity(activity);
}

function describe(s) {
  const live = (v) => `${s.formatName || '?'}${s.rated ? ' rated' : ''} ${s.siding ? 'siding for ' : ''}${s.game ? `game ${s.game}/${s.of || '?'}` : `series game ${s.seriesGame || '?'}`}${s.score ? ` [${s.score.join('-')}]` : (s.seriesScore ? ` [series ${s.seriesScore.join('-')}]` : '')}${s.players ? ` ${s.players[0]} vs ${s.players[1]}` : ''}${s.lp ? ` (${s.lp[0]}-${s.lp[1]})` : ''}${s.startedAt ? ` since ${new Date(s.startedAt).toISOString()}` : ''}`;
  const afk = s.away ? ' [AFK]' : '';
  if (s.kind === 'deck') return `deck editor${s.deckName ? ` "${s.deckName}"` : ''}${afk}`;
  if (s.kind === 'duel') return `duel ${live()}${s.turn ? ` turn ${s.turn}` : ''}${s.deck ? ` deck "${s.deck}"` : ''}${s.lastCard ? ` card "${s.lastCard.name || s.lastCard.id}"` : ''}${s.watchers ? ` ${s.watchers} watching` : ''}`;
  if (s.kind === 'watching') return `watching ${live()}${s.watchers ? ` ${s.watchers} watching` : ''}`;
  if (s.kind === 'result') return `match over: ${s.won ? 'won' : 'lost'}${s.score ? ` ${s.score.join('-')}` : ''}`;
  if (s.kind === 'solo') return `solo${s.deck ? ` "${s.deck}"` : ''}${s.turn ? ` turn ${s.turn}` : ''}`;
  if (s.kind === 'browsing') return `browsing ${s.pool ? 'pool' : s.hosting ? 'hosting' : s.screen || '?'}${afk}`;
  return 'none';
}

// Watchdog: the userscript heartbeats while a state is active; if the tab dies we clear.
setInterval(() => {
  if (state.kind !== 'none' && Date.now() - stateAt > cfg.staleAfterMs) {
    applyState({ kind: 'none' }, `watchdog (no update for ${Math.round(cfg.staleAfterMs / 1000)}s)`);
  }
}, 5000).unref();

// Hot-reload config.json (client ID, image keys). Port/host changes need a restart.
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try {
    const next = loadConfig();
    const prev = cfg;
    cfg = next;
    if (next.clientId !== prev.clientId) discord.setClientId(next.clientId);
    if (next.largeImageKey !== prev.largeImageKey || next.largeImageText !== prev.largeImageText) discord.setActivity(withClock(toActivity(state, cfg)));
    log('config.json reloaded');
  } catch (e) {
    log(`config.json reload failed (keeping previous): ${e.message}`);
  }
});

// ---- HTTP ----
function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Private-Network': 'true',
    'Vary': 'Origin',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function originAllowed(origin) {
  if (!origin) return true; // curl / local tools: no Origin header
  return cfg.allowedOrigins.includes(origin);
}

function send(res, status, body, extra = {}) {
  const isObj = typeof body === 'object';
  const data = isObj ? JSON.stringify(body) : String(body);
  res.writeHead(status, Object.assign({ 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' }, extra));
  res.end(data);
}

function health() {
  return {
    ok: true,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    discord: discord.snapshot(),
    state,
    stateAgeSeconds: stateAt ? Math.round((Date.now() - stateAt) / 1000) : null,
    activity: toActivity(state, cfg),
    pid: process.pid,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://localhost');
  if (!originAllowed(origin)) {
    log(`rejected request from origin ${origin}`);
    return send(res, 403, { ok: false, error: 'origin not allowed' });
  }
  const cors = corsHeaders(origin);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, health(), cors);
    if (req.method === 'GET' && url.pathname === '/') {
      const h = health();
      return send(res, 200, [
        'duelingbook-rpc',
        `discord: ${h.discord.status}${h.discord.clientId ? '' : ' (no client ID)'}`,
        `state:   ${describe(state)}${h.stateAgeSeconds !== null ? ` (${h.stateAgeSeconds}s ago)` : ''}`,
        `uptime:  ${h.uptimeSeconds}s`,
        '', 'GET /health for JSON.',
      ].join('\n'), cors);
    }
    if (req.method === 'GET' && /^\/userscripts\/[a-z0-9-]+\.user\.js$/.test(url.pathname)) {
      const file = path.join(__dirname, 'userscripts', path.basename(url.pathname));
      if (!fs.existsSync(file)) return send(res, 404, { ok: false, error: 'not found' }, cors);
      return send(res, 200, fs.readFileSync(file, 'utf8'), Object.assign({ 'Content-Type': 'text/javascript; charset=utf-8' }, cors));
    }
    if (req.method === 'POST' && url.pathname === '/presence') {
      const text = await readBody(req);
      let body;
      try { body = JSON.parse(text); } catch { return send(res, 400, { ok: false, error: 'invalid JSON' }, cors); }
      applyState(normalizeState(body), body && body.source ? String(body.source).slice(0, 40) : 'userscript');
      return send(res, 200, { ok: true, discord: discord.status, state }, cors);
    }
    return send(res, 404, { ok: false, error: 'not found' }, cors);
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message }, cors);
  }
});

server.on('error', (e) => {
  log(`HTTP server error: ${e.message}`);
  if (e.code === 'EADDRINUSE') {
    log(`port ${cfg.port} is in use — is another instance running? (launchctl list | grep duelingbook)`);
    process.exit(1);
  }
});

server.listen(cfg.port, cfg.host, () => {
  log(`duelingbook-rpc listening on http://${cfg.host}:${cfg.port} (pid ${process.pid}, node ${process.version})`);
  discord.start();
});

async function shutdown(signal) {
  log(`${signal} — shutting down`);
  server.close();
  await discord.stop();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { log(`uncaught: ${e && e.stack || e}`); });
process.on('unhandledRejection', (e) => { log(`unhandled rejection: ${e && e.stack || e}`); });
