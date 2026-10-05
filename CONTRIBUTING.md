# Contributing to Chorus

Thanks for taking a look. This is a small project with no build step and no
dependencies, so getting started takes a minute.

## Running it locally

```bash
git clone https://github.com/wixicle727/Chorus.git
cd Chorus
npm start
```

You also need [smtc-bridge](https://github.com/nuttylmao/smtc-bridge) running on
`127.0.0.1:5000`, and a music player that publishes a Windows media session.

There is no `npm install` — `package.json` deliberately has no dependencies, and
CI fails if one is added without a corresponding install step.

## Tests

```bash
npm run test:offline   # parsing, scoring, selection — no network, no server
npm run test:engine    # engine timing against a simulated smtc-bridge
npm run test:ui        # pages, DOM contract, theme tokens, JSON API (needs a server)
npm test               # everything, including live lyric-provider lookups
```

Run `npm start` in another terminal before `test:ui`. The suite defaults to port
6727; point it elsewhere with `npm run test:ui -- --base http://127.0.0.1:8080`.

**Please add tests with behaviour changes.** The suites exist because most bugs
here are invisible until a specific track or player hits them — a pause that was
never broadcast, an artist separator that did not match a player's convention,
untimed lyrics being discarded. Each of those has a regression test now.

CI runs the offline, engine and UI suites on Node 20 and 22. The live lookups are
excluded there on purpose: they hit third-party APIs and would be both flaky and
rude to run on every push.

## Layout

| Path | What lives there |
|---|---|
| `src/index.js` | Entry point, CLI flags, banner, lifecycle |
| `src/config.js` | Defaults, platform table, config load/save |
| `src/core/bridge.js` | smtc-bridge client and session selection |
| `src/core/engine.js` | Poll loop, track changes, what gets broadcast |
| `src/core/match.js` | Candidate scoring and selection |
| `src/core/lrc.js` | LRC parsing, translation merging, timing |
| `src/core/store.js` | Cache, history, overrides |
| `src/core/server.js` | HTTP routes and WebSocket wiring |
| `src/core/websocket.js` | Minimal RFC 6455 server (no dependencies) |
| `src/core/autostart.js` | Windows Run-key registration |
| `src/core/log.js` | Console output and the log file |
| `src/providers/index.js` | The four lyric sources |
| `web/` | Control panel and OBS overlay (plain HTML/CSS/JS) |
| `launcher/` | Hidden VBS launcher and the tray helper |

## Things worth knowing before you change them

- **The overlay must not use `requestAnimationFrame` for timing.** Chromium
  suspends rAF for a page that is not actively rendering — exactly what an OBS
  browser source becomes when the OBS window loses focus. A timer is used instead,
  and a test asserts rAF never creeps back in.
- **Do not write `#AARRGGBB` colours in the CSS.** Windows/WPF palettes use that
  byte order but CSS reads 8-digit hex as `#RRGGBBAA`, so copying one across
  produces fully transparent text. Translucent colours use `rgba()`, and a test
  enforces it.
- **Pausing must be broadcast.** The overlay dead-reckons its position from the
  last anchor it received, so a missing pause message means the lyrics keep
  scrolling forever.
- **Never pipe the server's output through Windows PowerShell.** PowerShell 5.1
  decodes a redirected pipe using the ANSI codepage, which turns the banner into
  mojibake. The server writes its own log file in UTF-8.
- **`\\b` does not work for Japanese.** JS word boundaries are defined over ASCII
  word characters, so `\bカラオケ\b` can never match. Version-detection patterns use
  explicit "not preceded/followed by a letter or digit" guards instead.
- **Only player-independent things belong in core.** Anything specific to one
  music service belongs in `src/providers/index.js`.

## Reporting a bug

Useful to include: Windows version, Chorus version, music player, the track that
misbehaved, and what the control panel showed (the **Lyrics** page lists every
candidate and its score). If lyrics did not appear, the **Application** page log
helps.
