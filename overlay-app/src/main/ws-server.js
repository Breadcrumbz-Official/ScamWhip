
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_MESSAGE_BYTES = 1024 * 1024;

class BridgeServer extends EventEmitter {

  constructor(options) {
    super();
    this.options = {
      port: 17311,
      host: '127.0.0.1',
      token: '',
      allowUnauthenticated: false,
      protocolVersion: 1,
      ...options
    };
    this.clients = new Set();
    this.server = null;
    this.listening = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.listening) return resolve(this.address());

      this.server = http.createServer((req, res) => this.handleHttp(req, res));
      this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

      this.server.on('error', (err) => {
        this.listening = false;
        this.emit('error', err);
        reject(err);
      });

      this.server.on('clientError', (err, socket) => {
        this.emit('socket-error', err);
        try { socket.destroy(); } catch {  }
      });

      this.server.listen(this.options.port, this.options.host, () => {
        this.listening = true;
        this.emit('listening', this.address());
        resolve(this.address());
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const client of this.clients) this.closeClient(client, 1001, 'server shutting down');
      this.clients.clear();
      if (!this.server) return resolve();
      this.server.close(() => {
        this.listening = false;
        this.server = null;
        resolve();
      });
    });
  }

  address() {
    return { host: this.options.host, port: this.options.port, url: `ws://${this.options.host}:${this.options.port}` };
  }

  get clientCount() {
    return this.clients.size;
  }

  handleHttp(req, res) {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        app: 'scamwhip-overlay',
        protocol: this.options.protocolVersion,
        clients: this.clients.size,
        requiresToken: !!this.options.token && !this.options.allowUnauthenticated
      }));
      return;
    }
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('ScamWhip bridge — WebSocket only. Try /health.\n');
  }

  handleUpgrade(req, socket, head) {

    socket.on('error', (err) => {
      this.emit('socket-error', err);
      try { socket.destroy(); } catch {  }
    });

    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      safely(() => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    const wrote = safely(() => socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    ));
    if (!wrote) return;
    safely(() => socket.setNoDelay(true));

    const url = new URL(req.url, 'http://localhost');
    const client = {
      socket,
      buffer: head && head.length ? Buffer.from(head) : Buffer.alloc(0),
      fragments: [],
      fragmentOp: null,
      alive: true,
      authed: false,
      info: {
        name: url.searchParams.get('client') || 'unknown',
        version: url.searchParams.get('v') || '?',
        remote: socket.remoteAddress
      }
    };

    const requiresToken = this.options.token && !this.options.allowUnauthenticated;
    const supplied = url.searchParams.get('token') || '';
    if (requiresToken && !safeEqual(supplied, this.options.token)) {
      this.emit('rejected', { reason: 'bad-token', info: client.info });
      this.sendFrame(client, OP.CLOSE, closePayload(4401, 'bad pairing code'));

      setTimeout(() => safely(() => socket.destroy()), 50);
      return;
    }
    client.authed = true;

    this.clients.add(client);
    socket.on('data', (chunk) => this.onData(client, chunk));
    socket.on('error', () => this.dropClient(client));
    socket.on('close', () => this.dropClient(client));

    socket.on('end', () => this.dropClient(client));

    this.emit('connection', client.info);
    this.sendTo(client, {
      type: 'hello',
      app: 'scamwhip-overlay',
      protocol: this.options.protocolVersion,
      clients: this.clients.size
    });
  }

  onData(client, chunk) {
    client.buffer = client.buffer.length ? Buffer.concat([client.buffer, chunk]) : chunk;

    for (;;) {
      const frame = decodeFrame(client.buffer);
      if (!frame) return;
      if (frame.error) {
        this.closeClient(client, 1002, frame.error);
        return;
      }
      client.buffer = client.buffer.subarray(frame.consumed);
      this.handleFrame(client, frame);
    }
  }

  handleFrame(client, frame) {
    switch (frame.opcode) {
      case OP.PING:
        this.sendFrame(client, OP.PONG, frame.payload);
        break;

      case OP.PONG:
        client.alive = true;
        break;

      case OP.CLOSE:
        this.sendFrame(client, OP.CLOSE, frame.payload);
        this.dropClient(client);
        break;

      case OP.CONT:
      case OP.TEXT:
      case OP.BINARY: {
        if (frame.opcode !== OP.CONT) {
          client.fragmentOp = frame.opcode;
          client.fragments = [];
        }
        client.fragments.push(frame.payload);
        const total = client.fragments.reduce((n, b) => n + b.length, 0);
        if (total > MAX_MESSAGE_BYTES) {
          this.closeClient(client, 1009, 'message too big');
          return;
        }
        if (!frame.fin) return;

        const payload = Buffer.concat(client.fragments);
        client.fragments = [];
        if (client.fragmentOp !== OP.TEXT) return;

        let message;
        try {
          message = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        if (message && typeof message.type === 'string') {
          client.alive = true;
          if (message.type === 'ping') {
            this.sendTo(client, { type: 'pong' });
          } else if (message.type === 'hello') {
            client.info = { ...client.info, ...message, type: undefined };
            this.emit('client-hello', client.info);
          }
          this.emit('message', message, client.info);
        }
        break;
      }

      default:
        this.closeClient(client, 1002, `unsupported opcode ${frame.opcode}`);
    }
  }

  broadcast(object) {
    let sent = 0;
    for (const client of this.clients) if (this.sendTo(client, object)) sent += 1;
    return sent;
  }

  sendTo(client, object) {
    const json = JSON.stringify({ v: this.options.protocolVersion, ts: Date.now(), ...object });
    return this.sendFrame(client, OP.TEXT, Buffer.from(json, 'utf8'));
  }

  sendFrame(client, opcode, payload = Buffer.alloc(0)) {
    if (!client.socket || client.socket.destroyed) return false;
    try {
      client.socket.write(encodeFrame(opcode, payload));
      return true;
    } catch {
      this.dropClient(client);
      return false;
    }
  }

  closeClient(client, code, reason) {
    this.sendFrame(client, OP.CLOSE, closePayload(code, reason));
    this.dropClient(client);
  }

  dropClient(client) {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    try { client.socket.destroy(); } catch {  }
    this.emit('disconnection', client.info);
  }

  sweep() {
    for (const client of this.clients) {
      if (!client.alive) {
        this.closeClient(client, 1001, 'no pong');
        continue;
      }
      client.alive = false;
      this.sendFrame(client, OP.PING);
    }
  }
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_MESSAGE_BYTES)) return { error: 'frame too big' };
    length = Number(big);
    offset += 8;
  }

  if (!masked) return { error: 'client frame was not masked' };
  if (buffer.length < offset + 4) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;

  if (buffer.length < offset + length) return null;
  const payload = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) payload[i] = buffer[offset + i] ^ mask[i & 3];

  return { fin, opcode, payload, consumed: offset + length };
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;

  return Buffer.concat([header, payload]);
}

function closePayload(code, reason = '') {
  const text = Buffer.from(String(reason).slice(0, 120), 'utf8');
  const buffer = Buffer.allocUnsafe(2 + text.length);
  buffer.writeUInt16BE(code, 0);
  text.copy(buffer, 2);
  return buffer;
}

function safely(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { BridgeServer, OP };
