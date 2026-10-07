# Chorus built-in SMTC bridge

An alternative to [nuttylmao/smtc-bridge](https://github.com/nuttylmao/smtc-bridge),
written in PowerShell, that reads Windows SMTC directly and serves the **same REST
API** — so Chorus can be pointed at either one.

> **Status: not wired into Chorus yet.** Nothing in the app uses this by default.
> It is a standalone tool so it can be exercised and compared before anything
> depends on it. See [Switching to it](#switching-to-it) for the manual step.

## Why it exists

The stock bridge is excellent and remains fully supported. This exists so Chorus
has no hard dependency on a second program a user has to find, download and keep
running — and because reading SMTC here removes a polling hop and a data-URL
round trip per request.

## Running it

```bat
start.bat            :: serves on http://127.0.0.1:5010
start.bat 5020       :: a different port
```

It defaults to **port 5010, not 5000**, so it can run alongside the stock bridge
while you compare the two. Neither one needs administrator rights.

| Endpoint | Returns |
|---|---|
| `GET /now-playing` | The full snapshot, same schema as the stock bridge |
| `GET /sessions` | The same JSON. (The stock bridge returns an HTML debug page here.) |
| `GET /health` | Liveness, port, poll interval and reader statistics |

One-shot, useful for scripting or debugging:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1 -Once
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1 -Once -NoThumbnails
```

Options: `-Port`, `-HostName`, `-PollMs`, `-Once`, `-Quiet`, `-NoThumbnails`, `-DebugLog <path>`.

`-DebugLog` appends one line per server-loop iteration and per snapshot decision. It
is how the polling bug below was found, and it is the first thing to reach for if the
served position stops advancing:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1 -DebugLog "%TEMP%\bridge.log"
```

The script resolves `package.json` and its sibling modules from its own location, so
it can be launched from any working directory — a shortcut, a scheduler, or another
process.

## Compatibility with the stock bridge

Field names, nesting and units match exactly, including the details that are easy
to get wrong:

- `Thumbnail` is a complete `data:` URL, not bare base64
- timeline values (`Position`, `StartTime`, `EndTime`, `MinSeekTime`, `MaxSeekTime`)
  are **millisecond offsets from the start of the item**, not wall-clock times
- `LastUpdatedTime` is the only absolute time, and it is ISO 8601 with an offset
- `PlaybackStatus` / `PlaybackType` / `AutoRepeatMode` use the same enum values

Two deliberate differences:

| | Stock bridge | This one |
|---|---|---|
| Thumbnail MIME | Always declares `image/jpeg` | **Sniffed from the magic bytes** (`image/png`, `image/webp`, …) |
| `/sessions` | HTML page | JSON |

The MIME point is not cosmetic. Spotify commonly supplies **PNG** artwork, and the
stock bridge labels it `image/jpeg` — the byte counts match to within base64
padding, so it is the same image with a wrong type. Browsers sniff and cope; a
strict consumer would not.

## Starting it at Windows sign-in

```bat
install-autostart.bat              :: show the current status
install-autostart.bat enable       :: start hidden at sign-in (port 5010)
install-autostart.bat enable 5020  :: ...on a different port
install-autostart.bat disable      :: stop doing that
```

It registers `bridge-hidden.vbs` under the current user's Run key:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run  ->  Chorus SMTC Bridge
```

`HKCU` needs no administrator rights, and running the launcher through `wscript.exe`
is what keeps it hidden — `wscript` is a GUI host, so no console window flashes at
sign-in. If the registry is not writable (policy-managed machines), it writes a
`Chorus SMTC Bridge.cmd` into the Startup folder instead.

This is **independent of Chorus's own auto-start entry** (`Chorus`). Either can be
enabled without the other, and disabling one does not disturb the other.

> **If you later let Chorus start the bridge itself**, turn this off first
> (`install-autostart.bat disable`). Otherwise both try to run it. It would not
> break anything — the second instance detects the first and exits 0 — but there is
> no reason to start it twice.

### Starting it twice is safe

A second instance checks `/health` on the port before giving up. If another Chorus
bridge is already serving, it logs `nothing to do` and exits **0**. At sign-in that
is the ordinary case, not an error.

The server also re-launches itself through `Sysnative` when started by a 32-bit
PowerShell, because WinRT projections are registered per architecture and a 32-bit
host cannot see them. That would otherwise fail with a bare "class not defined".

## Switching to it

Chorus reads its source from `data/config.json`:

```jsonc
{ "smtc": { "url": "http://127.0.0.1:5010" } }
```

Or set it live in the control panel: **Now playing → smtc-bridge address**. Either
way you can switch back to `http://127.0.0.1:5000` at any time.

A first-run "which source do you want" picker is the intended integration, but
that is deliberately not added yet.

## How it works

Windows PowerShell 5.1 reads WinRT through the `ContentType=WindowsRuntime` type
projection syntax. Three things about that are worth knowing before editing:

**Async.** PowerShell cannot await a WinRT `IAsyncOperation`. The generic
`AsTask` extension is reflected and blocked on — see `Invoke-WinRtAsync`.

**The HTTP server does not use `HttpListener`.** That sits on HTTP.SYS, which
needs a URL reservation for non-default prefixes and can fail outright when the
HTTP Server service is unavailable or the token is restricted (it did here).
A plain `TcpListener` needs no privileges and no `netsh` reservation; the cost is
the small amount of HTTP/1.1 framing in `server.ps1`.

**Thumbnails need `AsStreamForRead`.** `OpenReadAsync` returns a bare
`System.__ComObject` under this projection: its `Size` and `ContentType` are
invisible, casting to `IRandomAccessStreamWithContentType` fails, and `DataReader`
exposes only `FromBuffer`, so `CreateDataReader` is unavailable. The
`AsStreamForRead` extension accepts the COM object and returns a real .NET
`Stream`, which is the only route to the bytes from PowerShell 5.1.

Snapshots are cached and refreshed on a timer, so a burst of requests never each
pays for a WinRT round trip — the artwork alone is ~190 KB of base64 per session,
and rebuilding it per request is what makes naive bridges slow.

## Requirements

Windows 10/11 and Windows PowerShell 5.1 — both already present, nothing to
install. No administrator rights.
