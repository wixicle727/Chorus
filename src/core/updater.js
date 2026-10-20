/**
 * Self-updating from GitHub Releases.
 *
 * Two upgrade routes, picked by whether the running copy owns its folder:
 *
 *   writable folder  download the portable archive, unpack it to a temporary
 *                    directory, then let a detached helper copy it over this
 *                    folder once this process has exited.
 *   read-only folder download the installer and hand over to it, because only an
 *                    elevated process can write to "Program Files".
 *
 * In both cases the runtime folder (`data/`) is excluded from the copy, and the
 * unpack happens outside the application folder, so settings, the lyric cache and
 * history survive the update untouched.
 *
 * The archive is read with node:zlib rather than a dependency: a zip is a small
 * enough format that shipping the reader here is cheaper than carrying a package.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

import { ROOT, VERSION } from '../config.js';
import { DATA_DIR } from './paths.js';
import { checkForUpdate } from './update.js';

/** Where downloads and unpacked files go. Never inside the application folder. */
export const UPDATE_DIR = path.join(os.tmpdir(), 'chorus-update');

/** Progress of the current (last) update attempt, polled by the control panel. */
let progress = { state: 'idle', received: 0, total: 0, error: null, mode: null, version: null };

export function updateProgress() {
  return { ...progress };
}

function setProgress(patch) {
  progress = { ...progress, ...patch };
}

/* --------------------------------- zip ---------------------------------- */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * Read a zip archive from memory.
 *
 * Supports the two compression methods a Windows-produced archive uses: stored (0)
 * and deflate (8). Zip64 is rejected rather than half-handled — a Chorus release is
 * a few tens of megabytes, far below the point where any tool would emit it.
 *
 * @param {Buffer} buffer whole archive
 * @returns {Array<{name: string, data: Buffer}>}
 */
export function readZipEntries(buffer) {
  // The end-of-central-directory record sits at the tail, after a comment of up to
  // 64 KiB, so it has to be searched for backwards.
  let eocd = -1;
  const stop = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= stop; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('the downloaded file is not a zip archive');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset === 0xffffffff || count === 0xffff) {
    throw new Error('zip64 archives are not supported');
  }

  const entries = [];
  let pointer = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) {
      throw new Error('the zip archive has a damaged index');
    }
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    pointer += 46 + nameLength + extraLength + commentLength;

    // Directory entries carry no data.
    if (name.endsWith('/')) continue;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`the zip archive has a damaged entry for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`the zip archive uses an unsupported compression method (${method})`);

    if (data.length !== uncompressedSize && method === 0) {
      throw new Error(`the zip archive is truncated at ${name}`);
    }
    entries.push({ name, data });
  }
  return entries;
}

/**
 * Refuse entry names that would write outside the destination folder.
 *
 * A release archive is trusted, but this is the one place where a mistake would
 * overwrite arbitrary files, so the check is explicit.
 */
function safeRelativePath(name) {
  const normalised = name.replace(/\\/g, '/');
  if (normalised.startsWith('/') || /^[a-z]:/i.test(normalised)) return null;
  const parts = normalised.split('/');
  if (parts.some((part) => part === '..' || part === '.' || part === '')) return null;
  return normalised;
}

/**
 * Unpack an archive into a folder.
 *
 * @returns {number} number of files written
 */
export function extractZip(buffer, destination) {
  fs.mkdirSync(destination, { recursive: true });
  let written = 0;
  for (const entry of readZipEntries(buffer)) {
    const relative = safeRelativePath(entry.name);
    if (!relative) throw new Error(`the zip archive contains an unsafe path: ${entry.name}`);
    // Never let the archive carry runtime data over the top of the user's own.
    if (relative.split('/')[0].toLowerCase() === 'data') continue;
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    written += 1;
  }
  return written;
}

/* ------------------------------- helpers -------------------------------- */

/** True when this process can create files in `dir` (i.e. an update can be applied there). */
export function canWriteTo(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.chorus-update-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function downloadTo(url, destination, { timeoutMs = 600000 } = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': `Chorus/${VERSION}`, Accept: 'application/octet-stream' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub responded with HTTP ${response.status}`);
  if (!response.body) throw new Error('the download contained no data');

  const total = Number(response.headers.get('content-length')) || 0;
  setProgress({ received: 0, total });

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    received += buffer.length;
    setProgress({ received });
  }
  const data = Buffer.concat(chunks);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, data);
  return data;
}

/* ------------------------------- backups -------------------------------- */

/** How many pre-update backups to keep; older ones are pruned. */
const BACKUP_KEEP = 3;

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function directorySize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* a file that vanished mid-walk does not matter here */
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/**
 * Copy the runtime data folder somewhere safe before the files are replaced.
 *
 * An update that goes wrong must never cost the user their settings, lyric cache or
 * history, so this runs first and the update is abandoned if it fails. The backup is
 * a plain copy — restoring is dropping the folder back in place.
 *
 * @returns {{dir: string, bytes: number, files: number, exe: string|null}}
 */
export function backupBeforeUpdate({ destination, exeName }) {
  // Prefer a folder beside the app (easy to find); fall back to the update workspace
  // when the app folder is read-only, which is the Program Files case.
  const beside = path.join(destination, 'backup');
  let root = beside;
  if (!canWriteTo(destination)) root = path.join(UPDATE_DIR, 'backup');

  const dir = path.join(root, `${VERSION}-${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });

  let bytes = 0;
  let files = 0;
  if (fs.existsSync(DATA_DIR)) {
    fs.cpSync(DATA_DIR, path.join(dir, 'data'), { recursive: true });
    ({ bytes, files } = directorySize(path.join(dir, 'data')));
  }

  // Keep the outgoing executable too: if the new build starts and misbehaves, the old
  // one is right there and does not need to be downloaded again.
  let exe = null;
  const currentExe = path.join(destination, exeName);
  if (fs.existsSync(currentExe)) {
    exe = path.join(dir, `Chorus-${VERSION}.exe`);
    try {
      fs.copyFileSync(currentExe, exe);
    } catch {
      exe = null;
    }
  }

  fs.writeFileSync(
    path.join(dir, 'RESTORE.txt'),
    [
      `Backup taken before updating Chorus ${VERSION}.`,
      '',
      'To roll back:',
      '  1. Close Chorus.',
      `  2. Copy the folder "data" back over ${path.join(destination, 'data')}`,
      exe ? `  3. Copy "${path.basename(exe)}" over ${currentExe}` : '  3. Reinstall the previous version.',
      '',
      'The data folder holds settings, the lyric cache and the history.',
    ].join('\r\n'),
    'utf8',
  );

  pruneBackups(root);
  return { dir, bytes, files, exe };
}

function pruneBackups(root) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    while (entries.length > BACKUP_KEEP) {
      const oldest = entries.shift();
      fs.rmSync(path.join(root, oldest), { recursive: true, force: true });
    }
  } catch {
    /* pruning is housekeeping; never let it fail an update */
  }
}

/* ------------------------------ apply paths ----------------------------- */

/**
 * Write the detached helper that swaps the files after this process exits.
 *
 * A .cmd is used rather than a Node script because the helper must survive the
 * application exiting, and cmd.exe is always present. It is started through a .vbs
 * shim so no console window flashes on screen.
 *
 * `robocopy /XD data` is what keeps settings and the lyric cache intact: that
 * folder is excluded by name at every depth, so nothing the update copies can
 * land in it.
 */
function writeSwapHelper({ source, destination, exeName, pid }) {
  const helperPath = path.join(source, 'apply-update.cmd');
  const launcherPath = path.join(source, 'apply-update.vbs');
  // Outside `source` on purpose: the stage folder is deleted once the copy is done, and
  // a log that disappears with it would be useless exactly when it is needed.
  const logPath = path.join(path.dirname(source), 'apply-update.log');

  // /MIR, not /E: the destination has to end up matching the new release, so files
  // that no longer ship (renamed assets, dropped scripts) are removed instead of
  // lingering next to the new ones. The exclusions are what makes that safe:
  //   data    the user's settings, lyric cache and history
  //   backup  the pre-update backup this same run just created
  //   /XF     this helper, which must not copy itself into the app folder
  const mirror = [
    `robocopy "${source}" "${destination}" /MIR`,
    '/XD "data" "backup"',
    '/XF "apply-update.cmd" "apply-update.vbs" "apply-update.log"',
    '/XJ /R:5 /W:2 /NFL /NDL /NJH /NJS',
  ].join(' ');

  const lines = [
    '@echo off',
    'setlocal',
    // Wait for the running Chorus to exit before touching its files. The exe itself
    // cannot be replaced while it is open.
    ':wait',
    `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul`,
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto wait',
    ')',
    `${mirror} > "${logPath}"`,
    'set "RC=%ERRORLEVEL%"',
    // robocopy reports 0-7 for success, 8+ for a real failure.
    'if %RC% GEQ 8 (',
    `  echo update failed: robocopy exit %RC% >> "${logPath}"`,
    '  exit /b 1',
    ')',
    `start "" "${path.join(destination, exeName)}"`,
    // Clean up the unpacked copies; nothing has it open any more. The log lives one
    // level up, so it survives this.
    'timeout /t 2 /nobreak >nul',
    `rmdir /s /q "${source}"`,
  ];
  fs.writeFileSync(helperPath, `${lines.join('\r\n')}\r\n`, 'utf8');
  fs.writeFileSync(
    launcherPath,
    `CreateObject("WScript.Shell").Run "cmd.exe /c ""${helperPath}""", 0, False\r\n`,
    'utf8',
  );
  return { helperPath, launcherPath, logPath };
}

/** Start the swap helper and return immediately. */
function launchHelper(launcherPath) {
  // wscript is used because a plain detached spawn of a console program does not
  // reliably outlive the process that started it.
  const child = spawn('wscript.exe', [launcherPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/* ------------------------------- public API ----------------------------- */

/** Pick the portable archive out of a release's asset list. */
export function pickPortableAsset(update) {
  const assets = Array.isArray(update?.assets) ? update.assets : [];
  return assets.find((asset) => /-portable\.zip$/i.test(asset.name)) ?? null;
}

/** Pick the installer out of a release's asset list. */
export function pickInstallerAsset(update) {
  const assets = Array.isArray(update?.assets) ? update.assets : [];
  return assets.find((asset) => /setup\.exe$/i.test(asset.name)) ?? null;
}

/**
 * Download and stage a newer release.
 *
 * Resolves once everything needed to apply is on disk; the caller then decides
 * when to exit (the swap helper is already waiting on this process).
 *
 * @param {{onReady?: (info: object) => void}} options
 * @returns {Promise<object>} `{ok, mode, ...}`; `ok: false` carries an error string
 */
export async function stageUpdate({ pid = process.pid } = {}) {
  setProgress({ state: 'checking', received: 0, total: 0, error: null, mode: null, version: null });

  let update;
  try {
    update = await checkForUpdate({ force: true });
  } catch (err) {
    setProgress({ state: 'error', error: err.message });
    return { ok: false, error: `could not check for updates: ${err.message}` };
  }
  if (!update.ok) {
    setProgress({ state: 'error', error: update.reason });
    return { ok: false, error: update.reason };
  }
  if (!update.updateAvailable) {
    setProgress({ state: 'idle', error: null });
    return { ok: false, error: `Chorus ${update.current} is already the newest version` };
  }

  setProgress({ version: update.latest });
  const exeName = path.basename(process.execPath);
  // ROOT is the folder the executable lives in; that is what an update replaces.
  const destination = ROOT;
  const writable = canWriteTo(destination);

  try {
    fs.rmSync(UPDATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(UPDATE_DIR, { recursive: true });

    if (!writable) {
      // Program Files: only the installer can replace these files.
      const installer = pickInstallerAsset(update);
      if (!installer) {
        throw new Error('this install is read-only and the release has no installer');
      }
      setProgress({ state: 'downloading', mode: 'installer' });
      const target = path.join(UPDATE_DIR, installer.name);
      await downloadTo(installer.url, target);

      // The installer preserves the data folder itself, but take a copy anyway: this
      // path is the one used on a hardened "Program Files" install, where a failed
      // upgrade is the least recoverable.
      setProgress({ state: 'backing-up', mode: 'installer' });
      let backup = null;
      try {
        backup = backupBeforeUpdate({ destination, exeName });
      } catch {
        backup = null;
      }

      setProgress({ state: 'ready', mode: 'installer' });
      return {
        ok: true,
        mode: 'installer',
        version: update.latest,
        path: target,
        backupDir: backup?.dir ?? null,
        message: 'The installer will now run and replace the files. Chorus will close first.',
      };
    }

    const portable = pickPortableAsset(update);
    if (!portable) throw new Error('the release has no portable archive to update from');

    setProgress({ state: 'downloading', mode: 'zip' });
    const archive = path.join(UPDATE_DIR, portable.name);
    const data = await downloadTo(portable.url, archive);

    setProgress({ state: 'extracting' });
    const stage = path.join(UPDATE_DIR, 'stage');
    fs.rmSync(stage, { recursive: true, force: true });
    const files = extractZip(data, stage);
    if (files === 0) throw new Error('the downloaded archive was empty');

    // The staged archive must still contain the executable, otherwise the swap would
    // replace the app with an incomplete tree.
    if (!fs.existsSync(path.join(stage, exeName))) {
      throw new Error(`the downloaded archive does not contain ${exeName}`);
    }

    // Back up settings, cache and the outgoing executable before anything is
    // replaced. If this fails the update is abandoned rather than risking the data.
    setProgress({ state: 'backing-up' });
    let backup;
    try {
      backup = backupBeforeUpdate({ destination, exeName });
    } catch (err) {
      throw new Error(`could not back up your data before updating (${err.message}); nothing was changed`);
    }

    const helper = writeSwapHelper({ source: stage, destination, exeName, pid });
    setProgress({ state: 'ready', mode: 'zip' });
    return {
      ok: true,
      mode: 'zip',
      version: update.latest,
      files,
      from: update.current,
      helper: helper.helperPath,
      log: helper.logPath,
      dataDir: DATA_DIR,
      backupDir: backup.dir,
      backupFiles: backup.files,
      message: `Chorus will close, install ${update.latest} and start again. Your settings and cache were backed up to ${backup.dir}.`,
    };
  } catch (err) {
    setProgress({ state: 'error', error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * The script that starts the downloaded installer with elevation.
 *
 * Setup requests administrator rights, so it can only be started through
 * ShellExecute with the "runas" verb — CreateProcess on an elevation-required binary
 * fails outright with ERROR_ELEVATION_REQUIRED. `/SILENT /CLOSEAPPLICATIONS` lets it
 * replace the files without any further prompts.
 */
export function installerLauncher(installerPath) {
  return `CreateObject("Shell.Application").ShellExecute "${installerPath}", `
    + `"/SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS", "", "runas", 1\r\n`;
}

/** Start the staged swap. Called after the HTTP response has been sent. */
export function applyStagedUpdate(staged) {
  if (!staged?.ok) return false;
  if (staged.mode === 'zip') {
    launchHelper(path.join(path.dirname(staged.helper), 'apply-update.vbs'));
    return true;
  }

  const vbs = path.join(UPDATE_DIR, 'run-installer.vbs');
  fs.writeFileSync(vbs, installerLauncher(staged.path), 'utf8');
  const child = spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return true;
}

/** Test seam. */
export function resetUpdateProgress() {
  progress = { state: 'idle', received: 0, total: 0, error: null, mode: null, version: null };
}
