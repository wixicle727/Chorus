# SMTC Bridge + Lyric API Research

Consolidated, measured findings. Every URL below was actually fetched in this session; every
response-header claim was read from a real response, not inferred. Unverified items are marked.

- **Part 1** — `F:\SMTC-OBS\.ref\smtc-bridge` (`smtc-bridge.pyw`, `settings.ini`, `requirements.txt`)
- **Part 2** — public lyric APIs: LRCLIB, QQ Music, Kugou, NetEase Cloud Music

---

# Part 1 — smtc-bridge

Source: `smtc-bridge.pyw` (570 lines), `settings.ini` (3 lines), `requirements.txt` (7 lines),
plus `README.md`, `build.bat`, `launch.bat`, `smtc-bridge.spec`, icon assets.

## 1.1 Framework, host, port

| Item | Value |
|---|---|
| Framework | **Flask** + **flask-cors** |
| Version / author | `APP_VERSION = "1.0.0"`, `DEVELOPER = "nutty"` |
| Bind | `127.0.0.1:5000` (default in code and in `settings.ini`) |
| Server call | `app.run(host=HOST, port=PORT, threaded=True, use_reloader=False)` |
| Auth | **none** — anything reaching the port can read now-playing data |

`requirements.txt`:
```
flask
flask-cors
psutil
pystray
Pillow
plyer
winsdk
```
Note it uses **`winsdk`**, not `winrt` / `pywinrt` (a common misattribution).

`settings.ini` in full:
```ini
[SERVER]
host = 127.0.0.1
port = 5000
```

Code defaults are `{'Host': '127.0.0.1', 'Port': '5000'}` and are read with
`settings.get('SERVER','Host')` / `settings.getint('SERVER','Port')`. configparser option lookup is
case-insensitive, so lowercase-in-file vs `Host` in code is fine. **Bug if the file is ever
auto-generated**: the code writes the capitalized defaults (`Host`/`Port`), and configparser
preserves the case it wrote. Also, settings are never rewritten after startup.

`DISPLAY_HOST = get_local_ip() if HOST == "0.0.0.0" else HOST` — with `host=0.0.0.0` the tray links
use the LAN IP. werkzeug logging is forced to ERROR.

## 1.2 SMTC enumeration

```python
from winsdk.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as SMTC
from winsdk.windows.storage.streams import DataReader
import winsdk._winrt as winrt
```

The manager is cached in a module global and created once, with a retry-once wrapper:
```python
try:
    current_focused = manager.get_current_session()
    all_sessions = manager.get_sessions()
except Exception:
    # If the COM context dropped or invalidated, reset it and retry once
    print("Instantiating new SMTC manager...")
    smtc_manager = await SMTC.request_async()
```

**"Current" session selection is entirely delegated to Windows:**
```python
current_focused = manager.get_current_session()
current_session_id = current_focused.source_app_user_model_id if current_focused else None
```
There is no heuristic, no scoring, no play-state check, no fallback. If Windows reports no focused
session, `current_session_id` is `null` even when `sessions` is non-empty — **consumers must
implement their own fallback.**

`source_app_id` is the raw `SourceAppUserModelId` string, with **no normalization, lowercasing, or
trimming**. In practice these are AUMIDs such as `Spotify.exe` or
`Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic`. (That list is general AUMID knowledge, not
values observed from running this build — the load-bearing fact is that the code does zero
transformation.)

## 1.3 Routes

**`GET /now-playing`** → JSON, the main payload:
```python
payload = {
    "app_version": APP_VERSION,
    "os": f"{platform.system()} {platform.release()}",
    "current_session_id": current_session_id,
    "sessions": sessions_list
}
```
`app_version` and `os` are **missing from the README schema**, and are absent from both error paths
(`{"current_session_id": None, "sessions": [], "error": str(e)}` and the null-manager early return
`{"current_session_id": None, "sessions": []}`). Do not assume they always exist.

**`GET /sessions`** → **HTML, not JSON** (README calls it "list of all active media sessions"). It
uses a **fresh** manager, not the cached one, de-duplicates with `list(set([...]))`, and returns an
HTML `<ul>` of app ids with `Content-Type: text/html`. Errors also return HTTP 200, so status code
cannot distinguish them.

**`GET /artwork/<app_identifier>`** → `send_from_directory(THUMB_DIR, f"{app_identifier}.jpg")`.
**Effectively dead code**: `THUMB_DIR` is created but nothing ever writes a `.jpg` into it (only
in-memory base64 data URLs are produced). It 404s in practice.

## 1.4 Field-by-field

Per-session envelope:
```python
sessions_list.append({
    "source_app_id": app_id,
    "playback_info": playback_data,
    "timeline_properties": timeline_data,
    "media_properties": media_data
})
```

`playback_info`:
```python
"AutoRepeatMode": raw_playback.auto_repeat_mode.value if (raw_playback and raw_playback.auto_repeat_mode) else 0,
"IsShuffleActive": raw_playback.is_shuffle_active if raw_playback else False,
"PlaybackRate": raw_playback.playback_rate if raw_playback else 1.0,
"PlaybackStatus": raw_playback.playback_status.value if (raw_playback and raw_playback.playback_status) else 0,
"PlaybackType": raw_playback.playback_type.value if (raw_playback and raw_playback.playback_type) else 0
```
Types: int, bool, float, int, int. Enum meanings (README): PlaybackStatus 0=CLOSED, 1=OPENED,
2=CHANGING, 3=STOPPED, 4=PLAYING, 5=PAUSED; PlaybackType 0=UNKNOWN, 1=MUSIC, 2=VIDEO, 3=IMAGE;
AutoRepeatMode 0=NONE, 1=TRACK, 2=LIST.

`media_properties`:
```python
"Title": raw_media.title if raw_media else "Unknown",
"Artist": raw_media.artist if raw_media else "Unknown",
"AlbumTitle": raw_media.album_title if raw_media else "Unknown",
"AlbumArtist": raw_media.album_artist if raw_media else "Unknown",
"TrackNumber": raw_media.track_number if raw_media else 0,
"AlbumTrackCount": raw_media.album_track_count if raw_media else 0,
"Genres": list(raw_media.genres) if raw_media else [],
"Subtitle": raw_media.subtitle if raw_media else "",
"Thumbnail": None   # overwritten below
```
Types: str, str, str, str, int, int, array of str, str, str|null.

The strings are **raw SMTC values** — no splitting on `;`, no "feat." parsing, no cleanup. For
Spotify/YouTube these often carry app formatting, and for podcasts/video the *artist frequently
lives in `Subtitle`*. A lyric lookup should consider `Artist`, `AlbumArtist`, and `Subtitle`.

`timeline_properties` — **integer milliseconds, all offsets**:
```python
"EndTime": int(raw_timeline.end_time.total_seconds() * 1000) if raw_timeline.end_time else 0,
"LastUpdatedTime": str(raw_timeline.last_updated_time) if raw_timeline.last_updated_time else None,
"MaxSeekTime": int(raw_timeline.max_seek_time.total_seconds() * 1000) if raw_timeline.max_seek_time else 0,
"MinSeekTime": int(raw_timeline.min_seek_time.total_seconds() * 1000) if raw_timeline.min_seek_time else 0,
"Position": int(raw_timeline.position.total_seconds() * 1000) if raw_timeline.position else 0,
"StartTime": int(raw_timeline.start_time.total_seconds() * 1000) if raw_timeline.start_time else 0,
```
Semantics, quoted from the source comments:
- `Position` — *"The playback position, current as of LastUpdatedTime."* A **snapshot**, not a live clock.
- `EndTime` — *"The end timestamp of the current media item."* Usually the track duration.
- `StartTime` — *"The starting timestamp of the current media item."* Usually 0.
- `LastUpdatedTime` — *"The UTC time at which the timeline properties were last updated."* The **only
  absolute time** in the payload.

Therefore these are **offsets from the start of the media item, not absolute timestamps** (the field
names `StartTime`/`EndTime` are misleading). True position between polls is
`Position + (now - LastUpdatedTime)`.

Two traps: the guards `if raw_timeline.end_time` / `if raw_timeline.position` treat a legitimately
zero `TimeSpan` as falsy (harmless for real 0 ms, but "0" and "unknown" become indistinguishable);
and `raw_timeline` itself is never null-checked, so a `None` there raises into the outer handler and
degrades the **entire** response to the error payload.

## 1.5 Thumbnail format

```python
reader = DataReader(stream.get_input_stream_at(0))
await reader.load_async(stream.size)
buffer = bytearray(stream.size)
reader.read_bytes(buffer)
img_hash = hashlib.md5(buffer).hexdigest()
...
encoded_img = base64.b64encode(bytes(buffer)).decode('utf-8')
thumb_url = f"data:image/jpeg;base64,{encoded_img}"
```

- It is a **full data URL** with the prefix hardcoded to **`data:image/jpeg;base64,`** — not raw
  base64, not a bare `data:base64,`.
- **The mime prefix is frequently wrong.** The bytes are whatever SMTC supplied (often PNG, sometimes
  WebP/BMP). Nothing sniffs magic bytes and nothing transcodes via Pillow. Consumers that trust the
  declared type will fail to render some artwork — re-sniff and rewrite the prefix, or detect-decode.
  **This is the most likely integration bug in the payload.**
- Cached by MD5 of the raw bytes in an `OrderedDict` LRU, `MAX_CACHE_SIZE = 50`.
- `Thumbnail` is `string|null`: any exception (or a missing thumbnail) yields `null`, and the
  exception is swallowed. Each response still re-inlines the whole base64 blob.

## 1.6 Polling, CORS, tray, merging, config

- **No polling loop, no SSE, no WebSocket.** The client polls `GET /now-playing`.
- **0.5 s process-global cache**, doubling as a throttle:
  ```python
  if (current_time - last_execution_time) < 0.5 and last_payload:
      return last_payload
  ```
  Polling faster than 2 Hz just returns the cached payload. `last_execution_time`, `last_payload`,
  and `thumb_cache` are globals mutated from per-request threads (`threaded=True`) with **no lock** —
  a benign but real race.
- **One asyncio loop per request** (`asyncio.new_event_loop()` … `loop.close()`), while the cached
  `smtc_manager` was created on an earlier, now-closed loop. That mismatch is exactly why the
  `except Exception` re-instantiation retry exists; expect occasional latency spikes.
- **CORS is wide open**: `app = Flask(__name__)` then `CORS(app)` — no `resources`, no `origins`, no
  allowlist, so `Access-Control-Allow-Origin: *` on every route. Browser clients need no proxy. That
  is the tool's whole purpose, but it also means **any website you visit can fingerprint your
  listening activity** while the bridge runs.
- **No dedup and no merging of sessions.** One entry per `manager.get_sessions()` element,
  unconditionally, in Windows' order. Only `/sessions` de-duplicates, and only for display. The same
  track can appear **twice** with different `source_app_id`. Consumers should key on
  `current_session_id` first, then fall back to their own scoring (prefer `PlaybackStatus == 4`, then
  newest `LastUpdatedTime`).
- **Tray (`pystray`)** runs on the main thread while Flask runs on a daemon thread, so `Quit` →
  `os._exit(0)` kills the server. Menu: a disabled title item, `View Data (JSON)` →
  `http://{DISPLAY_HOST}:{PORT}/now-playing`, `View Active Sessions` → `/sessions`, links to
  `https://widgets.nutty.gg/now-playing/settings/` and
  `https://nutty.gg/collections/member-exclusive-widgets`, a checked `Start with Windows` toggle
  (PowerShell-created `.lnk` in the user Startup folder), and `Quit`.
- Other behavior: single-instance lock at `%TEMP%\smtc_bridge.lock` holding a PID validated with
  `psutil.pid_exists`; a **plyer toast** on startup (`Server successfully started on port {PORT}`);
  crash logs to `logs\crash_<timestamp>.txt` keeping the newest 10; `error.txt` on Flask start
  failure; PyInstaller spec + `build.bat`; `get_resource_path` handles `sys._MEIPASS`.
- **All config is `[SERVER] host/port` only.** No polling interval, cache size, CORS origins,
  thumbnail size, session filtering, or lyric options. `MAX_CACHE_SIZE = 50` and the `0.5` throttle
  are hardcoded.

## 1.7 Implications for a lyric overlay

1. `GET http://127.0.0.1:5000/now-playing` directly from the browser — open CORS, no proxy.
2. Resolve the track from the session whose `source_app_id == current_session_id`; if null, fall back
   to `PlaybackStatus == 4` with the newest `LastUpdatedTime`.
3. Sanitize `Title`/`Artist` (`;`, ` - `, `feat.`) and consider `Subtitle`/`AlbumArtist`.
4. Sync via `now_ms = Position + (Date.now() - Date.parse(LastUpdatedTime))`, clamped to
   `[StartTime, EndTime]`, re-anchored on every poll.
5. Pass duration from `EndTime` — it is **ms**, while LRCLIB/QQ want **seconds**, Kugou wants **ms**.
6. Treat every field as possibly absent (`Thumbnail` null, error payloads without `app_version`,
   `"Unknown"` titles).
7. Fix or ignore the `data:image/jpeg` prefix; ignore `/artwork/*`.

---

# Part 2 — lyric APIs

## 2.0 Method

PowerShell and `curl.exe` **cannot complete TLS to the public internet** in this environment
(`curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`). **Node's built-in
`fetch` works** (OpenSSL, not schannel), and it can set custom headers *and* read response headers —
so all CORS and `Referer` claims below are measured. Probe scripts: `.probe-verify.mjs`,
`.probe-detail.mjs`.

## 2.1 CORS matrix — measured `Access-Control-Allow-Origin`

| Platform | Observed ACAO | Browser-direct? |
|---|---|---|
| **LRCLIB** | **`*`** | ✅ **YES** |
| QQ Music | `null` (none) | ❌ proxy required (+ `Referer`) |
| Kugou | `acsing.kugou.com`, hardcoded, does **not** echo Origin | ❌ **proxy required** |
| NetEase | `null` (none) | ❌ proxy required |

An `ACAO` header being *present* is not the same as it *matching* your origin — that distinction is
what makes Kugou non-usable from `http://127.0.0.1:19387`.

## 2.2 LRCLIB — works, CORS confirmed

- Search: `https://lrclib.net/api/search?artist_name=Radiohead&track_name=Creep` → HTTP 200,
  `Content-Type: application/json`, **`Access-Control-Allow-Origin: *`**, top-level **array**.
- Get: `https://lrclib.net/api/get?artist_name=Radiohead&track_name=Creep&album_name=Pablo+Honey&duration=238`
  → HTTP 200, object, same keys, `ACAO: *`. `duration` is **seconds** (passed 238, got 239.0).
- Item fields: `id`, `name`, `trackName`, `artistName`, `albumName`, `duration` (float seconds),
  `instrumental`, `hasWordSync`, `plainLyrics`, `syncedLyrics`, `lyricsfile` (YAML lyrics-file v1.0,
  carries `start_ms`/`end_ms`).
- **CJK works natively**: `artist_name=周杰伦&track_name=晴天` → 20 hits, best
  `{"id":36847354,"duration":299,"syncedLyrics":"[00:29.36] 故事的小黃花\n..."}`. No romanization needed.
- **Filter `syncedLyrics != null`** — availability is query-dependent (0/20 plain-only for that CJK
  query, but many nulls on `track_name=Creep&q=Creep`).
- Junk params do **not** 404; the API returns loosely-matching rows, so rank by `duration` delta.
- No documented rate limit and no User-Agent requirement observed.

## 2.3 QQ Music — works with `Referer`

A/B on the identical URL: **no `Referer` → `{"retcode":-1310,...}` (46 bytes); with
`Referer: https://y.qq.com/` → `{"retcode":0,...,"lyric":"[ti:晴天]..."}`.** No cookie needed.

- Lyric: `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=0039MnYb0qxYhV&format=json&nobase64=1&g_tk=5381&inCharset=utf-8&outCharset=utf-8&platform=yqq.json&hostUin=0&needNewCode=0`
  Header `Referer: https://y.qq.com/`. Keys exactly: `retcode`, `code`, `subcode`, `lyric`, `trans`
  (no `roma` key). **`nobase64=1` is essential** — without it `lyric` is base64.
- Search: `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&inCharset=utf-8&outCharset=utf-8&platform=h5&needNewCode=1&w=周杰伦%20晴天&p=1&n=3`
  Header `Referer: https://y.qq.com/`. Content-Type is `application/x-javascript;charset=utf-8` but
  the body **is parseable JSON** — do not reject it on content type.
- `data.song.list[]` fields include `songmid`, `songname`, `singer[]`, `interval`, `albumname`,
  `albummid`, `songid`, `pay`, `size128`/`size320`/`sizeape`/`sizeflac`/`sizeogg`. Sample:
  `{"songmid":"0039MnYb0qxYhV","songname":"晴天","singer":[{"id":4558,"mid":"0025NhlN2yWrP4","name":"周杰伦","name_hilight":"<span ...>周杰伦</span>"}],"interval":269,"albumname":"叶惠美"}`.
- **`interval` is duration in SECONDS.** `singer[].name` is the artist; `name_hilight` contains HTML.
- `songmid` from search feeds the lyric URL. `w=` accepts `artist title` combined.
- `fcg_search_pic.fcg` returned **HTTP 404** — dead, do not use.

## 2.4 Kugou — works, but title-only query and no usable CORS

- Search: `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=晴天&duration=&hash=`
  → `candidates[]` with `id`, `accesskey`, `singer`, `song`, `duration` (**ms**), `score`,
  `product_from`, `krctype`, `language`, plus `ugccandidates`, `artists`, `ai_candidates`.
- Fetch: `https://lyrics.kugou.com/download?ver=1&client=pc&id=<id>&accesskey=<accesskey>&fmt=lrc&charset=utf8`
  → `{status, info, error_code, fmt:"lrc", contenttype, _source, charset, content, id}`; **`content`
  is base64 of the LRC** (decoded: `[offset:0]\r\n[00:00.00]...`). `accesskey` is per-candidate and
  mandatory.
- **Title-only query required**: `keyword=周杰伦 晴天` → `candidates: []`; `keyword=晴天` → 10;
  romanized `Jay Chou Qing Tian` → none. Top candidates had `"singer":"晴天"`, so `singer`/`song` are
  unreliable; rank on `score` + `duration`.
- **CORS: `ACAO` is hardcoded `acsing.kugou.com` and does not echo Origin** under any Origin tested
  → browser requests from `127.0.0.1` fail. Proxy required.

## 2.5 NetEase — lyric works, search is a dead end as-is

- Lyric (**works bare, no headers**): `https://music.163.com/api/song/lyric?id=186016&lv=1&kv=1&tv=-1`
  → `{sgc, sfy, qfy, lyricUser, lrc:{version,lyric}, tlyric:{...}, klyric:{...}, code:200}`.
  `lrc.lyric` = LRC; `tlyric` = translation; `klyric` = karaoke/word-level. `ACAO: null` → proxy.
- Metadata: `https://music.163.com/api/song/detail?ids=%5B185809%5D` → `songs[0].name`,
  `songs[0].artists[0].name`, `songs[0].album.name`, `songs[0].duration` (ms). Verified.
- Search (**unusable**): `https://music.163.com/api/search/get/web?csrf_token=&s=晴天&type=1&offset=0&total=true&limit=3`
  → HTTP 200 but the body is `{"result":"<ciphertext>","abroad":true,"code":200,"trp":{...}}`. Adding
  a Chrome UA **and** `Referer: https://music.163.com/` changed nothing. `&callback=cb` did not give
  JSONP either. `ACAO: null`.
  - Real song ids leak via `trp.rules` (`"search_tab_song::<id>::searchAlg$..."`) — a real but unwise
    workaround.
  - **Caveat: my egress IP is Hong Kong (`abroad: true`), so this may not reproduce from another
    region — retest before writing NetEase off.**
  - The robust route is a self-hosted implementation of NetEase's standard encryption
    (`NeteaseCloudMusicApi` and similar mirrored projects).

## 2.6 Third-party CORS proxies — not dependable

- `https://corsproxy.io/?url=<encoded>` → **HTTP 401**, `{"error":"A valid API key is required..."}`;
  the keyless tier is gone.
- `https://api.allorigins.win/raw?url=<encoded>` → **HTTP 522** (Cloudflare origin timeout), twice,
  and it also 522'd on a trivial `url=https://example.com` — down/unusable now.
- **Recommendation:** own the proxy. For a local OBS overlay the proxy is on the same machine, so
  there is no CORS surface at all, and it is also the one component that can inject QQ's `Referer`
  and host NetEase encryption.

## 2.7 Verdict

| Platform | Search by artist+title | Lyric fetch | Proxy | Verified how |
|---|---|---|---|---|
| **LRCLIB** | ✅ `artist_name`+`track_name`, CJK native | ✅ `syncedLyrics`/`plainLyrics` in the same response | **None** | fetched, parsed, **CORS header read** |
| **QQ Music** | ✅ `w=<artist> <title>`; JSON despite JS ctype | ✅ `nobase64=1` → raw LRC in `lyric` | **Yes** | fetched, parsed, **A/B'd `Referer`** |
| **Kugou** | ⚠️ title-only keyword | ✅ `content` = base64 LRC | **Yes** | fetched, decoded, **CORS header read** |
| **NetEase** | ❌ ciphertext (UA+Referer didn't help; retest from your IP) | ✅ `lrc.lyric`, but `ACAO: null` | **Yes** | fetched; search unusable as-is |

**Build order:** LRCLIB as primary (browser-direct, CJK works, synced LRC straight to the overlay) →
one local proxy to unlock QQ (best CJK coverage, clean `songmid` → lyric flow, `nobase64=1` gives
plain LRC) and Kugou (title-only + duration ranking) → NetEase last (needs encryption).

**Duration matching is the universal disambiguator:** QQ `interval` = seconds, Kugou `duration` = ms,
LRCLIB `duration` = seconds, SMTC `EndTime` = ms.

## Sources

- LRCLIB docs: <https://lrclib.net/docs> (renders as an empty JS shell to a plain fetch; verified by
  calling the API instead)
- `corsproxy.io` keyless deprecation: <https://corsproxy.io/docs/getting-started/>,
  <https://corsproxy.io/docs/faq/>
- QQ Music self-hosted API pattern: <https://github.com/copws/qq-music-api>
- LRCLIB Docker/consumer: <https://github.com/2t0m/lrclib-docker>,
  <https://www.npmjs.com/package/lrclib-sdk>
