import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEmbedded, readEmbedded } from './core/embedded.js';

/** Where this module lives: `<app>/src` in a source checkout, or the unpacked copy. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The application root.
 *
 * From source this is the project folder, whose `src` is this file's parent.
 *
 * Inside a bundled executable the code runs from an unpacked cache directory, and
 * using that as the root would put `data/` somewhere Windows may clear at any time —
 * losing the user's settings, cache and history without warning. The executable's own
 * folder is used instead, which also makes the packaged build behave like a portable
 * app: `data/` sits next to `Chorus.exe`.
 */
export const ROOT = isEmbedded() ? path.dirname(process.execPath) : path.resolve(MODULE_DIR, '..');

/**
 * The application version.
 *
 * Resolved once here because several modules need it — the startup banner, the health
 * endpoint — and a hardcoded copy in any of them drifts from package.json the moment a
 * release is cut. In a bundled executable package.json is embedded rather than on disk,
 * so the embedded copy is read first.
 */
export const VERSION = (() => {
  const sources = [];

  try {
    // Same module, so it is already loaded by the time this runs.
    const embedded = readEmbedded('package.json', 'utf8');
    if (embedded) sources.push(embedded);
  } catch {
    /* not embedded */
  }

  try {
    sources.push(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {
    /* no package.json beside the executable */
  }

  for (const text of sources) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.version) return parsed.version;
    } catch {
      /* try the next source */
    }
  }
  return '0.0.0';
})();

/** Music platforms we can recognise from a Windows SMTC app id (AUMID). */
export const PLATFORMS = [
  {
    id: 'spotify',
    name: 'Spotify',
    // Matched case-insensitively as substrings against source_app_id.
    match: ['spotify'],
    // Which lyric providers tend to carry this platform's catalogue best. Used only for tie-breaks.
    prefer: ['lrclib', 'netease', 'qq', 'kugou'],
  },
  {
    id: 'apple-music',
    name: 'Apple Music / iTunes',
    match: ['applemusic', 'itunes', 'music.ui', 'appleinc.applemusic'],
    prefer: ['lrclib', 'qq', 'netease', 'kugou'],
  },
  {
    id: 'deezer',
    name: 'Deezer',
    match: ['deezer'],
    prefer: ['lrclib', 'netease', 'qq', 'kugou'],
  },
  {
    id: 'youtube-music',
    name: 'YouTube Music',
    match: ['youtube music', 'youtubemusic', 'youtube-music'],
    prefer: ['lrclib', 'qq', 'netease', 'kugou'],
  },
  {
    id: 'youtube',
    name: 'YouTube (browser)',
    match: ['youtube'],
    prefer: ['lrclib', 'qq', 'netease', 'kugou'],
  },
  {
    id: 'netease',
    name: 'NetEase Cloud Music (网易云音乐)',
    match: ['cloudmusic', 'netease', 'orpheus'],
    prefer: ['netease', 'qq', 'kugou', 'lrclib'],
  },
  {
    id: 'qqmusic',
    name: 'QQ Music (QQ音乐)',
    match: ['qqmusic', 'tencent.qqmusic', 'qqmusic.exe'],
    prefer: ['qq', 'netease', 'kugou', 'lrclib'],
  },
  {
    id: 'kugou',
    name: 'Kugou (酷狗音乐)',
    match: ['kugou', 'kugoumusic'],
    prefer: ['kugou', 'qq', 'netease', 'lrclib'],
  },
  {
    id: 'kuwo',
    name: 'Kuwo (酷我音乐)',
    match: ['kuwo'],
    prefer: ['kugou', 'qq', 'netease', 'lrclib'],
  },
  {
    id: 'foobar',
    name: 'foobar2000',
    match: ['foobar'],
    prefer: ['lrclib', 'netease', 'qq', 'kugou'],
  },
  {
    id: 'aimp',
    name: 'AIMP',
    match: ['aimp'],
    prefer: ['lrclib', 'netease', 'qq', 'kugou'],
  },
  {
    id: 'vlc',
    name: 'VLC',
    match: ['vlc'],
    prefer: ['lrclib', 'netease', 'qq', 'kugou'],
  },
  {
    id: 'musicbee',
    name: 'MusicBee',
    match: ['musicbee'],
    prefer: ['lrclib', 'netease', 'qq', 'kugou'],
  },
  {
    id: 'mpv',
    name: 'mpv',
    match: ['mpv'],
    prefer: ['lrclib', 'netease', 'qq', 'kugou'],
  },
  {
    id: 'browser',
    name: 'Web browser (Chrome / Edge / Firefox)',
    match: ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'zen'],
    prefer: ['lrclib', 'qq', 'netease', 'kugou'],
  },
  {
    id: 'other',
    name: 'Anything else (generic)',
    match: [],
    prefer: ['lrclib', 'netease', 'qq', 'kugou'],
  },
];

export const PLATFORM_IDS = PLATFORMS.map((p) => p.id);

export const PROVIDER_IDS = ['lrclib', 'netease', 'qq', 'kugou'];

export const PROVIDER_LABELS = {
  lrclib: 'LRCLIB',
  netease: 'NetEase Cloud Music',
  qq: 'QQ Music',
  kugou: 'Kugou',
};

export const DEFAULTS = {
  server: {
    port: 6727,
  },
  app: {
    /**
     * Mirror of the Windows Run-key registration. The registry itself is the
     * source of truth (it is what actually launches Chorus); this records what
     * the toggle last set so the UI can show intent.
     */
    autostart: false,
    /** Also open the control panel in a browser when launched at sign-in. */
    openControlOnStart: false,
  },
  smtc: {
    // Chorus starts its own bundled bridge on this port by default, so there is no
    // second program to install. Point this at a stock smtc-bridge (or any other
    // source serving the same API) to use that instead.
    url: 'http://127.0.0.1:5000',
    pollIntervalMs: 500,
    /**
     * The bundled bridge in tools/smtc-bridge.
     *
     * managed: Chorus starts and stops it, and adopts anything already listening on
     * the port instead of fighting over it — so a user running the stock
     * smtc-bridge keeps working untouched.
     */
    bridge: {
      managed: true,
      port: 5000,
    },
  },
  source: {
    // Platform ids are matched by AUMID substring; anything unmatched falls back to "best playing session".
    primaryPlatform: 'spotify',
    // Session selection: 'auto' = primary platform, else newest playing session.
    // 'current' = trust smtc-bridge current_session_id first.
    strategy: 'auto',
    // Ignore video/stream sessions (long-running browser tabs etc.) when nothing else is playing.
    maxTrackSeconds: 3600,
  },
  lyrics: {
    enabled: PROVIDER_IDS.slice(),
    providerOrder: PROVIDER_IDS.slice(),
    // Prefer this provider when it returns a well-scoring result.
    preferredProvider: 'lrclib',
    // A candidate at or above this confidence is accepted outright.
    acceptScore: 75,
    // Candidates below this are never used.
    minScore: 40,
    // How far a candidate's duration may differ from the SMTC track length.
    durationToleranceMs: 8000,
    searchTimeoutMs: 6000,
    // Ask every provider in parallel and keep all scored candidates for the control panel.
    collectAlternatives: true,
    /**
     * When the main source has no lyrics, fall back to the single best result
     * from the other sources — but only if it scores at least `fallback.minScore`.
     * Below that the overlay stays blank until the next track rather than showing
     * words for the wrong song.
     */
    fallback: {
      enabled: false,
      minScore: 85,
    },
  },
  cache: {
    // Reuse cached lyrics only when the durations also line up.
    durationToleranceMs: 3000,
    maxEntries: 500,
    ttlDays: 60,
  },
  overlay: {
    visibleLines: 3,
    lineHeightPx: 100,
    // Overlay canvas size for OBS; the page fills whatever the browser source is.
    fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Meiryo", system-ui, sans-serif',
    lineScale: 1,
    activeMainScale: 1.9,
    inactiveMainScale: 0.95,
    activeSubScale: 1.25,
    inactiveSubScale: 0.64,
    alignment: 'center',
    showTranslation: true,
    translationAsMain: false,
    hideTranslationOnInstrumental: true,
    colorMain: '#ffffff',
    colorSub: '#e0e0e0',
    colorActive: '#ffffff',
    shadow: 3,
    uppercase: false,
    /** Opacity applied to non-active lines. */
    idleOpacity: 0.55,
    // Blank lead-in text shown before the first timed line.
    leadInText: '',
    // Hide all text when playback is paused.
    hideOnPause: false,
    // Empty lines render a musical note placeholder instead of nothing.
    showPlaceholder: true,
  },
  window: {
    // Gap before a line becomes active, in ms (positive = lyrics appear earlier).
    offsetMs: 0,
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base?.[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Where `config.json` lives.
 *
 * Resolved here rather than importing the shared data-directory helper, because
 * `paths.js` imports ROOT from this module — importing back would be circular. The
 * order of preference must match `paths.js` exactly or settings would be read from one
 * place and written to another:
 *
 *   CHORUS_DATA_DIR, or an existing data/ beside the app (portable installs and
 *   upgrades), otherwise %LOCALAPPDATA%\Chorus\data.
 */
function resolveDataDir() {
  const override = process.env.CHORUS_DATA_DIR;
  if (override) return override;

  const legacy = path.join(ROOT, 'data');
  if (fs.existsSync(legacy)) return legacy;

  try {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Chorus', 'data');
  } catch {
    return legacy;
  }
}

const CONFIG_PATH = path.join(resolveDataDir(), 'config.json');

export function configPath() {
  return CONFIG_PATH;
}

export function loadConfig() {
  let stored = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('[config] ignoring unreadable data/config.json:', err.message);
    stored = {};
  }
  const merged = deepMerge(DEFAULTS, stored);
  // Guard against nonsense values that would break the poll loop.
  merged.smtc.pollIntervalMs = Math.min(Math.max(Number(merged.smtc.pollIntervalMs) || 500, 100), 5000);
  merged.server.port = Number(merged.server.port) || DEFAULTS.server.port;
  merged.lyrics.enabled = (Array.isArray(merged.lyrics.enabled) ? merged.lyrics.enabled : PROVIDER_IDS)
    .filter((id) => PROVIDER_IDS.includes(id));
  if (merged.lyrics.enabled.length === 0) merged.lyrics.enabled = ['lrclib'];
  return merged;
}

export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

/** Merge a partial patch into a config object, clamping and normalising as loadConfig does. */
export function applyPatch(cfg, patch) {
  const merged = deepMerge(cfg, patch);
  merged.smtc.pollIntervalMs = Math.min(Math.max(Number(merged.smtc.pollIntervalMs) || 500, 100), 5000);
  merged.lyrics.enabled = (Array.isArray(merged.lyrics.enabled) ? merged.lyrics.enabled : PROVIDER_IDS)
    .filter((id) => PROVIDER_IDS.includes(id));
  if (merged.lyrics.enabled.length === 0) merged.lyrics.enabled = ['lrclib'];
  return merged;
}

export function platformById(id) {
  return PLATFORMS.find((p) => p.id === id) ?? null;
}

/**
 * Resolve a Windows SMTC app id to one of our platform descriptors.
 * Matching is a case-insensitive substring test against each platform's `match` list,
 * most specific first, so `youtube music` wins over `youtube`.
 */
export function platformForAppId(appId) {
  if (!appId) return null;
  const lower = String(appId).toLowerCase();
  const ordered = [...PLATFORMS].sort((a, b) => {
    const longest = (p) => p.match.reduce((n, m) => Math.max(n, m.length), 0);
    return longest(b) - longest(a);
  });
  for (const platform of ordered) {
    for (const needle of platform.match) {
      if (needle && lower.includes(needle)) return platform;
    }
  }
  return null;
}

export function platformLabel(appId) {
  const platform = platformForAppId(appId);
  return platform ? platform.name : 'Unknown source';
}
