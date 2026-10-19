/**
 * Cover-colour tests for the now-playing overlay.
 *
 *   node test/nowplaying.js offline
 *
 * The colour logic lives inside `web/nowplaying.html`, because the overlay is a single
 * self-contained page with no build step. Rather than duplicate it here (where it would
 * drift), the functions are extracted from the real file and exercised against synthetic
 * pixels — so these tests fail if the page's own implementation changes behaviour.
 *
 * A stubbed canvas stands in for the browser: `drawImage` is a no-op and `getImageData`
 * returns the pixels a test supplies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'web', 'nowplaying.html');

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
  if (start < 0) throw new Error(`nowplaying.html no longer defines ${name}()`);
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

/** Build the page's colour helpers against a stubbed canvas. */
function makeApi(pixels) {
  const code = ['luminance', 'saturate', 'dominantColor']
    .map((name) => extractFunction(source, name))
    .join('\n');
  const documentStub = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: pixels }),
      }),
    }),
  };
  // eslint-disable-next-line no-new-func
  return new Function('document', `${code}; return { dominantColor, luminance, saturate };`)(documentStub);
}

/** RGBA bytes from a list of [r,g,b] triples. */
const rgba = (triples) => triples.flatMap(([r, g, b]) => [r, g, b, 255]);
const fill = (r, g, b, n) => rgba(Array.from({ length: n }, () => [r, g, b]));

const near = (colour, r, g, b, tolerance = 10) =>
  Boolean(colour)
  && Math.abs(colour[0] - r) <= tolerance
  && Math.abs(colour[1] - g) <= tolerance
  && Math.abs(colour[2] - b) <= tolerance;

section('Dominant colour from cover art');

{
  check('a red cover reads as red', near(makeApi(fill(200, 30, 40, 400)).dominantColor({}), 200, 30, 40));
  check('a blue cover reads as blue', near(makeApi(fill(20, 60, 210, 400)).dominantColor({}), 20, 60, 210));

  // Letterboxing and borders are usually white or black; counting them would make every
  // cover resolve to the same colour, which is the bug this guards.
  const withWhiteBorder = rgba([
    ...Array.from({ length: 300 }, () => [255, 255, 255]),
    ...Array.from({ length: 100 }, () => [180, 40, 90]),
  ]);
  check(
    'white letterboxing is ignored in favour of the artwork',
    near(makeApi(withWhiteBorder).dominantColor({}), 180, 40, 90, 12),
  );

  const withBlackBorder = rgba([
    ...Array.from({ length: 200 }, () => [2, 2, 2]),
    ...Array.from({ length: 120 }, () => [40, 150, 90]),
  ]);
  check(
    'black borders are ignored too',
    near(makeApi(withBlackBorder).dominantColor({}), 40, 150, 90, 12),
  );

  const twoColours = rgba([
    ...Array.from({ length: 300 }, () => [200, 40, 40]),
    ...Array.from({ length: 100 }, () => [40, 40, 200]),
  ]);
  check(
    'the most-used colour wins over a less common one',
    near(makeApi(twoColours).dominantColor({}), 200, 40, 40, 12),
  );

  // Degenerate artwork must still yield a colour rather than nothing, so the card never
  // falls back to an unstyled state.
  check('an all-black cover still returns a colour', makeApi(fill(0, 0, 0, 100)).dominantColor({}) !== null);
  check('an all-white cover still returns a colour', makeApi(fill(255, 255, 255, 100)).dominantColor({}) !== null);

  const api = makeApi([]);
  check('no pixels yields null rather than throwing', api.dominantColor({}) === null);
}

section('Text contrast against the cover colour');

{
  const { luminance } = makeApi([]);
  // The threshold the page uses to choose between white and near-black text.
  check('a dark cover calls for light text', luminance(30, 30, 40) <= 0.45, String(luminance(30, 30, 40).toFixed(3)));
  check('a light cover calls for dark text', luminance(230, 225, 210) > 0.45, String(luminance(230, 225, 210).toFixed(3)));
  check('pure white is maximally bright', luminance(255, 255, 255) > 0.99);
  check('pure black is minimally bright', luminance(0, 0, 0) < 0.01);
}

section('The page implements the features');

{
  check('the cover shows the whole image, not a crop', /#cover-img\s*\{[^}]*object-fit:\s*contain/s.test(source));
  check('the rounded frame still clips the artwork', /#cover\s*\{[^}]*overflow:\s*hidden/s.test(source));
  check('the cover keeps its corners rounded', /#cover\s*\{[^}]*border-radius/s.test(source));
  check('there is a dominant-colour implementation', source.includes('function dominantColor'));
  check('the tint is applied from the artwork', source.includes('function applyCoverColors'));
  check('the card marks which plate style it uses', source.includes("classList.toggle('style-cover'"));
  check('text colour is chosen for contrast', source.includes('darkText'));
  // Both looks must exist: the cover wash and the blurred artwork.
  check('there is a cover-colour style', /#card\.style-cover #scrim\s*\{/.test(source));
  check('there is a blurred-artwork style', /#card\.style-blur #bg/.test(source));
  check('the style is switchable', source.includes('plateStyle'));
  check(
    'the blurred style keeps the artwork out of the colour path',
    /plateStyle === 'blur'\)\s*return/.test(source),
  );
}

console.log(`\n${'\u2500'.repeat(58)}`);
if (failed === 0) console.log(`\u001b[32mAll ${passed} checks passed\u001b[0m`);
else console.log(`\u001b[31m${failed} failed\u001b[0m, ${passed} passed`);
console.log(`${'\u2500'.repeat(58)}\n`);

process.exit(failed === 0 ? 0 : 1);
