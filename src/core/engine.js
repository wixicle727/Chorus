/**
 * The engine: polls smtc-bridge, decides what is playing, resolves lyrics, and
 * derives the live lyric position for the overlay.
 *
 * Design mirrors AF-Media-Bar: a poll/derive loop that is cheap when nothing
 * changed, a lyric lookup that runs once per track, and a resettable timeline
 * that corrects itself on every poll (SMTC's Position is a snapshot taken at
 * LastUpdatedTime, not a live clock).
 */

import { BridgeClient, selectSession, isPlaying, PlaybackStatus } from './bridge.js';
import { activeIndexAt, buildLyricDoc, mergeLyrics } from './lrc.js';
import { createRegistry, resolveLyrics } from './match.js';
import { PROVIDERS } from '../providers/index.js';
import { clamp } from './utils.js';
import { cacheKey } from './store.js';

export const EngineStatus = {
  OK: 'ok',
  BRIDGE_DOWN: 'bridge-down',
  IDLE: 'idle',
};

/**
 * How often an unchanged track still produces a full snapshot.
 *
 * Between lyric lines a quiet passage can be silent for minutes, leaving a client
 * with nothing to receive. The overlay uses that silence to detect a dead socket,
 * and the snapshot also heals any drift it has accumulated.
 */
const HEARTBEAT_INTERVAL_MS = 20000;

export class Engine extends EventEmitterLike {
  constructor(config, store) {
    super();
    this.config = config;
    this.store = store;
    this.bridge = new BridgeClient(config);
    this.registry = createRegistry(PROVIDERS);

    this.timer = null;
    this.lookupToken = 0;

    this.state = {
      status: EngineStatus.IDLE,
      error: null,
      sessions: [],
      currentSessionId: null,
      appVersion: null,
      os: null,
      track: null,
      lyricStatus: 'idle', // idle | searching | matched | notfound | error | instrumental
      lyricError: null,
      provider: null,
      providerLabel: null,
      candidate: null,
      alternatives: [],
      lines: [],
      lineIndex: -1,
      fromCache: false,
      /** Widen this when the user nudges the offset so the overlay resyncs. */
      timelineNonce: 0,
    };

    /** Dead-reckoning anchor: { anchorMs, wallClockMs, playing }. */
    this.clock = { anchorMs: 0, wallClockMs: 0, playing: false };
    this.currentTrackId = null;
    this.lastEmittedIndex = -2;
    this.lastEmittedNonce = -1;
    /** Last play/pause state sent, so a pause is always broadcast. */
    this.lastEmittedPlaying = null;
    /** When the last snapshot went out, used for the idle heartbeat. */
    this.lastEmitAt = 0;
    /** Set by refresh() so the next track resolution skips the cache once. */
    this.bypassCacheOnce = false;
    this.lastTrackSignature = null;
  }

  updateConfig(config) {
    this.config = config;
    this.bridge.setBaseUrl(config.smtc.url);
    this.store.updateConfig(config);
  }

  start() {
    if (this.timer) return;
    const interval = Number(this.config.smtc.pollIntervalMs) || 500;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[engine] tick failed:', err.message));
    }, interval);
    if (this.timer.unref) this.timer.unref();
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* --------------------------- live position --------------------------- */

  /** Current playback position in ms, interpolated between polls. */
  positionMs() {
    const { anchorMs, wallClockMs, playing } = this.clock;
    if (!playing) return anchorMs;
    return anchorMs + (Date.now() - wallClockMs);
  }

  effectiveOffsetMs() {
    const override = this.state.track ? this.store.getOverride(this.state.track) : null;
    const base = Number(this.config?.window?.offsetMs ?? 0);
    return base + (Number(override?.offsetMs) || 0);
  }

  /** Index of the lyric line that should be on screen right now. */
  currentLineIndex() {
    const { lines } = this.state;
    if (!lines || lines.length === 0) return -1;
    const position = clamp(this.positionMs(), 0, Number.MAX_SAFE_INTEGER);
    return activeIndexAt(lines, position, this.effectiveOffsetMs());
  }

  /* ------------------------------ polling ------------------------------ */

  async tick() {
    let snapshot;
    try {
      snapshot = await this.bridge.getSessions();
    } catch (err) {
      if (this.state.status !== EngineStatus.BRIDGE_DOWN) {
        this.state.status = EngineStatus.BRIDGE_DOWN;
        this.state.error = err.message;
        this.state.sessions = [];
        this.state.track = null;
        this.emitState({ reason: 'bridge-down' });
      } else {
        this.state.error = err.message;
      }
      return;
    }

    if (this.state.status === EngineStatus.BRIDGE_DOWN) {
      this.state.error = null;
    }
    this.state.appVersion = snapshot.appVersion;
    this.state.os = snapshot.os;
    this.state.currentSessionId = snapshot.currentSessionId;
    this.state.sessions = snapshot.sessions.map((s) => ({
      appId: s.appId,
      platformId: s.platformId,
      platformName: s.platformName,
      title: s.title,
      artist: s.artist,
      album: s.album,
      durationMs: s.durationMs,
      positionMs: s.positionMs,
      playbackStatus: s.playbackStatus,
      isPlaying: isPlaying(s),
      thumbnail: s.thumbnail,
    }));

    const configForSelection = { ...this.config, __currentSessionId: snapshot.currentSessionId };
    const chosen = selectSession(snapshot.sessions, configForSelection);

    if (!chosen) {
      this.state.status = EngineStatus.IDLE;
      this.clock = { anchorMs: 0, wallClockMs: Date.now(), playing: false };
      if (this.state.track) {
        this.state.track = null;
        this.state.lines = [];
        this.state.lineIndex = -1;
        this.state.lyricStatus = 'idle';
        this.currentTrackId = null;
        this.emitState({ reason: 'idle', full: true });
      }
      return;
    }

    this.state.status = EngineStatus.OK;

    // Re-anchor the clock. Position is only valid as of LastUpdatedTime, so add
    // however long ago that was, then let positionMs() dead-reckon forward.
    const age = chosen.lastUpdatedAt ? Math.max(0, Date.now() - chosen.lastUpdatedAt) : 0;
    const playing = isPlaying(chosen);
    this.clock = {
      anchorMs: chosen.positionMs + (playing ? age : 0),
      wallClockMs: Date.now(),
      playing,
    };

    const signature = `${chosen.appId}\u0000${chosen.title}\u0000${chosen.artist}\u0000${chosen.album}\u0000${Math.round(
      chosen.durationMs / 1000,
    )}`;

    if (signature !== this.lastTrackSignature) {
      this.lastTrackSignature = signature;
      await this.onTrackChanged(chosen);
    }

    this.emitterTick();
  }

  /* --------------------------- track handling --------------------------- */

  async onTrackChanged(session) {
    const track = {
      appId: session.appId,
      platformId: session.platformId,
      platformName: session.platformName,
      title: session.title,
      artist: session.artist,
      album: session.album,
      durationMs: session.durationMs,
    };
    this.state.track = track;
    this.state.lines = [];
    this.state.lineIndex = -1;
    this.state.lyricError = null;
    this.state.alternatives = [];
    this.state.candidate = null;
    this.state.provider = null;
    this.state.providerLabel = null;
    this.state.fromCache = false;
    this.currentTrackId = cacheKey(track);
    this.lastEmittedIndex = -2;

    // A manual override short-circuits everything.
    const override = this.store.getOverride(track);
    if (override?.lines?.length) {
      this.state.lines = buildLyricDoc(override.lines, track.durationMs);
      this.state.lyricStatus = 'matched';
      this.state.providerLabel = override.providerLabel ?? 'Manual';
      this.state.provider = 'manual';
      this.state.manual = true;
      this.state.timelineNonce += 1;
      this.store.addHistory({ ...track, status: 'matched', providerLabel: this.state.providerLabel });
      this.emitState({ reason: 'track', full: true });
      return;
    }

    const cached = this.store.get(track);
    if (cached && !this.bypassCacheOnce) {
      this.applyResolved({
        status: cached.status,
        provider: cached.provider,
        providerLabel: cached.providerLabel,
        candidate: cached.candidate,
        alternatives: cached.alternatives ?? [],
        lines: cached.lines,
        hasTranslation: cached.hasTranslation,
        estimated: cached.estimated,
        viaFallback: cached.viaFallback,
        fromCache: true,
      });
      this.store.addHistory({ ...track, status: cached.status, providerLabel: cached.providerLabel });
      return;
    }
    // Honour the one-shot bypass, then clear it so the cache applies to every
    // later track: a negative result stored before the user changed a matching
    // option would otherwise be reused forever.
    this.bypassCacheOnce = false;

    // Emit immediately with the "searching" state so the overlay can show the
    // new track without waiting for the network.
    this.state.lyricStatus = 'searching';
    this.emitState({ reason: 'track-searching', full: true });

    const token = ++this.lookupToken;
    await this.lookup(track, token);
  }

  async lookup(track, token, settingsOverride = null) {
    const settings = { ...this.config.lyrics, ...(settingsOverride ?? {}) };
    try {
      const result = await resolveLyrics(this.registry, track, settings, {
        shouldAbort: () => token !== this.lookupToken,
      });
      if (token !== this.lookupToken) return; // a newer track took over

      if (result.status === 'matched' && result.candidate) {
        const lines = buildLyricDoc(
          mergeLyrics(result.candidate.rawLyric, result.candidate.rawTranslation),
          track.durationMs,
        );
        const hasTranslation = lines.some((l) => l.translation);
        const payload = {
          status: 'matched',
          provider: result.candidate.provider,
          providerLabel: result.candidate.providerLabel,
          candidate: result.candidate,
          alternatives: result.alternatives ?? [],
          lines,
          hasTranslation,
          errors: result.errors,
          // Present when the main source had nothing and another source was used.
          viaFallback: Boolean(result.viaFallback),
          // Present when timings were approximated from untimed plain lyrics.
          estimated: Boolean(result.estimated),
          fallbackReason: result.fallbackReason ?? null,
        };
        this.store.put(track, payload);
        this.store.addHistory({ ...track, status: 'matched', providerLabel: payload.providerLabel });
        if (token !== this.lookupToken) return;
        this.applyResolved(payload);
        return;
      }

      // No usable lyric: distinguish "provider says instrumental" from "nothing found".
      const instrumental = Boolean(result.instrumentalCandidate);
      const payload = {
        status: 'notfound',
        provider: result.instrumentalCandidate?.provider ?? null,
        providerLabel: result.instrumentalCandidate?.providerLabel ?? null,
        candidate: result.instrumentalCandidate ?? null,
        alternatives: result.alternatives ?? [],
        lines: [],
        hasTranslation: false,
        errors: result.errors,
        // The fallback option was on, but the best other source scored below the
        // threshold, so the overlay stays blank on purpose until the next track.
        blankUntilNextTrack: Boolean(result.blankUntilNextTrack),
        fallbackReason: result.fallbackReason ?? null,
      };
      this.store.put(track, payload);
      this.store.addHistory({ ...track, status: 'notfound', providerLabel: payload.providerLabel });
      if (token !== this.lookupToken) return;
      this.state.lyricStatus = instrumental ? 'instrumental' : 'notfound';
      this.state.lyricError = result.errors?.length ? result.errors.join('; ') : null;
      this.state.provider = payload.provider;
      this.state.providerLabel = payload.providerLabel;
      this.state.candidate = payload.candidate;
      this.state.alternatives = payload.alternatives;
      this.state.lines = [];
      this.state.lineIndex = -1;
      this.state.fromCache = false;
      this.state.viaFallback = false;
      this.state.estimated = false;
      this.state.fallbackReason = payload.fallbackReason;
      this.state.blankUntilNextTrack = payload.blankUntilNextTrack;
      this.state.timelineNonce += 1;
      this.emitState({ reason: 'track-resolved', full: true });
    } catch (err) {
      if (token !== this.lookupToken) return;
      this.state.lyricStatus = 'error';
      this.state.lyricError = err.message;
      this.emitState({ reason: 'track-error', full: true });
    }
  }

  applyResolved(payload) {
    this.state.lines = payload.lines ?? [];
    this.state.lyricStatus = payload.lines?.length ? payload.status ?? 'matched' : 'notfound';
    this.state.provider = payload.provider ?? null;
    this.state.providerLabel = payload.providerLabel ?? null;
    this.state.candidate = payload.candidate ?? null;
    this.state.alternatives = payload.alternatives ?? [];
    this.state.lyricError = payload.errors?.length ? payload.errors.join('; ') : null;
    this.state.fromCache = Boolean(payload.fromCache);
    // Manual means "these lyrics did not come from a provider for this track",
    // whether they were pasted or chosen from the candidate list.
    this.state.manual = payload.provider === 'manual' || Boolean(payload.manual);
    this.state.blankUntilNextTrack = Boolean(payload.blankUntilNextTrack);
    /** True when timings were approximated; carried through cache hits too. */
    this.state.estimated = Boolean(payload.estimated);
    this.state.fallbackReason = payload.fallbackReason ?? null;
    // Derived as well as passed through, so a cache hit reports the same thing a
    // fresh lookup would: lyrics that did not come from the configured main source.
    const preferred = this.config?.lyrics?.preferredProvider;
    this.state.viaFallback =
      payload.provider && payload.provider !== 'manual' && Boolean(preferred)
        ? payload.provider !== preferred
        : Boolean(payload.viaFallback);
    this.state.timelineNonce += 1;
    this.emitState({ reason: 'track-resolved', full: true });
  }

  /**
   * Force a fresh lookup for the current track.
   *
   * Deliberately bypasses the cache. A negative ("no lyrics") result may have been
   * stored before the user changed a matching option — turning on the fallback,
   * lowering a threshold, enabling another source — and reusing it would make the
   * new option appear to do nothing.
   */
  async refresh(settingsOverride = null) {
    const { track } = this.state;
    if (!track) return { ok: false, error: 'nothing is playing' };
    this.lookupToken += 1;
    const token = this.lookupToken;
    this.bypassCacheOnce = true;
    this.state.lyricStatus = 'searching';
    this.emitState({ reason: 'refresh', full: true });
    await this.lookup(track, token, settingsOverride);
    this.bypassCacheOnce = false;
    return { ok: true };
  }

  /** Manually attach a specific candidate's lyrics to the current track. */
  async applyCandidate(candidate, { remember = true } = {}) {
    const { track } = this.state;
    if (!track) return { ok: false, error: 'nothing is playing' };
    const provider = this.registry.get(candidate.provider);
    if (!provider) return { ok: false, error: `unknown provider ${candidate.provider}` };
    try {
      const body = await provider.fetchLyrics(candidate, track, this.config.lyrics);
      const lines = buildLyricDoc(mergeLyrics(body.rawLyric, body.rawTranslation), track.durationMs);
      if (lines.length === 0) return { ok: false, error: 'that result has no lyrics' };
      const payload = {
        status: 'matched',
        provider: candidate.provider,
        providerLabel: candidate.providerLabel ?? provider.label,
        candidate,
        alternatives: [],
        lines,
        hasTranslation: lines.some((l) => l.translation),
        manual: remember,
      };
      this.store.put(track, payload);
      if (remember) this.store.setOverride(track, { provider: candidate.provider, key: candidate.key, lines });
      this.lookupToken += 1;
      this.applyResolved(payload);
      return { ok: true, lines: lines.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Apply a manual LRC paste to the current track. */
  setManualLyrics(lrcText, { translation = null, remember = true } = {}) {
    const { track } = this.state;
    if (!track) return { ok: false, error: 'nothing is playing' };
    const lines = buildLyricDoc(mergeLyrics(lrcText, translation), track.durationMs);
    if (lines.length === 0) return { ok: false, error: 'could not parse any timed lines from that text' };
    const payload = {
      status: 'matched',
      provider: 'manual',
      providerLabel: 'Manual',
      candidate: { provider: 'manual', key: 'manual', title: track.title, artist: track.artist },
      alternatives: [],
      lines,
      hasTranslation: lines.some((l) => l.translation),
      manual: remember,
    };
    this.store.put(track, payload);
    if (remember) {
      this.store.setOverride(track, { provider: 'manual', key: 'manual', lines, providerLabel: 'Manual' });
    }
    this.lookupToken += 1;
    this.state.manual = true;
    this.applyResolved(payload);
    return { ok: true, lines: lines.length };
  }

  clearOverride() {
    const { track } = this.state;
    if (!track) return { ok: false, error: 'nothing is playing' };
    this.store.setOverride(track, null);
    return { ok: true };
  }

  /* ----------------------------- emitting ----------------------------- */

  /**
   * Cheap per-poll emit: fires when the active line changed, when the timeline
   * was explicitly invalidated, when playback started or stopped, or when the
   * heartbeat interval has elapsed.
   *
   * The play/stop case matters: the overlay dead-reckons its position from the
   * anchor it was last sent, so if a pause were never broadcast it would keep
   * advancing and the lyrics would carry on scrolling. Line index alone is not
   * a sufficient change signal.
   *
   * The heartbeat matters for a different reason: between lyric lines a quiet
   * track can produce no messages at all for minutes. A client that has silently
   * lost its socket then has no way to notice, and keeps rendering stale lyrics.
   * A periodic full snapshot gives it something to receive, and heals any drift.
   */
  emitterTick() {
    const index = this.currentLineIndex();
    const playing = this.clock.playing;
    const now = Date.now();
    const heartbeatDue = now - this.lastEmitAt >= HEARTBEAT_INTERVAL_MS;

    const changed =
      index !== this.lastEmittedIndex ||
      this.state.timelineNonce !== this.lastEmittedNonce ||
      playing !== this.lastEmittedPlaying;
    const isHeartbeat = !changed && heartbeatDue;

    if (changed || isHeartbeat) {
      this.lastEmittedIndex = index;
      this.lastEmittedNonce = this.state.timelineNonce;
      this.lastEmittedPlaying = playing;
      this.lastEmitAt = now;
      this.state.lineIndex = index;
      // Only a heartbeat carries the lyric document again. A plain line change
      // stays a delta, because the client already has the lines.
      this.emitState({ reason: isHeartbeat ? 'heartbeat' : 'tick', full: isHeartbeat });
    }
  }

  /** Snapshot handed to WebSocket clients and the control panel. */
  snapshot({ full = true } = {}) {
    const lines = this.state.lines ?? [];
    const index = this.state.lineIndex;
    const positionMs = Math.round(this.positionMs());
    const current = index >= 0 ? lines[index] : null;
    const next = index + 1 < lines.length ? lines[index + 1] : null;
    return {
      type: 'state',
      serverTime: Date.now(),
      status: this.state.status,
      error: this.state.error,
      os: this.state.os,
      appVersion: this.state.appVersion,
      currentSessionId: this.state.currentSessionId,
      sessions: this.state.sessions,
      track: this.state.track
        ? {
            ...this.state.track,
            thumbnail:
              this.state.sessions.find((s) => s.appId === this.state.track.appId)?.thumbnail ?? null,
          }
        : null,
      playback: {
        positionMs,
        durationMs: this.state.track?.durationMs ?? 0,
        playing: this.clock.playing,
        status: this.state.sessions.find((s) => s.appId === this.state.track?.appId)?.playbackStatus ?? null,
        /**
         * False when the player publishes no track length.
         *
         * foobar2000 (and some other players) report title and artist to Windows
         * but no timeline, so position stays at 0 and lyrics can never advance.
         * Surfacing it lets the panel explain the situation instead of looking
         * broken.
         */
        timelineAvailable: (this.state.track?.durationMs ?? 0) > 0,
      },
      lyrics: {
        status: this.state.lyricStatus,
        error: this.state.lyricError,
        provider: this.state.provider,
        providerLabel: this.state.providerLabel,
        candidate: this.state.candidate
          ? {
              provider: this.state.candidate.provider,
              providerLabel: this.state.candidate.providerLabel,
              key: this.state.candidate.key,
              title: this.state.candidate.title,
              artist: this.state.candidate.artist,
              album: this.state.candidate.album,
              durationMs: this.state.candidate.durationMs,
              score: this.state.candidate.score,
              breakdown: this.state.candidate.breakdown,
            }
          : null,
        alternatives: (this.state.alternatives ?? []).map((c) => ({
          provider: c.provider,
          providerLabel: c.providerLabel,
          key: c.key,
          title: c.title,
          artist: c.artist,
          album: c.album,
          durationMs: c.durationMs,
          score: c.score,
          breakdown: c.breakdown,
        })),
        fromCache: this.state.fromCache,
        manual: Boolean(this.state.manual),
        /** True when the main source had no lyrics and another source was used. */
        viaFallback: Boolean(this.state.viaFallback),
        /** True when timings were approximated from untimed plain lyrics. */
        estimated: Boolean(this.state.estimated),
        fallbackReason: this.state.fallbackReason ?? null,
        /** Fallback was enabled but nothing reached the threshold: stay blank. */
        blankUntilNextTrack: Boolean(this.state.blankUntilNextTrack),
        offsetMs: this.effectiveOffsetMs(),
        lineCount: lines.length,
        // Send the full line set when it changed; the overlay keeps its own copy
        // and only needs index updates in between.
        lines: full ? lines : undefined,
      },
      // Only song changes carry `lines`; the overlay uses these to resync.
      lineIndex: index,
      nextLineMs: next ? Math.max(0, next.timeMs - positionMs) : -1,
      currentLine: current
        ? { text: current.text, translation: current.translation, timeMs: current.timeMs, endMs: current.endMs }
        : null,
      timelineNonce: this.state.timelineNonce,
      // Presentation settings travel with every full snapshot so the OBS browser
      // source picks up control-panel changes live, without a page reload.
      settings: this.config.overlay,
      full,
    };
  }

  emitState(meta = {}) {
    const full = meta.full !== false;
    const payload = this.snapshot({ full });
    payload.reason = meta.reason ?? 'update';
    this.emit('state', payload);
  }
}

/**
 * Minimal event emitter.
 *
 * Methods are deliberately named subscribe/unsubscribe rather than on/off:
 * Node 22 gives every object an `on` via EventEmitter.prototype, which silently
 * shadows a subclass method of the same name.
 */
function EventEmitterLike() {
  this.listeners = new Set();
}
EventEmitterLike.prototype.subscribe = function subscribe(fn) {
  this.listeners.add(fn);
  return () => this.listeners.delete(fn);
};
EventEmitterLike.prototype.unsubscribe = function unsubscribe(fn) {
  return this.listeners.delete(fn);
};
EventEmitterLike.prototype.emit = function emit(event, payload) {
  for (const fn of this.listeners) {
    try {
      fn(event, payload);
    } catch (err) {
      console.error('[engine] listener failed:', err.message);
    }
  }
};

export { PlaybackStatus };
