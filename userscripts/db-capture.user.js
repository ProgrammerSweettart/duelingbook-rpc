// ==UserScript==
// @name         DuelingBook Capture (WS + globals) — schema discovery
// @namespace    duelingbook-rpc
// @version      0.1.0
// @description  Records every WebSocket message (in/out), window.duel & friends, screen changes. Download all as one JSON.
// @author       duelingbook-rpc
// @match        https://www.duelingbook.com/*
// @match        https://duelingbook.com/*
// @run-at       document-start
// @updateURL    http://127.0.0.1:41337/userscripts/db-capture.user.js
// @downloadURL  http://127.0.0.1:41337/userscripts/db-capture.user.js
// @grant        none
// ==/UserScript==

/*
  Phase-1 tool. Runs in the PAGE context (@grant none) so the WebSocket hook is the
  real one the site uses — no sandbox/Xray games (matters on Firefox/Zen).

  What it records (each as one event in an append-only log, persisted to IndexedDB so
  a page reload mid-session does NOT lose data):
    ws-new / ws-open / ws-close / ws-error   socket lifecycle (url, close code)
    ws-in / ws-out                           every message; parsed JSON when possible,
                                             with top-level `action` and `play` copied up
    screen                                   currentLabel + visible #frames child + visible
                                             .duel_frame + selected deck name, on change
    globals                                  full dump of page-defined globals (primitives
                                             inline, interesting objects serialized deep)
    globals-diff                             only the primitives that changed since last tick
    duel                                     deckData / player1 / player2 / deck / turn_player
                                             snapshot (throttled; on Duel messages + screens).
                                             (window.duel itself is the #duel <div>, not state —
                                             the state lives in flat globals like duel_active,
                                             match, games, rated, speed, rush, duelId, turnCount,
                                             which `globals` / `globals-diff` track every second.)
    mark                                     your own note (button, Ctrl+Shift+M, __dbcap.mark)

  Download: the panel button, or __dbcap.download() in the console.
            Fallback if downloads are blocked: copy(JSON.stringify(await __dbcap.export()))
  Clear:    __dbcap.clear()  (also wipes IndexedDB)
*/

(() => {
  'use strict';
  if (window.__dbcap) return;

  const VERSION = '0.1.0';
  const T0 = Date.now();
  const SESSION = Math.random().toString(36).slice(2, 10);
  const DB_NAME = 'dbcap';
  const STORE = 'events';

  // ---------- serializer (safe for cyclic / DOM / jQuery / huge) ----------
  const SER_DEFAULT = { maxDepth: 6, maxArray: 40, maxString: 400, maxKeys: 120 };
  const SNAPSHOT_BYTES = 160 * 1024; // hard cap per serialized snapshot; depth is reduced until it fits
  function serialize(value, depth = 0, seen = new WeakSet(), SER = SER_DEFAULT) {
    try {
      if (value === null || value === undefined) return value;
      const t = typeof value;
      if (t === 'string') return value.length > SER.maxString ? value.slice(0, SER.maxString) + `…[+${value.length - SER.maxString}]` : value;
      if (t === 'number' || t === 'boolean') return value;
      if (t === 'bigint') return String(value) + 'n';
      if (t === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (t === 'symbol') return String(value);
      if (typeof Node !== 'undefined' && value instanceof Node) return `[${value.nodeName}${value.id ? '#' + value.id : ''}]`;
      // `.window` is readable even on a cross-origin WindowProxy (ad iframes end up as named globals)
      if (t === 'object' && value.window === value) return value === window ? '[Window self]' : '[Window other/cross-origin]';
      if (value.jquery) return `[jQuery ${value.selector || ''} len=${value.length}]`;
      if (value instanceof Date) return value.toISOString();
      if (typeof value.byteLength === 'number' && !Array.isArray(value)) return `[Binary ${value.byteLength}B]`;
      if (seen.has(value)) return '[Circular]';
      if (depth >= SER.maxDepth) return Array.isArray(value) ? `[Array len=${value.length}]` : `[Object ${ctorName(value)}]`;
      seen.add(value);
      if (Array.isArray(value)) {
        const out = value.slice(0, SER.maxArray).map(v => serialize(v, depth + 1, seen, SER));
        if (value.length > SER.maxArray) out.push(`…[+${value.length - SER.maxArray} more]`);
        return out;
      }
      const out = {};
      const cn = ctorName(value);
      if (cn && cn !== 'Object') out.__ctor = cn;
      let n = 0;
      for (const k of Object.keys(value)) {
        if (++n > SER.maxKeys) { out.__truncatedKeys = Object.keys(value).length - SER.maxKeys; break; }
        let v;
        try { v = value[k]; } catch (e) { v = `[Throws ${e && e.message}]`; }
        out[k] = serialize(v, depth + 1, seen, SER);
      }
      return out;
    } catch (e) {
      return `[Unserializable ${e && e.message}]`;
    }
  }
  // Serialize with a depth budget, shrinking depth until the JSON fits SNAPSHOT_BYTES.
  function bounded(value, maxDepth) {
    for (let d = maxDepth; d >= 1; d--) {
      const out = serialize(value, 0, new WeakSet(), Object.assign({}, SER_DEFAULT, { maxDepth: d }));
      let len = 0;
      try { len = JSON.stringify(out).length; } catch { len = Infinity; }
      if (len <= SNAPSHOT_BYTES) return d === maxDepth ? out : Object.assign({ __depthReducedTo: d }, typeof out === 'object' && out && !Array.isArray(out) ? out : { value: out });
    }
    return `[too large even at depth 1: ${ctorName(value)}]`;
  }
  function ctorName(o) { try { return o && o.constructor && o.constructor.name; } catch { return undefined; } }

  // ---------- storage: memory + IndexedDB append log ----------
  const events = [];
  let seq = 0;
  let idb = null;
  let idbQueue = [];
  let idbFlushTimer = null;
  let persistedCount = 0;

  function openIdb() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { autoIncrement: true }); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  function idbCount() {
    return new Promise((resolve) => {
      if (!idb) return resolve(0);
      try {
        const r = idb.transaction(STORE, 'readonly').objectStore(STORE).count();
        r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(0);
      } catch { resolve(0); }
    });
  }
  function idbReadAll() {
    return new Promise((resolve) => {
      if (!idb) return resolve(null);
      try {
        const r = idb.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  function idbClear() {
    return new Promise((resolve) => {
      if (!idb) return resolve();
      try {
        const r = idb.transaction(STORE, 'readwrite').objectStore(STORE).clear();
        r.onsuccess = () => resolve(); r.onerror = () => resolve();
      } catch { resolve(); }
    });
  }
  function idbFlush() {
    idbFlushTimer = null;
    if (!idb || idbQueue.length === 0) return;
    const batch = idbQueue; idbQueue = [];
    try {
      const store = idb.transaction(STORE, 'readwrite').objectStore(STORE);
      for (const ev of batch) store.add(ev);
      persistedCount += batch.length;
    } catch (e) {
      idbQueue = batch.concat(idbQueue); // retry later
    }
  }
  function scheduleFlush() {
    if (!idbFlushTimer) idbFlushTimer = setTimeout(idbFlush, 700);
  }

  function record(type, fields) {
    const t = Date.now();
    const ev = Object.assign({ i: ++seq, s: SESSION, t, dt: t - T0, type }, fields);
    events.push(ev);
    idbQueue.push(ev);
    scheduleFlush();
    updatePanel();
    // Snapshot duel state shortly after any inbound Duel message settles (throttled inside).
    if (type === 'ws-in' && fields && fields.action === 'Duel') setTimeout(() => duelSnapshot('ws:Duel/' + fields.play), 50);
    return ev;
  }

  // ---------- WebSocket hook ----------
  const NativeWS = window.WebSocket;
  const wsIds = new WeakMap();
  let wsSeq = 0;

  function decodeAndRecord(dir, wsId, data) {
    const base = { ws: wsId, dir };
    const finish = (text) => {
      let json = null;
      if (typeof text === 'string') {
        try { json = JSON.parse(text); } catch { /* not JSON */ }
      }
      const ev = Object.assign(base, { size: typeof text === 'string' ? text.length : null });
      if (json && typeof json === 'object') {
        ev.action = json.action;
        if (json.play !== undefined) ev.play = json.play;
        ev.json = json; // full payload, unmodified
      } else {
        ev.raw = typeof text === 'string' ? text : String(text);
      }
      record(dir === 'in' ? 'ws-in' : 'ws-out', ev);
    };
    try {
      if (typeof data === 'string') return finish(data);
      if (data instanceof Blob) return data.text().then(finish, () => finish(`[Blob ${data.size}B unreadable]`));
      if (data instanceof ArrayBuffer) return finish(new TextDecoder().decode(data));
      if (ArrayBuffer.isView(data)) return finish(new TextDecoder().decode(data));
      finish(String(data));
    } catch (e) {
      finish(`[decode error ${e && e.message}]`);
    }
  }

  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args) {
      const ws = Reflect.construct(target, args);
      const id = ++wsSeq;
      wsIds.set(ws, id);
      record('ws-new', { ws: id, url: String(args[0]), protocols: args[1] === undefined ? undefined : serialize(args[1]) });
      ws.addEventListener('open', () => record('ws-open', { ws: id, url: ws.url, protocol: ws.protocol, ext: ws.extensions }));
      ws.addEventListener('close', (e) => record('ws-close', { ws: id, code: e.code, reason: e.reason, wasClean: e.wasClean }));
      ws.addEventListener('error', () => record('ws-error', { ws: id }));
      ws.addEventListener('message', (e) => decodeAndRecord('in', id, e.data));
      return ws;
    },
  });
  const nativeSend = NativeWS.prototype.send;
  NativeWS.prototype.send = function (data) {
    try { decodeAndRecord('out', wsIds.get(this) || 0, data); } catch { /* never break the site */ }
    return nativeSend.call(this, data);
  };

  // ---------- globals discovery ----------
  // Baseline is taken NOW (document-start), before any site script runs. Anything on
  // window later that isn't in the baseline was put there by the site (or an extension).
  const baseline = new Set(Object.getOwnPropertyNames(window));
  const OWN_NAMES = new Set(['__dbcap']);
  const INTERESTING_OBJECT = /duel|game|match|format|player|deck|turn|phase|life|rps|side|watch|host|room|settings|opponent|username|rated|speed|rush|tag|start|timer|score/i;
  // Per-object depth budgets. Player objects hold full card arrays with DOM refs — depth 2 shows
  // their field names, primitive values and array lengths, which is what we need.
  // NOTE: window.duel is the <div id="duel"> element (named-element global), not state. Kept at depth 1 for the record.
  const DEEP = { deckData: 3, deck: 2, player1: 2, player2: 2, player3: 2, player4: 2, players: 3, turn_player: 2, duel: 1 };
  const DEEP_NAMES = Object.keys(DEEP);

  function siteGlobalNames() {
    const names = [];
    for (const k of Object.getOwnPropertyNames(window)) {
      if (baseline.has(k) || OWN_NAMES.has(k)) continue;
      names.push(k);
    }
    return names;
  }
  function readGlobal(k) {
    try {
      const d = Object.getOwnPropertyDescriptor(window, k);
      if (d && typeof d.get === 'function') return { accessor: true };
      return { value: window[k] };
    } catch (e) { return { error: e && e.message }; }
  }
  let lastPrimitives = null;
  function primitivesSnapshot() {
    const out = {};
    for (const k of siteGlobalNames()) {
      try {
        const r = readGlobal(k);
        if (!('value' in r)) continue;
        const v = r.value;
        const t = typeof v;
        if (v === null || t === 'string' || t === 'number' || t === 'boolean' || v === undefined) {
          out[k] = t === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
        }
      } catch { /* cross-origin or hostile global */ }
    }
    return out;
  }
  function fullGlobalsSnapshot(reason) {
    const prims = {};
    const objs = {};
    const fns = [];
    const other = {};
    for (const k of siteGlobalNames()) {
      try {
        const r = readGlobal(k);
        if (!('value' in r)) { other[k] = r; continue; }
        const v = r.value;
        const t = typeof v;
        if (v === null || t === 'string' || t === 'number' || t === 'boolean' || v === undefined) prims[k] = t === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
        else if (t === 'function') fns.push(k);
        else if (DEEP_NAMES.includes(k)) objs[k] = bounded(v, DEEP[k]);
        else if (INTERESTING_OBJECT.test(k)) objs[k] = bounded(v, 2);
        else other[k] = serialize(v, 0, new WeakSet(), Object.assign({}, SER_DEFAULT, { maxDepth: 0 }));
      } catch (e) { other[k] = `[Throws ${e && e.message}]`; }
    }
    lastPrimitives = prims;
    record('globals', { reason, primitives: prims, objects: objs, functions: fns.sort(), other });
  }
  function diffPrimitives(reason) {
    const now = primitivesSnapshot();
    if (!lastPrimitives) { lastPrimitives = now; return; }
    const changed = {};
    let n = 0;
    for (const k of Object.keys(now)) {
      if (!(k in lastPrimitives) || lastPrimitives[k] !== now[k]) { changed[k] = { from: lastPrimitives[k], to: now[k] }; n++; }
    }
    for (const k of Object.keys(lastPrimitives)) if (!(k in now)) { changed[k] = { from: lastPrimitives[k], to: '[deleted]' }; n++; }
    lastPrimitives = now;
    if (n) record('globals-diff', { reason, changed });
  }

  // ---------- duel object snapshots ----------
  let lastDuelSnapAt = 0;
  let duelSnapTimer = null;
  function duelSnapshot(reason, force) {
    const now = Date.now();
    if (!force && now - lastDuelSnapAt < 5000) {
      if (!duelSnapTimer) duelSnapTimer = setTimeout(() => { duelSnapTimer = null; duelSnapshot(reason + '+queued', true); }, 5000 - (now - lastDuelSnapAt));
      return;
    }
    lastDuelSnapAt = now;
    const snap = {};
    for (const k of DEEP_NAMES) {
      const r = readGlobal(k);
      if ('value' in r && r.value !== undefined) snap[k] = bounded(r.value, DEEP[k]);
    }
    // The flat duel-state globals, inline, so every snapshot is self-describing.
    const flat = {};
    for (const k of ['currentLabel', 'duel_active', 'duelist', 'match', 'match_type', 'games', 'rated', 'speed', 'rush', 'tag_duel', 'links', 'duelId', 'lastDuelId', 'turnCount', 'lifepointMax', 'used_allotted_rematch', 'rpsWinner', 'pickedRPS', 'awaiting_start_turn', 'duelDate', 'format', 'deckName', 'hosting', 'watching', 'viewing']) {
      const r = readGlobal(k);
      if ('value' in r) flat[k] = serialize(r.value, 0, new WeakSet(), Object.assign({}, SER_DEFAULT, { maxDepth: 1 }));
    }
    record('duel', { reason, flat, snap });
  }

  // ---------- screen tracking ----------
  function isVisible(el) {
    if (!el) return false;
    try { return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0; } catch { return false; }
  }
  function deckName() {
    try { const s = document.querySelector('#decklist_cb'); return s && s.selectedOptions && s.selectedOptions[0] ? s.selectedOptions[0].textContent.trim() : null; } catch { return null; }
  }
  function screenState() {
    const frames = document.getElementById('frames');
    const visibleFrames = frames ? [...frames.children].filter(isVisible).map(e => e.id || e.className || e.tagName) : [];
    const visibleDuelFrames = [...document.querySelectorAll('#duel .duel_frame')].filter(isVisible).map(e => e.id);
    let cl;
    try { cl = window.currentLabel; } catch { cl = undefined; }
    return {
      currentLabel: typeof cl === 'string' ? cl : (cl === undefined ? undefined : serialize(cl)),
      visibleFrames,
      visibleDuelFrames,
      deckConstructorVisible: isVisible(document.getElementById('deck_constructor')),
      duelVisible: isVisible(document.getElementById('duel')),
      deckName: deckName(),
      title: document.title,
      href: location.href,
    };
  }
  let lastScreenKey = null;
  function tickScreen() {
    const s = screenState();
    const key = JSON.stringify(s);
    if (key !== lastScreenKey) {
      const changed = lastScreenKey !== null;
      lastScreenKey = key;
      record('screen', s);
      if (changed) { diffPrimitives('screen'); duelSnapshot('screen:' + s.currentLabel); }
    }
  }

  // ---------- marks ----------
  function mark(note) {
    if (note === undefined) note = prompt('Capture mark (e.g. "game 2 started", "I won g1"):');
    if (note === null) return;
    record('mark', { note: String(note), screen: screenState() });
    duelSnapshot('mark', true);
    diffPrimitives('mark');
  }

  // ---------- download / clear ----------
  async function buildExport() {
    await new Promise(r => setTimeout(r, 0)); idbFlush();
    let all = await idbReadAll();
    if (!all || all.length < events.length) all = events; // IDB unavailable → memory only
    const meta = {
      tool: 'db-capture', version: VERSION,
      exportedAt: new Date().toISOString(), session: SESSION, sessionStartedAt: new Date(T0).toISOString(),
      userAgent: navigator.userAgent, href: location.href,
      siteScripts: [...document.scripts].map(s => s.src).filter(s => /duelingbook/.test(s)),
      eventCount: all.length, sessions: [...new Set(all.map(e => e.s))],
      types: all.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {}),
      actions: all.filter(e => e.type === 'ws-in' || e.type === 'ws-out').reduce((m, e) => { const k = e.type + ':' + e.action + (e.play !== undefined ? '/' + e.play : ''); m[k] = (m[k] || 0) + 1; return m; }, {}),
    };
    return { meta, events: all };
  }
  async function download() {
    const data = await buildExport();
    const text = JSON.stringify(data);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dbcap-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    console.info(`[dbcap] exported ${data.meta.eventCount} events, ${(text.length / 1024 / 1024).toFixed(2)} MB`);
    return data.meta;
  }
  async function clear() {
    events.length = 0; idbQueue = []; seq = 0; persistedCount = 0;
    await idbClear();
    updatePanel();
    console.info('[dbcap] cleared');
  }

  // ---------- panel ----------
  let panel, countEl, collapsed = false;
  function buildPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.id = '__dbcap_panel';
    panel.setAttribute('style', [
      'position:fixed', 'top:4px', 'left:4px', 'z-index:2147483647', 'background:rgba(20,20,20,.88)', 'color:#eee',
      'font:11px/1.4 Menlo,Consolas,monospace', 'padding:4px 6px', 'border-radius:6px', 'border:1px solid #555',
      'display:flex', 'gap:6px', 'align-items:center', 'pointer-events:auto', 'user-select:none',
    ].join(';'));
    const mk = (label, fn, title) => {
      const b = document.createElement('button');
      b.textContent = label; b.title = title || '';
      b.setAttribute('style', 'font:inherit;padding:1px 6px;background:#333;color:#eee;border:1px solid #666;border-radius:4px;cursor:pointer');
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };
    countEl = document.createElement('span');
    const body = document.createElement('span');
    body.setAttribute('style', 'display:inline-flex;gap:6px;align-items:center');
    body.append(countEl, mk('Mark', () => mark(), 'Insert a note into the timeline (Ctrl+Shift+M)'), mk('Download', () => download(), 'Export everything captured as one JSON'), mk('Clear', () => { if (confirm('Clear all captured events (memory + IndexedDB)?')) clear(); }));
    const toggle = mk('–', () => { collapsed = !collapsed; body.style.display = collapsed ? 'none' : 'inline-flex'; toggle.textContent = collapsed ? '+' : '–'; }, 'Collapse');
    panel.append(document.createTextNode('dbcap'), body, toggle);
    document.body.appendChild(panel);
    updatePanel();
  }
  function updatePanel() {
    if (countEl) countEl.textContent = `${events.length} ev · ${persistedCount} saved`;
  }

  // ---------- boot ----------
  window.__dbcap = {
    version: VERSION, download, clear, mark, export: buildExport,
    snapshot: () => { fullGlobalsSnapshot('manual'); duelSnapshot('manual', true); },
    get events() { return events; },
    get count() { return events.length; },
    serialize,
  };

  record('boot', { version: VERSION, href: location.href, ua: navigator.userAgent, readyState: document.readyState });

  openIdb().then(async (db) => {
    idb = db;
    const prior = await idbCount();
    persistedCount = prior;
    if (prior) console.info(`[dbcap] ${prior} events already persisted from earlier page loads (kept; Clear to reset)`);
    scheduleFlush();
    updatePanel();
  });

  const onReady = () => {
    buildPanel();
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); mark(); }
    }, true);
    setTimeout(() => fullGlobalsSnapshot('load+2s'), 2000);
    setTimeout(() => fullGlobalsSnapshot('load+15s'), 15000);
    setInterval(() => fullGlobalsSnapshot('periodic'), 120000);
    setInterval(() => diffPrimitives('tick'), 1000);
    setInterval(tickScreen, 400);
    setInterval(() => { if (isVisible(document.getElementById('duel'))) duelSnapshot('periodic'); }, 20000);
    tickScreen();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  window.addEventListener('pagehide', () => idbFlush());
  console.info(`[dbcap] v${VERSION} active — session ${SESSION}. Panel top-left; __dbcap.download() in console.`);
})();
