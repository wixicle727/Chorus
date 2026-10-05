/**
 * Client for nuttylmao/smtc-bridge.
 *
 * smtc-bridge is a Flask app (default 127.0.0.1:5000) that mirrors Windows
 * System Media Transport Controls as JSON:
 *
 *   GET /now-playing  -> { app_version, os, current_session_id, sessions: [...] }
 *   GET /sessions     -> HTML (human debug view; deliberately unused here)
 *
 * Per session: source_app_id, media_properties, playback_info, timeline_properties.
 * We reimplement its semantics rather than its code; see selectSession() for the
 * session-picking heuristic smtc-bridge itself does not do (it only reports what
 * Windows considers "current", which is frequently null or the wrong window).
 */

import { fetchWithTimeout } from './utils.js';
import { platformForAppId, platformById, platformLabel } from '../config.js';

/** PlaybackStatus enum from SMTC. */
export const PlaybackStatus = {
  CLOSED: 0,
  OPENED: 1,
  CHANGING: 2,
  STOPPED: 3,
  PLAYING: 4,
  PAUSED: 5,
};

/** PlaybackType enum from SMTC. */
export const PlaybackType = {
  UNKNOWN: 0,
  MUSIC: 1,
  VIDEO: 2,
  IMAGE: 3,
};

export class BridgeClient {
  constructor(config) {
    this.baseUrl = String(config.smtc?.url ?? 'http://127.0.0.1:5000').replace(/\/+$/, '');
    this.timeoutMs = 4000;
  }

  setBaseUrl(url) {
    this.baseUrl = String(url ?? '').replace(/\/+$/, '');
  }

  /** Fetch the raw /now-playing payload. Throws with a friendly message on failure. */
  async fetchNowPlaying() {
    let res;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/now-playing`,
        { headers: { Accept: 'application/json' } },
        this.timeoutMs,
      );
    } catch (err) {
      const e = new Error(
        `smtc-bridge not reachable at ${this.baseUrl} (${err.name === 'TimeoutError' ? 'timed out' : err.message})`,
      );
      e.code = 'BRIDGE_UNREACHABLE';
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`smtc-bridge returned HTTP ${res.status} for /now-playing`);
      e.code = 'BRIDGE_BAD_STATUS';
      throw e;
    }
    return res.json();
  }

  /** Normalise one SMTC session into the shape the rest of the app uses. */
  static normalizeSession(raw) {
    const media = raw?.media_properties ?? {};
    const playback = raw?.playback_info ?? {};
    const timeline = raw?.timeline_properties ?? {};
    const appId = String(raw?.source_app_id ?? '');
    const platform = platformForAppId(appId);

    const positionMs = Number(timeline.Position) || 0;
    const endMs = Number(timeline.EndTime) || 0;
    const startMs = Number(timeline.StartTime) || 0;
    const lastUpdatedRaw = timeline.LastUpdatedTime ?? null;
    const lastUpdatedAt = lastUpdatedRaw ? Date.parse(lastUpdatedRaw) : Number.NaN;

    return {
      appId,
      platformId: platform?.id ?? null,
      platformName: platform ? platform.name : 'Unknown source',
      title: String(media.Title ?? '').trim(),
      artist: String(media.Artist ?? '').trim(),
      album: String(media.AlbumTitle ?? '').trim(),
      albumArtist: String(media.AlbumArtist ?? '').trim(),
      subtitle: String(media.Subtitle ?? '').trim(),
      genres: Array.isArray(media.Genres) ? media.Genres : [],
      // smtc-bridge always labels artwork as image/jpeg, but the bytes can be PNG/WebP.
      // Browsers sniff the real type, so pass the data URL through unchanged.
      thumbnail: typeof media.Thumbnail === 'string' ? media.Thumbnail : null,
      playbackStatus: Number(playback.PlaybackStatus) || 0,
      playbackType: Number(playback.PlaybackType) || 0,
      playbackRate: Number(playback.PlaybackRate) || 1,
      isShuffleActive: Boolean(playback.IsShuffleActive),
      autoRepeatMode: Number(playback.AutoRepeatMode) || 0,
      positionMs,
      startMs,
      endMs,
      durationMs: endMs > startMs ? endMs - startMs : 0,
      lastUpdatedAt: Number.isFinite(lastUpdatedAt) ? lastUpdatedAt : null,
      lastUpdatedRaw,
    };
  }

  /** All sessions, normalised, in the order Windows reported them. */
  async getSessions() {
    const payload = await this.fetchNowPlaying();
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    return {
      payload,
      currentSessionId: payload?.current_session_id ?? null,
      appVersion: payload?.app_version ?? null,
      os: payload?.os ?? null,
      sessions: sessions.map((s) => BridgeClient.normalizeSession(s)),
    };
  }
}

/** True when Windows considers this session to be actively producing sound. */
export function isPlaying(session) {
  return session?.playbackStatus === PlaybackStatus.PLAYING;
}

/**
 * Does this title look like a live stream, video page or browser tab rather than
 * a track?
 *
 * Used to stop a paused Twitch tab hijacking the overlay. It has to be careful:
 * a music library contains titles full of exclamation marks and @ signs —
 * `!NVADE SHOW!`, `BANG!`, `P@ssword` — and an over-eager rule silently discards
 * real songs, which looks exactly like a lyrics bug.
 *
 * So a single `!word` or `@handle` is NOT enough. A title is only rejected when
 * the stream signals are strong and repeated.
 */
export function looksLikeStreamTitle(title) {
  const text = String(title ?? '');
  if (!text.trim()) return true;

  // A URL in the title is decisive on its own.
  if (/https?:\/\/|www\./i.test(text)) return true;

  // Chat-command spam: `!skinplace !h1 !discord !socials` and friends. Requires
  // several, or one repeated, so a song title with an exclamation mark survives.
  const commandTokens = text.match(/[!！][a-z0-9_]{2,}/gi) ?? [];
  if (commandTokens.length >= 2) return true;
  if (commandTokens.length === 1 && /[!！][a-z0-9_]{2,}\s*$/i.test(text)) return true;

  // Explicit streaming vocabulary, typically bracketed on a browser tab.
  const STREAM_WORDS = /\b(live\s*(now|stream)|streaming|twitch|youtube\s*live|watch\s*live|just\s*chatting|subathon|!?(?:drops?\s*enabled)|new\s*follower|donation|sub\s*goal|raid)\b/i;
  if (STREAM_WORDS.test(text)) return true;

  // A calendar-style broadcast banner: `🍤 NEW WEEK UPON US 🍤 ... 🍤`.
  if ((text.match(/[🍤🔴🎮🎉✨⭐]/gu) ?? []).length >= 2) return true;

  return false;
}

/**
 * A track is a plausible music track if it has a title and does not look like a
 * live stream, video, or browser tab. A paused 4-hour Twitch tab must never win
 * over the music app the user actually configured.
 */
function isPlausibleTrack(session, maxTrackSeconds) {
  if (!session || !session.title) return false;
  if (/^unknown$/i.test(session.title)) return false;
  if (session.playbackType === PlaybackType.IMAGE) return false;
  if (maxTrackSeconds > 0 && session.durationMs > maxTrackSeconds * 1000) return false;
  // No known duration on a playing source means it is a live stream or a tab,
  // not a track: SMTC reports EndTime for real music.
  if (session.durationMs <= 0 && isPlaying(session)) return false;
  if (looksLikeStreamTitle(session.title)) return false;
  return true;
}

/**
 * Pick the session to display lyrics for.
 *
 * Order of preference:
 *   1. the configured primary platform, playing or paused;
 *   2. any session Windows reports as current, when it is playing;
 *   3. the newest playing plausible session;
 *   4. the newest music-typed plausible session.
 *
 * The configured platform deliberately outranks `current_session_id`: Windows
 * reports whatever has focus, which on a typical desktop is a browser tab rather
 * than the music app. A user who picks Spotify wants Spotify. Leaving the primary
 * platform also keeps the last known song on screen while it is paused instead of
 * blanking the overlay.
 */
export function selectSession(sessions, config) {
  const maxTrackSeconds = Number(config?.source?.maxTrackSeconds ?? 3600);
  const primaryId = config?.source?.primaryPlatform ?? 'spotify';
  const strategy = config?.source?.strategy ?? 'auto';
  const currentSessionId = config?.__currentSessionId ?? null;

  const plausible = sessions.filter((s) => isPlausibleTrack(s, maxTrackSeconds));
  if (plausible.length === 0) return null;

  const newest = (list) =>
    [...list].sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0))[0] ?? null;

  // 1. The user's chosen platform always wins when it has anything loaded.
  if (primaryId && primaryId !== 'other') {
    const primaryMatches = plausible.filter((s) => s.platformId === primaryId);
    if (primaryMatches.length > 0) {
      const playingPrimary = primaryMatches.filter(isPlaying);
      return newest(playingPrimary.length > 0 ? playingPrimary : primaryMatches);
    }
  }

  // 2. Trust Windows' focused session next (the default 'current' strategy stops here).
  if (currentSessionId) {
    const match = plausible.find((s) => s.appId === currentSessionId && isPlaying(s));
    if (match) return match;
  }

  // 3. Anything actually playing.
  const playing = plausible.filter(isPlaying);
  if (playing.length > 0) return newest(playing);

  // 4. Nothing is playing: prefer a music-typed session over a video one.
  const musicTyped = plausible.filter((s) => s.playbackType === PlaybackType.MUSIC);
  return newest(musicTyped.length > 0 ? musicTyped : plausible);
}

export { platformLabel };
