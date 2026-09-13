'use strict';

// Minimal stand-in for the Discord desktop client's RPC IPC server.
// Speaks the real framing: 8-byte header (int32 LE opcode, int32 LE length) + JSON payload.
//   op 0 HANDSHAKE  → READY dispatch if client_id is accepted, else CLOSE {code:4000} and hang up
//   op 1 FRAME      → SET_ACTIVITY echoed back with the same nonce; everything else ack'd
//   op 2 CLOSE
//   op 3 PING → op 4 PONG
// Records every SET_ACTIVITY it receives so tests can assert on what Discord would have shown.

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function encode(op, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

function socketPath(id = 0) {
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir();
  return path.join(fs.realpathSync(dir), `discord-ipc-${id}`);
}

function start({ acceptClientIds, pipeId = 0, user = { id: '1', username: 'fake-discord', discriminator: '0' } } = {}) {
  const file = socketPath(pipeId);
  try { fs.unlinkSync(file); } catch { /* none */ }
  const activities = []; // { pid, activity|null, at }
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const payload = JSON.parse(buf.subarray(8, 8 + len).toString());
        buf = buf.subarray(8 + len);
        handle(sock, op, payload);
      }
    });
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
  });
  function handle(sock, op, msg) {
    if (op === OP.HANDSHAKE) {
      if (acceptClientIds && !acceptClientIds.includes(msg.client_id)) {
        sock.write(encode(OP.CLOSE, { code: 4000, message: 'Invalid Client ID' }));
        sock.end();
        return;
      }
      sock.write(encode(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', nonce: null, data: { v: 1, config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' }, user } }));
      return;
    }
    if (op === OP.PING) { sock.write(encode(OP.PONG, msg)); return; }
    if (op === OP.FRAME) {
      if (msg.cmd === 'SET_ACTIVITY') {
        activities.push({ pid: msg.args.pid, activity: msg.args.activity || null, at: Date.now() });
        sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', evt: null, nonce: msg.nonce, data: msg.args.activity || null }));
        return;
      }
      sock.write(encode(OP.FRAME, { cmd: msg.cmd, evt: null, nonce: msg.nonce, data: {} }));
    }
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => resolve({
      path: file,
      activities,
      dropClients() { for (const s of sockets) s.destroy(); },
      close() { return new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => { try { fs.unlinkSync(file); } catch { /* none */ } r(); }); }); },
    }));
  });
}

module.exports = { start, socketPath };
