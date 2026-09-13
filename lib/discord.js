'use strict';

// Discord RPC connection manager.
//  - keeps trying to reach the desktop client (it's normal for Discord to not be running yet)
//  - one fresh Client per attempt, so no stale transport state survives a disconnect
//  - coalesces activity updates: your own client renders every SET_ACTIVITY instantly, but what
//    reaches *other* users is throttled and lossy, so bursts leave friends on a stale card. We send
//    at most one update per MIN_UPDATE_MS (latest state wins), sooner when the headline (details) changes,
//    and skip no-op updates
//  - diagnoses the "Invalid Client ID" close frame (code 4000), which the library otherwise
//    surfaces only as a 10 s "Connection timed out"

const EventEmitter = require('node:events');
const { Client } = require('@xhayper/discord-rpc');

const MIN_UPDATE_MS = 15000;       // routine changes (life points, turn count) coalesce this long
const URGENT_UPDATE_MS = 4000;     // the card's headline changed (entered a duel, match over): Discord's hard floor is 5 per 20 s
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 30000;
const RETRY_BAD_ID_MS = 5 * 60 * 1000;

const CLIENT_ID_RE = /^\d{17,20}$/; // Discord snowflake

function isPlausibleClientId(id) {
  return typeof id === 'string' && CLIENT_ID_RE.test(id);
}

class DiscordPresence extends EventEmitter {
  constructor({ clientId, log = () => {}, minUpdateMs = MIN_UPDATE_MS }) {
    super();
    this.clientId = clientId;
    this.log = log;
    this.minUpdateMs = minUpdateMs;
    this.client = null;
    this.status = 'stopped'; // stopped | no-client-id | connecting | connected | disconnected | invalid-client-id
    this.desired = null; // activity object or null (= clear)
    this.applied = undefined; // JSON of last applied activity; undefined = unknown (fresh connection)
    this.lastApplyAt = 0;
    this.applyTimer = null;
    this.retryTimer = null;
    this.retryDelay = RETRY_MIN_MS;
    this.stopped = true;
    this.lastLoggedFailure = '';
    this.connectedAt = null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    this.clearTimers();
    const client = this.client;
    this.client = null;
    this.status = 'stopped';
    if (client) {
      // best effort, bounded: a reply never comes if the socket died a moment ago
      const bounded = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 2000).unref())]);
      try { if (client.user && this.status === 'connected') await bounded(client.user.clearActivity()); } catch { /* ignore */ }
      try { await bounded(client.destroy()); } catch { /* ignore */ }
    }
  }

  clearTimers() {
    if (this.applyTimer) { clearTimeout(this.applyTimer); this.applyTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  setClientId(clientId) {
    if (clientId === this.clientId) return;
    this.log(`client ID changed → reconnecting`);
    this.clientId = clientId;
    this.retryDelay = RETRY_MIN_MS;
    this.lastLoggedFailure = '';
    this.dropClient();
    this.clearTimers();
    if (!this.stopped) this.connect();
  }

  setActivity(activity) {
    this.desired = activity || null;
    this.scheduleApply();
  }

  dropClient() {
    const client = this.client;
    this.client = null;
    this.applied = undefined;
    this.connectedAt = null;
    if (client) client.destroy().catch(() => {});
  }

  scheduleRetry(delay) {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
  }

  logFailureOnce(msg) {
    if (msg !== this.lastLoggedFailure) { this.log(msg); this.lastLoggedFailure = msg; }
  }

  async connect() {
    if (this.stopped || this.client) return;
    if (!isPlausibleClientId(this.clientId)) {
      this.status = 'no-client-id';
      this.logFailureOnce('no Discord client ID configured — set "clientId" in config.json (Discord Developer Portal → your app → General Information → Application ID). It is picked up automatically when the file is saved.');
      return;
    }
    this.status = 'connecting';
    const client = new Client({ clientId: this.clientId });
    this.client = client;
    let closeReason = null;
    client.transport.on('close', (reason) => {
      // Discord's CLOSE frame (an object) is followed by a generic string when the socket ends; keep the first.
      if (closeReason === null || (typeof reason === 'object' && typeof closeReason !== 'object')) closeReason = reason;
      if (reason && typeof reason === 'object' && reason.code === 4000 && this.client === client) {
        // Don't wait for the library's 10 s handshake timeout — we know exactly what happened.
        this.status = 'invalid-client-id';
        this.logFailureOnce(`Discord rejected the client ID "${this.clientId}" (${reason.message || 'Invalid Client ID'}). Fix "clientId" in config.json; it is re-read automatically.`);
        this.dropClient();
        this.scheduleRetry(RETRY_BAD_ID_MS);
      }
    });
    client.on('ready', () => {
      if (this.client !== client) return;
      this.status = 'connected';
      this.connectedAt = Date.now();
      this.retryDelay = RETRY_MIN_MS;
      this.lastLoggedFailure = '';
      const u = client.user;
      this.log(`connected to Discord${u ? ` as ${u.username}` : ''} (app ${this.clientId})`);
      this.applied = null; // a fresh connection has no activity yet — nothing to clear, first real update goes out immediately
      this.scheduleApply();
      this.emit('connected');
    });
    client.on('disconnected', () => {
      if (this.client !== client) return;
      this.log('Discord disconnected');
      this.status = 'disconnected';
      this.dropClient();
      this.emit('disconnected');
      this.scheduleRetry(RETRY_MIN_MS);
    });
    try {
      await client.login();
    } catch (err) {
      if (this.client !== client) return; // superseded (stop() or setClientId())
      this.dropClient();
      if (closeReason && typeof closeReason === 'object' && closeReason.code === 4000) {
        this.status = 'invalid-client-id';
        this.logFailureOnce(`Discord rejected the client ID "${this.clientId}" (${closeReason.message || 'Invalid Client ID'}). Fix "clientId" in config.json; it is re-read automatically.`);
        this.scheduleRetry(RETRY_BAD_ID_MS);
        return;
      }
      this.status = 'disconnected';
      const why = closeReason && typeof closeReason === 'object' ? `${closeReason.code} ${closeReason.message}` : (err && err.message) || String(err);
      this.logFailureOnce(`Discord not reachable (${why}) — retrying every ${Math.round(this.retryDelay / 1000)}–${RETRY_MAX_MS / 1000}s`);
      this.scheduleRetry(this.retryDelay);
      this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    }
  }

  scheduleApply() {
    if (this.status !== 'connected' || !this.client) return; // applied on 'ready'
    const applied = this.applied ? JSON.parse(this.applied) : null;
    const headlineChanged = !!this.desired !== !!applied || (this.desired && applied && this.desired.details !== applied.details);
    const interval = headlineChanged ? Math.min(URGENT_UPDATE_MS, this.minUpdateMs) : this.minUpdateMs;
    const wait = Math.max(0, this.lastApplyAt + interval - Date.now());
    if (this.applyTimer) {
      if (!headlineChanged || Date.now() + wait >= this.applyTimerAt) return; // the pending timer is soon enough
      clearTimeout(this.applyTimer);
    }
    this.applyTimerAt = Date.now() + wait;
    this.applyTimer = setTimeout(() => { this.applyTimer = null; this.applyNow(); }, wait);
  }

  async applyNow() {
    const client = this.client;
    if (!client || this.status !== 'connected' || !client.user) return;
    const desired = this.desired;
    const json = desired ? JSON.stringify(desired) : null;
    if (json === this.applied) return;
    this.lastApplyAt = Date.now();
    try {
      if (desired) await client.user.setActivity(desired);
      else await client.user.clearActivity();
      if (this.client !== client) return;
      this.applied = json;
      this.log(desired ? `presence → ${desired.details} | ${desired.state}${desired.startTimestamp ? ' | timer' : ''}` : 'presence cleared');
      this.emit('applied', desired);
      if (JSON.stringify(this.desired) !== JSON.stringify(desired)) this.scheduleApply(); // changed while in flight
    } catch (err) {
      if (this.client !== client) return;
      this.applied = undefined;
      this.log(`failed to set activity: ${err && err.message}`);
      // one retry later; a persistent failure would otherwise spin
      if (!this.applyTimer) this.applyTimer = setTimeout(() => { this.applyTimer = null; this.applyNow(); }, 10000);
    }
  }

  snapshot() {
    return {
      status: this.status,
      clientId: isPlausibleClientId(this.clientId) ? this.clientId : null,
      connectedAt: this.connectedAt,
      applied: this.applied ? JSON.parse(this.applied) : null,
    };
  }
}

module.exports = { DiscordPresence, isPlausibleClientId };
