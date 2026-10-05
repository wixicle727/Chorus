/**
 * A minimal RFC 6455 WebSocket server, so the app has zero npm dependencies.
 *
 * Only the subset this app needs is implemented: the opening handshake, text
 * frames (including continuation), ping/pong, and close. No compression and no
 * client masking enforcement beyond what the spec requires of servers.
 */

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** Encode a payload as a single unmasked frame (server -> client). */
export function encodeFrame(payload, opcode = OPCODE.TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

/**
 * Incremental frame decoder. Feed it socket chunks; it calls `onFrame` for each
 * complete frame and buffers partial ones.
 */
class FrameDecoder {
  constructor(onFrame) {
    this.buffer = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.fragments = [];
    this.fragmentOpcode = null;
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Loop while a whole frame is available.
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(16 * 1024 * 1024)) {
          this.onFrame({ type: 'error', message: 'frame too large' });
          return;
        }
        length = Number(big);
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);

      if (maskKey) {
        const copy = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i += 1) copy[i] = payload[i] ^ maskKey[i % 4];
        payload = copy;
      }

      this.handleFrame(fin, opcode, payload);
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === OPCODE.CLOSE) {
      this.onFrame({ type: 'close', payload });
      return;
    }
    if (opcode === OPCODE.PING) {
      this.onFrame({ type: 'ping', payload });
      return;
    }
    if (opcode === OPCODE.PONG) {
      this.onFrame({ type: 'pong', payload });
      return;
    }
    if (opcode === OPCODE.CONTINUATION) {
      this.fragments.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this.fragments);
      const originalOpcode = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = null;
      this.emitMessage(originalOpcode, full);
      return;
    }
    // TEXT or BINARY
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      return;
    }
    this.emitMessage(opcode, payload);
  }

  emitMessage(opcode, payload) {
    if (opcode === OPCODE.TEXT) {
      this.onFrame({ type: 'text', text: payload.toString('utf8') });
    } else if (opcode === OPCODE.BINARY) {
      this.onFrame({ type: 'binary', payload });
    }
  }
}

export class WebSocketConnection {
  constructor(socket, req, server) {
    this.socket = socket;
    this.req = req;
    this.server = server;
    this.closed = false;
    this.handlers = { message: [], close: [] };
    this.decoder = new FrameDecoder((frame) => this.onFrame(frame));
    this.isAlive = true;
    /** Consecutive pings sent without a pong; see startHeartbeat(). */
    this.missedPongs = 0;

    socket.on('data', (chunk) => {
      try {
        this.decoder.push(chunk);
      } catch (err) {
        this.close(1011, err.message);
      }
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    socket.setNoDelay(true);
  }

  onFrame(frame) {
    switch (frame.type) {
      case 'text':
        this.isAlive = true;
        this.missedPongs = 0;
        for (const handler of this.handlers.message) {
          try {
            handler(frame.text, this);
          } catch (err) {
            console.error('[ws] message handler failed:', err.message);
          }
        }
        break;
      case 'ping':
        this.missedPongs = 0;
        this.sendFrame(frame.payload, OPCODE.PONG);
        break;
      case 'pong':
        this.isAlive = true;
        this.missedPongs = 0;
        break;
      case 'close':
        this.close(1000);
        break;
      default:
        break;
    }
  }

  on(event, handler) {
    if (this.handlers[event]) this.handlers[event].push(handler);
    return this;
  }

  sendFrame(payload, opcode) {
    if (this.closed) return false;
    try {
      this.socket.write(encodeFrame(payload, opcode));
      return true;
    } catch {
      this.finish();
      return false;
    }
  }

  /** Send a JSON message. */
  send(data) {
    return this.sendFrame(JSON.stringify(data), OPCODE.TEXT);
  }

  ping() {
    this.sendFrame(Buffer.alloc(0), OPCODE.PING);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(String(reason), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.sendFrame(payload, OPCODE.CLOSE);
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.handlers.close) {
      try {
        handler(this);
      } catch {
        /* ignore */
      }
    }
    if (this.server) this.server.remove(this);
  }
}

export class WebSocketServer {
  constructor({ path: wsPath = '/ws', heartbeatMs = 30000 } = {}) {
    this.path = wsPath;
    this.clients = new Set();
    this.heartbeatMs = heartbeatMs;
    this.timer = null;
  }

  /** Returns true when the request was a WebSocket upgrade for our path and was handled. */
  handleUpgrade(req, socket) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return false;
    }
    if (url.pathname !== this.path) return false;

    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );

    const connection = new WebSocketConnection(socket, req, this);
    connection.query = url.searchParams;
    connection.pathname = url.pathname;
    this.clients.add(connection);
    connection.on('close', () => this.remove(connection));
    if (typeof this.onConnection === 'function') this.onConnection(connection);
    return true;
  }

  remove(connection) {
    this.clients.delete(connection);
  }

  broadcast(payload, filter = null) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.closed) continue;
      if (filter && !filter(client)) continue;
      client.sendFrame(text, OPCODE.TEXT);
    }
  }

  /**
   * Keep connections alive without punishing a client that is merely busy.
   *
   * A single missed pong used to close the socket, which is dangerous for the
   * OBS browser source: when the OBS window loses focus, Chromium throttles the
   * page and its pong can be delayed past the interval, so the overlay would be
   * disconnected for no real reason. Three consecutive misses are required
   * before a client is treated as dead.
   */
  startHeartbeat() {
    if (this.timer) return;
    const MISSES_BEFORE_CLOSE = 3;
    this.timer = setInterval(() => {
      for (const client of this.clients) {
        if (client.missedPongs >= MISSES_BEFORE_CLOSE) {
          client.close(1001, 'heartbeat timeout');
          continue;
        }
        client.missedPongs += 1;
        client.ping();
      }
    }, this.heartbeatMs);
    if (this.timer.unref) this.timer.unref();
  }

  stopHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get size() {
    return this.clients.size;
  }
}

export { OPCODE };
