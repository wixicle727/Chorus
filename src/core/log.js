/**
 * Console output, optionally mirrored to a log file.
 *
 * When Chorus runs hidden (started by the tray helper at sign-in) there is no
 * console to look at, so the launcher passes a log path and everything written
 * here is appended to it as UTF-8.
 *
 * Deliberately NOT implemented by piping the process output through PowerShell:
 * Windows PowerShell 5.1 decodes a redirected pipe using the ANSI codepage, which
 * turns the banner's box-drawing characters into mojibake. Writing the file
 * ourselves keeps one encoding end to end.
 *
 * Interception is installed on the standard streams rather than replacing
 * `console`, so output from every module (which uses console.* directly) is
 * captured without those modules needing to know a log file exists.
 */

import fs from 'node:fs';
import path from 'node:path';

let logStream = null;
let logPath = null;

/** Start mirroring console output into `filePath`. */
export function openLogFile(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Rotate at 5 MB so a long-running background process cannot fill the disk.
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 5 * 1024 * 1024) {
      fs.rmSync(`${filePath}.1`, { force: true });
      fs.renameSync(filePath, `${filePath}.1`);
    }
    logStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    logPath = filePath;
    installInterception();
  } catch {
    logStream = null;
    logPath = null;
  }
  return logStream !== null;
}

/**
 * Tee process.stdout / process.stderr into the log file.
 *
 * `_write` is the internal hook every write funnels through, including
 * `console.log`, so one override captures everything. The original is always
 * called, so running in a terminal still prints normally.
 */
function installInterception() {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.__chorusTee) continue;
    const original = stream._write?.bind(stream);
    if (!original) continue;
    stream._write = (chunk, encoding, callback) => {
      if (logStream && !logStream.destroyed) {
        try {
          logStream.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        } catch {
          /* a failing log must never break output */
        }
      }
      // Older Node streams pass the callback third; newer may omit it.
      if (typeof encoding === 'function') return original(chunk, 'utf8', encoding);
      return original(chunk, encoding, callback);
    };
    stream.__chorusTee = true;
  }
}

export function getLogPath() {
  return logPath;
}

function stamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(stream, text) {
  try {
    stream.write(text);
  } catch {
    /* a broken console or log must never take the server down */
  }
}

export const log = {
  info(...args) {
    write(process.stdout, `${args.map(String).join(' ')}\n`);
  },
  /** Prefix with a timestamp; used for lifecycle events. */
  tagged(...args) {
    write(process.stdout, `[${stamp()}] ${args.map(String).join(' ')}\n`);
  },
  warn(...args) {
    write(process.stderr, `${args.map(String).join(' ')}\n`);
  },
  error(...args) {
    write(process.stderr, `${args.map(String).join(' ')}\n`);
  },
  close() {
    if (!logStream) return;
    const stream = logStream;
    logStream = null;
    try {
      stream.end();
    } catch {
      /* ignore */
    }
  },
};
