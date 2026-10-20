/**
 * Update tests: download, unpack, back up and swap.
 *
 *   node test/updater.js
 *
 * The updater decides what to replace from `ROOT`, which is derived from where the
 * module lives. To exercise a real swap without touching this checkout, the test copies
 * `src/` and `package.json` into a temporary folder and imports the copy from there — so
 * `ROOT` is the temporary install and every file the update touches is disposable.
 *
 * GitHub is stubbed at the `fetch` level, and the "release" archive is served from a
 * local HTTP server, so this runs without network access and without publishing
 * anything. The swap helper is asserted for content, then run with its "start the app"
 * line removed: mirroring the files is the part worth proving here, and starting a
 * process would outlive the test.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u001b[32m\u2713\u001b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \u001b[31m\u2717\u001b[0m ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/* --------------------------------- zip ---------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Build a stored (uncompressed) zip, which is all this test needs. */
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/* ------------------------------ test setup ------------------------------ */

const install = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-update-test-'));
fs.cpSync(path.join(SOURCE, 'src'), path.join(install, 'src'), { recursive: true });
fs.copyFileSync(path.join(SOURCE, 'package.json'), path.join(install, 'package.json'));
// Read before the swap: the mirror deletes `src/` (the release ships no source tree), so
// anything needed afterwards has to be captured up front.
const runningVersion = JSON.parse(fs.readFileSync(path.join(install, 'package.json'), 'utf8')).version;
fs.mkdirSync(path.join(install, 'data'), { recursive: true });
fs.writeFileSync(path.join(install, 'data', 'config.json'), '{"server":{"port":6727}}');
fs.writeFileSync(path.join(install, 'data', 'cache.json'), '{"tracks":{}}');
fs.writeFileSync(path.join(install, 'stale-file.txt'), 'this file is gone from the new release');
fs.writeFileSync(path.join(install, 'README.md'), 'old readme');
fs.writeFileSync(path.join(install, 'node.exe'), 'old executable');

const zip = buildZip({
  'node.exe': 'new executable from the release',
  'README.md': 'new readme from the release',
  'web/control.html': '<!doctype html><title>new panel</title>',
  'data/config.json': '{"should":"not be unpacked"}',
});

const server = http.createServer((req, res) => {
  if (req.url === '/archive.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length });
    res.end(zip);
    return;
  }
  res.writeHead(404).end('no');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// Stub the two endpoints the updater talks to. The release payload mirrors what
// GitHub returns closely enough for the code paths under test.
const RELEASE_TAG = 'v9.9.9';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = typeof url === 'string' ? url : url.url;
  if (target.startsWith('https://api.github.com/')) {
    return new Response(JSON.stringify({
      tag_name: RELEASE_TAG,
      name: 'Chorus 9.9.9',
      body: 'A test release.',
      html_url: 'https://github.com/wixicle727/Chorus/releases/tag/v9.9.9',
      assets: [
        { name: 'Chorus-v9.9.9-Setup.exe', browser_download_url: `http://127.0.0.1:${port}/setup.exe`, size: 1234 },
        { name: 'Chorus-v9.9.9-portable.zip', browser_download_url: `http://127.0.0.1:${port}/archive.zip`, size: zip.length },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (target.startsWith(`http://127.0.0.1:${port}/`)) {
    return new Response(zip, { status: 200, headers: { 'Content-Length': String(zip.length) } });
  }
  return realFetch(url, options);
};

const updater = await import(pathToFileURL(path.join(install, 'src', 'core', 'updater.js')).href);
const update = await import(pathToFileURL(path.join(install, 'src', 'core', 'update.js')).href);

/* --------------------------------- tests -------------------------------- */

section('Reading a release archive');
{
  const entries = updater.readZipEntries(zip);
  check('reads every entry', entries.length === 4, `${entries.length}`);
  check('preserves file content',
    entries.find((e) => e.name === 'README.md').data.toString() === 'new readme from the release');
  let threw = '';
  try {
    updater.readZipEntries(Buffer.from('this is not a zip'));
  } catch (err) {
    threw = err.message;
  }
  check('rejects a file that is not an archive', /not a zip archive/.test(threw), threw);

  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-extract-'));
  const written = updater.extractZip(zip, extracted);
  check('never unpacks a data/ folder from the archive', written === 3, `${written} files`);
  check('the app files did land', fs.existsSync(path.join(extracted, 'web', 'control.html')));
  check('the archive cannot overwrite runtime data', !fs.existsSync(path.join(extracted, 'data')));

  let unsafe = '';
  try {
    updater.extractZip(buildZip({ '../escape.txt': 'nope' }), extracted);
  } catch (err) {
    unsafe = err.message;
  }
  check('rejects an entry that leaves the folder', /unsafe path/.test(unsafe), unsafe);
}

section('Picking the right asset');
{
  const assets = [
    { name: 'Chorus-v9.9.9-Setup.exe', url: 'a' },
    { name: 'Chorus-v9.9.9-portable.zip', url: 'b' },
  ];
  check('the portable archive is found',
    updater.pickPortableAsset({ assets })?.url === 'b');
  check('the installer is found',
    updater.pickInstallerAsset({ assets })?.url === 'a');
  check('a release with only an installer has no portable archive',
    updater.pickPortableAsset({ assets: [assets[0]] }) === null);
  check('an empty release yields nothing', updater.pickPortableAsset({}) === null);
}

section('Installer hand-over');
{
  const script = updater.installerLauncher('C:\\Temp\\Chorus-v9.9.9-Setup.exe');
  check('elevates through ShellExecute', /Shell\.Application/.test(script));
  check('uses the runas verb', /"runas"/.test(script));
  check('installs without prompts', /\/SILENT/.test(script) && /\/CLOSEAPPLICATIONS/.test(script));
  check('points at the downloaded setup', script.includes('Chorus-v9.9.9-Setup.exe'));
}

section('Downloading and staging the update');
let staged;
{
  const writable = updater.canWriteTo(install);
  check('a normal folder is detected as writable', writable === true);

  staged = await updater.stageUpdate({ pid: 999999 });
  check('staging succeeds', staged.ok === true, staged.error ?? '');
  check('the portable route is used for a writable folder', staged.mode === 'zip', staged.mode);
  check('the version comes from the release', staged.version === '9.9.9', staged.version);
  check('the archive was unpacked', staged.files === 3, String(staged.files));

  const progress = updater.updateProgress();
  check('progress ends in the ready state', progress.state === 'ready', progress.state);
  check('progress carries the downloaded total', progress.total === zip.length, String(progress.total));
  check('progress reported the received bytes', progress.received === zip.length, String(progress.received));
}

section('The data backup');
{
  check('a backup folder was created', Boolean(staged.backupDir) && fs.existsSync(staged.backupDir), staged.backupDir);
  const dataCopy = path.join(staged.backupDir, 'data');
  check('settings were copied', fs.readFileSync(path.join(dataCopy, 'config.json'), 'utf8').includes('6727'));
  check('the lyric cache was copied', fs.existsSync(path.join(dataCopy, 'cache.json')));
  check('the file count is reported', staged.backupFiles === 2, String(staged.backupFiles));
  check('a restore note explains how to roll back',
    fs.readFileSync(path.join(staged.backupDir, 'RESTORE.txt'), 'utf8').includes('To roll back'));
  check('the outgoing executable was kept',
    fs.existsSync(path.join(staged.backupDir, `Chorus-${runningVersion}.exe`)));
}

section('The swap helper');
{
  const helper = fs.readFileSync(staged.helper, 'utf8');
  check('waits for this process to exit', /tasklist \/FI "PID eq 999999"/.test(helper), '');
  check('mirrors, so files dropped from a release are deleted', /\/MIR/.test(helper));
  check('never touches data/', /\/XD "data"/.test(helper));
  check('keeps the pre-update backup', /"backup"/.test(helper));
  check('does not copy itself into the app folder', /\/XF "apply-update\.cmd"/.test(helper));
  check('restarts the app when done', /start "" /i.test(helper));
  check('logs to a file beside the helper', /apply-update\.log/.test(helper));

  // Run the mirror step for real: same file, minus the launch of the new build.
  const runnable = helper
    .split('\r\n')
    .filter((line) => !/^\s*start ""/i.test(line))
    .join('\r\n');
  const runnablePath = path.join(path.dirname(staged.helper), 'apply-update-test.cmd');
  fs.writeFileSync(runnablePath, runnable, 'utf8');
  spawnSync('cmd.exe', ['/c', runnablePath], { stdio: 'ignore', windowsHide: true, timeout: 60000 });

  check('the new executable replaced the old one',
    fs.readFileSync(path.join(install, 'node.exe'), 'utf8') === 'new executable from the release');
  check('a new file was added', fs.existsSync(path.join(install, 'web', 'control.html')));
  check('a file the release no longer ships was deleted', !fs.existsSync(path.join(install, 'stale-file.txt')));
  check('settings survived the update',
    fs.readFileSync(path.join(install, 'data', 'config.json'), 'utf8').includes('6727'));
  check('the lyric cache survived the update', fs.existsSync(path.join(install, 'data', 'cache.json')));
  check('the backup survived the swap', fs.existsSync(path.join(staged.backupDir, 'data', 'config.json')));
  check('the update log was written', fs.existsSync(staged.log));
}

section('Refusing to update when there is nothing newer');
{
  updater.resetUpdateProgress();
  update.clearUpdateCache();
  check('the running version is the one in package.json', runningVersion === '1.4.0', runningVersion);

  // Pretend this build is the newest thing on GitHub.
  const before = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = typeof url === 'string' ? url : url.url;
    if (target.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({
        tag_name: `v${runningVersion}`,
        assets: [],
        html_url: 'https://github.com/wixicle727/Chorus/releases/tag/v1.4.0',
      }), { status: 200 });
    }
    return before(url, options);
  };
  try {
    update.clearUpdateCache();
    const result = await updater.stageUpdate({ pid: 999999 });
    check('staging is refused', result.ok === false, JSON.stringify(result));
    check('the reason names the installed version', /already the newest/.test(result.error ?? ''), result.error);
  } finally {
    globalThis.fetch = before;
    update.clearUpdateCache();
  }
}

section('Offline and rate-limited answers');
{
  const before = globalThis.fetch;
  const cases = [
    ['offline', () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); }, /could not reach GitHub/],
    ['rate limited', () => new Response('{}', { status: 403 }), /rate-limiting/],
    ['not found', () => new Response('{}', { status: 404 }), /no published release/],
    ['broken json', () => new Response('nope', { status: 200 }), /could not be read/],
  ];
  for (const [label, impl, pattern] of cases) {
    globalThis.fetch = impl;
    update.clearUpdateCache();
    const result = await update.checkForUpdate({ force: true });
    check(`${label} is reported, not thrown`, result.ok === false && pattern.test(result.reason ?? ''), result.reason);
  }
  globalThis.fetch = before;
  update.clearUpdateCache();
}

section('Cache behaviour on panel open');
{
  let calls = 0;
  const before = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = typeof url === 'string' ? url : url.url;
    if (target.startsWith('https://api.github.com/')) {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: 'v1.0.0', assets: [], html_url: 'x' }), { status: 200 });
    }
    return before(url, options);
  };
  try {
    update.clearUpdateCache();
    await update.checkForUpdate({});
    const reused = await update.checkForUpdate({ maxAgeMs: 60000 });
    check('opening the panel reuses a recent answer', reused.cached === true && calls === 1, `calls=${calls}`);
    await update.checkForUpdate({ maxAgeMs: 0 });
    check('a stale answer is re-fetched', calls === 2, `calls=${calls}`);
    await update.checkForUpdate({ force: true });
    check('"Check now" always asks GitHub', calls === 3, `calls=${calls}`);
  } finally {
    globalThis.fetch = before;
    update.clearUpdateCache();
  }
}

/* -------------------------------- teardown ------------------------------ */

globalThis.fetch = realFetch;
server.close();
try {
  fs.rmSync(install, { recursive: true, force: true });
  fs.rmSync(updater.UPDATE_DIR, { recursive: true, force: true });
} catch {
  /* the temp folders are fine to leave behind */
}

console.log(`\n${failed === 0 ? '\u001b[32mAll' : '\u001b[31m'} ${passed} checks passed${failed ? `, ${failed} failed` : ''}\u001b[0m`);
process.exit(failed === 0 ? 0 : 1);
