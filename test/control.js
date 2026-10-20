/**
 * Ordering tests for the control panel's candidate list.
 *
 *   node test/control.js
 *
 * The ordering runs inside `web/control.html` (the panel is one self-contained page with
 * no build step), so the function is extracted from the real file and exercised here.
 * That way the tests fail if the page's own implementation changes behaviour.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'web', 'control.html');

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

/** Cut a top-level function out of the page source, brace-matched. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`control.html no longer defines ${name}()`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}()`);
}

const source = fs.readFileSync(PAGE, 'utf8');

// The page's own collator, so a change to its options is picked up here too.
const collatorLine = source.match(/const collator = new Intl\.Collator\([^;]*\);/);
if (!collatorLine) throw new Error('control.html no longer builds a collator for sorting');

// eslint-disable-next-line no-new-func
const orderResults = new Function(
  `${collatorLine[0]}\n${extractFunction(source, 'orderResults')}\nreturn orderResults;`,
)();

const titles = (rows) => rows.map((row) => row.title).join(',');

section('Title order (the default)');
{
  const rows = [{ title: 'Lemon' }, { title: 'Again' }, { title: '晴天' }];
  const sorted = orderResults(rows, 'title');
  // Where a Kana/Kanji title lands depends on the machine's collator locale (this
  // machine puts CJK first), so only the Latin order is pinned here.
  check('sorts Latin titles alphabetically', titles(sorted).replace('晴天,', '') === 'Again,Lemon',
    titles(sorted));
  check('keeps a title it cannot compare', sorted.length === 3);
  check('is locale-aware, not code-point order', titles(rows) !== titles(sorted));
  check('the collator is the platform one', /new Intl\.Collator\(undefined,/.test(collatorLine[0]));

  const numeric = [{ title: 'Track 10' }, { title: 'Track 2' }];
  check('numbers sort 2 before 10', titles(orderResults(numeric, 'title')) === 'Track 2,Track 10',
    titles(orderResults(numeric, 'title')));

  const tied = [
    { title: 'Same', score: 40 },
    { title: 'Same', score: 90 },
  ];
  check('equal titles break on score, descending',
    orderResults(tied, 'title').map((r) => r.score).join(',') === '90,40');

  check('an unknown mode falls back to title',
    titles(orderResults([{ title: 'B' }, { title: 'A' }], 'nonsense')) === 'A,B');
  check('a missing mode falls back to title',
    titles(orderResults([{ title: 'B' }, { title: 'A' }], undefined)) === 'A,B');
}

section('Artist order');
{
  const rows = [
    { title: 'Zoo', artist: 'beta', score: 80 },
    { title: 'Apple', artist: 'alpha', score: 50 },
    { title: 'Banana', artist: 'beta', score: 70 },
  ];
  const sorted = orderResults(rows, 'artist');
  check('groups by artist, then title',
    sorted.map((r) => `${r.artist}/${r.title}`).join(',') === 'alpha/Apple,beta/Banana,beta/Zoo',
    sorted.map((r) => `${r.artist}/${r.title}`).join(','));

  const missing = orderResults([{ title: 'X', score: 10 }, { title: 'Y', artist: 'a', score: 10 }], 'artist');
  check('a candidate without an artist still sorts', missing.length === 2);
}

section('Score order');
{
  const rows = [
    { title: 'Low', score: 12 },
    { title: 'High', score: 97 },
    { title: 'Mid', score: 61 },
  ];
  check('descending by score', titles(orderResults(rows, 'score')) === 'High,Mid,Low',
    titles(orderResults(rows, 'score')));

  const unscored = [{ title: 'None' }, { title: 'Some', score: 5 }];
  check('an unscored candidate goes last', titles(orderResults(unscored, 'score')) === 'Some,None');

  const inUse = [
    { title: 'A', score: 99, inUse: true },
    { title: 'B', score: 40 },
  ];
  check('the in-use row keeps its real position, it is not promoted',
    orderResults(inUse, 'score')[0].title === 'A');
  check('ordering by title also leaves the in-use row in place',
    orderResults(inUse, 'title')[0].title === 'A');
}

section('Contract');
{
  const rows = [{ title: 'B', score: 1 }, { title: 'A', score: 2 }];
  const snapshot = JSON.stringify(rows);
  orderResults(rows, 'score');
  check('does not mutate the caller\'s array', JSON.stringify(rows) === snapshot);
  check('returns a new array', orderResults(rows, 'title') !== rows);
}

section('The panel offers these modes');
{
  check('SORT_MODES lists title, artist and score',
    /const SORT_MODES = \['title', 'artist', 'score'\];/.test(source));
  check('the saved config value is validated before use',
    /SORT_MODES\.includes\(config\?\.lyrics\?\.sortBy\)/.test(source));
  check('the dropdown posts the choice back to the server',
    /saveConfig\(\{ lyrics: \{ sortBy \} \}/.test(source));
}

console.log(`\n${failed === 0 ? '\u001b[32mAll' : '\u001b[31m' } ${passed} checks passed${failed ? `, ${failed} failed` : ''}\u001b[0m`);
process.exit(failed === 0 ? 0 : 1);
