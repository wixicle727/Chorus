# Changelog

All notable changes to Chorus are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **201 automated checks** across three suites: parsing, scoring and selection
  logic (104); engine timing against a simulated smtc-bridge (15); and pages, DOM
  contract, theme tokens and the JSON API (82).

### Notes

- Windows only, because SMTC is a Windows feature.
- No npm dependencies. There is nothing to install and no build step.
- Lyrics are fetched from public endpoints using only the track title and artist.
  No account, no API key, no telemetry.

[Unreleased]: https://github.com/wixicle727/Chorus/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/wixicle727/Chorus/releases/tag/v1.0.0
