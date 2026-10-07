/**
 * Build the Chorus installer.
 *
 * Wraps Inno Setup's compiler, which ships inside the `innosetup-compiler` npm package —
 * so CI needs no pre-installed tooling, and this stays a build-time dependency with no
 * runtime cost. Run after build-exe.mjs, which produces the executable it packages.
 *
 *   node tools/build/build-installer.mjs
 *
 * Produces build/Chorus-<version>-Setup.exe
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BUILD_DIR = path.join(ROOT, 'build');
const STAGE_DIR = path.join(BUILD_DIR, 'Chorus');
const ISS = path.join(HERE, 'chorus.iss');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function log(msg) {
  console.log(`  ${msg}`);
}

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/** Locate the bundled Inno Setup compiler. */
function resolveIscc() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'innosetup-compiler', 'bin', 'ISCC.exe'),
    // Some versions nest it under the compiler directory.
    path.join(ROOT, 'node_modules', 'innosetup-compiler', 'bin', 'ISCC', 'ISCC.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function main() {
  if (process.platform !== 'win32') fail('a Windows installer can only be built on Windows.');

  const iscc = resolveIscc();
  if (!iscc) {
    fail(
      'the Inno Setup compiler was not found.\n' +
        '  Install it with:  npm install\n' +
        '  (It ships inside the innosetup-compiler package, so nothing else is needed.)',
    );
  }

  if (!fs.existsSync(path.join(STAGE_DIR, 'Chorus.exe'))) {
    fail(`missing ${path.join(STAGE_DIR, 'Chorus.exe')}\n  Run:  npm run build:exe`);
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });

  log(`Chorus ${pkg.version} -> Chorus-${pkg.version}-Setup.exe`);
  log(`compiler: ${path.relative(ROOT, iscc)}`);

  const result = spawnSync(
    iscc,
    [
      `/DAppVersion=${pkg.version}`,
      `/DSourceDir=${STAGE_DIR}`,
      `/DOutputDir=${BUILD_DIR}`,
      ISS,
    ],
    // Inherited stdio: capturing a child's output through pipes is refused in some
    // confined Windows environments, and Inno Setup's progress is useful to see anyway.
    { cwd: ROOT, stdio: 'inherit' },
  );

  if (result.status !== 0) {
    fail(`the installer build failed (Inno Setup exited ${result.status}).`);
  }

  const setup = path.join(BUILD_DIR, `Chorus-${pkg.version}-Setup.exe`);
  if (!fs.existsSync(setup)) {
    fail(`Inno Setup reported success but ${setup} is missing.`);
  }

  const mb = (fs.statSync(setup).size / 1048576).toFixed(1);
  console.log('');
  log(`done: build/Chorus-${pkg.version}-Setup.exe (${mb} MB)`);
  log('installs per-user by default, so it needs no administrator rights');
}

main();
