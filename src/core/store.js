/**
 * Persistence: resolved-lyrics cache, search history, and per-track overrides.
 *
 * Everything lives under data/ as plain JSON so the user can inspect, edit or
 * delete it by hand. There is no database dependency.
 *
 *   data/config.json       app settings (see src/config.js)
 *   data/cache/index.json  cache metadata + LRU bookkeeping
 *   data/cache/<hash>.json one resolved lyric per track
 *   data/history.json      recently played tracks and how the lookup went
 *   data/overrides.json    manual "use THIS lyric for THIS track" decisions
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CACHE_DIR, INDEX_PATH, HISTORY_PATH, OVERRIDES_PATH, ensureDataDirs } from './paths.js';

function ensureDirs() {
  ensureDataDirs();
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[store] could not read ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Stable identity for a track: normalised-ish title/artist plus a bucketed duration. */
export function cacheKey(track) {
  const payload = [
    String(track.title ?? '').trim().toLowerCase(),
    String(track.artist ?? '').trim().toLowerCase(),
    String(Math.round((Number(track.durationMs) || 0) / 1000)),
  ].join('\u0000');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** Short key used by overrides, which must survive small duration differences. */
function overrideKey(track) {
  const payload = [
    String(track.title ?? '').trim().toLowerCase(),
    String(track.artist ?? '').trim().toLowerCase(),
  ].join('\u0000');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

export class Store {
  constructor(config) {
    this.config = config;
    this.index = readJson(INDEX_PATH, { entries: {} });
    if (!this.index.entries) this.index.entries = {};
    this.history = readJson(HISTORY_PATH, { tracks: [] });
    if (!Array.isArray(this.history.tracks)) this.history.tracks = [];
    this.overrides = readJson(OVERRIDES_PATH, { tracks: {} });
    if (!this.overrides.tracks) this.overrides.tracks = {};
  }

  updateConfig(config) {
    this.config = config;
  }

  /* ----------------------------- cache ----------------------------- */

  entryPath(hash) {
    return path.join(CACHE_DIR, `${hash}.json`);
  }

  /**
   * Look up a cached lyric for a track.
   * Returns null on miss, on expiry, or when the cached duration disagrees with
   * the playing track (a live version and a studio version share a title).
   */
  get(track) {
    const hash = cacheKey(track);
    const meta = this.index.entries[hash];
    if (!meta) return null;

    const ttlMs = (Number(this.config?.cache?.ttlDays) || 60) * 86400000;
    if (meta.savedAt && Date.now() - meta.savedAt > ttlMs) {
      this.remove(hash);
      return null;
    }

    const toleranceMs = Number(this.config?.cache?.durationToleranceMs ?? 3000);
    if (meta.durationMs > 0 && track.durationMs > 0 && Math.abs(meta.durationMs - track.durationMs) > toleranceMs) {
      return null;
    }

    const payload = readJson(this.entryPath(hash), null);
    if (!payload || !Array.isArray(payload.lines)) {
      this.remove(hash);
      return null;
    }
    meta.lastUsedAt = Date.now();
    meta.hits = (meta.hits ?? 0) + 1;
    this.saveIndex();
    return { ...payload, hash, fromCache: true };
  }

  /** Persist a resolved lyric (status may be 'matched' or 'notfound'). */
  put(track, result) {
    const hash = cacheKey(track);
    const payload = {
      hash,
      savedAt: Date.now(),
      track: {
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        durationMs: track.durationMs ?? 0,
        platform: track.platformName ?? '',
        appId: track.appId ?? '',
      },
      status: result.status,
      provider: result.provider ?? null,
      providerLabel: result.providerLabel ?? null,
      candidate: result.candidate
        ? {
            key: result.candidate.key,
            title: result.candidate.title,
            artist: result.candidate.artist,
            album: result.candidate.album,
            durationMs: result.candidate.durationMs,
            score: result.candidate.score,
          }
        : null,
      hasTranslation: Boolean(result.hasTranslation),
      /** True when timings were estimated from untimed plain lyrics. */
      estimated: Boolean(result.estimated),
      viaFallback: Boolean(result.viaFallback),
      lines: result.lines ?? [],
      alternatives: (result.alternatives ?? []).slice(0, 12),
      manual: Boolean(result.manual),
    };
    writeJsonAtomic(this.entryPath(hash), payload);
    this.index.entries[hash] = {
      hash,
      title: payload.track.title,
      artist: payload.track.artist,
      status: payload.status,
      provider: payload.provider,
      providerLabel: payload.providerLabel,
      durationMs: payload.track.durationMs,
      lineCount: payload.lines.length,
      savedAt: payload.savedAt,
      lastUsedAt: Date.now(),
      hits: 0,
      manual: payload.manual,
    };
    this.saveIndex();
    this.evict();
    return payload;
  }

  remove(hash) {
    try {
      fs.rmSync(this.entryPath(hash), { force: true });
    } catch {
      /* ignore */
    }
    delete this.index.entries[hash];
    this.saveIndex();
  }

  clearCache() {
    ensureDirs();
    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (file === 'index.json') continue;
      try {
        fs.rmSync(path.join(CACHE_DIR, file), { force: true });
      } catch {
        /* ignore */
      }
    }
    this.index.entries = {};
    this.saveIndex();
  }

  listCache({ page = 0, pageSize = 50, query = '' } = {}) {
    let items = Object.values(this.index.entries);
    if (query) {
      const q = query.toLowerCase();
      items = items.filter(
        (e) => e.title?.toLowerCase().includes(q) || e.artist?.toLowerCase().includes(q),
      );
    }
    items.sort((a, b) => (b.lastUsedAt ?? b.savedAt ?? 0) - (a.lastUsedAt ?? a.savedAt ?? 0));
    const total = items.length;
    const start = Math.max(0, page) * pageSize;
    return { total, page, pageSize, items: items.slice(start, start + pageSize) };
  }

  /** Keep the cache under maxEntries by dropping the least recently used. */
  evict() {
    const max = Number(this.config?.cache?.maxEntries ?? 500);
    const items = Object.values(this.index.entries);
    if (items.length <= max) return;
    items.sort((a, b) => (a.lastUsedAt ?? a.savedAt ?? 0) - (b.lastUsedAt ?? b.savedAt ?? 0));
    for (const item of items.slice(0, items.length - max)) this.remove(item.hash);
  }

  saveIndex() {
    writeJsonAtomic(INDEX_PATH, this.index);
  }

  /* ---------------------------- history ---------------------------- */

  /** Record a track the engine saw, merging repeats of the same song. */
  addHistory(entry) {
    const key = cacheKey(entry);
    const existing = this.history.tracks.find((t) => t.hash === key);
    if (existing) {
      existing.plays = (existing.plays ?? 1) + 1;
      existing.at = Date.now();
      existing.status = entry.status ?? existing.status;
      existing.providerLabel = entry.providerLabel ?? existing.providerLabel;
    } else {
      this.history.tracks.unshift({
        hash: key,
        title: entry.title,
        artist: entry.artist,
        album: entry.album ?? '',
        durationMs: entry.durationMs ?? 0,
        platform: entry.platformName ?? '',
        appId: entry.appId ?? '',
        status: entry.status ?? 'pending',
        providerLabel: entry.providerLabel ?? null,
        at: Date.now(),
        plays: 1,
      });
    }
    this.history.tracks = this.history.tracks.slice(0, 300);
    this.saveHistory();
  }

  saveHistory() {
    writeJsonAtomic(HISTORY_PATH, this.history);
  }

  clearHistory() {
    this.history.tracks = [];
    this.saveHistory();
  }

  /* --------------------------- overrides --------------------------- */

  getOverride(track) {
    return this.overrides.tracks[overrideKey(track)] ?? null;
  }

  setOverride(track, value) {
    const key = overrideKey(track);
    if (!value) delete this.overrides.tracks[key];
    else this.overrides.tracks[key] = { ...value, at: Date.now() };
    writeJsonAtomic(OVERRIDES_PATH, this.overrides);
    return this.overrides.tracks[key] ?? null;
  }

  /** Forget every remembered "use this lyric for this track" decision. */
  clearOverrides() {
    const count = Object.keys(this.overrides.tracks).length;
    this.overrides.tracks = {};
    writeJsonAtomic(OVERRIDES_PATH, this.overrides);
    return count;
  }

  /* ----------------------------- stats ----------------------------- */

  stats() {
    const entries = Object.values(this.index.entries);
    return {
      cacheEntries: entries.length,
      withLyrics: entries.filter((e) => e.status === 'matched' && e.lineCount > 0).length,
      notFound: entries.filter((e) => e.status !== 'matched').length,
      manual: entries.filter((e) => e.manual).length,
      historyTracks: this.history.tracks.length,
      overrides: Object.keys(this.overrides.tracks).length,
      dataDir: DATA_DIR,
    };
  }
}

export { DATA_DIR, CACHE_DIR };
