const DEFAULT_TIMEOUT_MS = 8000;

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
  constructor(message = 'request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * fetch() with a hard timeout. Returns the Response; the caller decides how to read it.
 * AbortError and timeout are normalised to TimeoutError so callers can treat them alike.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new TimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, { headers = {}, timeoutMs } = {}) {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', ...headers } },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function getText(url, { headers = {}, timeoutMs } = {}) {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers } },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * POST a JSON body. QQ's musicu endpoint rejects GET, so this is needed for QQ search.
 * Some legacy QQ endpoints are wrapped in JSONP-ish padding; `stripPadding` handles that.
 */
export async function postJson(url, body, { headers = {}, timeoutMs } = {}) {
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Strip `callback(...)`, `MusicJsonCallback(...)`, or `jsonp(...)` wrappers around a JSON body. */
export function stripJsonp(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const start = trimmed.indexOf('(');
  const end = trimmed.lastIndexOf(')');
  if (start === -1 || end <= start) return trimmed;
  return trimmed.slice(start + 1, end);
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(stripJsonp(text));
  } catch {
    return fallback;
  }
}

/** Decode standard base64 into a UTF-8 string (lyric payloads are frequently base64 LRC). */
export function base64ToUtf8(b64) {
  return Buffer.from(String(b64 ?? ''), 'base64').toString('utf8');
}

/** Percent-encode every parameter of a query object, skipping null/undefined. */
export function withQuery(base, params = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* ------------------------------------------------------------------ *
 * Text normalisation and fuzzy matching
 * ------------------------------------------------------------------ */

const BRACKETED = /[（(\[【][^）)\]】]*[）)\]】]/g;
const FEATURING = /\b(feat|ft|featuring|with|prod|remix|version|edit|ver|live|cover)\b\.?/g;

/**
 * Normalise a title/artist for comparison: drop bracketed asides, featuring credits,
 * punctuation and case, so "晴天 (Live)" and "晴天" compare equal.
 */
export function normalizeForMatch(input) {
  let text = String(input ?? '');
  text = text.replace(BRACKETED, ' ');
  text = text.toLowerCase();
  text = text.replace(/[’'`´]/g, '');
  text = text.replace(FEATURING, ' ');
  // Keep CJK, latin letters and digits; everything else becomes a space.
  text = text.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-z0-9]+/gu, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** Tokenise a normalised string into a Set of words (CJK strings stay whole). */
export function tokenize(input) {
  const normalized = normalizeForMatch(input);
  if (!normalized) return new Set();
  return new Set(normalized.split(' ').filter(Boolean));
}

function bigrams(text) {
  const s = text.replace(/\s+/g, '');
  const out = new Set();
  if (s.length < 2) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** Sørensen-Dice similarity over character bigrams; robust for both CJK and Latin. */
export function diceSimilarity(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = bigrams(na);
  const B = bigrams(nb);
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

/** Similarity of a candidate artist string against any of the "real" artists. */
export function artistSimilarity(candidate, wantedArtists) {
  if (!wantedArtists || wantedArtists.length === 0) return 0;
  const candidateText = normalizeForMatch(candidate);
  if (!candidateText) return 0;
  let best = 0;
  for (const wanted of wantedArtists) {
    const wantedText = normalizeForMatch(wanted);
    if (!wantedText) continue;
    if (candidateText === wantedText) return 1;
    const containment = candidateText.includes(wantedText) || wantedText.includes(candidateText);
    const dice = diceSimilarity(candidateText, wantedText);
    best = Math.max(best, dice, containment ? 0.9 : 0);
  }
  return best;
}

/**
 * Duration score in [0,1]. Tolerance widens with track length (intros/outros differ
 * between releases) but never exceeds `maxToleranceMs`.
 */
export function durationScore(aMs, bMs, maxToleranceMs = 8000) {
  const a = Number(aMs) || 0;
  const b = Number(bMs) || 0;
  if (a <= 0 || b <= 0) return 0.5; // unknown duration: neutral, neither rewarded nor punished
  const diff = Math.abs(a - b);
  const tolerance = Math.min(maxToleranceMs, Math.max(2500, b * 0.04));
  if (diff <= tolerance) return 1 - (diff / tolerance) * 0.25; // 0.75..1.0 inside the window
  const over = diff - tolerance;
  return Math.max(0, 0.75 * (1 - over / (tolerance * 2.5)));
}

/* ------------------------------------------------------------------ *
 * Artist string handling
 * ------------------------------------------------------------------ */

/**
 * Separators used to split a multi-artist string.
 *
 * Space-sensitive variants come first so that " & " is consumed as one unit where
 * it appears. The bare forms are then included because several players — notably
 * foobar2000, which writes `A&B&C` with no spaces — join artists without
 * surrounding whitespace.
 *
 * Splitting is only ever used to raise the best artist match (artistSimilarity
 * takes the maximum over all pairs), so an over-eager split cannot lower a score;
 * "Simon & Garfunkel" simply also offers "Simon" and "Garfunkel" as options.
 */
export const DEFAULT_ARTIST_SEPARATORS = [
  ';',
  ' & ',
  ' x ',
  ' × ',
  ' feat. ',
  ' ft. ',
  ' feat ',
  ' ft ',
  '、',
  '・',
  '／',
  '/',
  '&',
  '×',
  '；',
];

/**
 * Split a raw SMTC artist string into individual artists and clean streaming
 * artefacts such as YouTube's " - Topic" suffix.
 */
export function splitArtists(raw, separators = DEFAULT_ARTIST_SEPARATORS) {
  let text = String(raw ?? '').trim();
  if (!text || text.toLowerCase() === 'unknown') return [];
  text = text.replace(/\s*-\s*topic$/i, '').trim();
  let parts = [text];
  for (const sep of separators) {
    if (!sep) continue;
    const next = [];
    for (const part of parts) next.push(...part.split(sep));
    parts = next;
  }
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const cleaned = part.trim().replace(/^[\s\-–—·,]+|[\s\-–—·,]+$/g, '').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/**
 * Title cleanup that PRESERVES meaningful characters for searching and display,
 * unlike normalizeForMatch which is only for comparison.
 */
export function cleanTitle(raw) {
  return String(raw ?? '')
    .replace(/\s*[-–—]\s*topic\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove trailing "(Official Video)"-style noise while keeping the real title. */
export function titleForSearch(raw) {
  let text = cleanTitle(raw);
  text = text.replace(/[（(\[【]\s*(official\s*(music\s*)?(video|audio|lyric[s]?)|mv|pv|hd|4k|audio|lyrics?|高音质|官方|无损)\s*[）)\]】]/gi, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
