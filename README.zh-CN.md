<div align="center">

<a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a>

<img src="assets/chorus-banner.png" alt="Chorus — live lyrics for OBS, from Windows SMTC" width="720">

![Chorus's UI](https://i.ibb.co/MDpTQMV4/download-1.png)

**为 OBS 提供实时歌词，内容直接来自 Windows 上正在播放的一切。**

它会从 Windows 系统媒体传输控制（SMTC）里读出当前曲目，按标题和歌手在四个平台上找到原版歌词，再渲染成一个透明、自动滚动的歌词页面 —— 你把它作为浏览器源（Browser Source）加进 OBS 就行了。

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
> 不用账号，不用 API key，不依赖任何云服务。**也不必装 Node.js** —— 发布版就是一个 `Chorus.exe`。查歌词只用曲名和歌手，走的是公开接口。
>
> 你也用不着 [smtc-bridge](https://github.com/nuttylmao/smtc-bridge)：Chorus 自带一份，启动时会替你把它拉起来。假如你本来就在跑官方那个桥接，Chorus 会发现它，直接拿来用。

---

## 目录

- [为什么是 Chorus](#为什么是-chorus)
- [快速开始](#快速开始)
- [它能做什么](#它能做什么)
  - [1. 获取音频来源](#1-获取音频来源)
  - [2. 搜索原版歌词](#2-搜索原版歌词)
  - [3. 生成实时歌词页面](#3-生成实时歌词页面)
  - [4. 在一个界面里掌控一切](#4-在一个界面里掌控一切)
- [歌词同步](#歌词同步)
- [配置](#配置)
  - [命令行](#命令行)
- [随 Windows 启动](#随-windows-启动)
  - [托盘图标](#托盘图标)
- [测试](#测试)
- [HTTP API](#http-api)
- [系统要求](#系统要求)
- [说明与限制](#说明与限制)
  - [不报告时间轴的播放器](#不报告时间轴的播放器)
  - [其他限制](#其他限制)
- [致谢](#致谢)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

---

## 为什么是 Chorus

| | |
|---|---|
| 🎧 **你手上那些播放器都能用** | Spotify、Apple Music、Deezer、YouTube Music、各种浏览器、foobar2000、VLC、AIMP、MusicBee、mpv、网易云音乐、QQ 音乐、酷狗 —— 只要它会发布 Windows 媒体会话就行。选好你的平台，Chorus 就只认它。 |
| 🔍 **五路歌词来源，同时开查** | LRCLIB、网易云音乐、QQ 音乐、酷狗和汽水音乐，统一打分、统一排名。 |
| 🈶 **中日韩曲库覆盖得住** | 网易云音乐、QQ 音乐、酷狗和汽水音乐与 LRCLIB 并列，而且网易云、QQ 和汽水音乐还会带上翻译。 |
| 🖤 **Alt+Tab 切走也不会卡住** | 由定时器驱动，OBS 待在后台时歌词照样滚动。 |
| 🎤 **卡拉 OK 填色** | 正在唱的那一行会从左到右填上颜色，唱到哪儿填到哪儿——来源提供逐字时间（汽水音乐、QQ 音乐、酷狗和网易云音乐）时按字同步，其余来源按整行均匀推进。 |
| 🎛️ **什么都能边跑边调** | 字体、字号、配色、对齐、阴影、翻译、卡拉 OK、偏移 —— 改完立刻作用到正在运行的 OBS 源上。 |
| 💿 **另有一层「正在播放」浮层** | 封面、标题、歌手和进度。任何播放器都能用，没有歌词的曲目也能用。 |
| 🙈 **没内容可显示时安安静静** | 可以选择对没歌词的曲目干脆什么都不渲染，而不是弹一句「未找到歌词」。 |
| 🔄 **自己就能更新** | 每次打开面板都去 GitHub Releases 看一眼，你点一下它就下载并装上新版本 —— 设置和歌词缓存照旧保留，更新前还会先备份。 |
| 🌏 **支持你的语言** | 英文、简体中文与繁体中文，可在「应用 → *语言*」中切换。控制面板与两个叠加层会一起改变。 |
| 🪶 **零依赖** | 只用 Node 标准库，加上朴素的 HTML/CSS/JS。一个自包含的 `.exe`，Node 运行时就在里面。 |

---

## 快速开始

**1️⃣ 下载安装程序**

去[发布页](https://github.com/wixicle727/Chorus/releases)取 `Chorus-v<version>-Setup.exe`，运行它。Windows 会要求**管理员权限** —— 安装程序还没开始就弹一次 UAC —— 然后装进 `C:\Program Files\Chorus`，对所有用户生效。你也可以在*选择目标位置* 页面换个文件夹。装好之后，Chorus 自己是以普通权限运行的。

安装程序之所以要提权，是因为它得自己创建目录：在现在的 Windows 版本上，按用户安装的路径会拒绝那一次调用，安装程序还没复制任何文件就以 "Setup was unable to create the directory … Error 5: Access is denied" 停住了。所以这个提示框躲不掉，不是可选项。

> [!NOTE]
> 只要那个文件夹可写，你的设置、歌词缓存和历史就都放在 `Chorus.exe` 旁边 —— 也就是说装在非默认目录时，数据也跟着留在那儿。如果不可写（默认的 `Program Files` 就是这种情况），它们会改放到 `%LOCALAPPDATA%\Chorus\data`。

> [!TIP]
> 不想装东西？那就拿 `Chorus-v<version>-portable.zip`，解压到哪儿就在哪儿运行 `Chorus.exe`。两种方式下 Node.js 都打进可执行文件里了，没有别的要装。

**2️⃣ Chorus 从托盘启动**

时钟旁边会出现一个**托盘图标**：从那儿打开控制面板、看日志、重启或者退出。控制面板在 <http://127.0.0.1:6727/control>。

Chorus 会在 `http://127.0.0.1:5000` 上启动**自己的 SMTC 桥接**，退出时再把它停掉，所以没有第二个程序要装，也没有第二个程序要一直挂着。

> [!TIP]
> 已经在跑官方那份 [smtc-bridge](https://github.com/nuttylmao/smtc-bridge)？别动它。Chorus 会在端口上找到它，直接用它，不自己再起一份 —— 你现有的配置一点不用改。

**3️⃣ 把歌词层加进 OBS**

在 OBS 里：**来源 → + → 浏览器**，然后粘贴：

```
http://127.0.0.1:6727/overlay
```

> [!TIP]
> 还有第二个可选浮层，显示的是**封面、标题、歌手和进度**而不是歌词 —— 适合没有歌词的曲目，也可以当一张常驻的「正在播放」卡片。再添加一个浏览器源指向 `http://127.0.0.1:6727/nowplaying`，尺寸大约 600 × 140。

**4️⃣ 选定你的平台**

在控制面板里把**主平台**设成你实际听歌的那个应用。之后哪怕焦点在别的窗口上，歌词层也会跟着这个应用走。

> [!IMPORTANT]
> 把浏览器源设成 **1200 × 300**，并且**取消勾选** *源不可见时关闭源*，这样你切到场景的那一刻歌词就已经就绪。页面本身全透明，不需要色键。

<details>
<summary><b>5️⃣ 可选：让 Chorus 随 Windows 启动</b></summary>

<br>

控制面板 → **应用程序** → **随 Windows 启动**。这样 Chorus 会在登录时静默启动，OBS 一打开，歌词层就是活的。见[随 Windows 启动](#随-windows-启动)。

</details>

---

## 它能做什么

### 1. 获取音频来源

`smtc-bridge` 会暴露 Windows 上的每一个媒体会话。Chorus 把它们归一化，然后挑一个，优先顺序是：

1. **你配置的主平台** —— 正在播放或已暂停都算；
2. Windows 报告为当前焦点的会话，前提是它正在播放；
3. 最新的正在播放的会话；
4. 最新的音乐类会话。

Windows 说的「当前焦点」常常是个浏览器标签页，而不是你的音乐应用，所以显式选定的平台优先级更高。看着像直播或视频标签的会话 —— 没有时长、标题里带 URL 或 `!commands`、时长四个小时 —— 会被过滤掉，这样一个暂停着的 Twitch 标签就劫持不了歌词层。

支持的平台按 Windows 应用 id 匹配：

| 平台 | 匹配依据 |
|---|---|
| 🟢 Spotify | `Spotify.exe` |
| 🍎 Apple Music / iTunes | `AppleMusic.exe`、`AppleInc.AppleMusicWin_*` |
| 🟣 Deezer | `deezer.exe` |
| ▶️ YouTube Music | `YouTube Music.exe` |
| 🌐 YouTube（浏览器） | 任意浏览器的 AUMID |
| 🔴 网易云音乐 | `cloudmusic.exe`、`orpheus` |
| 🐧 QQ 音乐 | `QQMusic.exe`、`Tencent.QQMusic*` |
| 🐶 酷狗 | `kugou.exe` |
| 🎚️ 酷我、foobar2000、AIMP、VLC、MusicBee、mpv | 按可执行文件名匹配 |
| ❓ 别的任何东西 | 通用兜底 |

### 2. 搜索原版歌词

曲名和歌手会**同时**在四个平台上搜：

| 来源 | 说明 |
|---|---|
| **LRCLIB** | 开放数据库，带时间轴的 LRC，不需要 key。欧美曲目最好用。 |
| **网易云音乐** | 中日韩曲库很强，还能一并提供翻译。 |
| **QQ 音乐** | 中日韩覆盖面非常广。需要一个 `Referer` 头，由服务端设置。 |
| **酷狗** | 再一层中日韩兜底，先按标题搜，再按时长排名。 |

<details>
<summary><b>为什么搜索放在服务端跑</b></summary>

<br>

这些平台都不发 CORS 头，而 QQ 要求的那个 `Referer` 浏览器根本设不了。所以查询是在 Chorus 内部完成的，不在歌词层页面里。

</details>

每个候选都按下面几项打分：

| 信号 | 权重 |
|---|---|
| 标题相似度（字符二元组 Dice 系数） | 48% |
| 歌手相似度（拆分后的歌手取最大值） | 30% |
| 时长接近程度 | 18% |
| 首选来源加成 | 4% |

**真正能出歌词、并且得分最高的那个候选才算赢。**首选来源只负责打破平局 —— 分数打平时才轮到它，它从来不是「给你看一个更差的匹配」的理由。每一个打过分的候选都会列在**歌词**页面，你能看到排名，也可以手动改掉这个选择。

原始分数之上还有三重修正：

- 🚧 **标题硬门槛。** 标题跟正在播放的曲目毫无相像之处的候选，直接否掉，歌手和时长匹配得再好也没用。挡住「同一歌手、同样长度、但是另一首歌」的，就是这一条。
- 🔻 **版本降权。** 伴奏版、TV-size、翻唱、remix 和现场版都会扣分，因为它们身上的元数据往往和原版一模一样，否则光靠来源顺序就能赢。
- ✅ **同步优先。** 分差在 3 分以内时，真正带时间轴的结果优先于时间靠估算的结果。

#### 📝 不带时间轴的纯文本歌词

有些来源只存了不带时间轴的文本 —— LRCLIB 的 `syncedLyrics` 经常是 `null`，而 `plainLyrics` 是有内容的。这种歌词**照样会用**，不会丢掉：文本行会被摊到整个曲目时长上，结果在面板里标成 `estimated timing`，所以一条 97 分但没有时间轴的匹配，仍然能压过一条 63 分带时间轴的。

> [!WARNING]
> 估算出来的时间轴只是近似，**一定会漂**，副歌里尤其明显。如果某首歌上你实在受不了，就在候选列表里对一条带时间轴的备选点**应用**。

#### 🔄 主来源什么都没有时的回退

默认只信任你指定的首选来源：它没歌词，歌词层就什么都不显示，而不是去别的平台借。想改这个行为，就打开**歌词 → 主来源没有内容时的回退**。

开了之后，如果首选来源查不到歌词，Chorus 会取**其他来源里分数最高的那条** —— 但前提是它至少达到阈值（默认 **85**）。低于阈值，歌词层就**一直空到下首歌**，这是故意的，免得冒险把另一首歌的歌词显示出来。

| 情形 | 结果 |
|---|---|
| 首选来源分数最高 | ✅ 采用 |
| 别的来源分数更高 | ✅ 采用 —— 更好的匹配永远优先 |
| 首选来源为空，其他来源最佳 ≥ 85 | ✅ 采用，并标记 `fallback source` |
| 首选来源为空，其他来源最佳 < 85 | ⬛ 空到下首歌 |
| 其他来源最佳结果是另一首歌 | ❌ 被标题检查否掉，分数再高也一样 |

最终胜出由**分数**决定，跟哪个服务商先返回无关，所以 93 分永远压不过 94 分。

<details>
<summary><b>改了设置却没反应？</b></summary>

<br>

已经被记成「无歌词」的曲目会留着那条缓存下来的否定结果。用**重新解析歌词**再搜一次 —— 它会刻意绕过缓存。当前显示的是缓存里的未命中时，面板会告诉你。

</details>

### 3. 生成实时歌词页面

`/overlay` 复刻了 [tosu-lyrics](https://github.com/HollisMeynell/tosu-lyrics) 的样子：一个三行轮播，**高 300 px**，每行占 **100 px** 的槽位，整体平移到当前行正好停在中间。当前行靠**字号**区分（不是靠颜色或模糊），也只有它显示翻译。比源更宽的行，会在这一行的时长里横向滚过一遍。

页面会在两次轮询之间自己往前推算播放位置，并在每条消息到达时重新对齐，所以换行是准点发生的，而不是等下一次轮询；偏差会被纠正掉，不会越攒越多。

<details>
<summary><b>为什么不用 <code>requestAnimationFrame</code> 驱动</b></summary>

<br>

对于一个不再活跃渲染的页面，Chromium 会挂起 rAF —— 而 OBS 窗口一失去焦点，OBS 浏览器源正好就变成这种页面。所以用 rAF 循环的话，歌词会一直冻在那儿，直到你点回 OBS。Chorus 用的是定时器，焦点在不在都照样跑。

</details>

### 4. 在一个界面里掌控一切

`/control` 沿用 [AF-Media-Bar](https://github.com/Fervent-Tempo/AF-Media-Bar) 的视觉语言：浅色或深色外壳上的 Fluent 卡片、左侧导航栏，每行一个右对齐的控件。

| 页面 | 有什么 |
|---|---|
| 🎵 **正在播放** | 封面、标题、歌手、进度、实时会话、主平台、桥接地址、轮询间隔 |
| 🔍 **歌词** | 逐项开关来源、打分阈值、每个候选及其分数、「应用这个结果」、粘贴自己的 LRC |
| 🎨 **样式** | 字体、行高、活跃/非活跃字号、非活跃透明度、阴影、大写、三种颜色、卡拉 OK 填色及其颜色、对齐、翻译处理、全局偏移、实时预览 |
| 📺 **OBS 设置** | 可直接复制的浏览器源 URL、调试浮层、进度条、健康检查 |
| 💾 **缓存与历史** | 带单条删除的歌词缓存、最近播放的曲目，以及每次查询的结果 |
| ⚙️ **应用程序** | 随 Windows 启动、托盘图标、端口、服务端日志、退出 |
| ℹ️ **关于** | 处理流程、致谢、配置路径、重置操作 |

> [!TIP]
> 样式改动会通过 WebSocket **立刻**作用到 OBS 里的歌词层 —— 不刷新页面，也不重启。样式页面里嵌的就是真正的歌词层，所以你看到什么，OBS 就合成什么。

---

## 歌词同步

有两个细节让时间对得上：

- smtc-bridge 的 `Position` 是**在 `LastUpdatedTime` 那一刻拍的快照**，不是实时时钟。Chorus 把从那一刻起流逝的时间加上去，然后在两次轮询之间继续往前推算。
- 每次轮询都重新对齐时钟，所以误差不会累积。

如果某个来源总是偏早或偏晚，就用**全局歌词偏移**（`样式 → 时间`，或者「正在播放」页面上的 ± 按钮）。偏移是在服务端应用的，所以 OBS 里的源永远不用重新加载。

---

## 配置

设置存在 `data/config.json`，由控制面板写入。这文件就是普通 JSON —— 你可以手改，然后重启。

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

`data/` 下面还有：`cache/`（已解析的歌词，每首一个 JSON 文件）、`history.json`、`overrides.json`（你手动「就用这条歌词」的决定）和 `logs/chorus.log`（后台服务的输出）。

### 命令行

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

## 随 Windows 启动

控制面板 → **应用程序** → **随 Windows 启动**。

Chorus 会把自己注册到当前用户的 Run 键下：

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run  →  Chorus
```

不需要管理员权限，也只影响你自己的账户。登录时，可执行文件静默启动，只显示托盘图标 —— **不会弹出任何控制台窗口**。

**安装程序**也能替你做好这件事：安装界面里的*Windows 启动时启动 Chorus* 任务写入的是同一条 Run 键。

| 选项 | 作用 |
|---|---|
| **随 Windows 启动** | 注册 / 注销那条 Run 键 |
| **托盘图标** | 显示托盘图标，让面板、日志和退出都只差一次点击 |
| **登录时打开控制面板** | 默认关闭；歌词层是无界面运行的 |

<details>
<summary><b>把 Chorus 文件夹挪走了？</b></summary>

<br>

注册的命令还指着旧路径。应用程序页面能发现这一点，并提示你把开关关掉再打开，好把命令重写一遍。

</details>

### 托盘图标

| 菜单项 | 作用 |
|---|---|
| 打开控制面板 | 在你的默认浏览器里打开面板 |
| 打开 OBS 歌词页面 | 打开歌词层的 URL（想快速瞄一眼时挺方便） |
| 查看服务端控制台 | 打开实时的服务端日志 —— 这就是那个「控制台」 |
| 打开数据文件夹 | 配置、缓存、历史和日志 |
| 重启服务 | 停掉再启动服务，图标留着 |
| 退出 Chorus | 停掉服务并移除图标 |

双击图标会打开控制面板。因为服务是隐藏运行的，它的输出会写进 `data\logs\chorus.log`；托盘用记事本打开它，而**应用程序 → 查看服务端日志**会在面板里直接显示末尾几行。

假如托盘启动时已经有一个服务在跑，托盘会接管它，而不是再起一个。

---

## 测试

```bash
npm test              # everything, including live provider lookups
npm run test:offline  # no network; parsing, scoring, fallback and session logic
npm run test:engine   # engine timing against a fake smtc-bridge
npm run test:ui       # pages, DOM contract, theme tokens and the JSON API
```

**三个套件，共 278 项检查：**

| 套件 | 检查数 | 覆盖 |
|---|---|---|
| `test/run.js` | 133 | LRC 解析（小数位宽度、多时间戳行、offset 头、逐字标签、CRLF）、歌手拆分、无时间轴歌词 → 估算时间轴、文本归一化、打分、标题门槛、版本降权、分数优先的选择、回退策略、会话选择、**直播标题识别**（这样一首叫 `!NVADE SHOW!` 的歌不会被当成 Twitch 标签）、smtc-bridge 载荷 |
| `test/engine.js` | 18 | 拿假 smtc-bridge 跑真正的引擎：暂停会广播、位置随之冻结、不刷爆 socket、恢复会广播、`refresh` 绕过缓存里的否定结果、空闲曲目照样发心跳 |
| `test/ui.js` | 127 | 每个页面和资源都能被送出、面板脚本要找的每个元素都在、歌词层轮播与透明度的约定、**歌词层循环里没有 `requestAnimationFrame`**、无视 ping 的歌词层客户端仍保持连接、JSON API、没有任何颜色用 Windows 的 `#AARRGGBB` 字节序、品牌图标被正确送出并链接 |

`npm test` 还会额外跑真实查询：一首日文、一首英文、一首中文，再加一首故意匹配不上的，并对每个来源做一遍冒烟测试。

<details>
<summary><b>这些套件为什么存在</b></summary>

<br>

这里的多数 bug，都要等到某首特定的歌或某个特定的播放器撞上来才看得见 —— 一次没被广播出去的暂停、一个和某个播放器习惯对不上的歌手分隔符、被悄悄丢掉的无时间轴歌词。现在每一种都有回归测试了。

</details>

---

## HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/health` | 存活状态、版本、已连接的客户端 |
| `GET` | `/api/state` | 当前状态的完整快照 |
| `GET` | `/api/sessions` | smtc-bridge 的原始会话 |
| `GET` / `PUT` | `/api/config` | 读取 / 合并设置 |
| `GET` | `/api/cache` | 分页的歌词缓存 |
| `DELETE` | `/api/cache` · `/api/cache/:hash` | 清空全部 / 删掉单条 |
| `GET` / `DELETE` | `/api/history` | 最近播放 |
| `POST` | `/api/refresh` | 重新解析当前曲目 |
| `POST` | `/api/candidate` | 应用某个指定的搜索结果 |
| `POST` | `/api/manual` | 应用粘贴进来的 LRC |
| `POST` / `PUT` | `/api/offset` | 微调 / 设置歌词偏移 |
| `DELETE` | `/api/overrides` | 忘掉记住的匹配 |
| `POST` | `/api/probe` | 搜索任意曲目（不改变正在播放的内容） |
| `GET` | `/api/lrc` | 把当前歌词下载成 `.lrc` |
| `GET` / `POST` | `/api/autostart` | 读取 / 修改随 Windows 启动的注册 |
| `GET` | `/api/update` | 最新的 GitHub release 与运行中的版本（`?force=1` 绕过缓存） |
| `GET` | `/api/log` | 后台服务日志的末尾 |
| `POST` | `/api/shutdown` | 停掉服务（`--quit` 和托盘用的就是它） |
| `WS` | `/ws?role=overlay\|control` | 实时状态推送 |

### 页面

| 路径 | 是什么 |
|---|---|
| `/overlay` | 歌词层。透明；OBS 源的尺寸设成 1200 × 300 |
| `/nowplaying` | 正在播放浮层：封面、标题、歌手、进度。透明；尺寸约 600 × 140 |
| `/control` | 控制面板 |

正在播放浮层接受 URL 覆盖参数，所以一个浏览器源就能单独调整，不必去改配置：`?cover=0`、`?title=1`、`?artist=1`、`?progress=0`、`?times=0`、`?paused=0`、`?hideWhenIdle=0`、`?width=640`、`?fontSize=24`、`?textAlign=center`、`?borderRadius=12`、`?colorTitle=%23ffffff`、`?colorArtist=`、`?colorProgress=`、`?colorAccent=%234cc2ff`，以及 `?debug=1`。

---

## 系统要求

**要用现成的发布版 —— 只要有 Windows。**

- **Windows 10/11** —— SMTC 是 Windows 的功能，托盘图标和自动启动则用到 Windows PowerShell 5.1 和 WinForms，这两样 Windows 都自带
- **OBS Studio**，用来放歌词层（任何支持浏览器源的版本都行）

SMTC 桥接是 Chorus 自带并启动的，所以没有第二个程序。

**要从源码运行或构建：**

- **Node.js 22+** —— 在 Node 22 上开发并验证。只有你要跑 `node src/index.js` 或者自己构建可执行文件时才需要它
- **Python 3 + Pillow** —— 只用来重新生成 logo（`npm run logo`）
- **`npm install`** —— 只用于构建阶段：`postject`（把应用塞进 `.exe`）和 `innosetup-compiler`（打安装包）。应用本身**运行时零依赖**，安装程序既不需要、也不会安装 Node.js

---

## 说明与限制

### 不报告时间轴的播放器

播放器可以把一首歌发布给 Windows，却**不带**曲目长度或播放位置。有些播放器默认就这么干。

症状很典型，值得记住：**歌词搜到了，但永远不滚**，因为位置一直停在 `0:00`。

> [!NOTE]
> Chorus 能识别这种情况，会显示一个橙色的 `no timeline` 标签并附上解释，免得看起来像是歌词出了问题。

**怎么办：** 要是播放器自己的设置里有「系统媒体控制」 / 「SMTC」这类选项，就打开它，然后重启播放器。有些播放器只暴露元数据、不暴露时间轴，那就真的没辙了 —— 位置压根没被发布出来。

Windows 本身只以大约一秒的粒度提供位置，所以即便播放器很配合，同步也只能做到按行准确，做不到按帧准确。

### 其他限制

- 只有会发布 Windows 媒体会话的来源才看得见。如果某个播放器把 SMTC 藏了起来，去它自己的设置里打开「系统媒体控制」。
- 有些播放器得先处于*播放中*，Windows 才会报告它的会话。
- 歌词层是纯文本 —— 没有逐字高亮，因为四个来源里没有一个能为任意曲目给出可靠的逐字时间。
- 翻译只来自网易云和 QQ。LRCLIB 和酷狗返回的是原文歌词。
- 官方流媒体 API 是刻意不用的 —— 它们要按用户做 OAuth，而元数据 Windows 已经给我们了。
- 查歌词只用曲名和歌手，走公开接口。关于你这台机器的其他任何东西都不会离开这台机器。

---

## 致谢

站在三个项目的肩膀上：

- [**smtc-bridge**](https://github.com/nuttylmao/smtc-bridge)，作者 nutty —— 把 Windows 媒体会话变成一个 REST API。Chorus 现在自带桥接了，但它所讲的这套 API、以及数据的形状，都来自这个项目的设计。官方桥接依然被完整支持，已经在跑的话会被自动接管。
- [**tosu-lyrics**](https://github.com/HollisMeynell/tosu-lyrics)，作者 HollisMeynell —— 三行歌词轮播和它的时间模型
- [**AF-Media-Bar**](https://github.com/Fervent-Tempo/AF-Media-Bar)，作者 Fervent-Tempo —— 多来源歌词搜索、候选打分，以及控制面板的视觉风格

---

## 参与贡献

欢迎提 bug 和 pull request —— 动手改什么之前，先看看 [CONTRIBUTING.md](CONTRIBUTING.md)，里面有代码结构、测试套件，还有几个值得提前知道的坑。

---

## 许可证

[MIT](LICENSE)

