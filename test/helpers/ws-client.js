/**
 * A minimal WebSocket client for the tests.
 *
 * Node exposes a global `WebSocket` only from v21, so a test that calls
 * `new WebSocket(...)` throws on Node 20 — which is a declared supported version.
 * The runtime never needs a client (it only serves), so rather than raise the
 * minimum Node version for a test, this implements just enough of RFC 6455 to
 * connect, read text frames and answer pings, using nothing but `net` and
 * `crypto`.
 *
 * Only what the tests need: no permessage-deflate, no binary frames.
 */

import crypto from 'node:crypto';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** Frame a payload as a masked client frame (clients must mask). */
function encodeClientFrame(payload, opcode = OPCODE.TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];

  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, mask, masked]);
}

/**
 * Connect to a ws:// URL.
 *
 * @returns {Promise<{send:(data:any)=>void, close:()=>void, onMessage:(fn:(data:string)=>void)=>void, onClose:(fn:(code?:number)=>void)=>void}>}
 */
export function connect(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:') {
      reject(new Error(`only ws:// is supported, got ${parsed.protocol}`));
      return;
    }

    const key = crypto.randomBytes(16).toString('base64');
    const path = `${parsed.pathname}${parsed.search}`;
    const socket = net.connect(Number(parsed.port || 80), parsed.hostname);

    let settled = false;
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    const messageHandlers = [];
    const closeHandlers = [];
    const fragments = [];
    let fragmentOpcode = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`websocket connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const emitClose = (code) => {
      for (const fn of closeHandlers) {
        try {
          fn(code);
        } catch {
          /* ignore */
        }
      }
    };

    socket.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    socket.on('close', () => {
      clearTimeout(timer);
      if (!handshakeDone && !settled) {
        settled = true;
        reject(new Error('socket closed before the handshake completed'));
        return;
      }
      emitClose();
    });

    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${parsed.hostname}:${parsed.port || 80}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'),
      );
    });

    const handleFrame = (fin, opcode, payload) => {
      if (opcode === OPCODE.PING) {
        socket.write(encodeClientFrame(payload, OPCODE.PONG));
        return;
      }
      if (opcode === OPCODE.PONG) return;
      if (opcode === OPCODE.CLOSE) {
        socket.end();
        return;
      }
      if (opcode === OPCODE.CONTINUATION) {
        fragments.push(payload);
        if (!fin) return;
        const full = Buffer.concat(fragments);
        const original = fragmentOpcode;
        fragments.length = 0;
        fragmentOpcode = null;
        if (original === OPCODE.TEXT) for (const fn of messageHandlers) fn(full.toString('utf8'));
        return;
      }
      if (opcode === OPCODE.TEXT || opcode === 0x2) {
        if (!fin) {
          fragmentOpcode = opcode;
          fragments.push(payload);
          return;
        }
        if (opcode === OPCODE.TEXT) {
          const text = payload.toString('utf8');
          for (const fn of messageHandlers) fn(text);
        }
      }
    };

    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const status = head.split('\r\n')[0];
        if (!/101/.test(status)) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`server refused the upgrade: ${status}`));
          return;
        }
        handshakeDone = true;
        settled = true;
        clearTimeout(timer);
        resolve({
          send(data) {
            socket.write(encodeClientFrame(typeof data === 'string' ? data : JSON.stringify(data)));
          },
          close() {
            try {
              socket.write(encodeClientFrame(Buffer.alloc(0), OPCODE.CLOSE));
            } catch {
              /* ignore */
            }
            socket.end();
          },
          onMessage(fn) {
            messageHandlers.push(fn);
          },
          onClose(fn) {
            closeHandlers.push(fn);
          },
        });
      }

      // Decode as many complete frames as the buffer holds. Server frames are
      // unmasked, so there is no mask key to strip.
      for (;;) {
        if (buffer.length < 2) return;
        const first = buffer[0];
        const second = buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.length < offset + 2) return;
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) return;
          length = Number(buffer.readBigUInt64BE(offset));
          offset += 8;
        }

        let maskKey = null;
        if (masked) {
          if (buffer.length < offset + 4) return;
          maskKey = buffer.subarray(offset, offset + 4);
          offset += 4;
        }
        if (buffer.length < offset + length) return;

        let payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (maskKey) {
          const copy = Buffer.allocUnsafe(payload.length);
          for (let i = 0; i < payload.length; i += 1) copy[i] = payload[i] ^ maskKey[i % 4];
          payload = copy;
        }
        handleFrame(fin, opcode, payload);
      }
    });
  });
}

/**
 * Open a WebSocket, collect messages, and close after `waitMs`.
 * Prefers Node's built-in client when present, so the tests also exercise it.
 */
export async function collectMessages(url, { waitMs = 2500 } = {}) {
  if (typeof globalThis.WebSocket === 'function') {
    return new Promise((resolve) => {
      const messages = [];
      let socket;
      try {
        socket = new globalThis.WebSocket(url);
      } catch (err) {
        resolve({ messages, error: err.message, client: 'node' });
        return;
      }
      const done = () => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        resolve({ messages, client: 'node' });
      };
      socket.onmessage = (event) => {
        try {
          messages.push(JSON.parse(event.data));
        } catch {
          /* ignore non-JSON */
        }
      };
      socket.onerror = () => done();
      setTimeout(done, waitMs);
    });
  }

  // Node 20: fall back to the minimal client above.
  const client = await connect(url);
  const messages = [];
  client.onMessage((text) => {
    try {
      messages.push(JSON.parse(text));
    } catch {
      /* ignore non-JSON */
    }
  });
  await new Promise((r) => setTimeout(r, waitMs));
  client.close();
  return { messages, client: 'fallback' };
}
