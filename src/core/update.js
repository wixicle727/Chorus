/**
 * Update checking against GitHub Releases.
 *
 * Asks the repository's public releases API for the newest release and compares it with
 * the running version. No account or token is needed for a public repository, and the
 * result is cached so that opening the panel repeatedly does not hammer the API — an
 * unauthenticated client is limited to 60 requests an hour per address.
 *
 * Nothing is downloaded or installed automatically: this only reports.
 */

import { VERSION } from '../config.js';

const REPO = 'wixicle727/Chorus';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

/** How long a successful result is reused before asking GitHub again. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Failures are cached far more briefly, so a transient outage does not stick. */
const ERROR_TTL_MS = 5 * 60 * 1000;

let cache = null;

/**
 * Parse a version into comparable numbers.
 *
 * Accepts the "v1.2.3" form GitHub release tags use, and tolerates a trailing
 * pre-release suffix ("1.2.0-beta.1") by keeping it for a tie-break rather than
 * discarding it, so a pre-release is never treated as newer than the final release.
 */
export function parseVersion(input) {
  const text = String(input ?? '').trim().replace(/^v/i, '');
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Compare two versions.
 *
 * @returns {number} 1 when `a` is newer, -1 when older, 0 when equal
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }

  // Same numbers: a release outranks a pre-release of itself.
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease > right.prerelease ? 1 : -1;
}

function unavailable(reason, extra = {}) {
  return { ok: false, current: VERSION, reason, releasesUrl: RELEASES_PAGE, ...extra };
}

/**
 * Check for a newer release.
 *
 * @param {{force?: boolean, timeoutMs?: number}} options
 * @returns {Promise<object>} always resolves; `ok: false` carries a `reason`
 */
export async function checkForUpdate({ force = false, timeoutMs = 8000 } = {}) {
  if (!force && cache && Date.now() - cache.at < cache.ttl) {
    return { ...cache.value, cached: true };
  }

  const remember = (value, ttl) => {
    cache = { value, at: Date.now(), ttl };
    return value;
  };

  let response;
  try {
    response = await fetch(RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub asks for a User-Agent; requests without one can be rejected.
        'User-Agent': `Chorus/${VERSION}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return remember(unavailable(`could not reach GitHub (${err.name === 'TimeoutError' ? 'timed out' : err.message})`), ERROR_TTL_MS);
  }

  if (response.status === 404) {
    // No published releases yet is not an error worth alarming anyone about.
    return remember(unavailable('no published release was found'), CACHE_TTL_MS);
  }
  if (response.status === 403 || response.status === 429) {
    return remember(unavailable('GitHub is rate-limiting update checks; try again later'), ERROR_TTL_MS);
  }
  if (!response.ok) {
    return remember(unavailable(`GitHub responded with HTTP ${response.status}`), ERROR_TTL_MS);
  }

  let release;
  try {
    release = await response.json();
  } catch {
    return remember(unavailable('GitHub returned a response that could not be read'), ERROR_TTL_MS);
  }

  const tag = release.tag_name ?? release.name ?? '';
  const latest = String(tag).replace(/^v/i, '');
  if (!parseVersion(latest)) {
    return remember(unavailable(`the latest release has an unreadable version ("${tag}")`), CACHE_TTL_MS);
  }

  const assets = Array.isArray(release.assets)
    ? release.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
    : [];

  // Point at the installer when there is one, since that is the intended way to upgrade.
  const installer = assets.find((a) => /setup\.exe$/i.test(a.name)) ?? null;

  return remember(
    {
      ok: true,
      current: VERSION,
      latest,
      updateAvailable: compareVersions(latest, VERSION) > 0,
      name: release.name ?? null,
      publishedAt: release.published_at ?? null,
      notes: typeof release.body === 'string' ? release.body : null,
      pageUrl: release.html_url ?? RELEASES_PAGE,
      downloadUrl: installer?.url ?? null,
      downloadName: installer?.name ?? null,
      assets,
      releasesUrl: RELEASES_PAGE,
    },
    CACHE_TTL_MS,
  );
}

/** Test seam: forget any cached result. */
export function clearUpdateCache() {
  cache = null;
}

export { REPO, RELEASES_PAGE };
