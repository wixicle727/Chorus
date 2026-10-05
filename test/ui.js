/**
 * UI + API checks that do not need a browser.
 *
 * Verifies that every page and asset is actually served, that the control panel's
 * DOM contract is intact (every element the script looks up exists), that the
 * overlay still implements the carousel/transparency contract, and that the whole
 * JSON API answers.
 *
 *   node test/ui.js [--base http://127.0.0.1:6727]
 *
 * Requires a running server; see test/run.js for the logic tests.
 */

import { collectMessages } from './helpers/ws-client.js';

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const BASE = baseIndex >= 0 && args[baseIndex + 1] ? args[baseIndex + 1] : `http://127.0.0.1:${process.env.PORT ?? 6727}`;

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) {
    pass += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (t) => console.log(`\n\u001b[1m${t}\u001b[0m`);

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
};

/**
 * CSS 8-digit hex is #RRGGBBAA, but Windows/WPF palettes (which this project's
 * tokens were modelled on) write #AARRGGBB. Copying one across verbatim yields a
 * fully transparent colour — this caught a bug where every label was invisible.
 * Translucent colours must use rgba().
 */
function findAlphaFirstHex(css) {
  const offenders = [];
  for (const match of css.matchAll(/#([0-9a-fA-F]{8})\b/g)) {
    const hex = match[1];
    // In #RRGGBBAA the alpha is the last byte. A transparent-looking last byte
    // with an opaque-looking first byte is the signature of the swapped form.
    const alpha = hex.slice(6, 8).toLowerCase();
    if (alpha === '00' || alpha === '0f' || alpha === '09' || alpha === '07') {
      offenders.push(`#${hex}`);
    }
  }
  return offenders;
}

section('Static assets');
for (const [path, expectType, needle] of [
  ['/css/control.css', 'text/css', '--accent:'],
  ['/overlay', 'text/html', 'id="list"'],
  ['/control', 'text/html', 'id="page-now"'],
]) {
  const r = await get(path);
  ok(
    `${path} served`,
    r.status === 200 && r.type?.includes(expectType.split('/')[1]) && r.text.includes(needle),
    `status=${r.status} type=${r.type}`,
  );
}

section('Theme tokens');
{
  const css = (await get('/css/control.css')).text;

  const offenders = findAlphaFirstHex(css);
  ok('no #AARRGGBB colours written as 8-digit hex', offenders.length === 0, offenders.join(', '));

  // Every text token must be opaque enough to read.
  const textTokens = [...css.matchAll(/--text-(primary|secondary|tertiary):\s*([^;]+);/g)];
  ok('text tokens are defined', textTokens.length >= 6, `${textTokens.length} found`);
  for (const [, name, value] of textTokens) {
    const alphaMatch = value.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/);
    const alpha = alphaMatch ? Number(alphaMatch[1]) : 1;
    ok(`--text-${name} is visible (alpha ${alpha})`, alpha >= 0.4, value.trim());
  }

  // The panel must define both themes; dark is the default.
  ok('dark theme is the :root default', /:root,\s*\n?:root\[data-theme="dark"\]/.test(css));
  ok('light theme exists as an override', css.includes(':root[data-theme="light"]'));
  ok('declares color-scheme for native controls', css.includes('color-scheme: dark') && css.includes('color-scheme: light'));
  ok('browser scrollbars are themed', css.includes('scrollbar-color'));
  ok('CSS braces are balanced', (css.match(/\{/g) ?? []).length === (css.match(/\}/g) ?? []).length);

  /**
   * The <select> popup is painted by the OS, so an <option> only gets what is
   * set explicitly. With the translucent --bg-input the dark theme produced a
   * white popup whose text was unreadable until hovered.
   */
  ok('defines an opaque surface colour for native popups', /--bg-surface:\s*#[0-9a-f]{3,8}/i.test(css));
  ok('defines a hover variant of that surface', css.includes('--bg-surface-hover:'));

  const selectBlock = css.match(/select\.dropdown\s*\{[^}]*\}/)?.[0] ?? '';
  ok('the select uses an opaque background', /background(-color)?:\s*var\(--bg-surface\)/.test(selectBlock), selectBlock.replace(/\s+/g, ' ').slice(0, 120));
  ok('the select does not use the translucent input fill', !/background(-color)?:\s*var\(--bg-input\)/.test(selectBlock));

  const optionBlock = css.match(/select\.dropdown\s+option[^{]*\{[^}]*\}/)?.[0] ?? '';
  ok('select options set an explicit background', /background(-color)?:/.test(optionBlock), optionBlock.replace(/\s+/g, ' '));
  ok('select options set an explicit colour', /(^|[^-])color:\s*var\(/.test(optionBlock), optionBlock.replace(/\s+/g, ' '));

  const control = (await get('/control')).text;
  ok('control page defaults to the dark theme', control.includes('data-theme="dark"'));
  ok('theme fallback is dark', control.includes("?? 'dark'"));
}

section('Control panel DOM contract');
{
  const control = (await get('/control')).text;
  const ids = [...control.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);

  ok('has all six nav pages', ['page-now', 'page-lyrics', 'page-style', 'page-obs', 'page-cache', 'page-about'].every((p) => ids.includes(p)));
  ok('has the player card ids', ['artBox', 'trackTitle', 'trackArtist', 'posBar', 'offsetChip'].every((i) => ids.includes(i)));
  ok('has the lyric controls', ['providersList', 'resultsList', 'manualLrc', 'acceptScore', 'minScore', 'durationTolerance', 'preferredProvider'].every((i) => ids.includes(i)));
  ok('has the fallback controls', ['fallbackEnabled', 'fallbackMinScore', 'fallbackMinScoreVal'].every((i) => ids.includes(i)));
  ok(
    'has the style controls',
    ['fontFamily', 'lineHeight', 'lineScale', 'activeMainScale', 'inactiveMainScale', 'activeSubScale', 'idleOpacity', 'shadow', 'uppercase', 'colorActive', 'colorMain', 'colorSub', 'alignment', 'showTranslation', 'translationAsMain', 'showPlaceholder', 'hideOnPause', 'offsetMs'].every((i) => ids.includes(i)),
  );
  ok('has the OBS page controls', ['overlayUrl', 'debugMode', 'showProgress', 'copyOverlayUrl', 'healthBridge'].every((i) => ids.includes(i)));
  ok('has the cache page controls', ['cacheStats', 'cacheTable', 'cacheQuery', 'historyList'].every((i) => ids.includes(i)));
  ok('has a live preview iframe', control.includes('id="stylePreview"'));
  ok(
    'every data-page target exists',
    [...control.matchAll(/data-page="([a-z]+)"/g)].map((m) => m[1]).every((p) => ids.includes(`page-${p}`)),
  );

  // Every element the script reaches for must exist, or the panel breaks at runtime.
  const scriptIds = new Set([...control.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  const missing = [...scriptIds].filter((i) => !ids.includes(i));
  ok(`every $('id') lookup resolves (${scriptIds.size} lookups)`, missing.length === 0, `missing: ${missing.join(', ')}`);
}

section('Overlay contract');
{
  const overlay = (await get('/overlay')).text;
  for (const id of ['list', 'notice', 'progress', 'debug', 'viewport', 'stage']) {
    ok(`overlay has #${id}`, overlay.includes(`id="${id}"`));
  }
  ok('overlay paints no background colour', /html,\s*body\s*\{[^}]*background:\s*transparent/.test(overlay));
  ok('overlay implements the 3-line carousel', overlay.includes('translateY(') && overlay.includes('--line-height'));
  ok('overlay implements the marquee', overlay.includes('@keyframes marquee') && overlay.includes('scrolling'));
  ok('overlay dead-reckons position between messages', overlay.includes('performance.now()') && overlay.includes('timerAnchor'));
  ok('overlay connects with role=overlay', overlay.includes('role=overlay'));

  /**
   * The overlay must not drive its timing with requestAnimationFrame: Chromium
   * suspends rAF for a page that is not actively rendering, which is what an OBS
   * browser source becomes as soon as the OBS window loses focus. That froze the
   * scrolling until OBS was clicked again.
   */
  const overlayCode = overlay.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('overlay does not drive its loop with requestAnimationFrame', !overlayCode.includes('requestAnimationFrame'));
  ok('overlay drives its loop with a timer', /setInterval\(\s*tick\s*,/.test(overlayCode));
  ok('overlay resyncs on visibilitychange', overlayCode.includes('visibilitychange'));
}

section('WebSocket heartbeat');
{
  // A single missed pong must not disconnect the overlay; a backgrounded OBS
  // page can reply late, and being dropped would also stall the lyrics.
  //
  // This deliberately does NOT answer pings, to prove the server tolerates silence.
  //
  // `collectMessages` uses Node's built-in WebSocket when available and otherwise
  // a minimal client of our own, because the global only exists from Node 21 and
  // Node 20 is a supported version — calling `new WebSocket(...)` directly made
  // this crash on Node 20 in CI.
  const health = await (await fetch(`${BASE}/api/health`)).json();
  ok('server is up for heartbeat checks', health.ok === true);

  const { messages, client } = await collectMessages(`${BASE.replace('http', 'ws')}/ws?role=overlay`, {
    waitMs: 1500,
  });
  const gotHello = messages.some((m) => m.type === 'hello');
  const gotState = messages.some((m) => m.type === 'state');
  ok(`an overlay client completes the handshake and receives state (${client} client)`, gotHello && gotState, JSON.stringify({ gotHello, gotState, received: messages.length }));
}

section('API surface');
{
  for (const [path, method] of [
    ['/api/health', 'GET'],
    ['/api/state', 'GET'],
    ['/api/config', 'GET'],
    ['/api/providers', 'GET'],
    ['/api/cache', 'GET'],
    ['/api/history', 'GET'],
    ['/api/sessions', 'GET'],
  ]) {
    const r = await fetch(BASE + path, { method });
    let json = null;
    try {
      json = await r.json();
    } catch {
      /* not JSON */
    }
    ok(`${method} ${path} -> JSON`, r.status === 200 && json !== null, `status=${r.status}`);
  }
  const bad = await fetch(`${BASE}/api/nope`);
  ok('unknown /api path 404s as JSON', bad.status === 404 && Boolean((await bad.json()).error), `status=${bad.status}`);
}

section('Branding');
{
  const control = (await get('/control')).text;
  const overlay = (await get('/overlay')).text;
  const health = await (await fetch(`${BASE}/api/health`)).json();

  ok('control page is titled Chorus', control.includes('<title>Chorus'));
  ok('control page brand reads Chorus', /<h1>\s*Chorus\s*<\/h1>/.test(control));
  ok('overlay page is titled Chorus', overlay.includes('<title>Chorus'));
  ok('health reports the app name', health.name === 'chorus', health.name);
  ok('no stale product name in the control page', !/SMTC Lyrics|smtc-obs-lyrics/.test(control));
  ok('no stale product name in the overlay page', !/SMTC Lyrics|smtc-obs-lyrics/.test(overlay));
}

section('Application page');
{
  const control = (await get('/control')).text;
  const ids = [...control.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  ok(
    'has the startup controls',
    ['page-app', 'autostartToggle', 'autostartState', 'autostartCallout', 'autostartCommand', 'trayAtStartup', 'openControlOnStart'].every((i) => ids.includes(i)),
  );
  ok('has the server/log controls', ['serverPort', 'applyPort', 'appDataDir', 'logView', 'quitApp'].every((i) => ids.includes(i)));
  ok('has a nav entry for the Application page', control.includes('data-page="app"'));

  const status = await (await fetch(`${BASE}/api/autostart`)).json();
  ok('autostart endpoint reports support', typeof status.supported === 'boolean', JSON.stringify(status));
  ok('autostart reports the expected command', typeof status.expected === 'string' && status.expected.length > 0, status.expected);
  ok('expected command points at the hidden launcher', String(status.expected).includes('chorus-hidden.vbs'), status.expected);

  const log = await (await fetch(`${BASE}/api/log?lines=10`)).json();
  ok('log endpoint answers', log.ok === true && typeof log.exists === 'boolean', JSON.stringify({ ok: log.ok, exists: log.exists }));
}

section('Live state');
{
  const state = await (await fetch(`${BASE}/api/state`)).json();
  ok('reports engine status', typeof state.status === 'string', state.status);
  ok('reports the configured port-independent URLs', typeof state.serverTime === 'number');
  if (state.track) {
    ok('has a track', Boolean(state.track.title), JSON.stringify(state.track));
    ok('reports playback position', typeof state.playback.positionMs === 'number');
    if (state.lyrics.status === 'matched') {
      ok('lyrics are serialised for the overlay', Array.isArray(state.lyrics.lines) && state.lyrics.lines.length > 0, `${state.lyrics.lineCount} lines`);
      ok(
        'lines carry timeMs/text/endMs',
        state.lyrics.lines.every((l) => typeof l.timeMs === 'number' && typeof l.text === 'string' && typeof l.endMs === 'number'),
      );
      /**
       * Only assert an active line when the player publishes a timeline. A player
       * like foobar2000 without its media-control component reports no position,
       * so -1 is the correct answer there, not a fault.
       */
      if (state.playback.timelineAvailable) {
        ok('reports an active line index', state.lineIndex >= 0, String(state.lineIndex));
      } else {
        ok('reports no active line when the player gives no timeline', state.lineIndex === -1, String(state.lineIndex));
        ok('flags the missing timeline for the panel', state.playback.timelineAvailable === false);
      }
    }
  } else {
    ok('no track playing (acceptable)', true, 'engine idle');
  }
  ok('sends overlay settings with every snapshot', Boolean(state.settings) && typeof state.settings.alignment === 'string');
  ok(
    'reports the fallback fields the panel reads',
    typeof state.lyrics.viaFallback === 'boolean' && typeof state.lyrics.blankUntilNextTrack === 'boolean',
    JSON.stringify({ viaFallback: state.lyrics.viaFallback, blankUntilNextTrack: state.lyrics.blankUntilNextTrack }),
  );

  const config = await (await fetch(`${BASE}/api/config`)).json();
  ok(
    'config exposes the fallback option',
    config.lyrics.fallback && typeof config.lyrics.fallback.enabled === 'boolean' && typeof config.lyrics.fallback.minScore === 'number',
    JSON.stringify(config.lyrics.fallback),
  );
  ok('the fallback threshold defaults to 85', config.lyrics.fallback.minScore === 85, String(config.lyrics.fallback.minScore));
}

console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) console.log(`\u001b[32mAll ${pass} checks passed\u001b[0m`);
else console.log(`\u001b[31m${fail} failed\u001b[0m, ${pass} passed`);
console.log(`${'─'.repeat(56)}\n`);
process.exit(fail === 0 ? 0 : 1);
