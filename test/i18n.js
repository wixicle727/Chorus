/**
 * Localisation checks.
 *
 * The dictionaries are hand-written modules, so the risks worth testing are the
 * ones a compiler would otherwise catch: a key that exists in one language but
 * not the other, an empty translation, or a language id the server accepts while
 * the page silently falls back to English.
 *
 * Runs with no browser: `web/js/i18n.js` guards its DOM work, so the real module
 * under test is the one the panel and overlays load.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import zhHans from '../web/js/i18n.zh-Hans.js';
import zhHant from '../web/js/i18n.zh-Hant.js';
import { normaliseLanguage, setLanguage, t, isTranslated } from '../web/js/i18n.js';
import { normaliseLanguage as serverNormalise } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * Strings that stay Latin in every language: product names, file names, and
 * sample text the reader is meant to copy verbatim.
 */
const UNCHANGED = new Set([
  'Chorus',
  'OBS',
  'LRC',
  'URL',
  'Windows',
  'WebSocket',
  'smtc-bridge',
  'SMTC-Bridge',
  'LRCLIB',
  'tosu-lyrics',
  'AF-Media-Bar',
  'data',
  'data/',
  'data/config.json',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run → Chorus',
  '[mm:ss.xx]',
  // The LRC sample the reader is meant to copy verbatim.
  '[00:12.34] First line&#10;[00:18.90] Second line',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
]);

section('Dictionaries');

const hansKeys = Object.keys(zhHans);
const hantKeys = Object.keys(zhHant);

check('both languages carry the same keys', () => {
  const onlyHans = hansKeys.filter((key) => !(key in zhHant));
  const onlyHant = hantKeys.filter((key) => !(key in zhHans));
  assert.deepEqual(onlyHans, [], `missing from zh-Hant: ${onlyHans.slice(0, 3).join(' | ')}`);
  assert.deepEqual(onlyHant, [], `missing from zh-Hans: ${onlyHant.slice(0, 3).join(' | ')}`);
});

check('no empty translation', () => {
  for (const [language, dictionary] of Object.entries({ 'zh-Hans': zhHans, 'zh-Hant': zhHant })) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${language}: ${key} is not a string`);
      assert.ok(value.trim().length > 0, `${language}: empty translation for ${key}`);
    }
  }
});

check('every key is non-empty English text', () => {
  for (const key of hansKeys) {
    assert.ok(key.trim().length > 0, 'a key is blank');
    assert.equal(key, key.trim(), `key has surrounding whitespace: ${JSON.stringify(key)}`);
  }
});

check('translated values actually changed, unless deliberately Latin', () => {
  for (const [language, dictionary] of Object.entries({ 'zh-Hans': zhHans, 'zh-Hant': zhHant })) {
    for (const [key, value] of Object.entries(dictionary)) {
      // Numbers, units and timestamps read the same in every language.
      const withoutUnits = key.replace(/\s?(s|ms|px|%)$/i, '');
      if (!/[A-Za-z]/.test(withoutUnits)) continue;
      if (value === key) assert.ok(UNCHANGED.has(key), `${language}: ${key} was left untranslated`);
    }
  }
});

check('no stray object or array values', () => {
  for (const dictionary of [zhHans, zhHant]) {
    for (const value of Object.values(dictionary)) {
      assert.equal(typeof value, 'string');
      assert.ok(!value.includes('[object'), 'a value stringified an object');
    }
  }
});

section('Runtime translation');

check('english leaves text untouched', () => {
  setLanguage('en');
  assert.equal(isTranslated(), false);
  assert.equal(t('Nothing playing'), 'Nothing playing');
});

check('simplified chinese translates known text', () => {
  setLanguage('zh-Hans');
  assert.equal(isTranslated(), true);
  assert.equal(t('Nothing playing'), zhHans['Nothing playing']);
});

check('traditional chinese translates known text', () => {
  setLanguage('zh-Hant');
  assert.equal(t('Nothing playing'), zhHant['Nothing playing']);
});

check('unknown text falls back to the original', () => {
  setLanguage('zh-Hans');
  assert.equal(t('Some track title nobody indexed'), 'Some track title nobody indexed');
});

check('empty input is returned as-is', () => {
  setLanguage('zh-Hans');
  assert.equal(t(''), '');
  assert.equal(t(undefined), undefined);
});

check('html entities in keys match decoded DOM text', () => {
  // The key is written `Cache &amp; history` in markup, so the dictionary holds
  // that spelling while a text node reads `Cache & history`.
  const escaped = hansKeys.filter((key) => key.includes('&amp;'));
  assert.ok(escaped.length > 0, 'expected at least one entity-escaped key');
  setLanguage('zh-Hans');
  for (const key of escaped) {
    const decoded = key.replace(/&amp;/g, '&');
    assert.equal(t(decoded), zhHans[key], `no translation for decoded ${decoded}`);
  }
});

section('Language ids');

check('the browser and the server agree on every spelling', () => {
  const cases = [
    ['en', 'en'],
    ['EN', 'en'],
    ['en-US', 'en'],
    ['', 'en'],
    ['klingon', 'en'],
    ['zh', 'zh-Hans'],
    ['zh-CN', 'zh-Hans'],
    ['zh_CN', 'zh-Hans'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hans-CN', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'],
    ['zh_HK', 'zh-Hant'],
    ['zh-Hant', 'zh-Hant'],
    ['zh-Hant-TW', 'zh-Hant'],
    ['zh-MO', 'zh-Hant'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normaliseLanguage(input), expected, `browser: ${input || '(empty)'}`);
    assert.equal(serverNormalise(input), expected, `server: ${input || '(empty)'}`);
  }
});

check('unknown ids do not throw', () => {
  for (const value of [null, undefined, 0, {}, []]) {
    assert.equal(normaliseLanguage(value), 'en');
  }
});

section('Shipped pages');

for (const page of ['web/control.html', 'web/overlay.html']) {
  check(`${page} loads the i18n module`, () => {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.ok(/from '\/js\/i18n\.js'/.test(html), 'no i18n import');
  });
}

check('the panel offers all three languages', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web/control.html'), 'utf8');
  const select = html.match(/<select id="language">([\s\S]*?)<\/select>/);
  assert.ok(select, 'no language select');
  for (const language of ['en', 'zh-Hans', 'zh-Hant']) {
    assert.ok(select[1].includes(`value="${language}"`), `missing option ${language}`);
  }
});

/**
 * Text that is allowed to stay English in every language: language names shown
 * in their own language, document titles, and copy-paste samples.
 */
check('the panel saves the chosen language', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web/control.html'), 'utf8');
  assert.ok(/\$\('language'\)\.addEventListener\('change'/.test(html), 'the select is not wired');
  assert.ok(/saveConfig\(\{ app: \{ language:/.test(html), 'the choice is never persisted');
  assert.ok(/setLanguage\(e\.target\.value\)/.test(html), 'the page does not repaint on change');
});

const ALLOWED_ENGLISH = new Set([
  'English',
  '简体中文',
  '繁體中文',
  'Chorus — Overlay',
  'Chorus — Now Playing',
]);

check('every visible string in the panel has a translation', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web/control.html'), 'utf8');
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const decodedKeys = new Set(hansKeys.map((key) => key.replace(/&amp;/g, '&').replace(/&#10;/g, '\n')));

  const missing = [];
  for (const match of body.matchAll(/>([^<>]+)</g)) {
    const text = match[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (!/[A-Za-z]{2}/.test(text)) continue;
    if (ALLOWED_ENGLISH.has(text)) continue;
    if (decodedKeys.has(text)) continue;
    if (!missing.includes(text)) missing.push(text);
  }
  assert.deepEqual(missing, [], `untranslated markup: ${missing.slice(0, 5).join(' | ')}`);
});

check('the web bundle is staged recursively, so the dictionaries ship', () => {
  const bundle = fs.readFileSync(path.join(ROOT, 'tools/build/build-exe.mjs'), 'utf8');
  // `web` is walked recursively rather than listed file by file, which is what
  // makes web/js/ ship without a second entry here.
  assert.ok(/const WEB_ASSET_DIRS = \['web'\]/.test(bundle), 'web/ is no longer a staged asset dir');
  assert.ok(/if \(entry\.isDirectory\(\)\) walk\(/.test(bundle), 'the asset walker stopped recursing');
  for (const file of ['web/js/i18n.js', 'web/js/i18n.zh-Hans.js', 'web/js/i18n.zh-Hant.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is missing from web/`);
  }
});

console.log(`\n${failed === 0 ? `All ${passed} checks passed` : `${failed} of ${passed + failed} checks failed`}`);
process.exit(failed === 0 ? 0 : 1);
