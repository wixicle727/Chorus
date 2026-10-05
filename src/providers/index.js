/**
 * Lyric providers.
 *
 * Every provider implements:
 *   id, label
 *   search(track, settings)   -> Candidate[]
 *   fetchLyrics(candidate, track, settings) -> { rawLyric, rawTranslation, format }
 *
 * Candidate: { key, title, artist, album, durationMs }
 * `rawLyric` / `rawTranslation` are always LRC text (or plain text), never base64,
 * so the parser and the control panel only ever deal with one representation.
 *
 * Endpoints were verified against the live services from Node (with a desktop
 * User-Agent, and a Referer where the service demands one).
 */

import {
  base64ToUtf8,
  getJson,
  getText,
  postJson,
  safeJsonParse,
  withQuery,
} from '../core/utils.js';

/**
 * Convert untimed lyrics into a timed LRC document.
 *
 * Used for LRCLIB's `plainLyrics`, which has no timestamps at all. Lines are
 * spread evenly over the track with a lead-in and tail gap, so the overlay has
 * something sensible to scroll. The timing is an approximation — the caller marks
 * the result `estimated` — but showing correctly-timed-ish real lyrics is far
 * better than showing nothing or showing a worse-scoring match.
 *
 * @param {string} plain      raw lyric text, newline separated
 * @param {number} durationMs track length, used to lay the lines out
 */
export function plainToEstimatedLrc(plain, durationMs) {
  const lines = String(plain ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  // Reserve 6% at the start and 4% at the end for intro and outro.
  const startMs = Math.max(1500, Math.round(durationMs * 0.06)) || 1500;
  const endMs = durationMs > 0 ? Math.max(startMs + 1000, Math.round(durationMs * 0.96)) : startMs + lines.length * 4000;
  const span = Math.max(1000, endMs - startMs);
  const step = span / lines.length;

  const stamp = (ms) => {
    const total = Math.max(0, Math.round(ms));
    const m = Math.floor(total / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const cs = Math.floor((total % 1000) / 10);
    return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
  };

  return `${lines.map((line, index) => `${stamp(startMs + index * step)}${line}`).join('\n')}\n`;
}

/* ------------------------------------------------------------------ *
 * LRCLIB — public, no key, no headers, returns synced LRC directly.
 * ------------------------------------------------------------------ */

const lrclib = {
  id: 'lrclib',
  label: 'LRCLIB',
  // LRCLIB search is anchored on the exact metadata, so it is cheap to try variants.
  maxQueries: 3,

  async search(track, settings) {
    const timeoutMs = settings.searchTimeoutMs;
    const variants = [];
    if (track.title && track.artist) {
      variants.push({ track_name: track.title, artist_name: track.artist });
    }
    if (track.title) variants.push({ track_name: track.title });
    if (track.title) variants.push({ q: track.title });

    const seen = new Set();
    const results = [];
    for (const params of variants.slice(0, this.maxQueries)) {
      let list;
      try {
        list = await getJson(withQuery('https://lrclib.net/api/search', params), { timeoutMs });
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const durationMs = Math.round((Number(item.duration) || 0) * 1000);
        const dedupeKey = `${item.trackName}|${item.artistName}|${durationMs}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        results.push({
          key: String(item.id),
          title: String(item.trackName ?? item.name ?? ''),
          artist: String(item.artistName ?? ''),
          album: String(item.albumName ?? ''),
          durationMs,
          // Prefer entries that actually carry synced lyrics.
          hasSynced: Boolean(item.syncedLyrics),
          instrumental: Boolean(item.instrumental),
        });
      }
      if (results.some((r) => r.hasSynced)) break; // good enough, stop querying
    }
    return results;
  },

  async fetchLyrics(candidate) {
    const item = await getJson(`https://lrclib.net/api/get/${encodeURIComponent(candidate.key)}`);
    const synced = item?.syncedLyrics ?? '';
    if (synced) {
      return { rawLyric: synced, rawTranslation: null, format: 'lrc', hasSync: true };
    }

    /**
     * LRCLIB frequently holds only untimed plain text (`syncedLyrics: null`).
     * That is still real lyrics and must not be discarded just because it lacks
     * timestamps — dropping it is what let a 97-scoring match lose to a
     * 63-scoring one that happened to be timed.
     *
     * The text is converted to a timed document spread across the track duration
     * and flagged `estimated`, so it is usable and honestly labelled rather than
     * pretending to be an official sync.
     */
    const plain = item?.plainLyrics ?? '';
    const durationMs = Math.round((Number(item?.duration) || 0) * 1000) || candidate.durationMs || 0;
    return {
      rawLyric: plain ? plainToEstimatedLrc(plain, durationMs) : '',
      rawTranslation: null,
      format: plain ? 'plain-estimated' : 'plain',
      hasSync: false,
      estimated: Boolean(plain),
      instrumental: Boolean(item?.instrumental),
    };
  },
};

/* ------------------------------------------------------------------ *
 * NetEase Cloud Music (网易云音乐)
 *   search: /api/search/get            (plain JSON when called with a Referer)
 *   lyric:  /api/song/lyric?id=&lv=1&kv=1&tv=-1  -> lrc.lyric + tlyric.lyric
 * ------------------------------------------------------------------ */

const netease = {
  id: 'netease',
  label: 'NetEase Cloud Music',
  headers: { Referer: 'https://music.163.com/' },

  async search(track, settings) {
    const timeoutMs = settings.searchTimeoutMs;
    const queries = [];
    if (track.title && track.artist) queries.push(`${track.title} ${track.artist}`);
    if (track.title) queries.push(track.title);
    if (track.artist) queries.push(track.artist);

    const seen = new Set();
    const results = [];
    for (const query of queries.slice(0, 2)) {
      let payload;
      try {
        payload = await getJson(
          withQuery('https://music.163.com/api/search/get', {
            type: 1,
            s: query,
            limit: 12,
            offset: 0,
          }),
          { headers: this.headers, timeoutMs },
        );
      } catch {
        continue;
      }
      const songs = payload?.result?.songs;
      if (!Array.isArray(songs)) continue;
      for (const song of songs) {
        const key = String(song.id ?? '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        results.push({
          key,
          title: String(song.name ?? ''),
          artist: Array.isArray(song.artists) ? song.artists.map((a) => a?.name).filter(Boolean).join(' / ') : '',
          album: String(song.album?.name ?? ''),
          durationMs: Number(song.duration) || 0, // already milliseconds
        });
      }
      if (results.length > 0) break;
    }
    return results;
  },

  async fetchLyrics(candidate) {
    const payload = await getJson(
      withQuery('https://music.163.com/api/song/lyric', {
        id: candidate.key,
        lv: 1,
        kv: 1,
        tv: -1,
      }),
      { headers: this.headers },
    );
    const rawLyric = String(payload?.lrc?.lyric ?? '');
    const rawTranslation = String(payload?.tlyric?.lyric ?? '');
    // NetEase pads untimed header lines and may include [00:00.000] credits,
    // the parser drops those.
    return {
      rawLyric,
      rawTranslation: rawTranslation || null,
      format: 'lrc',
      pureMusic: Boolean(payload?.pureMusic),
    };
  },
};

/* ------------------------------------------------------------------ *
 * QQ Music (QQ音乐)
 *   search: u.y.qq.com/cgi-bin/musicu.fcg (POST) — the legacy
 *           c.y.qq.com/soso/... endpoint now answers HTTP 500 / -1310.
 *   lyric:  c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=&nobase64=1
 *           Requires Referer: https://y.qq.com/, hence the server-side fetch.
 * ------------------------------------------------------------------ */

const qq = {
  id: 'qq',
  label: 'QQ Music',
  headers: { Referer: 'https://y.qq.com/' },

  /**
   * Search via the h5 SmartBox endpoint, falling back to the newer
   * `musicu.fcg` service.
   *
   * The h5 endpoint answers `application/x-javascript` but the body is plain
   * JSON, so it is parsed manually. The `musicu.fcg` fallback starts returning
   * `req.code: 2001` with an empty list once it decides to throttle, which is
   * why it is not the primary path.
   */
  async search(track, settings) {
    const timeoutMs = settings.searchTimeoutMs;
    const queries = [];
    if (track.title && track.artist) queries.push(`${track.title} ${track.artist}`);
    if (track.title) queries.push(track.title);

    const seen = new Set();
    const results = [];
    for (const query of queries.slice(0, 2)) {
      let list = [];
      try {
        list = await this.searchH5(query, timeoutMs);
      } catch {
        list = [];
      }
      if (list.length === 0) {
        try {
          list = await this.searchMusicu(query, timeoutMs);
        } catch {
          list = [];
        }
      }
      for (const song of list) {
        // The two endpoints use different field names for the same values.
        const key = String(song.songmid ?? song.mid ?? '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const singers = Array.isArray(song.singer) ? song.singer : [];
        results.push({
          key,
          title: String(song.songname ?? song.title ?? ''),
          artist: singers
            .map((s) => (typeof s === 'string' ? s : s?.name))
            .filter(Boolean)
            .join(' / '),
          album: String(song.albumname ?? song.album?.name ?? ''),
          // `interval` is the duration in seconds on both endpoints.
          durationMs: (Number(song.interval) || 0) * 1000,
        });
      }
      if (results.length > 0) break;
    }
    return results;
  },

  async searchH5(query, timeoutMs) {
    const text = await getText(
      withQuery('https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp', {
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        platform: 'h5',
        needNewCode: 1,
        w: query,
        p: 1,
        n: 12,
      }),
      { headers: this.headers, timeoutMs },
    );
    const payload = safeJsonParse(text, null);
    const list = payload?.data?.song?.list;
    return Array.isArray(list) ? list : [];
  },

  async searchMusicu(query, timeoutMs) {
    const payload = await postJson(
      'https://u.y.qq.com/cgi-bin/musicu.fcg',
      {
        comm: { ct: 19, cv: 1859 },
        req: {
          module: 'music.search.SearchCgiService',
          method: 'DoSearchForQQMusicDesktop',
          param: { query, num_per_page: 12, page_num: 1, search_type: 0 },
        },
      },
      { headers: this.headers, timeoutMs },
    );
    const list = payload?.req?.data?.body?.song?.list;
    return Array.isArray(list) ? list : [];
  },

  async fetchLyrics(candidate) {
    const text = await getText(
      withQuery('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        songmid: candidate.key,
        format: 'json',
        nobase64: 1, // without this QQ returns base64-encoded LRC
        g_tk: 5381,
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        platform: 'yqq.json',
        hostUin: 0,
        needNewCode: 0,
      }),
      { headers: this.headers },
    );
    const payload = safeJsonParse(text, null);
    const rawLyric = String(payload?.lyric ?? '');
    const rawTranslation = String(payload?.trans ?? '');
    // QQ signals "no lyrics" with a well-known sentinel instead of an empty body.
    const noLyrics = rawLyric.includes('此歌曲为没有填词的纯音乐');
    return {
      rawLyric: noLyrics ? '' : rawLyric,
      rawTranslation: rawTranslation || null,
      format: 'lrc',
      pureMusic: noLyrics,
    };
  },
};

/* ------------------------------------------------------------------ *
 * Kugou (酷狗音乐)
 *   search: lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=
 *   lyric:  lyrics.kugou.com/download?...&fmt=lrc&charset=utf8 -> base64 `content`
 *
 * Kugou's search is keyword-exact: "artist title" returns zero candidates while
 * the title alone works, and the returned `singer` field is frequently wrong
 * (the top hit for 晴天 reports singer "晴天"). Metadata is therefore treated as
 * unreliable here and ranking leans on duration plus the local score.
 * ------------------------------------------------------------------ */

const kugou = {
  id: 'kugou',
  label: 'Kugou',

  async search(track, settings) {
    const timeoutMs = settings.searchTimeoutMs;
    const queries = [track.title, track.title && track.artist ? `${track.title} ${track.artist}` : null].filter(
      Boolean,
    );

    const seen = new Set();
    const results = [];
    for (const keyword of queries.slice(0, 2)) {
      let payload;
      try {
        payload = await getJson(
          withQuery('https://lyrics.kugou.com/search', {
            ver: 1,
            man: 'yes',
            client: 'pc',
            keyword,
            duration: track.durationMs ? Math.round(track.durationMs) : '',
            hash: '',
          }),
          { timeoutMs },
        );
      } catch {
        continue;
      }
      const candidates = payload?.candidates;
      if (!Array.isArray(candidates)) continue;
      for (const item of candidates) {
        const key = `${item.id}:${item.accesskey}`;
        if (!item.id || !item.accesskey || seen.has(key)) continue;
        seen.add(key);
        results.push({
          key,
          title: String(item.song ?? ''),
          artist: String(item.singer ?? ''),
          album: '',
          durationMs: Number(item.duration) || 0,
          // Kugou exposes its own relevance score and provenance; keep them for the UI.
          kugouScore: Number(item.score) || 0,
          origin: String(item.product_from ?? ''),
        });
      }
      if (results.some((r) => r.title)) break;
    }
    return results;
  },

  async fetchLyrics(candidate) {
    const [id, accesskey] = String(candidate.key).split(':');
    const payload = await getJson(
      withQuery('https://lyrics.kugou.com/download', {
        ver: 1,
        client: 'pc',
        id,
        accesskey,
        fmt: 'lrc',
        charset: 'utf8',
      }),
    );
    // `content` is base64-encoded LRC, not LRC itself.
    const rawLyric = payload?.content ? base64ToUtf8(payload.content) : '';
    return { rawLyric, rawTranslation: null, format: 'lrc' };
  },
};

export const PROVIDERS = [lrclib, netease, qq, kugou];
export default PROVIDERS;
