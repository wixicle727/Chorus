# Changelog

All notable changes to Chorus are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.3] — 2026-10-21

### Added

- **Karaoke timing from NetEase, Kugou and QQ, not just Qishui.** These services publish a
  per-syllable sheet alongside the plain one — YRC, KRC and QRC — and Chorus was only ever
  asking for the plain one, which is why the fill drifted on songs that another player synced
  correctly. All three are now requested first, converted to the same enhanced-LRC form the
  fill already reads, and used when present. Kugou's sheet is encrypted, so it is decrypted
  the same way Lyricify does it; QQ's is a hex 3DES variant with a non-standard key schedule
  over deflated XML, implemented here because Node's OpenSSL build has no single-DES.
- **A syllable sheet is now preferred over an identical-quality plain one.** When the karaoke
  version of a song scores within three points of the winner, it is used instead, because it
  is the better overlay even when the text match is fractionally worse. Bounded to two extra
  fetches per track, and switchable off with `syllablePreferenceMargin: 0`.
- **Writing credits no longer scroll past as lyrics.** NetEase, Kugou and QQ all carry
  `词：…` / `曲：…` as timed lines in the intro. Lines inside the first twenty seconds that
  start with a credit label and a colon are dropped, so a karaoke sheet opens on the first
  sung line instead of the songwriter's name.

### Changed

- **A sheet without usable syllable stamps still sweeps.** A line needs at least two timed
  syllables before the fill follows them; anything less falls back to the constant sweep, so
  a karaoke-less song looks exactly as it did before.

### Fixed

- **Syllable stamps from NetEase and Kugou are absolute, and are now read that way.** Both
  services time each syllable from the start of the track — the first syllable of a line
  repeats the line's own start — but the first release of the converters added the line start
  on top, roughly doubling every stamp. Lines early in a song then looked fully sung the
  moment they appeared, while later lines never filled at all.

## [1.4.2] — 2026-10-20

### Fixed

- **The karaoke fill now follows the singer, not the clock.** Lyric sources stamp one
  time per line, so the fill could only sweep at a constant rate from the line's start to
  the next line's start — ahead of the voice early in a line, behind it later, and still
  colouring through the silence before the next line begins. Qishui publishes per-syllable
  timings and they were being discarded during conversion; they are now carried through as
  enhanced-LRC word tags, read by the parser, and used to drive the fill. Measured on
  夜に駆ける, the constant sweep sat 0.25 s from the voice at the median and 0.68 s for
  one syllable in ten; the worst line was 66 % out. Sources without syllable data keep the
  estimate, so nothing else changes.

## [1.4.1] — 2026-10-20

### Added

- **Refresh status.** Now playing → *⟳ Refresh status* re-reads the player immediately
  instead of waiting for the next poll, so a track that changed between ticks (or a bridge
  that was restarted) is picked up at once.

### Fixed

- **Some CJK tracks resolved to nothing while other players found lyrics.** Two causes:
  QQ's search returns a placeholder `songmid` of `"0"` for aggregate ("best match") rows,
  and that placeholder was used as the lyric key, so the lookup asked for a track that does
  not exist. A placeholder key now counts as missing and the real `mid` is used.
- **A length difference no longer rejects an exact match.** Providers often list a
  different edit — album versus single, or stale metadata — so a song whose title matched
  exactly and whose artist matched well was still thrown away for being 25 seconds longer
  than the streaming copy. An exact title with a matching artist now gets a wider duration
  window, while a genuinely different edit (a TV-size cut) is still rejected.

### Changed

- **A failure explains itself** in the cache and history pages, naming the sources that were
  searched instead of leaving the row blank.

## [1.4.0] — 2026-10-20

### Added

- **Karaoke fill.** Style → *Karaoke*. The part of the active line that has already
  been sung is painted in its own colour and the rest stays in the active colour, so the
  line fills left to right as it is sung. The sweep is driven by the same clock as the
  lyric timing, so it stops when playback is paused, follows the global offset, and never
  runs past the next line's start. Off by default; *Sung colour* picks the fill colour
  (default `#4cc2ff`).

- **Qishui Music as a fifth lyric source.** Karaoke-timed lyrics with an optional
  translation, which covers tracks that only Qishui's catalogue carries. Enabled alongside
  the other four sources; the best-scoring result still wins.

- **Result ordering.** Lyrics → *Search results for this track* → *Sort results by*. Lists
  the candidates by title, artist or score. Ordering only changes the list — scoring still
  decides which result is used.

- **Updates from inside the app.** Application → *Updates* → *Install update* downloads the
  new release, replaces the program files and restarts Chorus. Your settings, lyric cache
  and history are copied to `backup\<version>-<timestamp>\` first and are never overwritten;
  roll-back instructions sit in `RESTORE.txt` beside the copy. Installs under
  `Program Files` hand over to the installer instead, because those files are not writable
  without elevation.

- **English, Simplified Chinese and Traditional Chinese.** Application → *Language* switches
  the control panel and both overlays together, so a translated panel never leaves an
  English overlay on stream. Every string in the panel and the lyric overlay is translated,
  and the README ships in all three languages, linked from the switcher at the top.

### Changed

- The update check now runs every time the control panel opens, not only when you press
  *Check now*. Results are cached for 30 minutes, well inside GitHub's unauthenticated
  rate limit.

### Fixed

- **The karaoke fill was cut off flat at the baseline.** The sung part of a line is a second
  copy of the text revealed by a CSS mask, and a mask only paints inside the element's box.
  Glyphs are taller than their line box, so every descender — p, g, y, j, q — lost its tail
  and showed a sliver of the unsung copy underneath.

- **The karaoke fill stayed on screen while paused.** It was hidden with `visibility`, which
  an element can override on itself, so *Hide text while paused* blanked every line but the
  blue copy. It now hides with `opacity`, which no descendant can undo.

- **The sung half of a line looked smudged.** The fill copy carried its own drop shadow on
  top of the base copy's, darkening the overlap. It no longer has one; the base's shadow
  already surrounds the blue glyphs, exactly as it surrounds white ones.

## [1.3.0] — 2026-10-20

### Added

- **Hide everything when a track has no lyrics.** Style → *Hide everything when there are
  no lyrics*. With it on, the overlay renders nothing at all for a track with no lyrics
  instead of the "no lyrics found" notice, so the OBS source simply stays empty until a
  track with lyrics comes along. Off by default.

- **A universal now-playing overlay.** A second, optional OBS browser source showing the
  cover art, title, artist and progress bar — useful for tracks that have no lyrics, or as
  a permanent "what's playing" card.

  ```
  http://127.0.0.1:6727/nowplaying
  ```

  Modelled on [nutty.gg](https://github.com/nuttylmao/nutty.gg)'s now-playing widget: the
  artwork is blurred into the card background so the card belongs to the cover rather than
  sitting on top of it, the cover cross-fades on a track change, long titles scroll, and a
  paused track dims with a pause glyph.

  It is universal by construction — it reads whatever session Chorus has selected, so it
  follows the configured primary platform with no per-platform code, exactly like the lyric
  overlay. Every part is toggleable from Style → *Now playing overlay* (cover, title,
  artist, progress, paused state, hide-when-idle, width, font size, corner radius, text
  alignment), and the same values can be overridden per browser source with URL parameters
  (`?cover=0&width=640`, and so on).

  It is independent of the lyrics overlay: either, both or neither can be added to OBS.
  `/now-playing` also works as a spelling.

### Changed

- **The Windows installer requires administrator rights.** It installs for all users under
  `C:\Program Files\Chorus` instead of per-user. A per-user install could not create its own
  folder on current Windows builds — Setup stopped with "unable to create the directory …
  Error 5: Access is denied" before copying a single file, no matter which folder was chosen.

  Inno Setup's `PrivilegesRequired=admin` alone was not enough on the machine this was
  reported from: Setup started unelevated anyway, and failed exactly the same way. The
  compiled `Setup.exe` now carries a `requestedExecutionLevel="requireAdministrator"`
  manifest, added after compiling by `tools/build/force-admin-manifest.mjs`, so Windows
  asks for elevation before any of Setup's code runs. Declining gives a plain message
  instead of a half-finished install.

- **The destination-folder page is shown again.** Inno hides it whenever Setup is elevated,
  so requiring admin would otherwise have removed the only chance to choose where Chorus
  is installed.

- Settings, cache and history live next to the executable when that folder is writable, and
  fall back to `%LOCALAPPDATA%\Chorus\data` when it is not.

## [1.2.0] — 2026-10-07

### Fixed

- **Quit from the tray did not stop Chorus.** `Find-RunningServer` only accepted a process
  named `node`, but in an installed build the server *is* the application (`Chorus.exe`),
  and the orphan fallback filtered on `node` as well — so Quit had nothing to stop.

  It now asks the app to shut down over `/api/shutdown` first, which is the only way it can
  clean up after itself: it stops the bundled SMTC bridge, where an outright kill would
  leave it orphaned and still holding port 5000. It then falls back to ending whatever is
  listening on the port, whatever its process name.

- **The tray icon never appeared in a packaged build.** The helper was being started but
  exited immediately (code `0`, never reaching its message loop): starting PowerShell from
  Node with `detached` and ignored stdio does not survive. It is now launched through
  `launcher/chorus-tray.vbs` with `wscript`, the same path `start.bat` uses.

  Separately, building the icon could kill the whole helper silently — a throwing
  `New-Object` terminated the script before the tray icon was created, leaving nothing in
  the log. Icon creation now falls back through the `.ico` on disk, then the icon embedded
  in the executable (which is what works once installed, where `assets/` is not on disk),
  then a drawn one.

- **The installer deleted your data on every upgrade.** `[UninstallDelete]` removed
  `{app}\data` on uninstall *and* every upgrade, which would have silently discarded
  settings, lyric cache and history. Removal is now an explicit prompt at uninstall time.

### Changed

- **Runtime data lives in the install folder** (`{app}\data`), falling back to
  `%LOCALAPPDATA%\Chorus\data` only when that is not writable — an all-users install
  without elevation. One source of truth in `src/core/paths.js`, and the tray helper takes
  the same directory through `CHORUS_DATA_DIR` rather than guessing.

- **The discontinued `foo_mediacontrol` component is no longer recommended.** The
  no-timeline guidance now says to enable system media controls in the player's own
  settings. Players that publish a track but never a position are still listed and
  supported the same as before.

### Added

- **A Windows installer.** `Chorus-<version>-Setup.exe`, built with Inno Setup, whose
  compiler ships inside the `innosetup-compiler` npm package so CI needs no pre-installed
  tooling. Per-user by default (**no administrator rights**), with Start Menu and optional
  desktop shortcuts, an optional *Start Chorus when Windows starts* task, and an uninstall
  that stops a running instance first so nothing stays locked.

  Releases now publish two artifacts: the installer, and the portable zip for anyone who
  would rather not install anything.

- **Update checking.** The About page asks GitHub for the newest release and says whether
  you are up to date, with the release notes and a direct download link when you are not.
  Checked when the page is opened, and on demand with **Check now**.

  Nothing is downloaded or installed automatically — it only reports. Results are cached
  server-side for six hours so opening the panel does not spend the 60-requests-per-hour
  allowance an unauthenticated GitHub client gets; **Check now** forces a fresh request.
  A failed check is not treated as an error: the panel says why and links to the releases
  page instead.

- **14 regression checks** for version comparison, covering `v`-prefixed tags, numeric
  rather than lexicographic ordering (`1.10.0` > `1.9.9`), and pre-releases ranking below
  the release they lead to.

- **A single-file `Chorus.exe`.** The release is one executable with nothing to
  install: the application, the front-end, the logo and the SMTC bridge's scripts are
  all embedded inside it, and the release folder holds only the exe, the README,
  `LICENSE` and a background-launch shortcut.

  Built with Node's Single Executable Applications support, using `postject` and
  `rcedit` as build-time-only dependencies — so the project still ships with **zero
  runtime dependencies**. `npm run build:exe`.

  - The front-end is served **straight from memory**, so no files are written for it.
  - The bridge must exist as real files for PowerShell to run it, so it is unpacked
    once into a per-user cache directory. Several locations are tried, because a
    locked-down profile can deny the usual one.
  - The executable carries the Chorus icon (`assets/chorus.ico`) and version metadata,
    set with `rcedit`, instead of the default Node icon.
  - `src/` is repacked next to itself on first run, so the extracted copy has the same
    layout as a source checkout and nothing in the app needs path rewriting.

- **A bundled SMTC bridge, started by Chorus.** The bridge in `tools/smtc-bridge/`
  is now launched as a child process when Chorus starts and stopped when it exits,
  so there is one lifecycle and no separate auto-start entry to keep in sync.

  Chorus no longer requires [smtc-bridge](https://github.com/nuttylmao/smtc-bridge)
  to be installed. If something *is* already serving the port — the stock bridge, or
  another Chorus — it is adopted rather than fought over, so existing setups keep
  working untouched. Disable the bundled one with `--no-bridge`, or set
  `smtc.bridge.managed` to `false` in `data/config.json`.

- **A logo**, generated by `tools/logo/make_logo.py` rather than hand-drawn, so it
  is reproducible. The mark is the overlay itself: three lyric lines with the middle
  one larger and cyan, because that is the line being sung.

  - `assets/chorus.ico` — multi-size Windows icon, now used by the **tray**
    (previously it drew a music note at runtime)
  - `assets/chorus-16/32/64/128/256/512.png` — app icons
  - `assets/chorus-mark.png`, `assets/chorus-mark-circle.png` — the mark alone
  - `assets/chorus-banner.png` — README header
  - favicons on the control panel and overlay pages

  Small sizes are rendered differently rather than downscaled: below 64 px the glow
  and hairline edge are dropped and the bars thickened, because a soft glow turns to
  mush at 16 px.

- **`install-autostart.bat`** for the bridge, registering a hidden launcher under
  `HKCU\...\Run` as `Chorus SMTC Bridge`. Independent of Chorus's own auto-start
  entry. Optional now that Chorus starts the bridge itself.

- **9 regression checks** that the brand icons are served, that the `.ico` carries
  multiple sizes, and that both pages link an icon.

### Fixed

- **A single unreadable SMTC session wiped out every session.** Building the
  snapshot for a **Chrome** session threw `The property 'value__' cannot be found on
  this object`, and because that exception aborted the whole snapshot, Chorus was
  told there were **zero** sessions while two were live — which looks exactly like
  "no music playing". Two changes in the bundled bridge:

  - WinRT playback enums are read with an `[int]` cast instead of `.value__`.
    Whether the backing field is exposed varies by session and Windows build.
  - Each session is built in its own `try`, so one bad session is skipped instead of
    emptying the snapshot.

  This only showed up with Spotify and Chrome open at once; Spotify alone worked,
  which is why it stayed hidden.

- **A `.exe` that could not start.** Node executes an embedded SEA main through its
  **CommonJS** embedder regardless of the file extension, so an ESM shim failed with
  `Cannot use import statement outside a module`. The shim is now CommonJS and loads
  the real ESM entry point with a dynamic `import()`.

- **The release workflow never staged `assets/`.** Because the tray helper falls back
  to a drawn icon when the asset is missing, every release would have shipped with
  the old icon and no warning.

### Changed

- `start.bat` and the tray helper are no longer the only way in; the executable is
  the documented route for releases. Running from source (`node src/index.js`) still
  works exactly as before.

## [1.1.0] — 2026-10-06

### Fixed

- **An idle connection could stop receiving updates without noticing.** After the
  machine slept or idled for a long time, the overlay's WebSocket could go quiet
  without ever firing `close` — so nothing reconnected, and the lyrics stayed
  frozen while the server was working perfectly. Two changes:

  - the server now emits a **heartbeat full snapshot every 20 seconds** even when
    nothing has changed, so a quiet passage between lyric lines still produces
    traffic, and a client that missed an update heals itself;
  - the overlay runs a **watchdog** that force-reconnects when nothing has been
    heard for 45 seconds.

- **Song titles containing `!` or `@` are no longer discarded.** The stream-title
  filter tested for a bare `[!！]\w{2,}`, so any song with an exclamation mark
  followed by letters was thrown away as if it were a Twitch chat-command title.
  `!NVADE SHOW!` by RAISE A SUILEN was dropped before lyrics were ever searched,
  and the overlay showed nothing — indistinguishable from a lyrics failure.

  Detection now requires a real stream signal:

  - a URL in the title
  - two or more chat commands, or one at the very end of the title
  - explicit streaming vocabulary (`LIVE NOW`, `twitch`, `sub goal`, …)
  - a broadcast banner with repeated emoji

  A stray exclamation mark or an `@` inside a word is no longer enough, so
  `!NVADE SHOW!`, `BANG!` and `P@ssword` survive while the real
  `!skinplace !h1 !discord !socials` tab is still filtered out.

### Changed

- **Node.js 22 or newer is now required** (was 20). Node 20 lacks the global
  `WebSocket`, which broke CI. 22 is what the project is developed and verified
  against.

- **README rewritten** — centred header with badges (platform, Node, zero
  dependencies, OBS, license), a table of contents, GitHub alert callouts, and
  collapsible sections for the deeper explanations.

### Added

- **15 regression checks for stream detection**, covering both directions: known
  song titles are kept, and genuine stream titles are still rejected.
- **3 regression checks for the idle heartbeat.**

### Documentation

- Corrected the test counts: 119 logic checks, 18 engine checks and 82 UI checks
  (219 total).

## [1.0.0] — 2026-10-05

First release.

### Added

- **Live lyrics for OBS.** Lyrics are read from whatever is playing in Windows and
  rendered as a transparent browser source at `/overlay`, styled after
  [tosu-lyrics](https://github.com/HollisMeynell/tosu-lyrics): a three-line
  carousel with the active line enlarged and centred.
- **Windows SMTC as the source**, through
  [smtc-bridge](https://github.com/nuttylmao/smtc-bridge). Playback state, title,
  artist, album and artwork come from the media session your player already
  publishes.
- **A primary-platform setting**, so the overlay follows the app you actually
  listen from rather than whichever window Windows considers focused. Sessions
  that look like live streams or video tabs are filtered out.
- **Four lyric sources searched in parallel:** LRCLIB, NetEase Cloud Music,
  QQ Music and Kugou. Each can be enabled or disabled individually.
- **Candidate scoring** on title similarity, artist similarity, duration and
  preferred source, with a hard title gate, demotion of karaoke/TV-size/cover
  variants, and a preference for properly time-synced results.
- **Untimed lyrics are usable.** Sources that hold only plain text (LRCLIB
  frequently does) are converted to estimated timings and labelled as such,
  instead of being discarded.
- **Fallback option**: when the main source has no lyrics, the highest-scoring
  result from another source is used if it reaches a configurable threshold (85 by
  default); otherwise the overlay stays blank until the next track.
- **Control panel** at `/control`, styled after
  [AF-Media-Bar](https://github.com/Fervent-Tempo/AF-Media-Bar), with light and
  dark themes. Covers the current track, lyric sources, scoring, appearance,
  timing and OBS setup, with a live preview of the real overlay.
- **Per-track overrides**: apply any search result by hand, and it is remembered
  for that track.
- **Start with Windows**, registered per user under `HKCU`, launching hidden with
  a tray icon. Falls back to a Startup-folder shortcut where the registry is not
  writable.
- **Tray helper** with the control panel, the server log, the data folder,
  restart and quit.
- **Global lyric offset**, adjustable live from the panel or the tray.
- **On-disk cache** of resolved lyrics, plus play history and a cache browser.
- **216 automated checks** across three suites: parsing, scoring and selection
  logic (119); engine timing against a simulated smtc-bridge (15); and pages, DOM
  contract, theme tokens and the JSON API (82).

### Notes

- Windows only, because SMTC is a Windows feature.
- No npm dependencies. There is nothing to install and no build step.
- Lyrics are fetched from public endpoints using only the track title and artist.
  No account, no API key, no telemetry.

[Unreleased]: https://github.com/wixicle727/Chorus/compare/v1.4.3...HEAD
[1.4.3]: https://github.com/wixicle727/Chorus/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/wixicle727/Chorus/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/wixicle727/Chorus/releases/tag/v1.4.1
[1.4.0]: https://github.com/wixicle727/Chorus/releases/tag/v1.4.0
[1.3.0]: https://github.com/wixicle727/Chorus/releases/tag/v1.3.0
[1.2.0]: https://github.com/wixicle727/Chorus/releases/tag/v1.2.0
[1.1.0]: https://github.com/wixicle727/Chorus/releases/tag/v1.1.0
[1.0.0]: https://github.com/wixicle727/Chorus/releases/tag/v1.0.0
