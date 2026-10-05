/**
 * LRC / enhanced-LRC parsing.
 *
 * All lyric sources we use hand back LRC text: NetEase `lrc.lyric`, QQ `lyric`,
 * Kugou base64 `content`, and LRCLIB `syncedLyrics`. They differ in small ways
 * (millisecond vs centisecond stamps, multiple stamps per line, inline word
 * timing, \r\n, metadata tags), so parsing is centralised here.
 *
 * Internal time unit is MILLISECONDS everywhere in this app.
 * (tosu-lyrics uses float seconds; we use ms to match SMTC's timeline fields
 * directly and avoid the unit-mixing bugs its parser has.)
 */

import { normalizeForMatch } from './utils.js';

// [mm:ss.xxx] or [mm:ss:xx] or [mm:ss]
const TIME_TAG = /[\[［](\d{1,3}):(\d{1,2})(?:[.:：](\d{1,3}))?[\]］]/g;
// [ar:Artist] and friends
const META_TAG = /^[\[［]([a-zA-Z]{1,10}):(.*)[\]］]$/;
// <mm:ss.xxx> word-level timing inside enhanced LRC
const WORD_TAG = /[<＜]\d{1,3}:\d{1,2}(?:[.:：]\d{1,3})?[>＞]/g;

/** Fractional part: 2 digits = centiseconds, 3 digits = milliseconds, 1 digit = tenths. */
function fractionToMs(fraction) {
  if (!fraction) return 0;
  const digits = String(fraction);
  if (digits.length === 1) return Number(digits) * 100;
  if (digits.length === 2) return Number(digits) * 10;
  return Number(digits.slice(0, 3));
}

/**
 * Parse LRC text into timed lines.
 * @returns {{lines: Array<{timeMs:number,text:string}>, meta: Record<string,string>, offsetMs:number}}
 */
export function parseLrc(text) {
  const result = { lines: [], meta: {}, offsetMs: 0 };
  if (!text || typeof text !== 'string') return result;

  const meta = {};
  let offsetMs = 0;
  const lines = [];

  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.replace(WORD_TAG, '').trim();
    if (!line) continue;

    // Metadata-only line, e.g. [ar:周杰伦]
    const metaOnly = line.match(META_TAG);
    if (metaOnly && !/^\d/.test(metaOnly[1])) {
      const key = metaOnly[1].toLowerCase();
      const value = metaOnly[2].trim();
      meta[key] = value;
      if (key === 'offset') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) offsetMs = parsed;
      }
      continue;
    }

    // Collect every timestamp on this line so "[00:01.00][00:05.00]text" yields two lines.
    TIME_TAG.lastIndex = 0;
    const stamps = [];
    let match;
    while ((match = TIME_TAG.exec(line)) !== null) {
      const minutes = Number.parseInt(match[1], 10);
      const seconds = Number.parseInt(match[2], 10);
      stamps.push(minutes * 60000 + seconds * 1000 + fractionToMs(match[3]));
    }
    if (stamps.length === 0) continue;

    // The lyric text is everything after the final timestamp tag.
    const lastTagEnd = line.lastIndexOf(']') >= 0 ? line.lastIndexOf(']') + 1 : 0;
    const content = line.slice(lastTagEnd).replace(WORD_TAG, '').trim();
    if (!content) continue;

    for (const timeMs of stamps) lines.push({ timeMs, text: content });
  }

  lines.sort((a, b) => a.timeMs - b.timeMs);

  // Apply the [offset:] header. Positive offset means "shift lyrics earlier".
  result.offsetMs = offsetMs;
  result.meta = meta;
  result.lines = offsetMs
    ? lines.map((l) => ({ ...l, timeMs: Math.max(0, l.timeMs - offsetMs) }))
    : lines;
  return result;
}

/** Strip leftover metadata rows that some providers leave inside the lyric body. */
function isNoiseLine(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^(作词|作曲|编曲|制作人|混音|母带|录音|吉他|贝斯|鼓|键盘|和声|监制|出品|发行|词|曲|OP|SP|录音室|配唱)\s*[:：]/.test(t)) {
    return true;
  }
  if (/^(作词|作曲|编曲|制作)\s*[:：]?\s*[:\u4e00-\u9fff]/.test(t) && t.length < 30) return true;
  if (/^\s*[\[［].*[\]］]\s*$/.test(t)) return true;
  return false;
}

const INSTRUMENTAL_MARKERS = [
  '纯音乐',
  '此歌曲为没有填词的纯音乐',
  'instrumental',
  'no lyrics',
  '暂无歌词',
];

/** True when a lyric body is a placeholder rather than real lyrics. */
export function isInstrumentalText(text) {
  const t = String(text ?? '').toLowerCase().replace(/[\s\-—–]/g, '');
  if (!t) return true;
  return INSTRUMENTAL_MARKERS.some((m) => t.includes(m.toLowerCase().replace(/[\s\-—–]/g, '')));
}

/**
 * Merge an original LRC and a translation LRC into one line array.
 * Translation lines are matched to original lines by nearest timestamp; a
 * translation with no counterpart becomes an original line (this is what
 * tosu-lyrics does, and it is the behaviour that survives messy data).
 *
 * @returns {Array<{timeMs:number,text:string,translation:string|null}>}
 */
export function mergeLyrics(originalText, translationText = null) {
  const original = parseLrc(originalText);
  const translation = translationText ? parseLrc(translationText) : { lines: [] };

  const filterNoise = (lines) => lines.filter((l) => !isNoiseLine(l.text));

  let lines = filterNoise(original.lines).map((l) => ({
    timeMs: l.timeMs,
    text: l.text,
    translation: null,
  }));

  const transLines = filterNoise(translation.lines);
  if (transLines.length > 0) {
    // Match translations to originals: exact-ish first, then nearest within 1s.
    const MAX_SHIFT = 1000;
    const used = new Set();
    const pending = [];
    for (const t of transLines) {
      let bestIndex = -1;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (let i = 0; i < lines.length; i += 1) {
        if (used.has(i)) continue;
        const delta = Math.abs(lines[i].timeMs - t.timeMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIndex = i;
        }
      }
      if (bestIndex >= 0 && bestDelta <= MAX_SHIFT) {
        used.add(bestIndex);
        lines[bestIndex].translation = t.text;
      } else {
        pending.push(t);
      }
    }
    // Unmatched translations become their own lines, merged with any that share a stamp.
    for (const t of pending) {
      const existing = lines.find((l) => Math.abs(l.timeMs - t.timeMs) <= 30 && !l.translation);
      if (existing) {
        existing.translation = t.text;
      } else {
        lines.push({ timeMs: t.timeMs, text: t.text, translation: null });
      }
    }
    lines.sort((a, b) => a.timeMs - b.timeMs);
  }

  // Collapse consecutive duplicates (providers often repeat a line for a held note).
  const deduped = [];
  for (const line of lines) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.text === line.text && line.timeMs - prev.timeMs < 300) {
      if (!prev.translation && line.translation) prev.translation = line.translation;
      continue;
    }
    deduped.push(line);
  }

  return deduped;
}

/**
 * Build a lyric object from a parsed line array: adds explicit end times so the
 * overlay can animate a line for exactly as long as it is on screen.
 */
export function buildLyricDoc(lines, trackDurationMs = 0) {
  const sorted = [...lines].sort((a, b) => a.timeMs - b.timeMs);
  const withEnd = sorted.map((line, index) => {
    const next = sorted[index + 1];
    let endMs = next ? next.timeMs : line.timeMs + 4000;
    if (!next && trackDurationMs > line.timeMs) endMs = trackDurationMs;
    // A gap longer than 8s is an instrumental break; do not hold the line that long.
    if (endMs - line.timeMs > 8000) endMs = line.timeMs + 8000;
    if (endMs <= line.timeMs) endMs = line.timeMs + 1000;
    return { timeMs: line.timeMs, endMs, text: line.text, translation: line.translation || null };
  });
  return withEnd;
}

/**
 * Index of the active line for a playback position.
 * Returns -1 before the first line. `offsetMs` shifts the whole timeline.
 */
export function activeIndexAt(lines, positionMs, offsetMs = 0) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;
  const t = positionMs + offsetMs;
  if (t < lines[0].timeMs) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let answer = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= t) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

/** Confidence that two lyric line sets describe the same recording (used to validate a swap). */
export function lyricTextOverlap(aLines, bLines) {
  const bag = new Set(aLines.map((l) => normalizeForMatch(l.text)).filter(Boolean));
  if (bag.size === 0) return 0;
  let hits = 0;
  let total = 0;
  for (const line of bLines) {
    const key = normalizeForMatch(line.text);
    if (!key) continue;
    total += 1;
    if (bag.has(key)) hits += 1;
  }
  return total === 0 ? 0 : hits / total;
}

/** Serialise a lyric document back to plain LRC (used by the "download .lrc" action). */
export function toLrcText(lines, { translation = false } = {}) {
  const stamp = (ms) => {
    const total = Math.max(0, ms);
    const m = Math.floor(total / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const cs = Math.floor((total % 1000) / 10);
    return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
  };
  const out = [];
  for (const line of lines) {
    out.push(`${stamp(line.timeMs)}${line.text}`);
    if (translation && line.translation) out.push(`${stamp(line.timeMs)}${line.translation}`);
  }
  return `${out.join('\n')}\n`;
}
