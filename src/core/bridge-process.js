/**
 * The built-in SMTC bridge, managed by Chorus.
 *
 * Chorus ships its own SMTC bridge at `tools/smtc-bridge/` (PowerShell). This
 * module starts it as a child process and stops it again on shutdown, so the two
 * have a single lifecycle: start Chorus and the bridge is there; quit Chorus and it
 * goes away. There is no separate auto-start entry to keep in sync.
 *
 * Why a child process rather than reading SMTC in-process: Node cannot bind WinRT.
 * PowerShell can, so it is what reads the session and serves the same REST API that
 * smtc-bridge does.
 *
 * The bridge is started with `stdio: 'ignore'` and is deliberately NOT detached.
 * Measured on Windows: a detached, unref'd child runs and then exits immediately,
 * whereas a non-detached one with ignored stdio stays up for the life of the
 * parent. Detaching would also be wrong here, since Chorus owns the lifecycle.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

/** Where the bundled bridge lives. */
export const BRIDGE_DIR = path.join(ROOT, 'tools', 'smtc-bridge');
export const BRIDGE_SCRIPT = path.join(BRIDGE_DIR, 'server.ps1');

function powershellPath() {
  const candidate = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

/** Query a bridge's /health. Resolves to null when nothing usable answers. */
async function probe(baseUrl, timeoutMs = 1500) {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? body : null;
  } catch {
    return null;
  }
}

/**
 * Owns the lifecycle of one bridge process.
 *
 * Nothing here throws: a bridge that cannot start must degrade Chorus to "no track
 * found" rather than stopping the server from starting at all.
 */
export class BridgeProcess {
  constructor({ port = 5000, host = '127.0.0.1', pollMs = 500, log = console } = {}) {
    this.port = Number(port);
    this.host = host;
    this.pollMs = Number(pollMs);
    this.log = log;
    this.child = null;
    /** True only when this instance started the process, so we never kill a foreign one. */
    this.owns = false;
    /** 'external' | 'managed' | 'starting' | 'failed' | 'disabled' */
    this.state = 'disabled';
    this.detail = null;
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  snapshot() {
    return {
      state: this.state,
      detail: this.detail,
      port: this.port,
      url: this.url,
      managed: this.owns,
      pid: this.child?.pid ?? null,
      available: fs.existsSync(BRIDGE_SCRIPT),
    };
  }

  /**
   * Bring a bridge up.
   *
   * If something already answers on the port it is adopted rather than fought over —
   * that is also how a user who prefers the stock smtc-bridge keeps using it.
   */
  async start() {
    if (await probe(this.url)) {
      this.state = 'external';
      this.owns = false;
      this.detail = 'a bridge was already running on this port; Chorus is using it';
      return this.snapshot();
    }

    if (!fs.existsSync(BRIDGE_SCRIPT)) {
      this.state = 'failed';
      this.detail = `the bundled bridge is missing at ${BRIDGE_SCRIPT}`;
      this.log?.warn?.(`  Built-in bridge unavailable: ${this.detail}`);
      return this.snapshot();
    }

    this.state = 'starting';
    try {
      this.child = spawn(
        powershellPath(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          BRIDGE_SCRIPT,
          '-Port',
          String(this.port),
          '-HostName',
          this.host,
          '-PollMs',
          String(this.pollMs),
          '-Quiet',
        ],
        {
          // No pipes, and NOT detached: see the note at the top of this file.
          stdio: 'ignore',
          windowsHide: true,
          detached: false,
        },
      );
      this.owns = true;

      this.child.on('error', (err) => {
        this.state = 'failed';
        this.detail = err.message;
        this.log?.warn?.(`  Built-in bridge failed to start: ${err.message}`);
      });
      this.child.on('exit', (code) => {
        // An exit after we started it means it died: PowerShell missing, port taken
        // by something else between probe and bind, WinRT unavailable.
        if (this.owns && this.state !== 'stopped') {
          this.state = 'failed';
          this.detail = `the bridge exited with code ${code}`;
          this.log?.warn?.(`  Built-in bridge exited (code ${code}).`);
        }
      });

      // PowerShell plus a WinRT request is not instant; wait for it to answer.
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (await probe(this.url, 2000)) {
          this.state = 'managed';
          this.detail = `started by Chorus (pid ${this.child.pid})`;
          return this.snapshot();
        }
        if (this.state === 'failed') return this.snapshot();
        await new Promise((r) => setTimeout(r, 400));
      }

      this.state = 'failed';
      this.detail = 'the bridge did not answer within 20s';
      this.log?.warn?.(`  Built-in bridge did not answer on ${this.url} within 20s.`);
      return this.snapshot();
    } catch (err) {
      this.state = 'failed';
      this.detail = err.message;
      this.log?.warn?.(`  Could not start the built-in bridge: ${err.message}`);
      return this.snapshot();
    }
  }

  /** Stop the bridge, but only if this process started it. */
  stop() {
    if (!this.owns || !this.child) {
      this.state = this.state === 'external' ? 'external' : 'disabled';
      return;
    }
    this.state = 'stopped';
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
    this.owns = false;
  }
}

/** Probe a base URL's bridge without starting anything. Used by the panel. */
export async function probeBridge(baseUrl) {
  return probe(String(baseUrl).replace(/\/+$/, ''), 2500);
}
