/**
 * Lyric candidate search + scoring.
 *
 * Method is taken from AF-Media-Bar's lyric engine: run the enabled providers,
 * score every candidate on title/artist/duration, accept a strong match
 * immediately, otherwise fall back to the best-scoring candidate, and treat
 * "confirmed no lyrics" as a valid, cacheable result.
 *
 * Unlike tosu-lyrics — whose title/artist filters are unimplemented stubs that
 * always return true, leaving selection to provider order plus a ±15s window —
 * this scores the metadata properly so a cover or an unrelated song cannot win
 * just by being the first hit.
 */

import { PROVIDER_IDS, PROVIDER_LABELS } from '../config.js';
import {
  artistSimilarity,
  diceSimilarity,
  durationScore,
  normalizeForMatch,
  titleForSearch,
  splitArtists,
} from './utils.js';

export function createRegistry(providers) {
  const map = new Map();
  for (const provider of providers) {
    if (provider?.id && typeof provider.search === 'function') map.set(provider.id, provider);
  }
  return map;
}

export function providerLabel(id) {
  return PROVIDER_LABELS[id] ?? id;
}

/**
 * How much to demote a candidate that is a version of the song rather than the
 * original recording. Higher means worse.
 *
 * These variants frequently carry identical or near-identical metadata and land
 * on the same score as the real track, so without this the karaoke cut can win on
 * provider order alone. Ordered worst-first.
 *
 * WORD BOUNDARIES ARE DELIBERATELY NOT USED. `\b` is defined in terms of ASCII
 * word characters, so `\bカラオケ\b` never matches — kana are not word characters,
 * so no boundary exists between a kana and the surrounding punctuation. The
 * guards below instead require "not preceded/followed by a letter or digit",
 * which is meaningless for CJK and correct for Latin.
 */
const LATIN_START = String.raw`(?<![a-z0-9])`;
const LATIN_END = String.raw`(?![a-z0-9])`;

const VERSION_PENALTIES = [
  [new RegExp(`${LATIN_START}(karaoke|off\\s*vocal|instrumental|伴奏|カラオケ|オフボーカル|纯音乐|純音樂|无人声|無人聲)${LATIN_END}`, 'i'), 3],
  [new RegExp(`${LATIN_START}(cover|covered|翻唱|カバー)${LATIN_END}`, 'i'), 2],
  [new RegExp(`${LATIN_START}(remix|リミックス|混音|重制|重製)${LATIN_END}`, 'i'), 2],
  [new RegExp(`${LATIN_START}(tv\\s*(size|edit|version)|short\\s*(size|version|edit)|anime\\s*(size|edit|version)|ショート|tvサイズ|テレビサイズ|テレビ|short\\s*ver)${LATIN_END}`, 'i'), 1],
  [new RegExp(`${LATIN_START}(live|ライブ|现场|現場|acoustic|アコースティック)${LATIN_END}`, 'i'), 1],
  [new RegExp(`${LATIN_START}(demo|instrumental\\s*version)${LATIN_END}`, 'i'), 1],
];

function versionPenalty(title) {
  const text = String(title ?? '');
  let worst = 0;
  for (const [pattern, penalty] of VERSION_PENALTIES) {
    if (pattern.test(text)) worst = Math.max(worst, penalty);
  }
  return worst;
}

/**
 * Compare two candidates for ordering.
 *
 * Score dominates. Within a small margin, a properly time-synced result is
 * preferred over one whose timing had to be estimated (LRCLIB `plainLyrics`),
 * because a real sync stays correct while an estimate drifts. The margin is
 * deliberately small so it never overrides a genuinely better match.
 */
const SYNC_PREFERENCE_MARGIN = 3;

function compareCandidates(a, b) {
  if (Math.abs(b.score - a.score) > SYNC_PREFERENCE_MARGIN) return b.score - a.score;
  const aSynced = a.synced === false ? 0 : 1;
  const bSynced = b.synced === false ? 0 : 1;
  if (aSynced !== bSynced) return bSynced - aSynced;
  return b.score - a.score;
}

/**
 * Score one search candidate against what SMTC told us is playing.
 * @returns {{total:number, breakdown:{title:number,artist:number,duration:number,preference:number}}}
 *          `total` is 0..100.
 */
export function scoreCandidate(candidate, track, settings = {}) {
  const weights = { title: 0.48, artist: 0.3, duration: 0.18, preference: 0.04 };
  const maxToleranceMs = Number(settings.durationToleranceMs ?? 8000);

  const wantedTitle = titleForSearch(track.title);
  const candTitle = titleForSearch(candidate.title);

  // Exact normalised titles should not be punished for extra "feat." text.
  let titleScore = diceSimilarity(wantedTitle, candTitle);
  if (normalizeForMatch(wantedTitle) && normalizeForMatch(wantedTitle) === normalizeForMatch(candTitle)) {
    titleScore = 1;
  }

  const wantedArtists = splitArtists(track.artist);
  const artistScore = wantedArtists.length > 0 ? artistSimilarity(candidate.artist, wantedArtists) : 0.6;

  const durScore = durationScore(track.durationMs, candidate.durationMs, maxToleranceMs);

  const preferred = settings.preferredProvider;
  const preferenceScore = preferred && candidate.provider === preferred ? 1 : 0.4;

  // When artist info is missing from the candidate entirely, do not let the
  // missing field drag a correct title+duration match below the accept line.
  const effectiveArtistWeight = candidate.artist ? weights.artist : weights.artist * 0.4;
  const effectiveTitleWeight = candidate.title ? weights.title : 0;

  const total =
    (titleScore * effectiveTitleWeight + artistScore * effectiveArtistWeight + durScore * weights.duration + preferenceScore * weights.preference) *
    100;

  return {
    total: Math.round(total * 10) / 10,
    breakdown: {
      title: Math.round(titleScore * 1000) / 1000,
      artist: Math.round(artistScore * 1000) / 1000,
      duration: Math.round(durScore * 1000) / 1000,
      preference: preferenceScore,
    },
  };
}

/**
 * Score a candidate, reusing the breakdown computed during search when present.
 * Candidates carry `score` as a plain number, so the numeric form alone cannot be
 * used to read the per-field breakdown back out.
 * @returns {{total:number, breakdown:{title:number,artist:number,duration:number,preference:number}}}
 */
function scoredFor(candidate, track, settings) {
  if (candidate.breakdown && typeof candidate.score === 'number') {
    return { total: candidate.score, breakdown: candidate.breakdown };
  }
  return scoreCandidate(candidate, track, settings);
}

/** Points subtracted per unit of version penalty (see VERSION_PENALTIES). */
const VERSION_PENALTY_WEIGHT = 3;

/**
 * Apply the version demotion to an already-scored candidate, and return the
 * effective score. Mutates and returns the candidate.
 *
 * The adjustment is folded into `score` and `breakdown.total` together, because
 * `scoredFor` reads the total back out of `breakdown` on later passes — leaving
 * them inconsistent would let a demoted candidate pass the accept threshold.
 */
function applyVersionPenalty(candidate) {
  const penalty = versionPenalty(candidate.title);
  candidate.versionPenalty = penalty;
  if (penalty > 0) {
    const deduction = penalty * VERSION_PENALTY_WEIGHT;
    candidate.score = Math.max(0, Math.round((candidate.score - deduction) * 10) / 10);
    candidate.breakdown.total = candidate.score;
  }
  return candidate;
}

/**
 * Minimum title resemblance for a candidate to be considered at all.
 *
 * This is a deliberately hard floor rather than part of the weighted score:
 * AF-Media-Bar weights artist and title equally, which lets a same-artist
 * different-song entry pass on a perfect artist match plus a coincidental
 * duration match. Requiring real title similarity is the single most effective
 * guard against showing the wrong lyrics.
 */
const MIN_TITLE_SCORE = 0.35;

/**
 * Hard filter: a candidate must not be obviously the wrong song.
 * Duration is only enforced when both sides know it.
 */
export function isCandidateAcceptable(candidate, track, settings = {}) {
  const minScore = Number(settings.minScore ?? 40);
  if (!candidate?.title) return false;
  if (!track) return false;
  if (candidate.durationMs > 0 && track.durationMs > 0) {
    const maxTolerance = Math.max(Number(settings.durationToleranceMs ?? 8000) * 2.5, 20000);
    if (Math.abs(candidate.durationMs - track.durationMs) > maxTolerance) return false;
  }
  const scored = scoredFor(candidate, track, settings);
  if (scored.total < minScore) return false;
  // The title gate comes first: a completely different title is never accepted,
  // however well the artist and duration line up.
  const titleScore = scored.breakdown.title;
  if (titleScore < MIN_TITLE_SCORE) return false;
  if (titleScore < 0.5 && scored.breakdown.artist < 0.85) return false;
  return true;
}

function trackKey(track) {
  return `${track.title}|${track.artist}|${Math.round((track.durationMs || 0) / 1000)}`;
}

/**
 * Search every enabled provider for the current track.
 *
 * @param registry  Map of provider id -> provider instance
 * @param track     Normalised track (title, artist, durationMs, album)
 * @param settings  Lyrics settings from config
 * @param hooks     { onCandidate?: (candidate) => void, shouldAbort?: () => boolean }
 * @returns {{status:'matched'|'notfound'|'error', candidate, alternatives, errors, key}}
 */
export async function resolveLyrics(registry, track, settings = {}, hooks = {}) {
  const enabled = (settings.enabled ?? PROVIDER_IDS).filter((id) => registry.has(id));
  const order = (settings.providerOrder ?? PROVIDER_IDS).filter((id) => enabled.includes(id));
  const key = trackKey(track);

  if (enabled.length === 0 || order.length === 0) {
    return { status: 'error', candidate: null, alternatives: [], errors: [`no lyric providers enabled`], key };
  }

  const errors = [];
  const candidates = [];

  // Run providers concurrently so a slow one cannot delay the whole lookup;
  // per-provider timeouts keep the worst case bounded.
  const tasks = order.map(async (id) => {
    const provider = registry.get(id);
    try {
      const raw = await provider.search(track, settings);
      if (hooks.shouldAbort?.()) return;
      for (const item of raw ?? []) {
        if (!item?.key) continue;
        const candidate = {
          provider: id,
          providerLabel: providerLabel(id),
          key: String(item.key),
          title: String(item.title ?? '').trim(),
          artist: String(item.artist ?? '').trim(),
          album: String(item.album ?? '').trim(),
          durationMs: Number(item.durationMs) || 0,
        };
        const scored = scoreCandidate(candidate, track, settings);
        candidate.score = scored.total;
        candidate.breakdown = scored.breakdown;
        // Demote karaoke / TV-size / cover entries before they are ranked, so a
        // variant cannot outrank the original on provider order alone.
        applyVersionPenalty(candidate);
        candidate.titleScore = scored.breakdown.title;
        candidates.push(candidate);
        hooks.onCandidate?.(candidate);
      }
    } catch (err) {
      errors.push(`${providerLabel(id)}: ${err.message}`);
    }
  });

  await Promise.all(tasks);

  const acceptScore = Number(settings.acceptScore ?? 75);
  const preferred = settings.preferredProvider ?? null;
  const fallback = settings.fallback ?? {};

  /**
   * Every candidate, best first.
   *
   * Ordering is by score, then by how "original" the entry is (a karaoke cut or
   * TV-size edit must not outrank the real recording when they tie), then by
   * provider order, then by how close the title length is to the track's.
   */
  const ranked = [...candidates].sort((a, b) => {
    const byScoreOrder = compareCandidates(a, b);
    if (byScoreOrder !== 0) return byScoreOrder;
    const pa = a.versionPenalty ?? 0;
    const pb = b.versionPenalty ?? 0;
    if (pa !== pb) return pa - pb;
    const ai = order.indexOf(a.provider);
    const bi = order.indexOf(b.provider);
    if (ai !== bi) return ai - bi;
    return Math.abs(a.title.length - track.title.length) - Math.abs(b.title.length - track.title.length);
  });

  const acceptable = ranked.filter((c) => isCandidateAcceptable(c, track, settings));

  const fetchBody = async (candidate) => {
    const provider = registry.get(candidate.provider);
    try {
      const body = await provider.fetchLyrics(candidate, track, settings);
      return { ...candidate, ...body };
    } catch (err) {
      errors.push(`${candidate.providerLabel}: ${err.message}`);
      return null;
    }
  };

  if (acceptable.length === 0) {
    return {
      status: errors.length === order.length ? 'error' : 'notfound',
      candidate: null,
      alternatives: [],
      errors,
      key,
      searchedProviders: order,
    };
  }

  /**
   * Selection policy.
   *
   * The HIGHEST-SCORING candidate that actually yields lyrics wins. The preferred
   * provider is a tie-break, not a first attempt.
   *
   * An earlier version tried every preferred-provider candidate first, which meant
   * a 63-scoring NetEase cover beat a 97-scoring LRCLIB original purely because
   * NetEase was selected as the preferred source.
   *
   * Borrowing (using a source other than the preferred one) is deferred to a
   * second pass and is subject to `fallback`: when the option is off, a source
   * other than the preferred one is only used if the preferred provider produced
   * no lyrics at all — i.e. as a last resort rather than in preference to it.
   */
  const fallbackEnabled = fallback.enabled === true;
  const fallbackMinScore = Number(fallback.minScore ?? 85);
  const isFromPreferred = (candidate) => !preferred || candidate.provider === preferred;
  const byScore = (a, b) => compareCandidates(a, b);

  const deferred = []; // other-source candidates, still in score order
  let firstResolved = null;
  let attemptedAny = false;
  /** Best preferred-source candidate that actually yielded lyrics. */
  let bestPreferred = null;

  // Pass 1: resolve every preferred-source candidate, in descending score order.
  // The best one is recorded rather than returned, because a higher-scoring
  // candidate from another source must still be able to win.
  for (const candidate of [...acceptable].sort(byScore)) {
    if (!isFromPreferred(candidate)) {
      deferred.push(candidate);
      continue;
    }
    attemptedAny = true;
    const resolved = await fetchBody(candidate);
    if (!resolved) continue;
    if (resolved.rawLyric || resolved.rawTranslation) {
      if (!bestPreferred) bestPreferred = resolved;
    } else if (!firstResolved) {
      // Metadata matched but no words; remember it so "matched but no lyrics" is
      // reported distinctly from "not found".
      firstResolved = resolved;
    }
  }

  /**
   * Pass 2: consider candidates from other sources.
   *
   * A higher-scoring result always beats a lower-scoring preferred one — that is
   * the whole point. Only when the preferred source produced nothing at all does
   * the `fallback` option govern, because then we really are borrowing.
   */
  const shouldConsider = (candidate) => {
    // Nothing to defer to: no preferred provider, or it produced no lyrics. This
    // is genuine borrowing, so the fallback option applies.
    if (!preferred || !bestPreferred) {
      if (!preferred) return true;
      if (!attemptedAny && deferred.length > 0) return true; // preferred never returned candidates
      if (!fallbackEnabled) return false;
      return candidate.score >= fallbackMinScore;
    }
    // The preferred source HAS lyrics: only a strictly better match may replace it.
    return candidate.score > bestPreferred.score;
  };

  for (const candidate of deferred) {
    if (!shouldConsider(candidate)) continue;
    const resolved = await fetchBody(candidate);
    if (!resolved) continue;
    if (resolved.rawLyric || resolved.rawTranslation) {
      const borrowed = !preferred || !bestPreferred;
      return {
        status: 'matched',
        candidate: resolved,
        alternatives: ranked.filter((c) => c !== candidate).slice(0, 12),
        errors,
        key,
        confident: candidate.score >= acceptScore,
        viaFallback: borrowed,
        // True when the timings were approximated from untimed plain lyrics.
        estimated: Boolean(resolved.estimated),
        fallbackReason: borrowed
          ? `main source had no lyrics; used ${resolved.providerLabel} at ${candidate.score}`
          : null,
      };
    }
    if (!firstResolved) firstResolved = resolved;
  }

  // The preferred source had lyrics and nothing beat it.
  if (bestPreferred) {
    return {
      status: 'matched',
      candidate: bestPreferred,
      alternatives: ranked.filter((c) => c !== bestPreferred).slice(0, 12),
      errors,
      key,
      confident: bestPreferred.score >= acceptScore,
      viaFallback: false,
      estimated: Boolean(bestPreferred.estimated),
      fallbackReason: null,
    };
  }

  // Borrowing was needed but nothing got through the gate: report no lyrics on
  // purpose so the overlay stays blank until the next track.
  if (preferred) {
    const topOther = deferred[0] ?? null;
    // `deferred` may be empty when every other-source candidate was filtered out
    // by the title gate, which is still a deliberate "nothing to show".
    const blockedByThreshold = fallbackEnabled && topOther && topOther.score < fallbackMinScore;
    return {
      status: 'notfound',
      candidate: null,
      alternatives: ranked.slice(0, 12),
      errors,
      key,
      blankUntilNextTrack: true,
      topCandidateScore: topOther ? topOther.score : null,
      fallbackMinScore,
      fallbackReason: !topOther
        ? 'the main source had no lyrics and no other source produced a usable match'
        : !fallbackEnabled
          ? `main source had no lyrics; the best other source (${topOther.providerLabel}) scores ${topOther.score}, but the fallback option is off`
          : blockedByThreshold
            ? `best other source (${topOther.providerLabel}) scored ${topOther.score}, below the ${fallbackMinScore} threshold`
            : `no other source could provide lyrics`,
    };
  }

  if (firstResolved) {
    return {
      status: 'notfound',
      candidate: null,
      alternatives: ranked.slice(0, 12),
      errors,
      key,
      // Metadata matched but every source was lyric-less: the overlay should show
      // the track as instrumental rather than claiming the lookup failed.
      instrumentalCandidate: firstResolved,
    };
  }

  return { status: 'notfound', candidate: null, alternatives: ranked.slice(0, 12), errors, key };
}

export { PROVIDER_IDS };
