/**
 * Where Chorus keeps its runtime data: settings, lyric cache, history, logs.
 *
 * Preference order:
 *   1. CHORUS_DATA_DIR                explicit override, used by the tray helper and tests
 *   2. data/ beside the executable    the installed and portable case: everything the app
 *                                     owns sits inside its own folder
 *   3. %LOCALAPPDATA%\Chorus\data     fallback for a read-only install location, which is
 *                                     what a "Program Files" install without elevation is
 *
 * Step 2 is only used when it is actually writable, which is checked once at startup by
 * attempting to create the folder. Without that check an all-users install would fail to
 * save settings at all rather than quietly working.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../config.js';

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

/** True when the directory can be created and written to. */
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.chorus-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir() {
  const override = process.env.CHORUS_DATA_DIR;
  if (override) return override;

  // Inside the app's own folder, which is what an installer creates.
  const beside = path.join(ROOT, 'data');
  if (isWritable(beside)) return beside;

  try {
    const fallback = path.join(localAppData(), 'Chorus', 'data');
    if (isWritable(fallback)) return fallback;
  } catch {
    /* fall through */
  }

  // Nothing is writable; return the intended location so error messages are sensible.
  return beside;
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
