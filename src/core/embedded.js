/**
 * Embedded-asset access.
 *
 * A release `Chorus.exe` carries its front-end and its PowerShell bridge inside the
 * binary, so it is a single file with nothing to install. Two mechanisms are at work:
 *
 * - **SEA assets** — the front-end (`web/`) is read straight out of the executable and
 *   served from memory by the HTTP server. No files are written anywhere.
 * - **Extracted files** — the SMTC bridge must exist as real files on disk for
 *   PowerShell to execute it, so those scripts are written once into a per-user cache
 *   directory and run from there.
 *
 * When running from a source checkout, `node:sea` is absent and every helper here
 * reports "not embedded", so the app falls back to reading the real directories.
 * That keeps `node src/index.js` behaving exactly as before.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `node:sea` is only importable inside a single executable application. */
let sea = null;
try {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  sea = await import('node:sea');
} catch {
  sea = null;
}

/**
 * The directory the executable unpacked itself into.
 *
 * The boot shim creates this and exports it as `CHORUS_HOME`, which matters because the
 * shim has already worked out which location is writable (a locked-down profile can
 * deny the usual one). Guessing again here would pick a different directory and, worse,
 * a different version string.
 */
function appHome() {
  const fromShim = process.env.CHORUS_HOME;
  if (fromShim) return fromShim;
  // Fallback for the case where the shim did not set it.
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Chorus', 'embedded');
}

/** True when running from a bundled Chorus.exe. */
export function isEmbedded() {
  try {
    return Boolean(sea?.isSea?.());
  } catch {
    return false;
  }
}

/** The embedded asset names, or an empty list when running from source. */
export function listEmbedded() {
  if (!isEmbedded()) return [];
  try {
    return sea.getAssetKeys();
  } catch {
    return [];
  }
}

/**
 * Read one embedded asset.
 *
 * `encoding` is omitted for binary assets, in which case a Buffer is returned.
 * Node 24 changed this argument to an options object; passing a plain string is the
 * Node 22 form this project targets, and it is tolerated by later versions.
 */
export function readEmbedded(key, encoding = null) {
  if (!isEmbedded()) return null;
  try {
    if (encoding) return sea.getAsset(key, encoding);
    return Buffer.from(sea.getAsset(key));
  } catch {
    return null;
  }
}

/** True when `key` is present in the executable. */
export function hasEmbedded(key) {
  return readEmbedded(key) !== null;
}

/**
 * The front-end files the HTTP server serves, keyed by request path without a
 * leading slash: `control.html`, `css/control.css`, …
 *
 * Returns null when running from source, so the caller knows to use the disk.
 */
export function webAssets() {
  if (!isEmbedded()) return null;
  const map = new Map();
  for (const key of listEmbedded()) {
    // Support files live under assets/ and tools/; the front-end is everything
    // under web/.
    if (!key.startsWith('web/')) continue;
    const body = readEmbedded(key);
    if (body) map.set(key.slice('web/'.length), body);
  }
  return map.size > 0 ? map : null;
}

// ---------------------------------------------------------------------------
// Extracted files (the PowerShell bridge)
// ---------------------------------------------------------------------------

/**
 * Write every embedded file whose name starts with `prefix` into `targetDir`,
 * preserving relative paths.
 *
 * @returns {string|null} the directory written, or null when not embedded / nothing matched
 */
export function extractEmbeddedTree(prefix, targetDir) {
  if (!isEmbedded()) return null;
  const keys = listEmbedded().filter((k) => k.startsWith(`${prefix}/`));
  if (keys.length === 0) return null;

  for (const key of keys) {
    const rel = key.slice(prefix.length + 1);
    // Refuse to escape the target directory.
    if (rel.includes('..')) continue;
    const dest = path.join(targetDir, rel);
    const body = readEmbedded(key);
    if (!body) continue;

    // Only rewrite when the content differs, so a restart is cheap and does not
    // touch files a running bridge may be holding open.
    try {
      if (fs.existsSync(dest) && fs.readFileSync(dest).equals(body)) continue;
    } catch {
      /* read failure means rewrite */
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  return targetDir;
}

/**
 * Ensure the bundled SMTC bridge exists on disk and return the directory holding it.
 *
 * The boot shim has already unpacked `tools/smtc-bridge` into the chosen application
 * directory, so this points at that copy rather than extracting a second one. The
 * version argument is accepted but unused for that reason — an extra versioned copy
 * previously ended up in a different directory with a different version string, which
 * is exactly the kind of drift that produces two bridges fighting over one port.
 *
 * @returns {{dir: string, script: string, launcher: string}|null}
 */
export function ensureEmbeddedBridge() {
  if (!isEmbedded()) return null;
  const dir = path.join(appHome(), 'tools', 'smtc-bridge');
  const script = path.join(dir, 'server.ps1');
  return {
    dir,
    script,
    launcher: path.join(dir, 'bridge-hidden.vbs'),
  };
}
