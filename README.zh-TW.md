<div align="center">

<a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a>

<img src="assets/chorus-banner.png" alt="Chorus — live lyrics for OBS, from Windows SMTC" width="720">

![Chorus's UI](https://i.ibb.co/MDpTQMV4/download-1.png)

**為 OBS 提供即時歌詞，內容直接來自 Windows 上正在播放的一切。**

它會從 Windows 系統媒體傳輸控制（SMTC）讀出目前曲目，依標題和演出者在五個平台上找到原版歌詞，再渲染成一個透明、會自動捲動的歌詞頁面 —— 你只要把它當作瀏覽器來源（Browser Source）加進 OBS 就行。

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?logo=windows&logoColor=white)](https://github.com/wixicle727/Chorus)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/wixicle727/Chorus)
[![OBS](https://img.shields.io/badge/OBS-Browser%20Source-302E31?logo=obsstudio&logoColor=white)](https://obsproject.com/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```
Windows SMTC  →  bundled bridge  →  Chorus  →  OBS Browser Source
                 (port 5000)        (port 6727)
```

</div>

> [!NOTE]
> 不用帳號，不用 API key，不依賴任何雲端服務。**也不必安裝 Node.js** —— 發行版就是一個 `Chorus.exe`。查歌詞只用曲名和演出者，走的是公開端點。
>
> 你也不需要 [smtc-bridge](https://github.com/nuttylmao/smtc-bridge)：Chorus 自帶一份，啟動時會替你把它拉起來。假如你原本就在跑官方那個橋接，Chorus 會發現它，直接拿來用。

---

## 目錄

- [為什麼是 Chorus](#為什麼是-chorus)
- [快速開始](#快速開始)
- [它能做什麼](#它能做什麼)
  - [1. 取得音訊來源](#1-取得音訊來源)
  - [2. 搜尋原版歌詞](#2-搜尋原版歌詞)
  - [3. 產生即時歌詞頁面](#3-產生即時歌詞頁面)
  - [4. 在一個介面裡掌控一切](#4-在一個介面裡掌控一切)
- [歌詞同步](#歌詞同步)
- [設定](#設定)
  - [命令列](#命令列)
- [隨 Windows 啟動](#隨-windows-啟動)
  - [系統匣圖示](#系統匣圖示)
- [測試](#測試)
- [HTTP API](#http-api)
- [系統需求](#系統需求)
- [說明與限制](#說明與限制)
  - [不報告時間軸的播放器](#不報告時間軸的播放器)
  - [其他限制](#其他限制)
- [致謝](#致謝)
- [參與貢獻](#參與貢獻)
- [授權](#授權)

---

## 為什麼是 Chorus

| | |
|---|---|
| 🎧 **你手上那些播放器都能用** | Spotify、Apple Music、Deezer、YouTube Music、各種瀏覽器、foobar2000、VLC、AIMP、MusicBee、mpv、網易雲音樂、QQ 音樂、酷狗音樂 —— 只要它會發佈 Windows 媒體工作階段就行。選好你的平台，Chorus 就只認它。 |
| 🔍 **五路歌詞來源，同時開查** | LRCLIB、網易雲音樂、QQ 音樂、酷狗音樂和汽水音樂，統一評分、統一排名。 |
| 🈶 **中日韓曲庫覆蓋得住** | 網易雲音樂、QQ 音樂、酷狗音樂和汽水音樂與 LRCLIB 並列，而且網易雲音樂、QQ 音樂和汽水音樂還會附上翻譯。 |
| 🖤 **Alt+Tab 切走也不會卡住** | 由計時器驅動，OBS 待在背景時歌詞照樣捲動。 |
| 🎤 **卡拉 OK 填色** | 正在唱的那一行會從左到右填上顏色，唱到哪裡填到哪裡——來源提供逐字時間（汽水音樂、QQ 音樂、酷狗音樂和網易雲音樂）時按字同步，其餘來源按整行均勻推進。 |
| 🎛️ **什麼都能邊跑邊調** | 字型、字級、配色、對齊、陰影、翻譯、卡拉 OK、偏移 —— 改完立刻作用到正在執行的 OBS 來源上。 |
| 💿 **另有一層「正在播放」浮層** | 封面、標題、演出者和進度。任何播放器都能用，沒有歌詞的曲目也能用。 |
| 🙈 **沒內容可顯示時安安靜靜** | 可以選擇對沒歌詞的曲目乾脆什麼都不渲染，而不是彈一句「找不到歌詞」。 |
| 🔄 **自己就能更新** | 每次開啟面板都去 GitHub Releases 看一眼，你點一下它就下載並裝上新版本 —— 設定和歌詞快取照舊保留，更新前還會先備份。 |
| 🌏 **支援你的語言** | 英文、簡體中文與繁體中文，可在「應用程式 → *語言*」中切換。控制面板與兩個浮層會一起改變。 |
| 🪶 **零依賴** | 只用 Node 標準函式庫，加上樸素的 HTML/CSS/JS。一個自包含的 `.exe`，Node 執行環境就在裡面。 |

---

## 快速開始

**1️⃣ 下載安裝程式**

去[發行頁](https://github.com/wixicle727/Chorus/releases)取 `Chorus-v<version>-Setup.exe`，執行它。Windows 會要求**系統管理員權限** —— 安裝程式還沒開始就彈一次 UAC —— 然後裝進 `C:\Program Files\Chorus`，對所有使用者生效。你也可以在*選擇目標位置* 頁面換個資料夾。裝好之後，Chorus 自己是以一般權限執行的。

安裝程式之所以要提權，是因為它得自己建立目錄：在現在的 Windows 版本上，按使用者安裝的路徑會拒絕那一次呼叫，安裝程式還沒複製任何檔案就以 "Setup was unable to create the directory … Error 5: Access is denied" 停住了。所以這個提示框躲不掉，不是可選項。

> [!NOTE]
> 只要那個資料夾可寫，你的設定、歌詞快取和歷史就都放在 `Chorus.exe` 旁邊 —— 也就是說裝在非預設目錄時，資料也跟著留在那兒。如果不可寫（預設的 `Program Files` 就是這種情況），它們會改放到 `%LOCALAPPDATA%\Chorus\data`。

> [!TIP]
> 不想裝東西？那就拿 `Chorus-v<version>-portable.zip`，解壓到哪就在哪執行 `Chorus.exe`。兩種方式下 Node.js 都打包進執行檔裡了，沒有別的要裝。

**2️⃣ Chorus 從系統匣啟動**

時鐘旁邊會出現一個**系統匣圖示**：從那裡開啟控制面板、看日誌、重新啟動或者離開。控制面板在 <http://127.0.0.1:6727/control>。

Chorus 會在 `http://127.0.0.1:5000` 上啟動**自己的 SMTC 橋接**，離開時再把它停掉，所以沒有第二個程式要裝，也沒有第二個程式要一直掛著。

> [!TIP]
> 已經在跑官方那份 [smtc-bridge](https://github.com/nuttylmao/smtc-bridge)？別動它。Chorus 會在連接埠上找到它，直接用它，不自己再起一份 —— 你現有的設定一點不用改。

**3️⃣ 把歌詞層加進 OBS**

在 OBS 裡：**來源 → + → 瀏覽器**，然後貼上：

```
http://127.0.0.1:6727/overlay
```

> [!TIP]
> 還有第二個選用浮層，顯示的是**封面、標題、演出者和進度**而不是歌詞 —— 適合沒有歌詞的曲目，也可以當一張常駐的「正在播放」卡片。再加一個瀏覽器來源指向 `http://127.0.0.1:6727/nowplaying`，尺寸大約 600 × 140。

**4️⃣ 選定你的平台**

在控制面板裡把**主平台**設成你實際聽歌的那個應用程式。之後哪怕焦點在別的視窗上，歌詞層也會跟著這個應用程式走。

> [!IMPORTANT]
> 把瀏覽器來源設成 **1200 × 300**，並且**取消勾選** *來源不可見時關閉來源*，這樣你切到場景的那一刻歌詞就已經就緒。頁面本身全透明，不需要色鍵。

<details>
<summary><b>5️⃣ 選用：讓 Chorus 隨 Windows 啟動</b></summary>

<br>

控制面板 → **應用程式** → **隨 Windows 啟動**。這樣 Chorus 會在登入時靜默啟動，OBS 一開啟，歌詞層就是活的。見[隨 Windows 啟動](#隨-windows-啟動)。

</details>

---

## 它能做什麼

### 1. 取得音訊來源

`smtc-bridge` 會暴露 Windows 上的每一個媒體工作階段。Chorus 把它們正規化，然後挑一個，優先順序是：

1. **你設定的主平台** —— 正在播放或已暫停都算；
2. Windows 回報為目前焦點的工作階段，前提是它正在播放；
3. 最新的正在播放的工作階段；
4. 最新的音樂類工作階段。

Windows 說的「目前焦點」常常是個瀏覽器分頁，而不是你的音樂應用程式，所以明確選定的平台優先順序更高。看起來像直播或影片分頁的工作階段 —— 沒有時長、標題裡帶 URL 或 `!commands`、時長四小時 —— 會被過濾掉，這樣一個暫停著的 Twitch 分頁就劫持不了歌詞層。

支援的平台依 Windows 應用程式 id 比對：

| 平台 | 匹配依據 |
|---|---|
| 🟢 Spotify | `Spotify.exe` |
| 🍎 Apple Music / iTunes | `AppleMusic.exe`、`AppleInc.AppleMusicWin_*` |
| 🟣 Deezer | `deezer.exe` |
| ▶️ YouTube Music | `YouTube Music.exe` |
| 🌐 YouTube（瀏覽器） | 任何瀏覽器的 AUMID |
| 🔴 網易雲音樂 | `cloudmusic.exe`、`orpheus` |
| 🐧 QQ 音樂 | `QQMusic.exe`、`Tencent.QQMusic*` |
| 🐶 酷狗音樂 | `kugou.exe` |
| 🎚️ 酷我、foobar2000、AIMP、VLC、MusicBee、mpv | 依執行檔名比對 |
| ❓ 其他任何東西 | 通用備援 |

### 2. 搜尋原版歌詞

曲名和演出者會**同時**在四個平台上搜尋：

| 來源 | 說明 |
|---|---|
| **LRCLIB** | 開放資料庫，帶時間軸的 LRC，不需要 key。歐美曲目最好用。 |
| **網易雲音樂** | 中日韓曲庫很強，還能一併提供翻譯。 |
| **QQ 音樂** | 中日韓覆蓋面非常廣。需要一個 `Referer` 標頭，由伺服器端設定。 |
| **酷狗音樂** | 再一層中日韓備援，先依標題搜，再依時長排名。 |

<details>
<summary><b>為什麼搜尋放在伺服器端跑</b></summary>

<br>

這些平台都不發 CORS 標頭，而 QQ 要求的那個 `Referer` 瀏覽器根本設不了。所以查詢是在 Chorus 內部完成的，不在歌詞層頁面裡。

</details>

每個候選都依下面幾項評分：

| 信號 | 權重 |
|---|---|
| 標題相似度（字元二元組 Dice 係數） | 48% |
| 演出者相似度（拆分後的演出者取最大值） | 30% |
| 時長接近程度 | 18% |
| 首選來源加成 | 4% |

**真正能出歌詞、並且得分最高的那個候選才算贏。**首選來源只負責打破平手 —— 分數打平時才輪到它，它從來不是「給你看一個比較差的匹配」的理由。每一個評過分的候選都會列在**歌詞**頁面，你能看到排名，也可以手動改掉這個選擇。

原始分數之上還有三重修正：

- 🚧 **標題硬門檻。** 標題跟正在播放的曲目毫無相像之處的候選，直接否掉，演出者和時長匹配得再好也沒用。擋住「同一演出者、同樣長度、但另一首歌」的，就是這一條。
- 🔻 **版本降權。** 伴奏版、TV-size、翻唱、remix 和現場版都會扣分，因為它們身上的中繼資料往往和原版一模一樣，否則光靠來源順序就能贏。
- ✅ **同步優先。** 分差在 3 分以內時，真正帶時間軸的結果優先於時間靠估算的結果。

#### 📝 不帶時間軸的純文字歌詞

有些來源只存了不帶時間軸的文字 —— LRCLIB 的 `syncedLyrics` 經常是 `null`，而 `plainLyrics` 是有內容的。這種歌詞**照樣會用**，不會丟掉：文字行會被攤到整個曲目時長上，結果在面板裡標成 `estimated timing`，所以一條 97 分但沒有時間軸的匹配，仍然能壓過一條 63 分帶時間軸的。

> [!WARNING]
> 估算出來的時間軸只是近似，**一定會漂**，副歌裡尤其明顯。如果某首歌上你實在受不了，就在候選清單裡對一條帶時間軸的備選點**套用**。

#### 🔄 主要來源沒有內容時的回退

預設只信任你指定的首選來源：它沒歌詞，歌詞層就什麼都不顯示，而不是去別的平台借。想改這個行為，就開啟**歌詞 → 主要來源沒有內容時的回退**。

開了之後，如果首選來源查不到歌詞，Chorus 會取**其他來源裡分數最高的那條** —— 但前提是它至少達到閾值（預設 **85**）。低於閾值，歌詞層就**一直空到下一首歌**，這是故意的，免得冒險把另一首歌的歌詞顯示出來。

| 情形 | 結果 |
|---|---|
| 首選來源分數最高 | ✅ 採用 |
| 別的來源分數更高 | ✅ 採用 —— 更好的匹配永遠優先 |
| 首選來源為空，其他來源最佳 ≥ 85 | ✅ 採用，並標記 `fallback source` |
| 首選來源為空，其他來源最佳 < 85 | ⬛ 空到下一首歌 |
| 其他來源最佳結果是另一首歌 | ❌ 被標題檢查否掉，分數再高也一樣 |

最終勝出由**分數**決定，跟哪個服務商先回應無關，所以 93 分永遠壓不過 94 分。

<details>
<summary><b>改了設定卻沒反應？</b></summary>

<br>

已經被記成「無歌詞」的曲目會留著那條快取下來的否定結果。用**重新解析歌詞**再搜一次 —— 它會刻意繞過快取。目前顯示的是快取裡的未命中時，面板會告訴你。

</details>

### 3. 產生即時歌詞頁面

`/overlay` 複刻了 [tosu-lyrics](https://github.com/HollisMeynell/tosu-lyrics) 的樣子：一個三行輪播，**高 300 px**，每行佔 **100 px** 的槽位，整體平移到目前行正好停在中間。目前行靠**字級**區分（不是靠顏色或模糊），也只有它顯示翻譯。比來源更寬的行，會在這一行的時長裡橫向捲過一遍。

頁面會在兩次輪詢之間自己往前推算播放位置，並在每則訊息到達時重新對齊，所以換行是準時發生的，而不是等下一次輪詢；偏差會被糾正掉，不會越積越多。

<details>
<summary><b>為什麼不用 <code>requestAnimationFrame</code> 驅動</b></summary>

<br>

對於一個不再活躍渲染的頁面，Chromium 會暫停 rAF —— 而 OBS 視窗一失去焦點，OBS 瀏覽器來源正好就變成這種頁面。所以用 rAF 迴圈的話，歌詞會一直凍在那裡，直到你點回 OBS。Chorus 用的是計時器，焦點在不在都照樣跑。

</details>

### 4. 在一個介面裡掌控一切

`/control` 沿用 [AF-Media-Bar](https://github.com/Fervent-Tempo/AF-Media-Bar) 的視覺語言：淺色或深色外殼上的 Fluent 卡片、左側導覽列，每列一個靠右對齊的控制項。

| 頁面 | 有什麼 |
|---|---|
| 🎵 **正在播放** | 封面、標題、演出者、進度、即時工作階段、主平台、橋接位址、輪詢間隔 |
| 🔍 **歌詞** | 逐項開關來源、評分閾值、每個候選及其分數、「套用這個結果」、貼上自己的 LRC |
| 🎨 **樣式** | 字型、行高、作用中/非作用中字級、非作用中透明度、陰影、大寫、三種顏色、卡拉 OK 填色及其顏色、對齊、翻譯處理、全域偏移、即時預覽 |
| 📺 **OBS 設定** | 可直接複製的瀏覽器來源 URL、偵錯浮層、進度條、健康檢查 |
| 💾 **快取與歷史** | 帶單筆刪除的歌詞快取、最近播放的曲目，以及每次查詢的結果 |
| ⚙️ **應用程式** | 隨 Windows 啟動、系統匣圖示、連接埠、伺服器日誌、離開 |
| ℹ️ **關於** | 處理流程、致謝、設定路徑、重設操作 |

> [!TIP]
> 樣式變更會透過 WebSocket **立刻**作用到 OBS 裡的歌詞層 —— 不重新整理頁面，也不重新啟動。樣式頁面裡嵌的就是真正的歌詞層，所以你看到什麼，OBS 就合成什麼。

---

## 歌詞同步

有兩個細節讓時間對得上：

- smtc-bridge 的 `Position` 是**在 `LastUpdatedTime` 那一刻拍的快照**，不是即時時鐘。Chorus 把從那一刻起流逝的時間加上去，然後在兩次輪詢之間繼續往前推算。
- 每次輪詢都重新對齊時鐘，所以誤差不會累積。

如果某個來源總是偏早或偏晚，就用**全域歌詞偏移**（`樣式 → 時間`，或者「正在播放」頁面上的 ± 按鈕）。偏移是在伺服器端套用的，所以 OBS 裡的來源永遠不用重新載入。

---

## 設定

設定存在 `data/config.json`，由控制面板寫入。這個檔案就是普通 JSON —— 你可以手改，然後重新啟動。

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

`data/` 底下還有：`cache/`（已解析的歌詞，每首一個 JSON 檔案）、`history.json`、`overrides.json`（你手動「就用這條歌詞」的決定）和 `logs/chorus.log`（背景服務的輸出）。

### 命令列

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

## 隨 Windows 啟動

控制面板 → **應用程式** → **隨 Windows 啟動**。

Chorus 會把自己註冊到目前使用者的 Run 機碼下：

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run  →  Chorus
```

不需要系統管理員權限，也只影響你自己的帳戶。登入時，執行檔靜默啟動，只顯示系統匣圖示 —— **不會彈出任何主控台視窗**。

**安裝程式**也能替你做好這件事：安裝介面裡的*Windows 啟動時啟動 Chorus* 任務寫入的是同一條 Run 機碼。

| 選項 | 作用 |
|---|---|
| **隨 Windows 啟動** | 註冊 / 取消註冊那條 Run 機碼 |
| **系統匣圖示** | 顯示系統匣圖示，讓面板、日誌和離開都只差一次點選 |
| **登入時開啟控制面板** | 預設關閉；歌詞層是無介面執行的 |

<details>
<summary><b>把 Chorus 資料夾搬走了？</b></summary>

<br>

註冊的命令還指著舊路徑。應用程式頁面能發現這一點，並提示你把開關關掉再開啟，好把命令重寫一遍。

</details>

### 系統匣圖示

| 選單項目 | 作用 |
|---|---|
| 開啟控制面板 | 在你的預設瀏覽器裡開啟面板 |
| 開啟 OBS 歌詞頁面 | 開啟歌詞層的 URL（想快速瞄一眼時挺方便） |
| 檢視伺服器主控台 | 開啟即時的伺服器日誌 —— 這就是那個「主控台」 |
| 開啟資料目錄 | 設定、快取、歷史和日誌 |
| 重新啟動服務 | 停掉再啟動服務，圖示留著 |
| 離開 Chorus | 停掉服務並移除圖示 |

雙擊圖示會開啟控制面板。因為服務是隱藏執行的，它的輸出會寫進 `data\logs\chorus.log`；系統匣用記事本開啟它，而**應用程式 → 檢視伺服器日誌**會在面板裡直接顯示最後幾行。

假如系統匣啟動時已經有一個服務在跑，系統匣會接管它，而不是再起一個。

---

## 測試

```bash
npm test              # everything, including live provider lookups
npm run test:offline  # no network; parsing, scoring, fallback and session logic
npm run test:engine   # engine timing against a fake smtc-bridge
npm run test:ui       # pages, DOM contract, theme tokens and the JSON API
```

**三個測試套件，共 278 項檢查：**

| 套件 | 檢查數 | 涵蓋範圍 |
|---|---|---|
| `test/run.js` | 133 | LRC 解析（小數位寬度、多時間戳記行、offset 標頭、逐字標籤、CRLF）、演出者拆分、無時間軸歌詞 → 估算時間軸、文字正規化、評分、標題門檻、版本降權、分數優先的選擇、回退策略、工作階段選擇、**直播標題辨識**（這樣一首叫 `!NVADE SHOW!` 的歌不會被當成 Twitch 分頁）、smtc-bridge 承載內容 |
| `test/engine.js` | 18 | 拿假 smtc-bridge 跑真正的引擎：暫停會廣播、位置隨之凍結、不刷爆 socket、恢復會廣播、`refresh` 繞過快取裡的否定結果、閒置曲目照樣送心跳 |
| `test/ui.js` | 127 | 每個頁面和資源都能被送出、面板腳本要找的每個元素都在、歌詞層輪播與透明度的約定、**歌詞層迴圈裡沒有 `requestAnimationFrame`**、無視 ping 的歌詞層客戶端仍保持連線、JSON API、沒有任何顏色用 Windows 的 `#AARRGGBB` 位元組序、品牌圖示被正確送出並連結 |

`npm test` 還會額外跑真實查詢：一首日文、一首英文、一首中文，再加一首故意匹配不上的，並對每個來源做一遍冒煙測試。

<details>
<summary><b>這些測試套件為什麼存在</b></summary>

<br>

這裡的多數 bug，都要等到某首特定的歌或某個特定的播放器撞上來才看得見 —— 一次沒被廣播出去的暫停、一個和某個播放器習慣對不上的演出者分隔符、被悄悄丟掉的無時間軸歌詞。現在每一種都有回歸測試了。

</details>

---

## HTTP API

| 方法 | 路徑 | 用途 |
|---|---|---|
| `GET` | `/api/health` | 存活狀態、版本、已連線的客戶端 |
| `GET` | `/api/state` | 目前狀態的完整快照 |
| `GET` | `/api/sessions` | smtc-bridge 的原始工作階段 |
| `GET` / `PUT` | `/api/config` | 讀取 / 合併設定 |
| `GET` | `/api/cache` | 分頁的歌詞快取 |
| `DELETE` | `/api/cache` · `/api/cache/:hash` | 清空全部 / 刪掉單筆 |
| `GET` / `DELETE` | `/api/history` | 最近播放 |
| `POST` | `/api/refresh` | 重新解析目前曲目 |
| `POST` | `/api/candidate` | 套用某個指定的搜尋結果 |
| `POST` | `/api/manual` | 套用貼上的 LRC |
| `POST` / `PUT` | `/api/offset` | 微調 / 設定歌詞偏移 |
| `DELETE` | `/api/overrides` | 忘掉記住的匹配 |
| `POST` | `/api/probe` | 搜尋任意曲目（不改變正在播放的內容） |
| `GET` | `/api/lrc` | 把目前歌詞下載成 `.lrc` |
| `GET` / `POST` | `/api/autostart` | 讀取 / 修改隨 Windows 啟動的註冊 |
| `GET` | `/api/update` | 最新的 GitHub release 與執行中的版本（`?force=1` 繞過快取） |
| `GET` | `/api/log` | 背景服務日誌的末尾 |
| `POST` | `/api/shutdown` | 停掉服務（`--quit` 和系統匣用的就是它） |
| `WS` | `/ws?role=overlay\|control` | 即時狀態推送 |

### 頁面

| 路徑 | 是什麼 |
|---|---|
| `/overlay` | 歌詞層。透明；OBS 來源的尺寸設成 1200 × 300 |
| `/nowplaying` | 正在播放浮層：封面、標題、演出者、進度。透明；尺寸約 600 × 140 |
| `/control` | 控制面板 |

正在播放浮層接受 URL 覆寫參數，所以一個瀏覽器來源就能單獨調整，不必去改設定：`?cover=0`、`?title=1`、`?artist=1`、`?progress=0`、`?times=0`、`?paused=0`、`?hideWhenIdle=0`、`?width=640`、`?fontSize=24`、`?textAlign=center`、`?borderRadius=12`、`?colorTitle=%23ffffff`、`?colorArtist=`、`?colorProgress=`、`?colorAccent=%234cc2ff`，以及 `?debug=1`。

---

## 系統需求

**要用現成的發行版 —— 只要有 Windows。**

- **Windows 10/11** —— SMTC 是 Windows 的功能，系統匣圖示和自動啟動則用到 Windows PowerShell 5.1 和 WinForms，這兩樣 Windows 都自帶
- **OBS Studio**，用來放歌詞層（任何支援瀏覽器來源的版本都行）

SMTC 橋接是 Chorus 自帶並啟動的，所以沒有第二個程式。

**要從原始碼執行或建置：**

- **Node.js 22+** —— 在 Node 22 上開發並驗證。只有你要跑 `node src/index.js` 或者自己建置執行檔時才需要它
- **Python 3 + Pillow** —— 只用來重新產生 logo（`npm run logo`）
- **`npm install`** —— 只用於建置階段：`postject`（把應用程式塞進 `.exe`）和 `innosetup-compiler`（打安裝包）。應用程式本身**執行時零依賴**，安裝程式既不需要、也不會安裝 Node.js

---

## 說明與限制

### 不報告時間軸的播放器

播放器可以把一首歌發佈給 Windows，卻**不帶**曲目長度或播放位置。有些播放器預設就這麼做。

症狀很典型，值得記住：**歌詞搜到了，但永遠不捲**，因為位置一直停在 `0:00`。

> [!NOTE]
> Chorus 能辨識這種情況，會顯示一個橘色的 `no timeline` 標籤並附上解釋，免得看起來像是歌詞出了問題。

**怎麼辦：** 要是播放器自己的設定裡有「系統媒體控制」 / 「SMTC」這類選項，就開啟它，然後重新啟動播放器。有些播放器只暴露中繼資料、不暴露時間軸，那就真的沒輒了 —— 位置壓根沒被發佈出來。

Windows 本身只以大約一秒的粒度提供位置，所以即便播放器很配合，同步也只能做到按行準確，做不到按幀準確。

### 其他限制

- 只有會發佈 Windows 媒體工作階段的來源才看得見。如果某個播放器把 SMTC 藏了起來，去它自己的設定裡開啟「系統媒體控制」。
- 有些播放器得先處於*播放中*，Windows 才會回報它的工作階段。
- 歌詞層是純文字 —— 沒有逐字高亮，因為四個來源裡沒有一個能為任意曲目給出可靠的逐字時間。
- 翻譯只來自網易雲音樂和 QQ 音樂。LRCLIB 和酷狗音樂回傳的是原文歌詞。
- 官方串流 API 是刻意不用的 —— 它們要按使用者做 OAuth，而中繼資料 Windows 已經給我們了。
- 查歌詞只用曲名和演出者，走公開端點。關於你這台機器的其他任何東西都不會離開這台機器。

---

## 致謝

站在三個專案的肩膀上：

- [**smtc-bridge**](https://github.com/nuttylmao/smtc-bridge)，作者 nutty —— 把 Windows 媒體工作階段變成一個 REST API。Chorus 現在自帶橋接了，但它所講的這套 API、以及資料的形狀，都來自這個專案的設計。官方橋接依然被完整支援，已經在跑的話會被自動接管。
- [**tosu-lyrics**](https://github.com/HollisMeynell/tosu-lyrics)，作者 HollisMeynell —— 三行歌詞輪播和它的時間模型
- [**AF-Media-Bar**](https://github.com/Fervent-Tempo/AF-Media-Bar)，作者 Fervent-Tempo —— 多來源歌詞搜尋、候選評分，以及控制面板的視覺風格

---

## 參與貢獻

歡迎提 bug 和 pull request —— 動手改什麼之前，先看看 [CONTRIBUTING.md](CONTRIBUTING.md)，裡面有程式碼結構、測試套件，還有幾個值得提前知道的坑。

---

## 授權

[MIT](LICENSE)

