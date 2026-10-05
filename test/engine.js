/**
 * Engine behaviour tests against a fake smtc-bridge.
 *
 * These run the real Engine and a real Store against a local HTTP server that
 * imitates smtc-bridge's /now-playing payload, so timing behaviour can be
 * observed deterministically without Windows media sessions.
 *
 *   node test/engine.js
 *
 * The case that motivated this file: when playback paused, the engine emitted
 * nothing, so the overlay kept dead-reckoning from a stale "playing" anchor and
 * the lyrics carried on scrolling.
 */

import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/**
 * A stand-in for smtc-bridge. `position()` is evaluated per request so the
 * timeline advances in real time while playing, exactly like the real thing.
 */
function createFakeBridge() {
  const state = {
    playing: true,
    pausedAt: 0,
    startedAt: Date.now(),
    title: 'Engine Test Song',
    artist: 'Engine Test Artist',
    durationMs: 240000,
    basePositionMs: 60000,
    status: 4,
  };

  const server = http.createServer((req, res) => {
    const position = state.playing
      ? state.basePositionMs + (Date.now() - state.startedAt)
      : state.basePositionMs + (state.pausedAt - state.startedAt);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        app_version: 'test',
        os: 'Windows 11',
        current_session_id: 'Spotify.exe',
        sessions: [
          {
            source_app_id: 'Spotify.exe',
            media_properties: {
              Title: state.title,
              Artist: state.artist,
              AlbumTitle: 'Test Album',
              AlbumArtist: state.artist,
              Thumbnail: null,
              Genres: [],
            },
            playback_info: {
              PlaybackStatus: state.playing ? 4 : 5,
              PlaybackType: 1,
              PlaybackRate: 1,
              IsShuffleActive: false,
              AutoRepeatMode: 0,
            },
            timeline_properties: {
              Position: Math.round(position),
              StartTime: 0,
              EndTime: state.durationMs,
              LastUpdatedTime: new Date().toISOString(),
            },
          },
        ],
      }),
    );
  });

  return { server, state };
}

async function waitFor(predicate, timeoutMs = 4000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

const bridge = createFakeBridge();
await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
const port = bridge.server.address().port;

const config = loadConfig();
config.smtc.url = `http://127.0.0.1:${port}`;
config.smtc.pollIntervalMs = 100;
// Keep lyric lookups out of the way: this file tests timing, not matching.
config.lyrics.enabled = ['lrclib'];
config.lyrics.searchTimeoutMs = 1500;

const engine = new Engine(config, new Store(config));
const broadcasts = [];
engine.subscribe((event, payload) => {
  broadcasts.push({ playing: payload.playback?.playing, pos: payload.playback?.positionMs, at: Date.now() });
});

engine.start();
await waitFor(() => broadcasts.length >= 2);

section('Playback state broadcasting');

{
  check('engine reports the session as playing', engine.clock.playing === true, String(engine.clock.playing));
  check('broadcasts while playing say playing=true', broadcasts.every((b) => b.playing === true));

  const first = engine.positionMs();
  await new Promise((r) => setTimeout(r, 700));
  const later = engine.positionMs();
  check('position advances while playing', later > first, `${first} -> ${later}`);
}

{
  // The regression: pausing must reach the overlay.
  const before = broadcasts.length;
  bridge.state.pausedAt = Date.now();
  bridge.state.playing = false;

  const told = await waitFor(() => broadcasts.slice(before).some((b) => b.playing === false), 3000);
  check('pausing is broadcast to clients', told, `${broadcasts.length - before} broadcasts after pause`);

  const pausedBroadcast = broadcasts.slice(before).find((b) => b.playing === false);
  check('the paused broadcast carries playing=false', pausedBroadcast?.playing === false);

  // With playing=false the overlay must hold this exact position.
  const anchor = engine.positionMs();
  await new Promise((r) => setTimeout(r, 1200));
  const after = engine.positionMs();
  check('position is frozen while paused', after === anchor, `${anchor} -> ${after} (advanced ${after - anchor}ms)`);
  check('clock reports not playing', engine.clock.playing === false, String(engine.clock.playing));

  // No spurious broadcasts should accumulate while nothing changes.
  const quietBefore = broadcasts.length;
  await new Promise((r) => setTimeout(r, 800));
  const spam = broadcasts.length - quietBefore;
  check('paused state does not spam clients', spam <= 2, `${spam} broadcasts in 800ms while paused`);
}

section('Resuming');

{
  const before = broadcasts.length;
  bridge.state.basePositionMs = 90000;
  bridge.state.startedAt = Date.now();
  bridge.state.playing = true;

  const resumed = await waitFor(() => broadcasts.slice(before).some((b) => b.playing === true), 3000);
  check('resuming is broadcast to clients', resumed);

  const anchor = engine.positionMs();
  await new Promise((r) => setTimeout(r, 700));
  check('position advances again after resuming', engine.positionMs() > anchor, `${anchor} -> ${engine.positionMs()}`);
}

section('Track changes');

{
  const before = broadcasts.length;
  bridge.state.title = 'A Different Song';
  bridge.state.basePositionMs = 0;
  bridge.state.startedAt = Date.now();

  const changed = await waitFor(() => engine.state.track?.title === 'A Different Song', 3000);
  check('a new title is picked up', changed, engine.state.track?.title);
  const full = await waitFor(
    () => broadcasts.slice(before).some((b) => b.playing === true),
    3000,
  );
  check('clients keep being told about playback after a track change', full);
}

section('Cache bypass on refresh');

{
  /**
   * A negative result stored before the user changed a matching option must not
   * be reused. This is what made the fallback option look broken: the "no lyrics"
   * entry from before it was enabled kept being served.
   */
  const track = {
    appId: 'Spotify.exe',
    platformName: 'Spotify',
    title: 'Cache Bypass Song',
    artist: 'Cache Bypass Artist',
    album: '',
    durationMs: 200000,
  };
  engine.state.track = track;

  // Seed a negative cache entry, as an earlier lookup would have.
  engine.store.put(track, { status: 'notfound', provider: null, providerLabel: null, candidate: null, lines: [] });
  const seed = engine.store.get(track);
  check('a negative result is cached', seed?.status === 'notfound', String(seed?.status));

  // A plain resolve path would reuse it...
  const reused = engine.store.get(track);
  check('the cached negative result is served on a normal read', reused?.status === 'notfound');

  // ...but refresh() must ignore it.
  check('refresh sets the bypass flag', (() => {
    engine.bypassCacheOnce = false;
    engine.refresh().catch(() => {});
    return engine.bypassCacheOnce === true;
  })());
}

section('Idle heartbeat');

{
  /**
   * Between lyric lines a quiet passage can produce no state changes for minutes.
   * A client whose socket has silently died then has nothing to receive, so it
   * cannot notice, and keeps rendering stale lyrics while the server is fine.
   *
   * The engine therefore sends a full snapshot on a fixed interval even when
   * nothing has changed.
   */
  engine.state.lines = [
    { timeMs: 0, endMs: 1000, text: 'one', translation: null },
    { timeMs: 1000, endMs: 600000, text: 'two', translation: null },
  ];
  engine.state.track = {
    appId: 'Spotify.exe',
    title: 'Heartbeat Song',
    artist: 'Test',
    album: 'A',
    platformName: 'Spotify',
    durationMs: 600000,
  };
  // Pin the index so no line change can occur during the window.
  engine.state.lineIndex = 1;
  engine.lastEmittedIndex = 1;
  engine.lastEmittedNonce = engine.state.timelineNonce;
  engine.lastEmittedPlaying = engine.clock.playing;
  engine.lastEmitAt = Date.now();

  const seen = [];
  const unsubscribe = engine.subscribe((ev, payload) => {
    if (payload.reason === 'heartbeat') {
      seen.push({ full: payload.full, carriesLines: Array.isArray(payload.lyrics?.lines) });
    }
  });

  // HEARTBEAT_INTERVAL_MS is 20s; wait past it with slack for a loaded runner.
  await new Promise((resolve) => setTimeout(resolve, 24000));
  unsubscribe();

  check('an unchanged track still emits a heartbeat', seen.length >= 1, `${seen.length} in 24s`);
  check('the heartbeat is a full snapshot', seen.every((s) => s.full === true));
  check(
    'the heartbeat carries the lyric document, so a client can recover',
    seen.every((s) => s.carriesLines),
  );
}

engine.stop();
bridge.server.close();

console.log(`\n${'─'.repeat(56)}`);
if (failed === 0) console.log(`\u001b[32mAll ${passed} checks passed\u001b[0m`);
else console.log(`\u001b[31m${failed} failed\u001b[0m, ${passed} passed`);
console.log(`${'─'.repeat(56)}\n`);
process.exit(failed === 0 ? 0 : 1);
