/**
 * Karaoke fill tests for the lyric overlay.
 *
 *   node test/karaoke.js
 *
 * The fill maths lives inside `web/overlay.html`, because the overlay is a single
 * self-contained page with no build step. Rather than reimplement it here (where it
 * would drift), `karaokeProgressAt` is extracted from the real file and exercised
 * directly — so these tests fail if the page's own timing changes behaviour.
 *
 * The structural checks pin the parts that make the fill work at all: the registered
 * custom property, the second copy of the text, and the mask that reveals it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'web', 'overlay.html');

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
  if (start < 0) throw new Error(`overlay.html no longer defines ${name}()`);
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

/** The page's own timing function, evaluated in isolation. */
function makeProgress() {
  const constant = source.match(/const MIN_TIMED_WORDS = \d+;/);
  if (!constant) throw new Error('overlay.html no longer defines MIN_TIMED_WORDS');
  const helper = extractFunction(source, 'usableWords');
  const code = extractFunction(source, 'karaokeProgressAt');
  // eslint-disable-next-line no-new-func
  return new Function(`${constant[0]} ${helper}; ${code}; return karaokeProgressAt;`)();
}

const progressAt = makeProgress();

/** A three-line document: 0s–4s, 4s–10s, and a last line with a 6s tail. */
const DOC = [
  { timeMs: 0, endMs: 4000, text: 'one' },
  { timeMs: 4000, endMs: 10000, text: 'two' },
  { timeMs: 10000, endMs: 16000, text: 'three' },
];

section('Progress through a line');

check('halfway through a line is 0.5', progressAt(0, 2000, DOC, 0) === 0.5);
check('a quarter through a line is 0.25', progressAt(0, 1000, DOC, 0) === 0.25);
check('before the line starts is 0', progressAt(1, 3000, DOC, 0) === 0);
check('at the exact start is 0', progressAt(1, 4000, DOC, 0) === 0);
check('at the exact end is 1', progressAt(1, 10000, DOC, 0) === 1);
check('past the end stays 1', progressAt(1, 25000, DOC, 0) === 1);

section('Line boundaries');

// The second line's own endMs (10s) wins over the third line's start, so a
// document whose lines overlap cannot fill one line while another is sung.
check(
  'the next line\'s start caps a longer line',
  progressAt(0, 3999, [
    { timeMs: 0, endMs: 8000, text: 'long' },
    { timeMs: 4000, endMs: 9000, text: 'next' },
  ], 0) === 3999 / 4000,
);
check(
  'a line with no endMs falls back to the next line',
  progressAt(0, 2000, [
    { timeMs: 0, text: 'a' },
    { timeMs: 4000, text: 'b' },
  ], 0) === 0.5,
);
check(
  'the last line uses its own endMs',
  progressAt(2, 13000, DOC, 0) === 0.5,
);
check(
  'a last line with no endMs still progresses',
  progressAt(0, 2000, [{ timeMs: 0, text: 'only' }], 0) === 0.5,
);
check(
  'an end equal to the start falls back to the 4s tail',
  progressAt(0, 500, [{ timeMs: 0, endMs: 0, text: 'x' }], 0) === 0.125,
);

section('Offset and missing input');

check('a positive offset fills earlier', progressAt(0, 2000, DOC, 1000) === 0.75);
check('a negative offset fills later', progressAt(0, 2000, DOC, -1000) === 0.25);
check('index -1 yields null (nothing is being sung)', progressAt(-1, 0, DOC, 0) === null);
check('a missing line yields null', progressAt(9, 0, DOC, 0) === null);
check('an empty document yields null', progressAt(0, 0, [], 0) === null);
check('a fractional index yields null', progressAt(0.5, 1000, DOC, 0) === null);

section('The page wires the fill up');

check('the progress property is registered for interpolation',
  /@property --karaoke-progress\s*\{[\s\S]{0,120}syntax: "<percentage>"/.test(source));
check('the property inherits, so the mask can read it', /@property --karaoke-progress\s*\{[\s\S]{0,160}inherits: true/.test(source));
check('the sung colour is a custom property', source.includes('--color-karaoke'));
check('a second copy of the line text is created', source.includes("scan.className = 'main karaoke-scan'"));
check('the copy is hidden from screen readers', source.includes("scan.setAttribute('aria-hidden', 'true')"));
check('the mask reveals the copy from the left', /mask-image: linear-gradient\(\s*to right/.test(source));
check('there is a clip-path fallback when masks are unsupported', source.includes('clip-path: inset(0 calc(100% - var(--karaoke-progress)) 0 0)'));
check('the fill is recomputed on every tick', /render\(false\);\s*\n\s*updateKaraoke\(\);/.test(source));
check('a karaoke change rebuilds the lines', /settings\.visibleLines,\s*\n\s*settings\.karaoke,/.test(source));
check('karaoke is off unless configured', /karaoke: false,/.test(source));

section('Fill geometry edge cases');

/*
   A mask only paints inside the element's box, and these glyphs are taller than
   their line box, so without extra room the fill was sliced flat at the baseline
   and the tails of p, g and y were left uncoloured. The padding is the room; the
   negative margin gives it back so the copies stay where they were.
*/
check('the two copies get room for their descenders',
  /\.karaoke-stack > \.main \{[\s\S]{0,200}padding: 0\.5em 0/.test(source));
check('that room does not move the text', /\.karaoke-stack > \.main \{[\s\S]{0,200}margin: -0\.5em 0/.test(source));

/*
   `visibility` is inherited but can be overridden by a descendant, so a child set
   to `visible` defeats the paused blanking. Opacity cannot be undone that way.
*/
check('the copy is hidden with opacity, not visibility',
  /li\.karaoke \.main\.karaoke-scan \{[\s\S]{0,260}opacity: 0;/.test(source));
check('the copy never overrides visibility', !/\.karaoke-scan \{[^}]*visibility:/.test(source));
check('the active line shows the copy', /li\.active\.karaoke \.karaoke-scan \{[\s\S]{0,80}opacity: 1;/.test(source));
check('the copy carries no shadow of its own', !/\.main\.karaoke-scan \{[^}]*filter: drop-shadow/.test(source));
check('pausing still blanks the whole list', /listEl\.style\.visibility = visibility/.test(source));

section('Syllable-timed lines');

/*
   Most sources only say when a line starts, so the fill has to sweep. A source that
   stamps every syllable (Qishui) says when each one is sung, and those stamps win:
   the fill then follows the voice instead of averaging it.
*/
const WORDED = [
  {
    timeMs: 10000,
    endMs: 20000,
    text: 'ABB',
    words: [
      { timeMs: 10000, text: 'A', endMs: 12000 },
      { timeMs: 12000, text: 'BB', endMs: 14000 },
    ],
  },
];

check('a third of the way through a syllable is a third of its characters',
  Math.abs(progressAt(0, 11000, WORDED, 0) - 1 / 6) < 1e-9);
check('the second syllable starts where the first ends',
  Math.abs(progressAt(0, 12000, WORDED, 0) - 1 / 3) < 1e-9);
check('halfway through a two-character syllable adds half of it',
  Math.abs(progressAt(0, 13000, WORDED, 0) - 2 / 3) < 1e-9);
check('the fill finishes when the last syllable does', progressAt(0, 14000, WORDED, 0) === 1);
// The fallback the overlay owes every other source: stamps that cannot describe a
// line must leave it sweeping exactly as it did before karaoke timing existed.
check(
  'a single stamp is not enough to fill from',
  (() => {
    const doc = [{ timeMs: 0, endMs: 10000, text: 'abcdef', words: [{ timeMs: 0, text: 'abcdef', endMs: 10000 }] }];
    return progressAt(0, 5000, doc, 0) === 0.5;
  })(),
);
check(
  'stamps without usable times fall back to the sweep',
  (() => {
    const doc = [{ timeMs: 0, endMs: 10000, text: 'abcdef', words: [{ text: 'a' }, { text: 'b' }] }];
    return progressAt(0, 5000, doc, 0) === 0.5;
  })(),
);
// The point of the stamps: the old sweep ran to the next line's start, so it kept
// colouring through silence that no one was singing over.
check('silence after the last syllable stays full, not half swept',
  progressAt(0, 15000, WORDED, 0) === 1);
check('before the first syllable is still 0', progressAt(0, 9000, WORDED, 0) === 0);
check('a syllable with no end falls back to the next one',
  (() => {
    const doc = [{ timeMs: 0, endMs: 4000, text: 'ab', words: [{ timeMs: 0, text: 'a' }, { timeMs: 2000, text: 'b' }] }];
    return Math.abs(progressAt(0, 1000, doc, 0) - 0.25) < 1e-9;
  })());
check('the last syllable fills to the line end when it has no end',
  (() => {
    const doc = [{ timeMs: 0, endMs: 4000, text: 'ab', words: [{ timeMs: 0, text: 'a' }, { timeMs: 2000, text: 'b' }] }];
    return Math.abs(progressAt(0, 3000, doc, 0) - 0.75) < 1e-9;
  })());
check('a plain line still sweeps evenly',
  Math.abs(progressAt(0, 11000, [{ timeMs: 10000, endMs: 20000, text: 'AB' }], 0) - 0.1) < 1e-9);
check('an empty word list falls through to the sweep',
  Math.abs(progressAt(0, 11000, [{ timeMs: 10000, endMs: 20000, text: 'AB', words: [] }], 0) - 0.1) < 1e-9);
check('the page reads the syllable stamps', /Array\.isArray\(line\.words\)/.test(source));

console.log(
  failed === 0
    ? `\n\u001b[32mAll ${passed} checks passed\u001b[0m`
    : `\n\u001b[31m${failed} failed, ${passed} passed\u001b[0m`,
);
process.exit(failed === 0 ? 0 : 1);
