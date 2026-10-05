# Chorus

Live lyrics for OBS, driven by whatever is playing in Windows.

Reads the current track from **Windows System Media Transport Controls** (via
[smtc-bridge](https://github.com/nuttylmao/smtc-bridge)), finds **original
lyrics** by title and artist across four platforms, and renders a transparent,
auto-scrolling lyrics page you add to OBS as a **Browser Source**.

```
Windows SMTC  →  smtc-bridge  →  Chorus  →  OBS Browser Source
                 (port 5000)    (port 6727)
```

Windows 10/11 · Node.js 20+ · no dependencies · MIT licensed

---

No account, no API key, no cloud service. Everything runs on your machine.

---

## Quick start

**1. Start smtc-bridge** (if it is not already running)

Download it from [the releases page](https://github.com/nuttylmao/smtc-bridge/releases)
and run `SMTC-Bridge.exe`. A tray icon appears and it serves
`http://127.0.0.1:5000/now-playing`. Leave it running.

**2. Start Chorus**

Double-click **`start.bat`**, or:

```bash
npm start
```

`start.bat` runs Chorus hidden in the background and puts a **tray icon** near
the clock. From it you can open the control panel, view the server console,
restart, or quit. To watch the output in a console instead, use
`node src/index.js`.

The control panel is at <http://127.0.0.1:6727/control>.

**3. Add the overlay to OBS**

In OBS: **Sources → + → Browser**, then paste:

```
http://127.0.0.1:6727/overlay
```

Set the size to **1200 × 300** and untick *Shutdown source when not visible* so
lyrics are ready the moment you cut to the scene. The background is fully
transparent — no chroma key needed.

**4. Turn on Start with Windows** (optional)

Control panel → **Application** → **Start with Windows**. Chorus then launches
hidden at sign-in, so the overlay is live whenever OBS opens.

**5. Pick your platform**

In the control panel, set **Primary platform** to the app you actually listen
from (Spotify, Apple Music, NetEase, QQ Music, Kugou, YouTube Music, a browser,
…). The overlay then follows that app even when another window has focus.

---

## What it does

### 1. Fetch the audio source

`smtc-bridge` exposes every Windows media session. This app normalises them and
picks one, preferring:

1. **your configured primary platform** — playing or paused;
2. the session Windows reports as focused, if it is playing;
3. the newest playing session;
4. the newest music-typed session.

Windows' "currently focused" session is frequently a browser tab rather than
your music app, so the explicit platform choice outranks it. Sessions that look
like live streams or video tabs — no duration, URLs or `!commands` in the title,
four-hour runtimes — are filtered out so a paused Twitch tab cannot hijack the
overlay.

Supported platforms are matched from the Windows app id:

| Platform | Matched from |
|---|---|
| Spotify | `Spotify.exe` |
| Apple Music / iTunes | `AppleMusic.exe`, `AppleInc.AppleMusicWin_*` |
| Deezer | `deezer.exe` |
| YouTube Music | `YouTube Music.exe` |
| YouTube (browser) | any browser AUMID |
| NetEase Cloud Music | `cloudmusic.exe`, `orpheus` |
| QQ Music | `QQMusic.exe`, `Tencent.QQMusic*` |
| Kugou | `kugou.exe` |
| Kuwo, foobar2000, AIMP, VLC, MusicBee, mpv | by executable name |
| anything else | generic fallback |

### 2. Search for original lyrics

The track title and artist are searched across four platforms **in parallel**:

| Source | Notes |
|---|---|
| **LRCLIB** | Open database, synced LRC, no key. Best for Western tracks. |
| **NetEase Cloud Music** | Strong CJK catalogue; also supplies translations. |
| **QQ Music** | Very broad CJK coverage. Needs a `Referer` header, set server-side. |
| **Kugou** | Further CJK fallback, searched by title then ranked by duration. |

Because these platforms send no CORS headers (and QQ requires a `Referer`),
the search runs **server-side inside this app**, not in the browser.

Every candidate is scored on:

| Signal | Weight |
|---|---|
| Title similarity (character-bigram Dice) | 48% |
| Artist similarity (max over split artists) | 30% |
| Duration closeness | 18% |
| Preferred-source bonus | 4% |

**The highest-scoring candidate that actually yields lyrics wins.** The preferred
source settles ties and is used when scores are level — it is never a reason to
show a worse match. Every scored candidate is listed on the **Lyrics** page so you
can see the ranking and override the pick.

Three refinements on top of the raw score:

- **A hard title gate.** A candidate whose title bears no resemblance to the
  playing track is rejected outright, however well the artist and duration match.
  This is what stops a same-artist, same-length different song being shown.
- **Version demotion.** Karaoke, TV-size, cover, remix and live variants are
  scored down, because they routinely carry metadata identical to the original and
  would otherwise win on provider order alone.
- **Sync preference.** Within a 3-point margin, a properly time-synced result is
  preferred over one whose timing had to be estimated.

#### Untimed (plain) lyrics

Some sources hold only untimed text — LRCLIB's `syncedLyrics` is frequently `null`
while `plainLyrics` is populated. Those lyrics are **used**, not discarded: the
lines are spread across the track duration and the result is flagged
`estimated timing` in the panel, so a 97-scoring untimed match still beats a
63-scoring timed one. The timing is an approximation and will drift; the label
says so.

#### Fallback when the main source has nothing

By default only your preferred source is trusted: if it has no lyrics, the
overlay shows nothing rather than borrowing from another platform. Turn on
**Lyrics → Fallback when the main source has nothing** to change that.

When enabled, if the preferred source yields no lyrics, Chorus takes the
**highest-scoring result among the other sources** — but only if it scores at
least the threshold (default **85**). Below that the overlay stays **blank until
the next song**, on purpose, rather than risk displaying words for the wrong
track.

| Behaviour | Result |
|---|---|
| Preferred source has the highest score | Used |
| Another source scores higher | Used — a better match always wins |
| Preferred source empty, best other source ≥ 85 | Used, flagged `fallback source` |
| Preferred source empty, best other source < 85 | Blank until the next track |
| Best other source is a different song | Rejected by the title check regardless of score |

The winner is chosen by **score**, not by which provider answers first, so a
93 never beats a 94. The normal title-similarity gate still applies, so a
compilation entry with the right artist and length cannot slip through.

Changing this option does not disturb an already-resolved song. If a track was
previously stored as "no lyrics" and you then turn the fallback on, the cached
negative result is reused — use **Re-resolve lyrics** to search again, which
deliberately ignores the cache. The panel says so when it shows a cached miss.

### 3. Generate the live lyrics page

`/overlay` recreates the look of
[tosu-lyrics](https://github.com/HollisMeynell/tosu-lyrics): a three-line
carousel **300 px tall**, one **100 px** slot per line, translating so the active
line sits in the middle. The active line is distinguished by **font size** (not
colour or blur), and only it shows its translation. Lines wider than the source
scroll across once per line duration.

The page dead-reckons playback position between polls and re-anchors on every
message, so lines change on time instead of on the next poll, and it corrects
itself rather than drifting.

It is driven by a **timer, not `requestAnimationFrame`**. Chromium suspends rAF
for a page that is not actively rendering — which is what an OBS browser source
becomes the moment the OBS window loses focus — so an rAF loop freezes the lyrics
until you click back into OBS. A timer keeps running regardless of focus.

### 4. Control everything from one UI

`/control` follows the visual language of
[AF-Media-Bar](https://github.com/Fervent-Tempo/AF-Media-Bar) — Fluent cards on a
light or dark shell, a left nav rail, one control right-aligned per row.

| Page | What is there |
|---|---|
| **Now playing** | Artwork, title, artist, progress, live sessions, primary platform, bridge address, poll interval |
| **Lyrics** | Enable/disable each source, scoring thresholds, every search candidate for the current track with its score, "apply this result", paste-your-own LRC |
| **Style** | Font, line height, active/idle text sizes, idle opacity, shadow, uppercase, three colours, alignment, translation handling, global offset, live preview |
| **OBS setup** | Copy-ready browser-source URL, debug overlay, progress bar, health checks |
| **Cache & history** | Cached lyrics with per-entry delete, recently played tracks and how each lookup went |
| **About** | Pipeline, credits, config path, reset actions |

Style changes apply to the OBS overlay **immediately** over WebSocket — no page
refresh, no restart.

---

## Lyrics synchronisation

Two details make the timing correct:

- smtc-bridge's `Position` is a **snapshot taken at `LastUpdatedTime`**, not a
  live clock. This app adds the elapsed time since that snapshot and then
  dead-reckons forward between polls.
- Every poll re-anchors the clock, so error cannot accumulate.

If a particular source is consistently early or late, use the **global lyric
offset** (`Style → Timing`, or the ± buttons on the Now playing page). The
offset is applied on the server, so the OBS source never needs to reload.

---

## Configuration

Settings live in `data/config.json` and are written by the control panel. The
file is plain JSON — you can edit it by hand and restart.

```jsonc
{
  "server":  { "port": 6727 },
  "app":     { "autostart": false, "openControlOnStart": false },
  "smtc":    { "url": "http://127.0.0.1:5000", "pollIntervalMs": 500 },
  "source":  { "primaryPlatform": "spotify", "maxTrackSeconds": 3600 },
  "lyrics":  {
    "enabled": ["lrclib", "netease", "qq", "kugou"],
    "preferredProvider": "lrclib",
    "acceptScore": 75,
    "minScore": 40,
    "durationToleranceMs": 8000,
    "fallback": { "enabled": false, "minScore": 85 }
  },
  "overlay": { "alignment": "center", "showTranslation": true, /* … */ },
  "window":  { "offsetMs": 0 }
}
```

Also under `data/`: `cache/` (resolved lyrics, one JSON file per track),
`history.json`, `overrides.json` (your manual "use this lyric" decisions), and
`logs/chorus.log` (output of the background server).

### Command line

```bash
npm start                          # start, open the panel in a browser
npm run start:tray                 # start with the system tray icon
npm run stop                       # ask a running instance to exit
node src/index.js --port 8080      # different port
node src/index.js --no-open        # do not open a browser
node src/index.js --background     # start hidden, keep no console
node src/index.js --tray           # show the tray icon
node src/index.js --quit           # stop whatever runs on the port
node src/index.js --host 0.0.0.0   # listen on all interfaces
```

---

## Starting with Windows

Control panel → **Application** → **Start with Windows**.

Chorus registers itself under the current user's Run key:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run  →  Chorus
```

No administrator rights are needed, and it affects only your account. At sign-in
it launches through `launcher\chorus-hidden.vbs`, which starts the tray helper
and the server as hidden processes — **no console window appears**.

Three related options live on the same page:

| Option | Effect |
|---|---|
| **Start with Windows** | Register/unregister the Run-key entry |
| **Tray icon** | Show the tray icon so the panel, log and Quit stay one click away |
| **Open the control panel at sign-in** | Off by default; the overlay runs headless |

If you move the Chorus folder, the registered command still points at the old
path. The Application page detects this and tells you to toggle the setting off
and on to rewrite it.

### The tray icon

| Menu item | What it does |
|---|---|
| Open control panel | Opens the panel in your default browser |
| Open OBS lyrics page | Opens the overlay URL (handy for a quick look) |
| View server console | Opens the live server log — this is the "console" |
| Open data folder | Config, cache, history and logs |
| Restart server | Stops and starts the server, keeping the icon |
| Quit Chorus | Stops the server and removes the icon |

Double-clicking the icon opens the control panel. Because the server runs hidden,
its output goes to `data\logs\chorus.log`; the tray opens it in Notepad, and
**Application → View the server log** shows the tail in the panel itself.

If a server is already running when the tray starts, the tray adopts it instead
of starting a second one.

---

## Tests

```bash
npm test              # everything, including live provider lookups
npm run test:offline  # no network; parsing, scoring, fallback and session logic
npm run test:engine   # engine timing against a fake smtc-bridge
npm run test:ui       # pages, DOM contract, theme tokens and the JSON API
```

`test/run.js` has 104 offline checks covering LRC parsing (fraction widths,
multi-timestamp lines, offset headers, word tags, CRLF), artist splitting,
conversion of untimed plain lyrics into estimated timings, text normalisation,
scoring, the title gate, version demotion, score-first selection, the fallback
policy — including that the highest-scoring candidate wins even when it belongs to
a different source than the preferred one — session selection and smtc-bridge
payload handling. The live section searches the real providers for a Japanese, an
English and a Chinese track, plus a deliberately unmatchable one, and smoke-tests
each provider.

`test/engine.js` has 15 checks and needs no server. It runs the real Engine
against an HTTP server that imitates smtc-bridge, and asserts the timing
behaviour directly: that pausing is **broadcast** to clients, that the position
then stays frozen, that pausing does not spam the socket, that resuming is
broadcast, and that `refresh` bypasses a cached negative result.

`test/ui.js` has 76 checks and needs a running server. It verifies every page and
asset is served, that every element the panel's script looks up actually exists,
that the overlay still meets its carousel/transparency contract and does **not**
drive its loop with `requestAnimationFrame`, that an overlay client which ignores
pings is not disconnected, that the JSON API answers, and — after a bug where all
panel text rendered invisible — that no colour uses the Windows `#AARRGGBB` byte
order where CSS expects `#RRGGBBAA`.

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness, versions, connected clients |
| `GET` | `/api/state` | Full current state snapshot |
| `GET` | `/api/sessions` | Raw smtc-bridge sessions |
| `GET` / `PUT` | `/api/config` | Read / merge settings |
| `GET` | `/api/cache` | Paginated lyric cache |
| `DELETE` | `/api/cache` · `/api/cache/:hash` | Clear all / one entry |
| `GET` / `DELETE` | `/api/history` | Recently played |
| `POST` | `/api/refresh` | Re-resolve the current track |
| `POST` | `/api/candidate` | Apply a specific search result |
| `POST` | `/api/manual` | Apply pasted LRC |
| `POST` / `PUT` | `/api/offset` | Nudge / set the lyric offset |
| `DELETE` | `/api/overrides` | Forget remembered matches |
| `POST` | `/api/probe` | Search for an arbitrary track (does not change playback) |
| `GET` | `/api/lrc` | Download current lyrics as `.lrc` |
| `GET` / `POST` | `/api/autostart` | Read / change the Start-with-Windows registration |
| `GET` | `/api/log` | Tail of the background server log |
| `POST` | `/api/shutdown` | Stop the server (used by `--quit` and the tray) |
| `WS` | `/ws?role=overlay\|control` | Live state push |

---

## Requirements

- **Windows 10/11** — SMTC is a Windows feature.
- **Node.js 20+** — developed and verified on Node 22. No npm dependencies; there
  is nothing to install.
- **smtc-bridge running** on `127.0.0.1:5000`, and your music app publishing a
  media session.
- **OBS Studio** for the overlay (any version with Browser Source).

The tray icon and Start-with-Windows use Windows PowerShell 5.1
(`powershell.exe`) and WinForms, both included in Windows 10/11 — nothing extra
to install.

---

## Notes and limitations

### Players that do not report a timeline

A player can publish a track to Windows **without** a track length or position.
foobar2000 does exactly this unless its media-control component is installed.

The symptom is specific and worth recognising: **lyrics are found but never
scroll**, because the position stays at `0:00` forever. The control panel detects
this and shows an orange `no timeline` tag plus an explanation, so it does not look
like a lyrics problem.

- **foobar2000** — install the [`foo_mediacontrol`](https://www.foobar2000.org/components/view/foo_mediacontrol)
  component and restart foobar2000. (The Microsoft Store build reports metadata
  but not the timeline.)
- **Other players** — enable "system media controls" / "SMTC" in the player's own
  settings if it has such an option.

Windows itself only exposes position at roughly one-second granularity, so sync is
line-accurate rather than frame-accurate even with a cooperative player.

### Other limitations

- Only sources that publish a Windows media session can be seen. If a player
  hides SMTC, enable "system media controls" in its own settings.
- Some players need to be *playing* before Windows reports their session.
- The overlay is plain text; it has no word-by-word highlight, because none of
  the four sources exposes reliable word timings for arbitrary tracks.
- Translations are only available from NetEase and QQ. LRCLIB and Kugou return
  original lyrics only.
- Official streaming APIs are deliberately not used — they need per-user OAuth,
  and Windows already gives us the metadata.
- Lyrics are fetched from public endpoints using only the track title and
  artist. Nothing else about your machine leaves the machine.

### Known Issue
- Not working with foobar2000

## Credits

Built on the ideas and interfaces of three projects:

- [**smtc-bridge**](https://github.com/nuttylmao/smtc-bridge) by nutty — exposes
  Windows SMTC as a REST API.
- [**tosu-lyrics**](https://github.com/HollisMeynell/tosu-lyrics) by
  HollisMeynell — the three-line lyric carousel and lyric timing model.
- [**AF-Media-Bar**](https://github.com/Fervent-Tempo/AF-Media-Bar) by
  Fervent-Tempo — multi-source lyric search, candidate scoring, and the control
  panel's visual style.

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for the layout, the test suites, and a few sharp edges worth knowing about before
changing anything.

## License

[MIT](LICENSE)
