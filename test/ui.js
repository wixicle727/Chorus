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

/**
 * Report a crash legibly.
 *
 * These are registered before the first `await`, because the suite body runs at
 * module top level and cannot be wrapped in try/catch. Without them a failure
 * exits with a bare non-zero code once the stack has scrolled past, which is all
 * CI showed.
 */
process.on('uncaughtException', (err) => {
  console.error(`\n\u001b[31mSuite crashed after ${pass} passed, ${fail} failed\u001b[0m`);
  console.error(`  ${err?.stack ?? err}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(`\n\u001b[31mSuite crashed on an unhandled rejection after ${pass} passed, ${fail} failed\u001b[0m`);
  console.error(`  ${err?.stack ?? err}`);
  process.exit(1);
});

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
  ['/nowplaying', 'text/html', 'id="card"'],
]) {
  const r = await get(path);
  ok(
    `${path} served`,
    r.status === 200 && r.type?.includes(expectType.split('/')[1]) && r.text.includes(needle),
    `status=${r.status} type=${r.type}`,
  );
}

section('Now playing overlay');
{
  // Both spellings resolve, since "now-playing" reads naturally in OBS while the file is
  // nowplaying.html.
  const dashed = await get('/now-playing');
  ok('/now-playing is an alias for /nowplaying', dashed.status === 200 && dashed.text.includes('id="card"'));

  const page = (await get('/nowplaying')).text;
  // The four things the feature is for.
  for (const [what, needle] of [
    ['cover art', 'id="cover-img"'],
    ['title', 'id="title"'],
    ['artist', 'id="artist"'],
    ['progress bar', 'id="fill"'],
  ]) {
    ok(`renders the ${what}`, page.includes(needle));
  }

  ok('shows elapsed and total time', page.includes('id="elapsed"') && page.includes('id="duration"'));
  ok('has a paused indicator', page.includes('id="pause-badge"'));
  ok('paints no background of its own (transparent for OBS)', /background:\s*transparent/.test(page));
  // The progress bar must not be driven by requestAnimationFrame: Chromium suspends it
  // for a browser source OBS is not rendering, which would freeze the bar.
  ok('drives the progress bar with a timer, not rAF', page.includes('setInterval(tickProgress') && !/requestAnimationFrame\(\s*tickProgress/.test(page));
  ok('connects to the local socket', page.includes('/ws?role=overlay'));
  // The cover is a data: URL from SMTC, which only loads if the scheme is allowed.
  ok('allows data: images', /img-src[^;]*data:/i.test(page) || !/Content-Security-Policy/i.test(page));
  ok('reads its settings from nowPlayingSettings', page.includes('nowPlayingSettings'));
  ok('survives a silent socket with a watchdog', page.includes('SILENCE_TIMEOUT_MS'));
}

section('Hide when there are no lyrics');
{
  // Feature: render nothing at all for a track without lyrics, rather than the notice.
  const overlay = (await get('/overlay')).text;
  ok('the overlay knows about the option', overlay.includes('hideWhenNoLyrics'));
  ok('the option hides the whole stage', overlay.includes('stageEl.style.visibility'));
  // A search in progress must NOT count as "no lyrics": blanking then would flash the
  // overlay away and back on every track change, and hide a result still being fetched.
  ok(
    'only a finished search may blank the overlay',
    /searchFinished\s*=\s*status === 'notfound'/.test(overlay),
  );
  ok(
    'the blank decision requires the search to be finished',
    /noLyrics\s*=\s*searchFinished && lines\.length === 0/.test(overlay),
  );

  const control = (await get('/control')).text;
  ok('the panel exposes a toggle', control.includes('id="hideWhenNoLyrics"'));

  const config = await (await fetch(`${BASE}/api/config`)).json();
  ok('config carries a default', typeof config.overlay.hideWhenNoLyrics === 'boolean', JSON.stringify(config.overlay.hideWhenNoLyrics));

  // The now-playing overlay has its own settings, delivered separately so the lyrics
  // overlay's flat contract is untouched.
  const state = await (await fetch(`${BASE}/api/state`)).json();
  ok('the snapshot carries now playing settings', Boolean(state.nowPlayingSettings));
  for (const key of ['showCover', 'showTitle', 'showArtist', 'showProgress', 'widthPx', 'textAlign']) {
    ok(`nowPlayingSettings.${key} is present`, state.nowPlayingSettings?.[key] !== undefined);
  }
  ok('the lyrics settings contract is unchanged', typeof state.settings?.alignment === 'string');

  // The panel's own DOM contract is checked generally below; these are the specific
  // controls this feature added.
  for (const id of ['npShowCover', 'npShowTitle', 'npShowArtist', 'npShowProgress', 'npShowPausedState', 'npHideWhenIdle', 'npHideOnPause', 'npWidth', 'npFontSize', 'npRadius', 'npTextAlign', 'nowPlayingUrl', 'copyNowPlayingUrl', 'openNowPlaying']) {
    ok(`the panel has #${id}`, control.includes(`id="${id}"`));
  }

  // The cover and the text panel must form ONE plate: a single rounded container that clips
  // its children, with no gap, so the two halves cannot drift apart or double-round.
  const npPage = (await get('/nowplaying')).text;
  ok(
    'the plate clips its children, so the corners come from one shape',
    /#card\s*\{[^}]*overflow:\s*hidden/s.test(npPage),
  );
  ok('there is no gap between the cover and the panel', /#card\s*\{[^}]*gap:\s*0\s*;/s.test(npPage));
  ok(
    'the cover is stretched to the panel height',
    /#cover\s*\{[^}]*align-self:\s*stretch/s.test(npPage),
  );
  ok(
    'only the cover\u2019s outer corners are rounded',
    /#cover\s*\{[^}]*border-radius:\s*var\(--card-radius\)\s+0\s+0\s+var\(--card-radius\)/s.test(npPage),
  );
  ok(
    'only the panel\u2019s outer corners are rounded',
    /#info\s*\{[^}]*border-radius:\s*0\s+var\(--card-radius\)\s+var\(--card-radius\)\s+0/s.test(npPage),
  );
  // With the cover off, the panel is the whole plate and needs its left edge back.
  ok('hiding the cover restores the panel\u2019s left corners', npPage.includes('#card.no-cover #info'));
  ok('the hide-while-paused option exists', npPage.includes('hideOnPause'));
  ok('config carries a hide-while-paused default', typeof config.nowPlaying?.hideOnPause === 'boolean');
}

section('Brand assets');
{
  // The icons are what the tray, the browser tab and the README all point at. They
  // are binary, so nothing else in the suite would notice them going missing or
  // being served as the wrong type.
  for (const [path, mime] of [
    ['/assets/chorus.ico', 'image/'],
    ['/assets/chorus-32.png', 'image/'],
    ['/assets/chorus-16.png', 'image/'],
    ['/assets/chorus-128.png', 'image/'],
    ['/assets/chorus-mark-circle.png', 'image/'],
  ]) {
    const r = await get(path);
    ok(`${path} served as an image`, r.status === 200 && (r.type ?? '').startsWith(mime), `status=${r.status} type=${r.type}`);
  }

  // The .ico must carry multiple sizes, or Windows scales one bitmap and the tray
  // goes soft. Byte 4 of the ICONDIR is the image count.
  const ico = await fetch(BASE + '/assets/chorus.ico');
  const bytes = Buffer.from(await ico.arrayBuffer());
  const imageCount = bytes.length > 6 ? bytes.readUInt16LE(4) : 0;
  ok('the .ico is multi-size', imageCount >= 4, `${imageCount} sizes embedded`);

  // Both pages must actually reference an icon, or the tab shows a blank page glyph.
  const control = (await get('/control')).text;
  const overlay = (await get('/overlay')).text;
  ok('the control page links an icon', /<link[^>]+rel="icon"/.test(control));
  ok('the overlay page links an icon', /<link[^>]+rel="icon"/.test(overlay));
  ok('the icon link points at an asset that exists', control.includes('/assets/chorus.ico'));
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
  ok('has the result-ordering control', ids.includes('resultsSort'));
  ok(
    'the ordering control offers title, artist and score',
    ['title', 'artist', 'score'].every((v) => new RegExp(`<option value="${v}"`).test(control)),
  );
  ok('title is the default ordering in the markup', /<option value="title">/.test(control));
  // The update row only appears once the server has staged a download.
  ok(
    'has the self-update controls',
    ['installUpdate', 'updateProgressRow', 'updateProgressBar', 'updateProgressLabel', 'updateDownload', 'checkUpdate'].every((i) => ids.includes(i)),
  );
  ok('the install button starts hidden', /id="installUpdate"[^>]*hidden/.test(control));
  ok('the progress row starts hidden', /id="updateProgressRow"[^>]*hidden/.test(control));
  ok('the update section promises the data folder is untouched', /never touched/.test(control));
  // The user asked for a check on every panel open, not only on the About page.
  ok('the panel checks for updates on boot', /Check for a newer release every time/.test(control));
  ok(
    'has the style controls',
    ['fontFamily', 'lineHeight', 'lineScale', 'activeMainScale', 'inactiveMainScale', 'activeSubScale', 'idleOpacity', 'shadow', 'uppercase', 'colorActive', 'colorMain', 'colorSub', 'karaoke', 'karaokeColor', 'karaokeColorHex', 'alignment', 'showTranslation', 'translationAsMain', 'showPlaceholder', 'hideOnPause', 'offsetMs'].every((i) => ids.includes(i)),
  );
  // The markup default (not the live config) — the panel sets the real state from
  // the server, so this guards against shipping it pre-ticked.
  ok('the karaoke switch is unticked in the markup', /<input type="checkbox" id="karaoke" \/>/.test(control));
  ok('the karaoke controls are reachable from the panel script', /\$\('karaoke'\)\.checked/.test(control) && /\$\('karaokeColor'\)/.test(control));
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
  const health = await (await fetch(`${BASE}/api/health`)).json();
  ok('server is up for heartbeat checks', health.ok === true);

  const { messages, error } = await collectMessages(`${BASE.replace('http', 'ws')}/ws?role=overlay`, {
    waitMs: 1500,
  });
  const gotHello = messages.some((m) => m.type === 'hello');
  const gotState = messages.some((m) => m.type === 'state');
  ok(
    'an overlay client completes the handshake and receives state',
    gotHello && gotState,
    error ?? JSON.stringify({ gotHello, gotState, received: messages.length }),
  );
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
    // Hits the GitHub releases API on a cold cache. A failure there still answers 200
    // with ok:false — which is what the panel renders — so this stays a liveness check
    // rather than a network dependency, and the suite passes offline.
    ['/api/update', 'GET'],
    // Progress of a self-update: idle until the panel asks for an install.
    ['/api/update/progress', 'GET'],
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

  const providers = await (await fetch(`${BASE}/api/providers`)).json();
  ok(
    'every lyric source is advertised to the panel',
    ['lrclib', 'netease', 'qq', 'kugou', 'qishui'].every((id) => (providers.providers ?? []).some((p) => p.id === id)),
    JSON.stringify((providers.providers ?? []).map((p) => p.id)),
  );
  ok(
    'Qishui is listed with a human-readable label',
    (providers.providers ?? []).find((p) => p.id === 'qishui')?.label === 'Qishui Music',
  );
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
  // Deliberately not asserting a specific number. The threshold is user-configurable and
  // this suite runs against the real data folder, so asserting the default made the test
  // fail for anyone who had changed it. What matters is that it is a usable percentage.
  ok(
    'the fallback threshold is a percentage',
    Number.isFinite(config.lyrics.fallback.minScore)
      && config.lyrics.fallback.minScore >= 0
      && config.lyrics.fallback.minScore <= 100,
    String(config.lyrics.fallback.minScore),
  );
}

section('Qishui and result ordering');
{
  const control = (await get('/control')).text;
  const registry = await (await fetch(`${BASE}/api/providers`)).json();
  const ids = (registry.providers ?? []).map((p) => p.id);

  ok('Qishui is registered as a lyric source', ids.includes('qishui'), ids.join(','));
  ok('Qishui has a display name', (registry.providers ?? []).find((p) => p.id === 'qishui')?.label === 'Qishui Music');
  ok('the panel builds a toggle per registered provider', /data-provider="\$\{provider\.id\}"/.test(control));
  ok('the toggle list is fed from the provider registry', /api\/providers/.test(control));
  ok('the About page describes Qishui', /Qishui Music<\/div>/.test(control));

  ok('the panel has the sort dropdown', control.includes('id="resultsSort"'));
  const modes = [...control.matchAll(/<option value="(title|artist|score)"/g)].map((m) => m[1]);
  ok('the dropdown offers title, artist and score',
    ['title', 'artist', 'score'].every((m) => modes.includes(m)), modes.join(','));
  ok('title comes first, so it is the default',
    control.indexOf('<option value="title"') < control.indexOf('<option value="artist"'), 'order');
  ok('the ordering lives in one function the tests can reach', /function orderResults\(/.test(control));
  ok('the panel refreshes the update check when it opens', /refreshUpdate\('fresh'\)/.test(control));
}

section('Interface language');
{
  const control = (await get('/control')).text;
  const overlayPage = (await get('/overlay')).text;

  for (const file of ['/js/i18n.js', '/js/i18n.zh-Hans.js', '/js/i18n.zh-Hant.js']) {
    const response = await fetch(`${BASE}${file}`);
    ok(`${file} is served`, response.status === 200, `status ${response.status}`);
    ok(`${file} is javascript`, /javascript/i.test(response.headers.get('content-type') ?? ''),
      response.headers.get('content-type'));
  }

  const dictionaries = await (await fetch(`${BASE}/js/i18n.zh-Hans.js`)).text();
  ok('the simplified dictionary is a module', /export default \{/.test(dictionaries));
  ok('the simplified dictionary carries Chinese text', /[\u4e00-\u9fff]/.test(dictionaries));

  ok('the panel imports the i18n module', /from '\/js\/i18n\.js'/.test(control));
  ok('the overlay imports the i18n module', /from '\/js\/i18n\.js'/.test(overlayPage));
  ok('the panel offers all three languages',
    ['en', 'zh-Hans', 'zh-Hant'].every((id) => control.includes(`value="${id}"`)), 'options');
  ok('the overlay can be forced into a language for previews', /params\.get\('lang'\)/.test(overlayPage));
  ok('overlay notices go through the translator', /t\('Nothing playing'\)/.test(overlayPage));

  const config = await (await fetch(`${BASE}/api/config`)).json();
  ok('the config carries the interface language',
    ['en', 'zh-Hans', 'zh-Hant'].includes(config.app?.language), config.app?.language);
}

section('Update section');
{
  const control = (await get('/control')).text;
  const info = await (await fetch(`${BASE}/api/update`)).json();
  ok('the update endpoint answers', typeof info.ok === 'boolean', JSON.stringify({ ok: info.ok, reason: info.reason }));
  if (info.ok) {
    ok('it reports the running version', info.current === (await (await fetch(`${BASE}/api/health`)).json()).version,
      info.current);
    ok('it reports whether an update is available', typeof info.updateAvailable === 'boolean');
    ok('it links to the releases page', String(info.releasesUrl).includes('github.com'));
  } else {
    ok('an unreachable GitHub is reported, not thrown', typeof info.reason === 'string' && info.reason.length > 0, info.reason);
  }

  const progress = await (await fetch(`${BASE}/api/update/progress`)).json();
  ok('progress is reported before an update runs', progress.ok === true && progress.state === 'idle', JSON.stringify(progress));

  ok('the panel has a Check now button', control.includes('id="checkUpdate"'));
  ok('the panel has an install button', control.includes('id="installUpdate"'));
  ok('the panel has a progress row', control.includes('id="updateProgressRow"'));
  ok('a hidden element really is hidden', /\[hidden\] \{ display: none !important; \}/.test(
    (await get('/css/control.css')).text,
  ));
  ok('installing goes through the apply endpoint', /api\/update\/apply/.test(control));
}

console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) console.log(`\u001b[32mAll ${pass} checks passed\u001b[0m`);
else console.log(`\u001b[31m${fail} failed\u001b[0m, ${pass} passed`);
console.log(`${'─'.repeat(56)}\n`);
process.exit(fail === 0 ? 0 : 1);

