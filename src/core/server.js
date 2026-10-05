/**
 * HTTP + WebSocket server.
 *
 * Serves the control panel and the OBS overlay from the same origin, exposes a
 * small JSON API, and pushes live state over /ws.
 *
 * Endpoints
 *   GET  /                      -> redirect to /control
 *   GET  /control               control panel
 *   GET  /overlay               OBS browser-source lyrics page
 *   GET  /api/health            liveness + versions
 *   GET  /api/config            current settings
 *   PUT  /api/config            merge a settings patch
 *   GET  /api/state             full current state snapshot
 *   GET  /api/sessions          raw smtc-bridge sessions
 *   GET  /api/providers         provider metadata
 *   GET  /api/cache             paginated lyric cache listing
 *   DELETE /api/cache           clear the lyric cache
 *   DELETE /api/cache/:hash     remove one entry
 *   GET  /api/history           recent tracks
 *   DELETE /api/history         clear history
 *   POST /api/refresh           re-resolve the current track (bypass cache)
 *   POST /api/candidate         apply a specific search candidate
 *   POST /api/manual            apply pasted LRC
 *   POST /api/offset            nudge the lyric offset
 *   POST /api/override/clear    forget the manual override for this track
 *   GET  /api/lrc               download the current lyrics as .lrc
 *
 * WS   /ws?role=overlay|control
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, loadConfig, saveConfig, applyPatch, PLATFORMS, PROVIDER_LABELS } from '../config.js';
import { WebSocketServer } from './websocket.js';
import { toLrcText } from './lrc.js';
import { getAutostartStatus, enableAutostart, disableAutostart } from './autostart.js';

const WEB_DIR = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** Serve a file from web/, refusing anything that escapes the directory. */
function serveStatic(res, relativePath, { download = null } = {}) {
  const target = path.resolve(WEB_DIR, relativePath);
  if (!target.startsWith(WEB_DIR)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      sendText(res, 404, `not found: /${relativePath}`);
      return;
    }
    const headers = {
      'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      // The overlay must never serve a stale cached page while the user is tuning it.
      'Cache-Control': 'no-cache',
    };
    if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;
    res.writeHead(200, headers);
    res.end(data);
  });
}

export function createServer({ engine, store, getConfig, setConfig, onShutdown = null }) {
  const ws = new WebSocketServer({ path: '/ws' });

  /** Which role each socket is, so the overlay can be told apart from the panel. */
  const roles = new WeakMap();

  ws.onConnection = (connection) => {
    const role = connection.query?.get('role') === 'overlay' ? 'overlay' : 'control';
    roles.set(connection, role);
    connection.send({ type: 'hello', role, serverTime: Date.now() });
    // New clients immediately get the full picture.
    connection.send(engine.snapshot({ full: true }));
    connection.on('message', (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      handleWsCommand(message, connection).catch((err) => {
        connection.send({ type: 'error', message: err.message });
      });
    });
  };

  async function handleWsCommand(message, connection) {
    switch (message?.type) {
      case 'ping':
        connection.send({ type: 'pong', serverTime: Date.now() });
        break;
      case 'refresh':
        await engine.refresh();
        break;
      default:
        break;
    }
  }

  /** Push state to every socket, but only send `lines` to clients that need them. */
  const onEngineState = (event, payload) => {
    for (const client of ws.clients) {
      const role = roles.get(client) ?? 'control';
      // The control panel always wants the full payload; the overlay only needs
      // the line array when it actually changed.
      if (role === 'overlay' && !payload.full) {
        const { lyrics, ...rest } = payload;
        client.send({ ...rest, lyrics: { ...lyrics, lines: undefined } });
      } else {
        client.send(payload);
      }
    }
  };
  engine.subscribe(onEngineState);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      sendText(res, 400, 'bad request');
      return;
    }
    const { pathname } = url;
    const method = req.method ?? 'GET';

    try {
      // ------------------------------- pages -------------------------------
      if (method === 'GET' && (pathname === '/' || pathname === '/control' || pathname === '/control/')) {
        serveStatic(res, 'control.html');
        return;
      }
      if (method === 'GET' && (pathname === '/overlay' || pathname === '/overlay/')) {
        serveStatic(res, 'overlay.html');
        return;
      }

      // -------------------------------- api --------------------------------
      if (pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          name: 'chorus',
          version: '1.0.0',
          node: process.version,
          uptimeSeconds: Math.round(process.uptime()),
          wsClients: ws.size,
          dataDir: store.stats().dataDir,
        });
        return;
      }

      if (pathname === '/api/providers') {
        sendJson(res, 200, {
          providers: Object.entries(PROVIDER_LABELS).map(([id, label]) => ({ id, label })),
          platforms: PLATFORMS.map((p) => ({ id: p.id, name: p.name })),
        });
        return;
      }

      if (pathname === '/api/log' && method === 'GET') {
        // Tail of the launcher log, so the control panel can show what the
        // hidden background server has been saying.
        const logPath = path.join(ROOT, 'data', 'logs', 'chorus.log');
        const requestedLines = Number(url.searchParams.get('lines') ?? 200);
        const maxLines = Math.min(Math.max(requestedLines || 200, 10), 2000);
        if (!fs.existsSync(logPath)) {
          sendJson(res, 200, { ok: true, path: logPath, exists: false, lines: [] });
          return;
        }
        try {
          const text = fs.readFileSync(logPath, 'utf8');
          const all = text.split(/\r?\n/);
          sendJson(res, 200, {
            ok: true,
            path: logPath,
            exists: true,
            bytes: Buffer.byteLength(text),
            lines: all.slice(Math.max(0, all.length - maxLines)),
          });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `could not read the log: ${err.message}` });
        }
        return;
      }

      if (pathname === '/api/autostart') {
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, ...(await getAutostartStatus()) });
          return;
        }
        if (method === 'POST' || method === 'PUT') {
          const body = await readBody(req);
          const result = body?.enabled ? await enableAutostart() : await disableAutostart();
          sendJson(res, result.ok ? 200 : 500, result);
          return;
        }
      }

      if (pathname === '/api/shutdown' && method === 'POST') {
        // Used by `--quit` and the tray's Quit action to stop a detached server.
        sendJson(res, 200, { ok: true, message: 'Chorus is shutting down' });
        if (typeof onShutdown === 'function') setTimeout(() => onShutdown(), 120);
        else setTimeout(() => process.exit(0), 120);
        return;
      }

      if (pathname === '/api/config') {
        if (method === 'GET') {
          sendJson(res, 200, getConfig());
          return;
        }
        if (method === 'PUT' || method === 'POST') {
          const patch = await readBody(req);
          const next = applyPatch(getConfig(), patch);
          setConfig(next);
          saveConfig(next);
          engine.updateConfig(next);
          engine.emitState({ reason: 'config', full: true });
          sendJson(res, 200, { ok: true, config: next });
          return;
        }
      }

      if (pathname === '/api/state' && method === 'GET') {
        sendJson(res, 200, engine.snapshot({ full: true }));
        return;
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        try {
          const snapshot = await engine.bridge.getSessions();
          sendJson(res, 200, {
            ok: true,
            currentSessionId: snapshot.currentSessionId,
            os: snapshot.os,
            appVersion: snapshot.appVersion,
            sessions: snapshot.sessions,
          });
        } catch (err) {
          sendJson(res, 200, { ok: false, error: err.message, sessions: [] });
        }
        return;
      }

      if (pathname === '/api/cache' && method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? 0);
        const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? 50), 200);
        const query = url.searchParams.get('query') ?? '';
        sendJson(res, 200, { ok: true, ...store.listCache({ page, pageSize, query }), stats: store.stats() });
        return;
      }

      if (pathname === '/api/cache' && method === 'DELETE') {
        store.clearCache();
        sendJson(res, 200, { ok: true, stats: store.stats() });
        return;
      }

      if (pathname.startsWith('/api/cache/') && method === 'DELETE') {
        const hash = pathname.slice('/api/cache/'.length);
        store.remove(hash);
        sendJson(res, 200, { ok: true, stats: store.stats() });
        return;
      }

      if (pathname === '/api/history') {
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, tracks: store.history.tracks.slice(0, 100) });
          return;
        }
        if (method === 'DELETE') {
          store.clearHistory();
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      if (pathname === '/api/refresh' && method === 'POST') {
        const body = await readBody(req);
        const result = await engine.refresh(body?.settings ?? null);
        sendJson(res, 200, result);
        return;
      }

      /**
       * Search every enabled provider for an arbitrary track.
       * Used by the control panel's "test a track" box and by the test suite;
       * it never disturbs what is currently playing.
       */
      if (pathname === '/api/probe' && method === 'POST') {
        const body = await readBody(req);
        if (!body?.title) {
          sendJson(res, 400, { ok: false, error: 'title is required' });
          return;
        }
        const { createRegistry, resolveLyrics } = await import('./match.js');
        const { PROVIDERS } = await import('../providers/index.js');
        const { mergeLyrics, buildLyricDoc } = await import('./lrc.js');
        const track = {
          title: String(body.title),
          artist: String(body.artist ?? ''),
          album: String(body.album ?? ''),
          durationMs: Number(body.durationMs) || 0,
        };
        const settings = { ...getConfig().lyrics, ...(body.settings ?? {}) };
        const candidates = [];
        const result = await resolveLyrics(createRegistry(PROVIDERS), track, settings, {
          onCandidate: (c) => candidates.push(c),
        });
        const lines = result.candidate
          ? buildLyricDoc(mergeLyrics(result.candidate.rawLyric, result.candidate.rawTranslation), track.durationMs)
          : [];
        sendJson(res, 200, {
          ok: true,
          status: result.status,
          errors: result.errors,
          winner: result.candidate
            ? {
                provider: result.candidate.provider,
                providerLabel: result.candidate.providerLabel,
                title: result.candidate.title,
                artist: result.candidate.artist,
                album: result.candidate.album,
                durationMs: result.candidate.durationMs,
                score: result.candidate.score,
              }
            : null,
          lineCount: lines.length,
          translatedLines: lines.filter((l) => l.translation).length,
          preview: lines.slice(0, 6),
          allCandidates: candidates.sort((a, b) => b.score - a.score),
        });
        return;
      }

      if (pathname === '/api/candidate' && method === 'POST') {
        const body = await readBody(req);
        if (!body?.provider || !body?.key) {
          sendJson(res, 400, { ok: false, error: 'provider and key are required' });
          return;
        }
        const result = await engine.applyCandidate(
          {
            provider: body.provider,
            providerLabel: PROVIDER_LABELS[body.provider] ?? body.provider,
            key: body.key,
            title: body.title ?? '',
            artist: body.artist ?? '',
            album: body.album ?? '',
            durationMs: body.durationMs ?? 0,
          },
          { remember: body.remember !== false },
        );
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/manual' && method === 'POST') {
        const body = await readBody(req);
        if (!body?.lrc) {
          sendJson(res, 400, { ok: false, error: 'lrc is required' });
          return;
        }
        const result = engine.setManualLyrics(body.lrc, {
          translation: body.translation ?? null,
          remember: body.remember !== false,
        });
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/offset' && method === 'POST') {
        const body = await readBody(req);
        const delta = Number(body?.deltaMs);
        if (!Number.isFinite(delta)) {
          sendJson(res, 400, { ok: false, error: 'deltaMs must be a number' });
          return;
        }
        const config = getConfig();
        const next = applyPatch(config, {
          window: { offsetMs: Math.round((Number(config.window.offsetMs) || 0) + delta) },
        });
        setConfig(next);
        saveConfig(next);
        engine.updateConfig(next);
        engine.state.timelineNonce += 1;
        engine.emitState({ reason: 'offset', full: false });
        sendJson(res, 200, { ok: true, offsetMs: next.window.offsetMs });
        return;
      }

      if (pathname === '/api/offset' && method === 'PUT') {
        const body = await readBody(req);
        const value = Number(body?.offsetMs);
        if (!Number.isFinite(value)) {
          sendJson(res, 400, { ok: false, error: 'offsetMs must be a number' });
          return;
        }
        const next = applyPatch(getConfig(), { window: { offsetMs: Math.round(value) } });
        setConfig(next);
        saveConfig(next);
        engine.updateConfig(next);
        engine.state.timelineNonce += 1;
        engine.emitState({ reason: 'offset', full: false });
        sendJson(res, 200, { ok: true, offsetMs: next.window.offsetMs });
        return;
      }

      if (pathname === '/api/override/clear' && method === 'POST') {
        sendJson(res, 200, engine.clearOverride());
        return;
      }

      if (pathname === '/api/overrides' && method === 'DELETE') {
        const removed = store.clearOverrides();
        engine.emitState({ reason: 'overrides-cleared', full: false });
        sendJson(res, 200, { ok: true, removed, stats: store.stats() });
        return;
      }

      if (pathname === '/api/lrc' && method === 'GET') {
        const lines = engine.state.lines ?? [];
        if (lines.length === 0) {
          sendText(res, 404, 'no lyrics loaded');
          return;
        }
        const includeTranslation = url.searchParams.get('translation') !== '0';
        const track = engine.state.track ?? {};
        const safeName = `${track.artist ?? 'unknown'} - ${track.title ?? 'track'}`.replace(/[<>:"/\\|?*]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}.lrc"`,
          'Cache-Control': 'no-store',
        });
        res.end(toLrcText(lines, { translation: includeTranslation }));
        return;
      }

      // ------------------------------- static ------------------------------
      if (method === 'GET') {
        const relative = pathname.replace(/^\/+/, '');
        // Unknown /api/* paths must 404 as JSON rather than falling through.
        if (relative.startsWith('api/')) {
          sendJson(res, 404, { ok: false, error: `unknown endpoint /${relative}` });
          return;
        }
        serveStatic(res, relative || 'control.html');
        return;
      }

      sendJson(res, 405, { ok: false, error: `${method} not allowed on ${pathname}` });
    } catch (err) {
      console.error(`[http] ${method} ${pathname} failed:`, err.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
      else res.end();
    } finally {
      const ms = Date.now() - started;
      if (ms > 1500) console.warn(`[http] slow request ${method} ${pathname} took ${ms}ms`);
    }
  });

  // WebSocket upgrade shares the same port and process.
  server.on('upgrade', (req, socket) => {
    if (!ws.handleUpgrade(req, socket)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port is already in use. Close whatever is using it, or change server.port in data/config.json.\n`);
      process.exit(1);
    }
    throw err;
  });

  return {
    server,
    ws,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          ws.startHeartbeat();
          resolve(server.address());
        });
      });
    },
    close() {
      ws.stopHeartbeat();
      for (const client of ws.clients) client.close(1001, 'server shutting down');
      engine.unsubscribe(onEngineState);
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
