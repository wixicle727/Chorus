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
  splitArtists,
  withQuery,
} from '../core/utils.js';
import zlib from 'node:zlib';
import { decryptQrc, qrcToLrc } from './qrc.js';

/**
 * Search queries for a track, most specific first.
 *
 * The artist string a player publishes is often a CREDITED LIST, not one performer — Spotify
 * reports `初星学園, フワリ, 秦谷美鈴` for an idol unit's track — while providers index the entry
 * under a different member of that list. Searching only the first name therefore misses
 * entries that exist, which is what happened with "My Precious".
 *
 * So the full credited string is tried first (it is the most specific and matches when the
 * provider stores the same list), then the title alone, then each individual artist. The
 * candidates are pooled and ranked by score afterwards, so a looser query cannot win on its
 * own — it only adds candidates that the strict query could not reach.
 *
 * @param {{title?: string, artist?: string}} track
 * @param {{limit?: number, includeArtistOnly?: boolean}} options
 */
export function buildSearchQueries(track, { limit = 4, includeArtistOnly = false } = {}) {
  const title = String(track?.title ?? '').trim();
  const artist = String(track?.artist ?? '').trim();
  const queries = [];

  const push = (value) => {
    const text = String(value ?? '').trim();
    if (text && !queries.includes(text)) queries.push(text);
  };

  // Title first, on its own.
  //
  // A player's artist field is often a credited list ("舞桜・るり・響子・栞 from STARRY
  // PLANET☆"), and appending the whole thing makes providers answer with whatever contains
  // a fragment of it: NetEase answers that query with "PLANET — ラムジ" and "Planet Matrix"
  // and never returns the song. The title identifies the song, so it leads and the artist
  // narrows afterwards.
  if (title) push(title);
  if (title && artist) push(`${title} ${artist}`);

  // Individual credited artists, longest first: the most distinctive name is the most
  // likely to be the one the provider indexes under.
  const parts = splitArtists(artist).sort((a, b) => b.length - a.length);
  for (const part of parts) {
    if (title) push(`${title} ${part}`);
  }
  if (includeArtistOnly && artist) push(artist);

  return queries.slice(0, limit);
}

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
 * Syllable-level lyric formats (the "karaoke" sources)
 *
 * Plain LRC stamps only the start of each line, so a karaoke fill has to guess
 * the pacing inside it. Three of the CJK services publish per-syllable timings
 * under their own format, and AF-Media-Bar reads all of them:
 *
 *   NetEase YRC   [1671,1767](0,469,0)沈(469,365,0)む…      ( ) separators
 *   Kugou   KRC   [1671,1767]<0,469,0>沈<469,365,0>む…      < > separators
 *   Qishui        [1671,1767]<0,469,0>沈<469,365,0>む…
 *
 * All three use the same idea: `[line start ms, line duration ms]` followed by
 * tokens of `<offset within the line, word duration, flag>text`. They are
 * converted here into enhanced LRC (`[mm:ss.xx]<mm:ss.xx>沈…`), which is what
 * parseLrc already understands, so the rest of the app needs no new format.
 *
 * A document that carries no timings at all yields '', and the caller keeps the
 * plain LRC — a lyric sheet is never made worse by trying for the karaoke one.
 * ------------------------------------------------------------------ */

/** `[mm:ss.cc]` for a line start. */
function lrcStamp(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}]`;
}

/** The same instant in the form enhanced LRC uses inside a line: `<mm:ss.xx>`. */
function lrcWordStamp(ms) {
  return `<${lrcStamp(ms).slice(1, -1)}>`;
}

/**
 * One converted line, or null when it has no usable timing.
 * @param {number} lineStart absolute milliseconds
 * @param {number} lineEnd absolute milliseconds where the singing stops
 * @param {Array<{at:number,text:string}>} words absolute syllable starts
 */
function syllableLineToLrc(lineStart, lineEnd, words) {
  if (!words.length) return null;
  const tagged = words.map((word) => `${lrcWordStamp(word.at)}${word.text}`).join('');
  // A trailing tag with no text closes the line, so the fill stops when the
  // singing does instead of running on through the silence that follows.
  return `${lrcStamp(lineStart)}${tagged}${lrcWordStamp(lineEnd)}`;
}

/** Plain text with the timing tokens removed, used when a line has no syllables. */
function stripTimingTokens(text, pattern) {
  return String(text ?? '').replace(pattern, '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert a NetEase YRC document into enhanced LRC.
 * @param {string} text raw `yrc.lyric`
 * @returns {string} LRC text, or '' when the document has no per-syllable timing
 */
export function yrcToLrc(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^\[(\d+),(\d+)\](.*)$/);
    if (!match) continue;
    const lineStart = Number(match[1]);
    const lineEnd = lineStart + Number(match[2]);
    const words = [];
    for (const token of match[3].matchAll(/\((\d+),(\d+),\d+\)([^()]*)/g)) {
      if (!token[3].trim()) continue;
      // YRC syllable offsets are absolute milliseconds from the start of the
      // track, not relative to the line: the first syllable of a line repeats
      // the line's own start value. Adding lineStart here doubled the time and
      // left every line filling only at the very end of the song.
      words.push({ at: Number(token[1]), text: token[3] });
    }
    const built = syllableLineToLrc(lineStart, lineEnd, words);
    if (built) out.push(built);
    else {
      const plain = stripTimingTokens(match[3], /\([^)]*\)/g);
      if (plain) out.push(`${lrcStamp(lineStart)}${plain}`);
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/**
 * Convert a Kugou KRC document (already decrypted) into enhanced LRC.
 *
 * KRC files start with metadata lines such as `[id:$00000000]`, `[ar:…]`, which
 * the `^\d+,\d+` guard skips for free.
 *
 * @param {string} text plaintext KRC
 * @returns {string} LRC text, or '' when the document has no per-syllable timing
 */
export function krcToLrc(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^\[(\d+),(\d+)\](.*)$/);
    if (!match) continue;
    const lineStart = Number(match[1]);
    const lineEnd = lineStart + Number(match[2]);
    const words = [];
    for (const token of match[3].matchAll(/<(\d+),(\d+),\d+>([^<]*)/g)) {
      if (!token[3].trim()) continue;
      // KRC syllable offsets are absolute milliseconds from the start of the
      // track, exactly like YRC, so the line start is not added here.
      words.push({ at: Number(token[1]), text: token[3] });
    }
    const built = syllableLineToLrc(lineStart, lineEnd, words);
    if (built) out.push(built);
    else {
      const plain = stripTimingTokens(match[3], /<[^>]*>/g);
      if (plain) out.push(`${lrcStamp(lineStart)}${plain}`);
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/**
 * Kugou's KRC cipher key, the same one Lyricify (and therefore AF-Media-Bar)
 * uses: the file is base64, the first four bytes are a header, and the rest is
 * this repeating XOR followed by a raw-deflate stream.
 */
const KRC_KEY = Buffer.from([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
]);

/**
 * Decrypt a base64 KRC payload.
 * @param {string} base64 the `content` field of the Kugou download response
 * @returns {string} plaintext KRC, or '' when the payload cannot be read
 */
export function decodeKrcBase64(base64) {
  let buffer;
  try {
    buffer = Buffer.from(String(base64 ?? ''), 'base64');
  } catch {
    return '';
  }
  if (buffer.length <= 4) return '';
  const data = Buffer.from(buffer.subarray(4));
  for (let i = 0; i < data.length; i += 1) data[i] ^= KRC_KEY[i % KRC_KEY.length];
  for (const attempt of [zlib.inflateSync, zlib.inflateRawSync, zlib.unzipSync]) {
    try {
      return attempt(data).toString('utf8');
    } catch {
      // Try the next framing before giving up.
    }
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * NetEase Cloud Music (网易云音乐)
 *   search: /api/search/get            (plain JSON when called with a Referer)
 *   lyric:  /api/song/lyric?id=&lv=1&kv=1&tv=-1  -> lrc.lyric + tlyric.lyric
 *   karaoke: the same call with yv=1 also fills yrc.lyric when the song has it
 * ------------------------------------------------------------------ */

const netease = {
  id: 'netease',
  label: 'NetEase Cloud Music',
  // Returns per-syllable timings (YRC) when the song has them.
  syllables: true,
  headers: { Referer: 'https://music.163.com/' },

  async search(track, settings) {
    const timeoutMs = settings.searchTimeoutMs;
    // Credited artist lists mean the strictest query is not always the one that matches.
    const queries = buildSearchQueries(track, { limit: 4, includeArtistOnly: true });

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
        // yv=1 asks for the per-syllable version. The endpoint answers without it
        // for songs that have none, which is most of them, so this costs nothing
        // when there is no karaoke sheet to be had.
        yv: 1,
      }),
      { headers: this.headers },
    );
    const rawTranslation = String(payload?.tlyric?.lyric ?? '');
    // YRC first: it is the same lyrics with syllable timings, so it is strictly
    // more useful than the plain LRC the same response carries.
    const yrcText = String(payload?.yrc?.lyric ?? '');
    if (yrcText.trim()) {
      const karaoke = yrcToLrc(yrcText);
      if (karaoke) {
        return {
          rawLyric: karaoke,
          rawTranslation: rawTranslation || null,
          format: 'yrc',
          syllable: true,
          pureMusic: Boolean(payload?.pureMusic),
        };
      }
    }
    const rawLyric = String(payload?.lrc?.lyric ?? '');
    // NetEase pads untimed header lines and may include [00:00.000] credits,
    // the parser drops those.
    return {
      rawLyric,
      rawTranslation: rawTranslation || null,
      format: 'lrc',
      pureMusic: Boolean(payload?.pureMusic),
    };
  },

  /**
   * Cover art for a candidate.
   *
   * The song detail endpoint hands over a ready-made `album.picUrl`. Deriving the URL from
   * `album.picId` instead does not work: the id exceeds Number.MAX_SAFE_INTEGER (so plain
   * arithmetic silently loses precision) and the transform is not the documented one, which
   * produced 404s on every attempt.
   */
  async fetchCover(candidate) {
    const payload = await getJson(
      `https://music.163.com/api/song/detail?ids=%5B${encodeURIComponent(candidate.key)}%5D`,
      { headers: this.headers },
    );
    return payload?.songs?.[0]?.album?.picUrl ?? null;
  },
};

/* ------------------------------------------------------------------ *
 * QQ Music (QQ音乐)
 *   search: u.y.qq.com/cgi-bin/musicu.fcg (POST) — the legacy
 *           c.y.qq.com/soso/... endpoint now answers HTTP 500 / -1310.
 *   lyric:  c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=&nobase64=1
 *           Requires Referer: https://y.qq.com/, hence the server-side fetch.
 * ------------------------------------------------------------------ */

/**
 * The song id QQ's lyric endpoint needs, from either search shape.
 *
 * `search_for_qq_cp` names it `songmid`, the musicu response names it `mid`, and the h5
 * endpoint signals "best guess, no real id" with the string `"0"` — which is truthy, so it
 * must be rejected explicitly. Without that, a query the h5 endpoint is unsure about yields
 * a candidate whose lyrics can never be fetched: the panel lists the right song and then
 * shows nothing for it.
 */
export function qqSongKey(song) {
  for (const value of [song?.songmid, song?.mid, song?.songMid]) {
    const text = String(value ?? '').trim();
    if (text && text !== '0') return text;
  }
  return '';
}

const qq = {
  id: 'qq',
  label: 'QQ Music',
  // Returns per-syllable timings (QRC) for songs that publish them.
  syllables: true,
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
    const queries = buildSearchQueries(track, { limit: 4 });

    const seen = new Set();
    const results = [];
    for (const query of queries.slice(0, 2)) {
      let list = [];
      try {
        list = await this.searchH5(query, timeoutMs);
      } catch {
        list = [];
      }
      // The h5 endpoint answers a query it is unsure about with a single synthetic
      // entry whose `songmid` is the string "0" — no id, so its lyrics can never be
      // fetched. Treat that as "no results" and ask musicu, which does carry the mid.
      if (list.length > 0 && list.every((song) => !qqSongKey(song))) {
        try {
          list = await this.searchMusicu(query, timeoutMs);
        } catch {
          list = [];
        }
      }
      for (const song of list) {
        // The two endpoints use different field names for the same values.
        const key = qqSongKey(song);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const singers = Array.isArray(song.singer) ? song.singer : [];
        results.push({
          key,
          title: String(song.songname ?? song.name ?? song.title ?? ''),
          artist: singers
            .map((s) => (typeof s === 'string' ? s : s?.name))
            .filter(Boolean)
            .join(' / '),
          album: String(song.albumname ?? song.album?.name ?? ''),
          // `interval` is the duration in seconds on both endpoints.
          durationMs: (Number(song.interval) || 0) * 1000,
          // QRC (the karaoke sheet) is addressed by numeric id, which only the
          // search responses carry; the mid alone cannot reach it.
          songId: Number(song.songid ?? song.id) || 0,
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
    const qrc = await this.fetchQrc(candidate);
    if (qrc) return qrc;
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

  /**
   * The karaoke sheet, when QQ has one.
   *
   * `lyric_download.fcg` with `lrctype=4` answers QRC — hex, encrypted, deflated —
   * which is the only QQ format that carries per-syllable timings. Not every song
   * has one (a pure-instrumental or a plain-LRC release answers an empty or
   * undecryptable body), so a failure here is silent and the caller falls back to
   * the ordinary LRC endpoint rather than surfacing an error.
   */
  async fetchQrc(candidate) {
    const songId = Number(candidate?.songId) || 0;
    if (!songId) return null;

    let xml = '';
    try {
      const response = await fetch('https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg', {
        method: 'POST',
        headers: {
          ...this.headers,
          'content-type': 'application/x-www-form-urlencoded',
          Referer: 'https://y.qq.com/portal/player.html',
        },
        body: new URLSearchParams({
          version: '15',
          miniversion: '82',
          lrctype: '4',
          musicid: String(songId),
        }).toString(),
        signal: AbortSignal.timeout(8000),
      });
      const text = await response.text();
      const node = text.match(/<content[^>]*>([\s\S]*?)<\/content>/);
      const payload = node ? node[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      if (payload) xml = decryptQrc(payload);
    } catch {
      return null;
    }

    const rawLyric = xml ? qrcToLrc(xml) : '';
    if (!rawLyric) return null;
    return { rawLyric, rawTranslation: null, format: 'qrc', syllable: true };
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
  // Returns per-syllable timings (KRC) when the song has them.
  syllables: true,

  async search(track, settings) {
    const timeoutMs = settings.searchTimeoutMs;
    const queries = [track.title, ...buildSearchQueries(track, { limit: 4 })].filter(
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
    // Ask for KRC first. It is the same song with per-character timings, and the
    // service simply answers `status: 0` for tracks that have no karaoke sheet,
    // which is what the plain-LRC request below is for.
    try {
      const krcPayload = await getJson(
        withQuery('https://lyrics.kugou.com/download', {
          ver: 1,
          client: 'pc',
          id,
          accesskey,
          fmt: 'krc',
          charset: 'utf8',
        }),
      );
      if (krcPayload?.content) {
        const karaoke = krcToLrc(decodeKrcBase64(krcPayload.content));
        if (karaoke) {
          // KRC translation lines are stored as a second block this app does not
          // split out yet; the original alone is still the better lyric sheet.
          return { rawLyric: karaoke, rawTranslation: null, format: 'krc', syllable: true };
        }
      }
    } catch {
      // No karaoke sheet; fall through to the plain LRC download.
    }
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

/* ------------------------------------------------------------------ *
 * Qishui Music (汽水音乐)
 *   search: api.qishui.com/luna/search/track?q=&device_platform=web
 *   lyric:  api.qishui.com/luna/h5/seo_track?track_id=&device_platform=web
 *
 * The lyric field is NOT LRC. It is Qishui's own karaoke format, one line per
 * lyric line:
 *
 *   [15278,3319]<0,403,0>雨<560,403,0>下<1120,403,0>了
 *
 * i.e. `[line start ms, line duration ms]` followed by word tokens of
 * `<offset ms within the line, word duration, flag>text`. Word timing is
 * discarded here — the overlay works per line — but the line stamps are exact,
 * so no estimation is needed.
 *
 * Translations arrive separately under `lyric.translations`, keyed by language
 * (`cn`, sometimes others), and are already plain LRC.
 * ------------------------------------------------------------------ */

/**
 * Convert one of Qishui's karaoke lyric documents into enhanced LRC.
 *
 * Qishui stamps every syllable — `[1671,1767]<0,469,0>沈<469,365,0>む…` — which is
 * the one thing no other source of ours offers, so those timings are kept as
 * `<mm:ss.xx>` word tags instead of being thrown away. parseLrc reads them back,
 * the overlay fills the line from them rather than guessing a sweep, and every
 * other consumer still sees plain text.
 *
 * Lines without a leading `[start,duration]` are dropped: without a stamp they
 * would have to be estimated, and mixing timed and untimed lines in one document
 * makes the overlay jump around.
 *
 * @param {string} content raw `lyric.content`
 * @returns {string} LRC text, empty when the document carried no timed lines
 */
export function qishuiRichToLrc(content) {
  const out = [];
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const match = rawLine.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!match) continue;

    const lineStart = Number(match[1]);
    const lineEnd = lineStart + Number(match[2]);
    // Word tokens: `<offset,duration,flag>text` — the offset is relative to the line.
    const words = [];
    for (const token of match[3].matchAll(/<(\d+),(\d+),\d+>([^<]*)/g)) {
      if (!token[3].trim()) continue;
      // Qishui's offsets really are relative to the line, unlike YRC and KRC.
      words.push({ at: lineStart + Number(token[1]), text: token[3] });
    }

    if (!words.length) {
      const plain = match[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (plain) out.push(`${lrcStamp(lineStart)}${plain}`);
      continue;
    }

    // A trailing tag with no text closes the line, so the fill stops when the
    // singing does instead of running on through the silence that follows.
    const tagged = words.map((w) => `${lrcWordStamp(w.at)}${w.text}`).join('');
    out.push(`${lrcStamp(lineStart)}${tagged}${lrcWordStamp(lineEnd)}`);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/** Pull the newest-looking translation out of `lyric.translations`. */
function qishuiTranslation(translations) {
  if (!translations || typeof translations !== 'object') return null;
  // `cn` is the usual key; fall back to any string value that looks like LRC.
  for (const key of ['cn', 'zh', 'translation']) {
    const value = translations[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const value of Object.values(translations)) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

const qishui = {
  id: 'qishui',
  label: 'Qishui Music',
  // Every Qishui sheet is syllable-timed; that is the whole point of the source.
  syllables: true,
  headers: {
    // The web client's UA is enough for both endpoints; no cookie or signature
    // is needed for search or lyrics (the PC endpoints do require one).
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  },

  async search(track, settings) {
    const timeoutMs = settings.searchTimeoutMs;
    const queries = buildSearchQueries(track, { limit: 4 });

    const seen = new Set();
    const results = [];
    for (const query of queries.slice(0, 2)) {
      let payload;
      try {
        payload = await getJson(
          withQuery('https://api.qishui.com/luna/search/track', {
            q: query,
            device_platform: 'web',
            cursor: 0,
            count: 12,
          }),
          { headers: this.headers, timeoutMs },
        );
      } catch {
        continue;
      }
      const group = Array.isArray(payload?.result_groups)
        ? payload.result_groups.find((g) => g?.id === 'tracks')
        : null;
      const items = Array.isArray(group?.data) ? group.data : [];
      for (const item of items) {
        // Tracks normally sit under entity.track_wrapper.track, but videos and a
        // few item kinds put the object one level up.
        const song = item?.entity?.track_wrapper?.track ?? item?.entity?.track ?? null;
        if (!song?.id) continue;
        const key = String(song.id);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          key,
          title: String(song.name ?? ''),
          artist: Array.isArray(song.artists)
            ? song.artists.map((a) => a?.name).filter(Boolean).join(' / ')
            : '',
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
      withQuery('https://api.qishui.com/luna/h5/seo_track', {
        track_id: candidate.key,
        device_platform: 'web',
      }),
      { headers: this.headers },
    );
    const lyric = payload?.lyric ?? {};
    const rawLyric = qishuiRichToLrc(lyric.content ?? '');
    return {
      rawLyric,
      rawTranslation: qishuiTranslation(lyric.translations),
      format: 'lrc',
      // `hide_request_lyrics` marks tracks whose rights holder hid the lyrics.
      pureMusic: !rawLyric && Boolean(lyric.hide_request_lyrics),
    };
  },
};

export const PROVIDERS = [lrclib, netease, qq, kugou, qishui];
export default PROVIDERS;


