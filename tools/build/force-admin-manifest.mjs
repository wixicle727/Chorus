// Rewrite the embedded application manifest of the compiled Setup.exe so Windows
// itself demands elevation, instead of trusting Inno's PrivilegesRequired flag.
//
// Why: on the user's machine `PrivilegesRequired=admin` produced no elevation at all.
// Setup then created {app} unelevated, which Windows refuses, and it died with
// "Internal error: Failed to expand shell folder constant 'userappdata'" / Error 5.
// The loader reads an embedded manifest before any of our code runs, so this is the
// one place that cannot be ignored.
//
// resedit is ESM-only and build-time only — it is never shipped with Chorus.
//   npm install --no-save --cache build/npmcache --prefix build/npmtools resedit

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RT_MANIFEST = 24;

let cached = null;

async function loadResEdit() {
  if (cached) return cached;
  const candidates = [
    'resedit',
    path.join(HERE, '..', '..', 'build', 'npmtools', 'node_modules', 'resedit', 'dist', 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      const spec = candidate.startsWith('.') || path.isAbsolute(candidate)
        ? pathToFileURL(candidate).href
        : candidate;
      cached = await import(spec);
      return cached;
    } catch {
      /* try the next location */
    }
  }
  throw new Error(
    'resedit is not installed. Run:\n' +
      '  npm install --no-save --cache build/npmcache --prefix build/npmtools resedit',
  );
}

// resedit binds a resource table to one executable instance, so both are returned.
function open(ResEdit, buffer) {
  const exe = ResEdit.NtExecutable.from(buffer, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const entries = res.entries.filter((e) => e.type === RT_MANIFEST);
  if (!entries.length) throw new Error('no RT_MANIFEST resource found');
  // id 1 is CREATEPROCESS_MANIFEST_RESOURCE_ID: the one the loader actually reads.
  return { exe, res, entry: entries.find((e) => e.id === 1) ?? entries[0] };
}

function levelOf(text) {
  const m = /requestedExecutionLevel[^>]*level\s*=\s*"([a-zA-Z]+)"/.exec(text);
  return m ? m[1] : null;
}

export async function readManifest(exePath) {
  const ResEdit = await loadResEdit();
  const { entry } = open(ResEdit, readFileSync(exePath));
  const text = Buffer.from(entry.bin).toString('utf8');
  return { level: levelOf(text), text };
}

export async function forceAdminManifest(exePath, { dryRun = false } = {}) {
  const ResEdit = await loadResEdit();
  const raw = readFileSync(exePath);
  const { exe, res, entry } = open(ResEdit, raw);
  const before = Buffer.from(entry.bin).toString('utf8');

  if (before.includes('requireAdministrator')) {
    return { ok: true, changed: false, reason: 'already requires administrator' };
  }
  if (!/level\s*=\s*"asInvoker"/.test(before)) {
    throw new Error('unexpected manifest (no asInvoker level):\n' + before.slice(0, 400));
  }

  const after = before.replace(/level\s*=\s*"asInvoker"/g, 'level="requireAdministrator"');
  if (dryRun) return { ok: true, changed: true, dryRun: true };

  entry.bin = Buffer.from(after, 'utf8');
  res.outputResource(exe);
  const out = Buffer.from(exe.generate());
  writeFileSync(exePath, out);

  // Re-read from disk and prove it stuck in the bytes we actually wrote.
  const verify = await readManifest(exePath);
  if (verify.level !== 'requireAdministrator') throw new Error('manifest rewrite did not stick');

  return { ok: true, changed: true, bytes: out.length, level: verify.level };
}

// CLI: node tools/build/force-admin-manifest.mjs <path-to-setup.exe>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node tools/build/force-admin-manifest.mjs <setup.exe>');
    process.exit(2);
  }
  const before = (await readManifest(target)).level;
  const result = await forceAdminManifest(target);
  const after = (await readManifest(target)).level;
  console.log(`  ${path.basename(target)}: requestedExecutionLevel ${before} -> ${after}`);
  console.log('  ' + JSON.stringify(result));
}
