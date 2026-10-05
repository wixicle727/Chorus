/**
 * WebSocket helper for the tests.
 *
 * A thin wrapper over Node's built-in global `WebSocket` (available from Node 21,
 * and 22 is this project's minimum). It exists so the suite gets a promise-based
 * "collect messages for N milliseconds" helper instead of hand-rolling one at each
 * call site.
 */

/** Node's global WebSocket has been available since v21; 22 is the minimum here. */
function requireWebSocket() {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error(
      `this project requires Node 22 or newer, but global WebSocket is unavailable on ${process.version}`,
    );
  }
  return globalThis.WebSocket;
}

/**
 * Open a WebSocket, collect parsed JSON messages for `waitMs`, then close.
 *
 * Deliberately does not answer pings, so the caller can prove the server tolerates
 * a silent client.
 *
 * @returns {Promise<{messages: any[], error?: string}>}
 */
export async function collectMessages(url, { waitMs = 2500 } = {}) {
  const WebSocketImpl = requireWebSocket();

  return new Promise((resolve) => {
    const messages = [];
    let settled = false;
    let socket;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* already closing */
      }
      resolve(error ? { messages, error } : { messages });
    };

    const timer = setTimeout(() => finish(), waitMs);

    try {
      socket = new WebSocketImpl(url);
    } catch (err) {
      finish(err.message);
      return;
    }

    socket.onmessage = (event) => {
      try {
        messages.push(JSON.parse(event.data));
      } catch {
        /* ignore non-JSON frames */
      }
    };
    socket.onerror = () => finish('socket error');
  });
}
