/**
 * Where Chorus keeps its runtime data: settings, lyric cache, history, logs.
 *
 * This deliberately does NOT live beside the executable.
 *
 * Two reasons. A single-file release should stay a single file — an exe that grows a
 * `data/` folder next to itself is not what "one executable" promises, and a folder
 * beside a downloaded exe looks like clutter. And the install location may be read-only
 * (Program Files, a locked-down profile), so writing settings there can simply fail.
 *
 * `%LOCALAPPDATA%\Chorus` is the conventional per-user location for application data on
 * Windows and needs no administrator rights.
 *
 * Overrides, highest priority first:
 *   CHORUS_DATA_DIR            environment variable, used by the tray helper and tests
 *   data/ beside the executable   only when it already exists, so a portable/unzipped
 *                                 layout keeps working and upgrading does not strand data
 *   %LOCALAPPDATA%\Chorus\data
 *   <install folder>\data         last resort, when LOCALAPPDATA is unavailable
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../config.js';

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function resolveDataDir() {
  const override = process.env.CHORUS_DATA_DIR;
  if (override) return override;

  // An existing data/ folder wins, so a portable install and anyone upgrading from an
  // earlier version keeps their settings, cache and history.
  const legacy = path.join(ROOT, 'data');
  if (fs.existsSync(legacy)) return legacy;

  try {
    return path.join(localAppData(), 'Chorus', 'data');
  } catch {
    return legacy;
  }
}

/** Absolute path to the runtime data folder. */
export const DATA_DIR = resolveDataDir();

export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
export const OVERRIDES_PATH = path.join(DATA_DIR, 'overrides.json');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const PID_FILE = path.join(DATA_DIR, '.chorus.pid');
export const INDEX_PATH = path.join(CACHE_DIR, 'index.json');

/** Create the folders on first use. Never throws: a missing folder is recoverable. */
export function ensureDataDirs() {
  for (const dir of [DATA_DIR, CACHE_DIR, LOG_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* the caller degrades gracefully */
    }
  }
}
