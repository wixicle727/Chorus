#!/usr/bin/env node
/**
 * Chorus — live lyrics for OBS, driven by Windows SMTC.
 *
 *   node src/index.js              start the engine and the local server
 *   node src/index.js --port N     override the port
 *   node src/index.js --no-open    do not open the control panel in a browser
 *   node src/index.js --tray       also show the system tray icon (Windows)
 *   node src/index.js --background start hidden and keep no console
 *   node src/index.js --quit       stop a server already running on the port
 *
 * Three pieces:
 *   smtc-bridge (http://127.0.0.1:5000)  ->  this engine  ->  OBS browser source
 *
 * The OBS browser source points at http://127.0.0.1:<port>/overlay
 * The control panel is     http://127.0.0.1:<port>/control
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadConfig, saveConfig, ROOT } from './config.js';
import { Engine } from './core/engine.js';
import { Store } from './core/store.js';
import { createServer } from './core/server.js';
import { getAutostartStatus } from './core/autostart.js';
import { log, openLogFile, getLogPath } from './core/log.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const noOpen = flag('--no-open') || flag('--background');
const wantTray = flag('--tray');
const quiet = flag('--quiet');
const host = option('--host', '127.0.0.1');

// When started hidden, mirror output to a file so the tray's "View server
// console" has something real to show.
const logFileOption = option('--log-file', null);
if (logFileOption) openLogFile(logFileOption);

let config = loadConfig();
const portOverride = option('--port', null);
if (portOverride) config = { ...config, server: { ...config.server, port: Number(portOverride) } };

/** Written so the tray helper can adopt (and later stop) a server it did not start. */
const PID_FILE = path.join(ROOT, 'data', '.chorus.pid');

function writePidFile() {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {
    /* a missing pid file only costs the tray its adopt/stop convenience */
  }
}

function clearPidFile() {
  try {
    // Only remove the file if it still names this process.
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.rmSync(PID_FILE, { force: true });
    }
  } catch {
    /* ignore */
  }
}

/** `--quit`: ask the running instance to stop, then exit. */
async function quitRunningInstance() {
  const base = `http://127.0.0.1:${config.server.port}`;
  try {
    const res = await fetch(`${base}/api/shutdown`, { method: 'POST' });
    if (res.ok) {
      console.log(`  Asked Chorus on port ${config.server.port} to stop.`);
      process.exit(0);
    }
    console.log(`  Chorus responded with HTTP ${res.status}.`);
  } catch {
    console.log(`  Nothing is listening on port ${config.server.port}.`);
  }
  process.exit(0);
}

const store = new Store(config);
const engine = new Engine(config, store);

const getConfig = () => config;
const setConfig = (next) => {
  config = next;
};

const api = createServer({
  engine,
  store,
  getConfig,
  setConfig,
  onShutdown: () => shutdown('requested'),
});

function banner(address) {
  const port = address.port;
  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  if (quiet) {
    // The log file gets a compact, greppable form instead of the art.
    log.tagged(`Chorus listening on ${base} (overlay ${base}/overlay)`);
    return base;
  }
  const line = '─'.repeat(64);
  log.info(`\n  ${line}`);
  log.info('   Chorus — live lyrics for OBS, from Windows SMTC');
  log.info(`  ${line}`);
  log.info(`   OBS browser source   ${base}/overlay`);
  log.info(`   Control panel        ${base}/control`);
  log.info(`  ${line}`);
  log.info(`   smtc-bridge          ${config.smtc.url}/now-playing`);
  log.info(`   Primary platform     ${config.source.primaryPlatform}`);
  log.info(`   Lyric sources        ${config.lyrics.enabled.join(', ')}`);
  log.info(`   Data folder          ${store.stats().dataDir}`);
  log.info(`  ${line}`);
  log.info('   In OBS: add a Browser source, size 1200x300, and tick');
  log.info('   "Shutdown source when not visible" off. The page is transparent.');
  log.info(`  ${line}\n`);
  return base;
}

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* opening a browser is a convenience, never a failure */
  }
}

/** Launch the tray helper detached, so it survives independently of this process. */
function startTrayHelper(port) {
  if (process.platform !== 'win32') {
    log.warn('  --tray is only supported on Windows.');
    return;
  }
  const script = path.join(ROOT, 'launcher', 'chorus-tray.ps1');
  if (!fs.existsSync(script)) {
    log.warn(`  Tray helper not found at ${script}`);
    return;
  }
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    spawn(
      fs.existsSync(shell) ? shell : 'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Root', ROOT, '-Port', String(port), '-NoServer'],
      { detached: true, stdio: 'ignore', windowsHide: true },
    ).unref();
  } catch (err) {
    log.warn(`  Could not start the tray helper: ${err.message}`);
  }
}

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.tagged(`Shutting down (${reason})`);
  engine.stop();
  clearPidFile();
  try {
    await api.close();
  } catch {
    /* ignore */
  }
  log.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error(`  Unexpected error: ${err?.stack ?? err}`);
});
process.on('unhandledRejection', (err) => {
  log.error(`  Unhandled rejection: ${err?.stack ?? err}`);
});

async function main() {
  if (flag('--quit')) {
    await quitRunningInstance();
    return;
  }

  const address = await api.listen(config.server.port, host);
  const base = banner(address);
  engine.start();
  writePidFile();
  log.tagged(`Server started (pid ${process.pid}, port ${address.port})`);

  // Persist the config once so a first run leaves an editable file behind.
  saveConfig(config);

  if (wantTray) {
    startTrayHelper(address.port);
  } else if (!noOpen) {
    openBrowser(`${base}/control`);
  }

  const status = await getAutostartStatus();
  if (!status.enabled && !noOpen && !quiet) {
    log.info('   Tip: run  node src/index.js --tray  for a tray icon, or turn on');
    log.info('   "Start with Windows" in the control panel to launch it at sign-in.\n');
  }
}

main().catch((err) => {
  log.error(`  Failed to start: ${err.message}`);
  log.close();
  process.exit(1);
});
