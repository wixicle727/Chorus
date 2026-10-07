/**
 * Build a standalone Chorus.exe.
 *
 * Node 22 ships Single Executable Applications, so no bundler is needed. The build
 * embeds `src/` into a copy of node.exe with `postject`, which keeps the project's
 * zero-runtime-dependency promise: `postject` is a build-time devDependency only.
 *
 *   node tools/build/build-exe.mjs
 *
 * What gets embedded vs. shipped alongside
 * ----------------------------------------
 * `src/` is embedded. `web/`, `assets/` and `tools/smtc-bridge/` are NOT: the bridge
 * is a PowerShell program (it cannot be embedded in a Node binary), and keeping the
 * front-end as real files means the overlay can be edited without a rebuild. The
 * result is a folder — `Chorus.exe` plus those three directories — which is what the
 * release zip contains. Users still install nothing: Node is inside the .exe.
 *
 * The capture cannot be the whole project, so the embedded main is a tiny shim that
 * re-executes the real entry point path in a way that works from inside the binary.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BUILD_DIR = path.join(ROOT, 'build');
const OUT_DIR = path.join(BUILD_DIR, 'Chorus');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXE_NAME = 'Chorus.exe';

function log(msg) {
  console.log(`  ${msg}`);
}

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Locate postject. It is a devDependency, so a production checkout may not
//    have it; say so clearly instead of dying on a stack trace.
// ---------------------------------------------------------------------------
function resolvePostject() {
  const cli = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (fs.existsSync(cli)) return cli;
  return null;
}

function resolveRcedit() {
  const exe = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  if (fs.existsSync(exe)) return exe;
  const fallback = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit.exe');
  return fs.existsSync(fallback) ? fallback : null;
}

// ---------------------------------------------------------------------------
// Embedded assets.
//
// Everything the app serves or launches is embedded into the executable, so the
// release is genuinely one file. Two different mechanisms are needed:
//
//   SEA assets -- the front-end and images, read straight out of the binary and
//                 served from memory. No extraction, no temp files.
//   base64 in the blob -- the SMTC bridge's PowerShell scripts, because the bridge
//                 must exist as real files on disk for PowerShell to run it. They
//                 are written to a per-user cache directory on first use.
// ---------------------------------------------------------------------------

/** Files the HTTP server serves, keyed as `web/<path>`. */
const WEB_ASSET_DIRS = ['web'];
/** Support files exposed to the app: images, the PowerShell bridge, and the tray helper. */
const RAW_ASSET_DIRS = ['assets', 'tools/smtc-bridge', 'launcher'];
/**
 * The application itself.
 *
 * Embedded so the executable is truly self-contained, then written to a per-user
 * cache directory by the shim at startup. Node can import a module from any path, so
 * the code does not care that it came out of the binary rather than the install
 * folder. It ships as `.js` rather than being bundled into the blob because keeping
 * the module graph intact means no bundler and no code rewriting.
 */
const APP_ASSET_DIRS = ['src'];

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

function collectAssets() {
  const assets = {};
  const counts = {};

  // Keyed with their project-relative prefix ("web/control.html") so the runtime can
  // tell the groups apart: web/ is served, src/ is the app, the rest is support.
  for (const dir of [...WEB_ASSET_DIRS, ...RAW_ASSET_DIRS, ...APP_ASSET_DIRS]) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const files = walk(abs);
    for (const rel of files) assets[`${dir}/${rel}`] = path.join(abs, rel);
    counts[dir] = files.length;
  }

  // The app reads its own version from package.json at startup, and `ROOT` is the
  // parent of `src`, so it has to sit at the unpack root — otherwise the executable
  // reports the fallback version. It is also kept under src/ because the build keys
  // everything by project-relative path.
  const pkgPath = path.join(ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    assets['package.json'] = pkgPath;
    counts['package.json'] = 1;
  }

  return { assets, counts };
}

// ---------------------------------------------------------------------------
// 2. Build the SEA blob. The "main" is a generated shim rather than src/index.js,
//    because a SEA captures a single script: the rest of the app is loaded from
//    disk next to the executable, which is what keeps `web/` editable.
// ---------------------------------------------------------------------------
function writeShim(shimPath) {
  // This shim MUST be CommonJS.
  //
  // Contrary to what the file extension suggests, Node executes the embedded SEA
  // main through its CommonJS embedder. An `import` statement at the top level fails
  // with "Cannot use import statement outside a module". A dynamic `import()` works
  // from CommonJS, which is what lets the real ESM entry point be loaded.
  //
  // The app is resolved relative to the executable's own folder rather than
  // process.cwd(), so a double-click from anywhere works.
  const shim = `'use strict';
/*
 * Chorus boot shim (the only code compiled into the blob).
 *
 * This MUST be CommonJS: Node executes an embedded SEA main through its CommonJS
 * embedder regardless of the file extension, so an ESM shim fails with
 * "Cannot use import statement outside a module". A dynamic import() works from
 * CommonJS, which is how the real ESM application is loaded.
 *
 * The application lives inside the executable as SEA assets. It is written to a
 * per-user cache directory once per version, and then imported from there — Node can
 * import a module from any path, so it does not matter that it came out of the binary.
 * PowerShell has the same requirement for the SMTC bridge, which the app extracts
 * itself on first use.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sea = require('node:sea');

// Tell the app it is the packaged build, so it defaults to tray behaviour rather than
// assuming someone is watching a console.
process.env.CHORUS_PACKAGED = '1';

function fail(message, detail) {
  console.error('');
  console.error('  Chorus could not start.');
  console.error('  ' + message);
  if (detail) {
    console.error('');
    console.error('  ' + detail);
  }
  console.error('');
  process.exit(1);
}

let keys = [];
try {
  keys = sea.getAssetKeys();
} catch (err) {
  fail('This executable is damaged - its bundled files could not be read.', String((err && err.message) || err));
}

const appKeys = keys.filter((k) => k.startsWith('src/'));
if (appKeys.length === 0) {
  fail('This executable is damaged - it does not contain the Chorus application.');
}

// A stable per-user location, versioned so an upgrade never mixes old files with new.
const version = ${JSON.stringify(pkg.version)};

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/*
 * Unpack into a directory that mirrors the project layout.
 *
 * The app resolves web/, assets/, launcher/ and tools/ as SIBLINGS of src/, because
 * ROOT is the parent of the src directory. Reproducing that layout is what makes the
 * extracted copy behave exactly like a source checkout, with no path rewriting
 * anywhere.
 *
 * Several locations are tried, because a locked-down or virtualised profile can deny
 * writes to the usual one. The first that accepts a probe file wins.
 */
const appName = 'Chorus';
const candidates = [
  path.join(localAppData, appName, 'embedded', version),
  path.join(process.env.TEMP || os.tmpdir(), appName + '-embedded', version),
  path.join(os.tmpdir(), appName + '-embedded', version),
];

let appRoot = null;
let lastError = null;
for (const candidate of candidates) {
  try {
    fs.mkdirSync(candidate, { recursive: true });
    // Prove it is actually writable rather than merely creatable.
    const probe = path.join(candidate, '.writable');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    appRoot = candidate;
    break;
  } catch (err) {
    lastError = err;
  }
}

if (!appRoot) {
  fail(
    'Chorus has nowhere to unpack its application files.',
    'Tried: ' + candidates.join(', ') + '\\n  Last error: ' + String((lastError && lastError.message) || lastError),
  );
}

try {
  for (const key of keys) {
    // Keys are project-relative paths: "src/index.js", "web/control.html", and the
    // root-level "package.json". Writing each one at its own relative path reproduces
    // the project layout, which is what lets the app resolve ROOT without any changes.
    if (key.includes('..') || key.length === 0 || key.endsWith('/')) continue;

    const dest = path.join(appRoot, key);
    const body = Buffer.from(sea.getAsset(key));

    // Only rewrite when the bytes differ, so a restart is cheap and files a running
    // process may hold open are left alone.
    let current = null;
    try {
      current = fs.readFileSync(dest);
    } catch {
      /* missing: write it */
    }
    if (current && current.equals(body)) continue;

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
} catch (err) {
  fail('Chorus could not unpack its application files.', String((err && err.message) || err));
}

// Tell the app where its extracted copy lives, so it does not have to guess the same
// way this shim did.
process.env.CHORUS_HOME = appRoot;

const entry = path.join(appRoot, 'src', 'index.js');
if (!fs.existsSync(entry)) {
  fail('Chorus could not unpack its application files.', 'Expected: ' + entry);
}

import(pathToFileURL(entry).href).catch((err) => {
  fail('The application failed to load.', String((err && err.stack) || err));
});
`;
  fs.writeFileSync(shimPath, shim, 'utf8');
}

function buildBlob() {
  const shimPath = path.join(BUILD_DIR, 'chorus-sea-main.cjs');
  const blobPath = path.join(BUILD_DIR, 'chorus.blob');
  const configPath = path.join(BUILD_DIR, 'sea-config.json');

  writeShim(shimPath);

  const { assets, counts } = collectAssets();
  for (const [dir, n] of Object.entries(counts)) log(`embedding ${dir}/ (${n} files)`);

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: path.relative(BUILD_DIR, shimPath).replace(/\\/g, '/'),
        output: path.relative(BUILD_DIR, blobPath).replace(/\\/g, '/'),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets,
      },
      null,
      2,
    ),
    'utf8',
  );

  log('building the SEA blob');
  // stdio is inherited rather than piped: capturing a child's output through pipes
  // is refused in some confined Windows environments (spawn EPERM), and inheriting
  // still puts any error text straight on the console where it can be read.
  const result = spawnSync(process.execPath, ['--experimental-sea-config', configPath], {
    cwd: BUILD_DIR,
    stdio: 'inherit',
  });
  // spawnSync reports a launch failure as status null plus an `error`, so both have to be
  // checked or the message is lost and CI shows only "exit code 1".
  if (result.error) {
    throw new Error(`could not launch Node for the SEA blob: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`blob build failed (exit ${result.status}). The Node error is above.`);
  }
  if (!fs.existsSync(blobPath)) throw new Error('the blob was not written');
  log(`blob: ${(fs.statSync(blobPath).size / 1024).toFixed(1)} KB (includes the embedded files)`);
  return blobPath;
}

// ---------------------------------------------------------------------------
// 3. Copy node.exe, stamp the icon and version info, then inject the blob.
// ---------------------------------------------------------------------------

/**
 * Set the executable's icon and version metadata.
 *
 * Done BEFORE the blob is injected. rcedit rewrites the PE resource section, which
 * would destroy an injected blob; appending the blob with postject only adds to the
 * end of the file, so nothing rcedit wrote is disturbed.
 */
function stampIcon(exePath, rcedit) {
  const icon = path.join(ROOT, 'assets', 'chorus.ico');
  if (!fs.existsSync(icon)) {
    log('no assets/chorus.ico - leaving the default Node icon');
    return;
  }

  log('setting the executable icon');
  let result;
  try {
    result = spawnSync(
      rcedit,
      [
        exePath,
        '--set-icon', icon,
        '--set-version-string', 'ProductName', 'Chorus',
        '--set-version-string', 'FileDescription', 'Chorus - live lyrics for OBS',
        '--set-version-string', 'CompanyName', 'Chorus contributors',
        '--set-version-string', 'LegalCopyright', 'MIT licensed',
        '--set-file-version', pkg.version,
        '--set-product-version', pkg.version,
      ],
      { cwd: BUILD_DIR, stdio: 'inherit' },
    );
  } catch (err) {
    log(`warning: rcedit could not be run (${err.message})`);
    return;
  }

  if (result.error) {
    log(`warning: rcedit could not be run (${result.error.message})`);
    return;
  }
  if (result.status !== 0) {
    // An icon is cosmetic. Failing the whole release over it would be the wrong trade, and
    // on a locked-down runner (an anti-virus holding the freshly written file, a policy
    // blocking the executable) it is exactly what would happen.
    log(`warning: could not set the icon (rcedit exited ${result.status}); continuing without it`);
    return;
  }
  log(`icon and version info set (v${pkg.version})`);
}

/**
 * Rewrite the PE subsystem from Console to Windows GUI.
 *
 * Node ships as a console-subsystem binary, so Windows allocates a console window when
 * the executable is started from Explorer. A lyrics overlay belongs in the tray, so the
 * subsystem is changed in place — which means no console is ever created and there is
 * no flash of a window appearing and disappearing.
 *
 * rcedit cannot set the subsystem, and Node has no FFI to call FreeConsole, so the PE
 * header is edited directly. The field is at a fixed offset in the optional header:
 * PE signature (4) + COFF header (20) + 68 into the optional header.
 *
 * Node was measured to keep working with no console handles: stdout/stderr, console.log
 * and console.error all resolve without throwing.
 */
function setGuiSubsystem(exePath) {
  const buf = fs.readFileSync(exePath);

  // "MZ" then the offset of the PE header at 0x3C.
  if (buf.readUInt16LE(0) !== 0x5a4d) {
    log('warning: not a PE file, leaving the subsystem alone');
    return false;
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    log('warning: no PE signature, leaving the subsystem alone');
    return false;
  }

  const optionalHeader = peOffset + 4 + 20;
  const magic = buf.readUInt16LE(optionalHeader);
  if (magic !== 0x10b && magic !== 0x20b) {
    log(`warning: unexpected optional header magic 0x${magic.toString(16)}, leaving the subsystem alone`);
    return false;
  }

  const subsystemOffset = optionalHeader + 68;
  const before = buf.readUInt16LE(subsystemOffset);
  const GUI = 2;
  if (before === GUI) {
    log('subsystem is already Windows GUI');
    return true;
  }

  buf.writeUInt16LE(GUI, subsystemOffset);
  fs.writeFileSync(exePath, buf);
  log(`subsystem changed ${before} (console) -> ${GUI} (windows gui): no console window`);
  return true;
}

function injectBlob(blobPath, exePath, postjectCli) {
  fs.copyFileSync(process.execPath, exePath);
  log(`copied node.exe -> ${EXE_NAME} (${(fs.statSync(exePath).size / 1048576).toFixed(1)} MB)`);

  // Subsystem and resources are set BEFORE the blob is injected: rcedit rewrites the PE
  // resource section, which would destroy an already-injected blob.
  setGuiSubsystem(exePath);

  const rcedit = resolveRcedit();
  if (rcedit) stampIcon(exePath, rcedit);
  else log('rcedit not found - the executable keeps the default Node icon');

  log('injecting the blob');
  const result = spawnSync(
    process.execPath,
    [postjectCli, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
    { cwd: BUILD_DIR, stdio: 'inherit' },
  );
  if (result.error) {
    throw new Error(`could not launch postject: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`postject failed (exit ${result.status}). The error is above.`);
  }
  log('blob injected');
}

// ---------------------------------------------------------------------------
// 4. Assemble the release folder.
// ---------------------------------------------------------------------------
function copyTree(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.cpSync(from, to, { recursive: true });
  return fs.readdirSync(to).length;
}

function assemble(exePath) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.copyFileSync(exePath, path.join(OUT_DIR, EXE_NAME));
  log(`staged ${EXE_NAME}`);

  // The executable is self-contained: the front-end, the images and the SMTC
  // bridge's scripts are all embedded. Only human-facing files ship beside it.
  for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
    const from = path.join(ROOT, file);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(OUT_DIR, file));
      log(`staged ${file}`);
    }
  }

  // A convenience launcher that starts it hidden, matching start.bat.
  fs.writeFileSync(
    path.join(OUT_DIR, 'Chorus (background).cmd'),
    [
      '@echo off',
      'REM Generated by the build. Starts Chorus hidden, with no console window.',
      'cd /d "%~dp0"',
      'start "" /b "%~dp0Chorus.exe" --background --tray',
      '',
    ].join('\r\n'),
    'utf8',
  );
  log('staged Chorus (background).cmd');
}

// ---------------------------------------------------------------------------

function main() {
  if (process.platform !== 'win32') fail('a Windows .exe can only be built on Windows.');

  const postjectCli = resolvePostject();
  if (!postjectCli) {
    fail(
      'postject is required to inject the blob into the executable.\n' +
        '  Install it with:  npm install\n' +
        '  (If npm cannot write its cache, point it somewhere writable:\n' +
        '     npm install --cache .npm-cache )',
    );
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });

  log(`Chorus ${pkg.version} -> ${EXE_NAME}`);
  log(`node ${process.version}`);
  log(`platform ${process.platform} ${process.arch}`);
  log(`node binary ${process.execPath}`);
  log(`postject ${path.relative(ROOT, postjectCli)}`);
  const rc = resolveRcedit();
  log(`rcedit ${rc ? path.relative(ROOT, rc) : 'NOT FOUND (icon will be skipped)'}`);
  console.log('');

  try {
    const blobPath = buildBlob();
    const exePath = path.join(BUILD_DIR, EXE_NAME);
    injectBlob(blobPath, exePath, postjectCli);
    assemble(exePath);

    const size = fs.statSync(path.join(OUT_DIR, EXE_NAME)).size;
    console.log('');
    log(`done: build/Chorus/${EXE_NAME} (${(size / 1048576).toFixed(1)} MB)`);
    log('the executable is self-contained - nothing else is required in the folder');
  } catch (err) {
    // Without this the CI log ends at a bare "exit code 1": the failing step is visible
    // but the reason is not, which is not something worth debugging twice.
    console.error('');
    console.error(`  BUILD FAILED: ${err?.message ?? err}`);
    if (err?.stack) console.error(String(err.stack).split('\n').slice(1, 6).join('\n'));
    process.exit(1);
  }
}

main();
