/**
 * Automated checks for the pieces that are easy to get subtly wrong:
 * LRC parsing, artist splitting, scoring, session selection and lyric matching.
 *
 *   node test/run.js
 *   node test/run.js --offline   skip anything that touches the network
 *
 * Offline tests always run. Network tests need the internet (they search the
 * real providers) and are reported separately so a sandboxed run is still useful.
 */

import { parseLrc, mergeLyrics, buildLyricDoc, activeIndexAt, isInstrumentalText, toLrcText } from '../src/core/lrc.js';
import {
  splitArtists,
  artistSimilarity,
  diceSimilarity,
  durationScore,
  normalizeForMatch,
  titleForSearch,
  formatDuration,
} from '../src/core/utils.js';
import { scoreCandidate, isCandidateAcceptable, createRegistry, resolveLyrics, providerLabel } from '../src/core/match.js';
import { selectSession, BridgeClient, PlaybackStatus, looksLikeStreamTitle } from '../src/core/bridge.js';
import { PROVIDERS, plainToEstimatedLrc } from '../src/providers/index.js';
import { compareVersions, parseVersion } from '../src/core/update.js';

const OFFLINE_ONLY = process.argv.includes('--offline');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/* ------------------------------------------------------------------ *
 * LRC parsing
 * ------------------------------------------------------------------ */

section('LRC parsing');

{
  const doc = parseLrc('[00:12.34]Hello\n[01:05.50]World\n');
  check('parses mm:ss.xx into milliseconds', doc.lines[0].timeMs === 12340 && doc.lines[1].timeMs === 65500, JSON.stringify(doc.lines));
}
{
  const doc = parseLrc('[00:01.5]Tenths\n[00:02.123]Millis\n');
  check('handles 1-digit fraction as tenths', doc.lines[0].timeMs === 1500, String(doc.lines[0]?.timeMs));
  check('handles 3-digit fraction as millis', doc.lines[1].timeMs === 2123, String(doc.lines[1]?.timeMs));
}
{
  const doc = parseLrc('[ar:Artist Name]\n[offset:+500]\n[00:10.00]Text\n');
  check('reads metadata tags', doc.meta.ar === 'Artist Name');
  check('applies the offset header', doc.offsetMs === 500 && doc.lines[0].timeMs === 9500, JSON.stringify(doc.lines));
}
{
  const doc = parseLrc('[00:01.00][00:05.00]Repeated\n');
  check('expands multiple timestamps on one line', doc.lines.length === 2 && doc.lines[1].timeMs === 5000, JSON.stringify(doc.lines));
}
{
  const doc = parseLrc('[00:01.00]<00:01.50>Word<00:02.00> timed\n');
  check('strips enhanced-LRC word tags', doc.lines.length === 1 && doc.lines[0].text === 'Word timed', JSON.stringify(doc.lines));
}
{
  const doc = parseLrc('[00:01.00]CRLF line\r\n[00:02.00]Next\r\n');
  check('handles CRLF input', doc.lines.length === 2 && doc.lines[1].text === 'Next', JSON.stringify(doc.lines));
}
{
  check('detects the "no lyrics" sentinel', isInstrumentalText('此歌曲为没有填词的纯音乐') === true);
  check('does not treat real text as instrumental', isInstrumentalText('故事的小黄花') === false);
}
{
  const merged = mergeLyrics('[00:10.00]Original\n[00:20.00]Second\n', '[00:10.05]译一\n[00:20.00]译二\n');
  check('merges translation by nearest timestamp', merged[0].translation === '译一' && merged[1].translation === '译二', JSON.stringify(merged));
}
{
  const merged = mergeLyrics('[00:10.00]Original\n', '[00:10.00]第一行\n[00:12.00]第二行\n');
  check('unmatched translation lines survive as their own lines', merged.length === 2, JSON.stringify(merged.map((l) => l.text)));
}
{
  const merged = mergeLyrics('[00:00.00] 作词 : Someone\n[00:10.00]Real lyric\n');
  check('drops credit lines', merged.length === 1 && merged[0].text === 'Real lyric', JSON.stringify(merged.map((l) => l.text)));
}
{
  const doc = buildLyricDoc(
    [
      { timeMs: 1000, text: 'A', translation: null },
      { timeMs: 3000, text: 'B', translation: null },
    ],
    10000,
  );
  check('computes end times from the next line', doc[0].endMs === 3000, JSON.stringify(doc));
  check('caps the last line at the track length', doc[1].endMs === 10000, JSON.stringify(doc));
}
{
  const doc = buildLyricDoc([{ timeMs: 0, text: 'A', translation: null }, { timeMs: 30000, text: 'B', translation: null }], 40000);
  check('caps an instrumental gap at 8 s', doc[0].endMs === 8000, String(doc[0].endMs));
}
{
  const lines = [
    { timeMs: 1000, text: 'A' },
    { timeMs: 2000, text: 'B' },
    { timeMs: 3000, text: 'C' },
  ];
  check('activeIndexAt is -1 before the first line', activeIndexAt(lines, 500) === -1);
  check('activeIndexAt picks the last line at or before the position', activeIndexAt(lines, 2500) === 1);
  check('activeIndexAt respects a positive offset', activeIndexAt(lines, 500, 600) === 0);
  check('activeIndexAt handles the exact boundary', activeIndexAt(lines, 2000) === 1);
}
{
  const text = toLrcText([{ timeMs: 12340, text: 'Hello', translation: 'Bonjour' }], { translation: true });
  check('serialises back to valid LRC', text.includes('[00:12.34]Hello') && text.includes('[00:12.34]Bonjour'), text.replace(/\n/g, '\\n'));
}

/* ------------------------------------------------------------------ *
 * Text handling
 * ------------------------------------------------------------------ */

section('Text handling');

{
  const artists = splitArtists('ゆな from STAR☆ANIS');
  check('keeps a single artist intact', artists.length === 1, JSON.stringify(artists));
}
{
  check('splits on semicolons', splitArtists('A; B; C').length === 3, JSON.stringify(splitArtists('A; B; C')));
  check('splits on " & "', splitArtists('Simon & Garfunkel').length === 2, JSON.stringify(splitArtists('Simon & Garfunkel')));
  check('strips YouTube "- Topic"', splitArtists('Some Artist - Topic')[0] === 'Some Artist', JSON.stringify(splitArtists('Some Artist - Topic')));
  check('splits on ideographic comma', splitArtists('わか・ふうり・ゆな').length === 3, JSON.stringify(splitArtists('わか・ふうり・ゆな')));
  check('returns nothing for "Unknown"', splitArtists('Unknown').length === 0);

  /**
   * foobar2000 joins artists with a bare "&" — no surrounding spaces. Not
   * splitting it left the artist score around 0.72, which capped every candidate
   * below the accept threshold so nothing was ever shown.
   */
  const band = 'キュアアイドル(CV：松岡美里)&キュアウインク(CV：髙橋ミナミ)&キュアキュンキュン(CV：高森奈津美)';
  const split = splitArtists(band);
  check('splits a bare "&" with no spaces (foobar2000)', split.length === 3, JSON.stringify(split));
  check('the split yields usable individual names', split[0] === 'キュアアイドル(CV：松岡美里)', split[0]);
  check(
    'splitting raises the artist match for a bare "&"',
    artistSimilarity(split[0], split) >= 0.99,
    String(artistSimilarity(split[0], split)),
  );
  check('splits a bare "+" style pair on "x"', splitArtists('A x B').length === 2, JSON.stringify(splitArtists('A x B')));
  check('does not mangle a single artist with no separator', splitArtists('Radiohead').length === 1);
}
{
  check('normalises punctuation and case', normalizeForMatch('Hello, World!') === 'hello world', normalizeForMatch('Hello, World!'));
  check('drops bracketed asides', normalizeForMatch('Song (Live)') === 'song', normalizeForMatch('Song (Live)'));
  check('preserves CJK', normalizeForMatch('晴天 (Live)') === '晴天', normalizeForMatch('晴天 (Live)'));
  check('identical strings score 1', diceSimilarity('Creep', 'creep') === 1);
  check('unrelated strings score low', diceSimilarity('Creep', '晴天') < 0.2, String(diceSimilarity('Creep', '晴天')));
  check('CJK near-matches score high', diceSimilarity('晴天', '晴天 (Live)') > 0.9, String(diceSimilarity('晴天', '晴天 (Live)')));
}
{
  check('artist similarity finds an exact member', artistSimilarity('ゆな from STAR☆ANIS', ['ゆな from STAR☆ANIS']) === 1);
  check('artist similarity handles a list member', artistSimilarity('周杰伦 / 方文山', ['周杰伦']) >= 0.9, String(artistSimilarity('周杰伦 / 方文山', ['周杰伦'])));
  check('artist similarity rejects a stranger', artistSimilarity('Someone Else', ['Radiohead']) < 0.5);
}
{
  check('duration within tolerance scores high', durationScore(219000, 219500) > 0.9, String(durationScore(219000, 219500)));
  check('duration far off scores near zero', durationScore(219000, 300000) < 0.1, String(durationScore(219000, 300000)));
  check('unknown duration is neutral', durationScore(0, 219000) === 0.5);
}
{
  check('titleForSearch strips "(Official Video)"', titleForSearch('Song (Official Video)') === 'Song', titleForSearch('Song (Official Video)'));
  check('titleForSearch keeps a real bracket', titleForSearch('Song (Live at Budokan)') === 'Song (Live at Budokan)', titleForSearch('Song (Live at Budokan)'));
  check('formatDuration renders m:ss', formatDuration(219000) === '3:39', formatDuration(219000));
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

section('Candidate scoring');

const SETTINGS = { durationToleranceMs: 8000, preferredProvider: 'lrclib', minScore: 40, acceptScore: 75 };
const TRACK = { title: '晴天', artist: '周杰伦', durationMs: 269000 };

{
  const perfect = scoreCandidate({ provider: 'qq', title: '晴天', artist: '周杰伦', durationMs: 269000 }, TRACK, SETTINGS);
  check('a perfect match scores above 90', perfect.total > 90, String(perfect.total));
}
{
  const cover = scoreCandidate({ provider: 'kugou', title: '晴天', artist: '晴天', durationMs: 210000 }, TRACK, SETTINGS);
  check('a wrong-artist, wrong-duration cover is rejected', isCandidateAcceptable({ ...cover, title: '晴天', artist: '晴天', durationMs: 210000, provider: 'kugou' }, TRACK, SETTINGS) === false, JSON.stringify(cover));
}
{
  const wrongSong = scoreCandidate({ provider: 'qq', title: 'ドラマチックガール', artist: '周杰伦', durationMs: 269000 }, TRACK, SETTINGS);
  check('a different title with the right artist is rejected', isCandidateAcceptable({ ...wrongSong, title: 'ドラマチックガール', artist: '周杰伦', durationMs: 269000 }, TRACK, SETTINGS) === false, JSON.stringify(wrongSong));
}
{
  const unknownDuration = scoreCandidate({ provider: 'lrclib', title: '晴天', artist: '周杰伦', durationMs: 0 }, TRACK, SETTINGS);
  check('an unknown candidate duration does not disqualify a match', unknownDuration.total > 80, String(unknownDuration.total));
}
{
  const tied = { title: '晴天', artist: '周杰伦', durationMs: 269000 };
  const lrclib = scoreCandidate({ ...tied, provider: 'lrclib' }, TRACK, SETTINGS);
  const kugou = scoreCandidate({ ...tied, provider: 'kugou' }, TRACK, SETTINGS);
  check('the preferred provider breaks a tie', lrclib.total > kugou.total, `${lrclib.total} vs ${kugou.total}`);
}
{
  check('providerLabel resolves known ids', providerLabel('netease') === 'NetEase Cloud Music', providerLabel('netease'));
}

/**
 * Karaoke / TV-size / cover entries routinely carry metadata identical to the
 * original, so they tie on score and used to win on provider order alone. The
 * guards must work for CJK too, where \b does not apply.
 */
section('Version demotion (original recording preferred)');

{
  const base = { provider: 'netease', artist: '周杰伦', album: '', durationMs: 269000 };
  const original = scoreCandidate({ ...base, title: '晴天' }, { title: '晴天', artist: '周杰伦', durationMs: 269000 }, SETTINGS);
  const karaoke = scoreCandidate({ ...base, title: '晴天 (カラオケ)' }, { title: '晴天', artist: '周杰伦', durationMs: 269000 }, SETTINGS);
  const tv = scoreCandidate({ ...base, title: '晴天 (TVサイズ)' }, { title: '晴天', artist: '周杰伦', durationMs: 269000 }, SETTINGS);
  const live = scoreCandidate({ ...base, title: '晴天 (Live)' }, { title: '晴天', artist: '周杰伦', durationMs: 269000 }, SETTINGS);

  // The scores before demotion are all close; the demotion is what separates them.
  check('a karaoke variant scores lower than the original', karaoke.total <= original.total, `${karaoke.total} vs ${original.total}`);
  check('a TV-size variant scores lower than the original', tv.total <= original.total, `${tv.total} vs ${original.total}`);
  check('a live variant scores no higher than the original', live.total <= original.total, `${live.total} vs ${original.total}`);
}

{
  // Ranking: the original must win even when the variant comes first from the
  // provider, which is exactly the real-world tie that caused the wrong pick.
  const makeProvider = (id, candidates) => ({
    id,
    label: id,
    async search() {
      return candidates;
    },
    async fetchLyrics(candidate) {
      return { rawLyric: `[00:01.00]${candidate.key}`, rawTranslation: null };
    },
  });
  const track = { title: 'キミとルララ', artist: 'A&B', durationMs: 0 };
  const registry = createRegistry([
    makeProvider('lrclib', [
      { key: 'karaoke-first', title: 'キミとルララ(オリジナル・カラオケ)', artist: 'A / B', album: '', durationMs: 278000 },
      { key: 'tv', title: 'キミとルララ(TVサイズ)', artist: 'A / B', album: '', durationMs: 90000 },
      { key: 'original', title: 'キミとルララ', artist: 'A / B', album: '', durationMs: 278000 },
    ]),
  ]);
  const result = await resolveLyrics(registry, track, {
    enabled: ['lrclib'],
    providerOrder: ['lrclib'],
    preferredProvider: 'lrclib',
    acceptScore: 75,
    minScore: 40,
    durationToleranceMs: 8000,
    searchTimeoutMs: 5000,
    collectAlternatives: true,
    fallback: { enabled: false, minScore: 85 },
  });
  check(
    'the original recording wins over a karaoke entry listed first',
    result.status === 'matched' && result.candidate?.key === 'original',
    `chose "${result.candidate?.key}" (score ${result.candidate?.score})`,
  );
}

/* ------------------------------------------------------------------ *
 * Session selection
 * ------------------------------------------------------------------ */

section('Session selection');

const playing = (appId, platformId, title, extra = {}) => ({
  appId,
  platformId,
  platformName: platformId,
  title,
  artist: 'Someone',
  album: '',
  playbackStatus: PlaybackStatus.PLAYING,
  playbackType: 1,
  durationMs: 200000,
  lastUpdatedAt: Date.now(),
  ...extra,
});

const CONFIG = { source: { primaryPlatform: 'spotify', maxTrackSeconds: 3600, strategy: 'auto' } };

{
  const sessions = [
    playing('chrome', 'browser', 'A live stream', { durationMs: 0 }),
    playing('Spotify.exe', 'spotify', 'Real Song'),
  ];
  const chosen = selectSession(sessions, CONFIG);
  check('the primary platform wins over a playing browser', chosen?.appId === 'Spotify.exe', chosen?.appId);
}
{
  const sessions = [
    playing('chrome', 'browser', 'A live stream'),
    playing('Spotify.exe', 'spotify', 'Paused Song', { playbackStatus: PlaybackStatus.PAUSED }),
  ];
  const chosen = selectSession(sessions, CONFIG);
  check('the primary platform wins even while paused', chosen?.appId === 'Spotify.exe', chosen?.appId);
}
{
  const sessions = [playing('Spotify.exe', 'spotify', '')];
  check('a session with no title is ignored', selectSession(sessions, CONFIG) === null);
}
{
  const sessions = [
    playing('chrome', 'browser', 'Live stream', { durationMs: 0 }),
    playing('other.exe', 'other', 'A real track'),
  ];
  const chosen = selectSession(sessions, CONFIG);
  check('a zero-duration playing stream is treated as implausible', chosen?.appId === 'other.exe', chosen?.appId);
}
{
  const sessions = [playing('chrome', 'browser', '🔴 LIVE https://twitch.tv/x !socials')];
  check('a URL/command-laden title is treated as a stream', selectSession(sessions, CONFIG) === null);
}
{
  const sessions = [playing('other.exe', 'other', 'A very long video', { durationMs: 4 * 3600 * 1000 })];
  check('an over-long track is rejected', selectSession(sessions, CONFIG) === null);
}
{
  const sessions = [playing('Spotify.exe', 'spotify', 'Song', { playbackStatus: PlaybackStatus.PAUSED })];
  check('a paused primary platform still wins when alone', selectSession(sessions, CONFIG)?.appId === 'Spotify.exe');
}

/**
 * Stream detection must not eat real song titles.
 *
 * This regressed once: the rule was a bare `[!！]\w{2,}`, so `!NVADE SHOW!` by
 * RAISE A SUILEN was discarded as if it were a Twitch chat-command title and the
 * overlay showed nothing — indistinguishable from a lyrics failure.
 */
section('Stream-title detection');

{
  const SONGS = [
    ['!NVADE SHOW!', 'the reported track'],
    ['BANG!', 'song with an exclamation mark'],
    ['Everybody Talks!', 'ordinary song'],
    ['アイカツ! ミュージックアワー', 'CJK song with an exclamation mark'],
    ['Wow! Amazing!', 'several exclamations, no commands'],
    ['P@ssword', 'an @ inside a word is not a handle'],
    ['!!!', 'punctuation only'],
    ['Some Video - YouTube', 'a normal browser title'],
  ];
  for (const [title, why] of SONGS) {
    check(`song title kept: ${why}`, looksLikeStreamTitle(title) === false, JSON.stringify(title));
  }

  const STREAMS = [
    ['🍤 NEW WEEK UPON US 🍤 YOU WILL HAVE SO MUCH FUN 🍤 !skinplace !h1 !discord !socials 🍤', 'the real Twitch tab'],
    ['Minecraft !drops', 'a command at the end'],
    ['Chill stream !discord !socials', 'command spam'],
    ['LIVE NOW - playing games', 'live vocabulary'],
    ['Watch live: finals', 'watch live'],
    ['🔴 LIVE 🔴 ranked grind', 'red-circle live banner'],
  ];
  for (const [title, why] of STREAMS) {
    check(`stream rejected: ${why}`, looksLikeStreamTitle(title) === true, JSON.stringify(title).slice(0, 60));
  }

  // End to end: the song must survive selection even with a stream playing.
  const sessions = [
    playing('chrome', 'browser', 'Some stream'),
    playing('Spotify.exe', 'spotify', '!NVADE SHOW!'),
  ];
  const chosen = selectSession(sessions, CONFIG);
  check(
    'a song with "!" in the title is still selected over a stream',
    chosen?.title === '!NVADE SHOW!',
    chosen?.title,
  );
}

/* ------------------------------------------------------------------ *
 * smtc-bridge payload handling
 * ------------------------------------------------------------------ */

section('smtc-bridge payload handling');

{
  const session = BridgeClient.normalizeSession({
    source_app_id: 'Spotify.exe',
    media_properties: { Title: 'T', Artist: 'A', AlbumTitle: 'Al', Thumbnail: 'data:image/jpeg;base64,AAA' },
    playback_info: { PlaybackStatus: 4, PlaybackType: 1, PlaybackRate: 1 },
    timeline_properties: { Position: 1000, StartTime: 0, EndTime: 219000, LastUpdatedTime: '2026-10-05 12:41:01.497622+00:00' },
  });
  check('normalises a session', session.title === 'T' && session.artist === 'A');
  check('computes duration from Start/End', session.durationMs === 219000, String(session.durationMs));
  check('resolves the platform from the AUMID', session.platformId === 'spotify', session.platformId);
  check('parses LastUpdatedTime into a timestamp', Number.isFinite(session.lastUpdatedAt), String(session.lastUpdatedAt));
}
{
  const session = BridgeClient.normalizeSession({ source_app_id: 'unknown.app', media_properties: {}, playback_info: {}, timeline_properties: {} });
  check('tolerates a completely empty session', session.title === '' && session.durationMs === 0 && session.platformId === null);
}
{
  const { platformForAppId } = await import('../src/config.js');
  check('matches Spotify by AUMID', platformForAppId('Spotify.exe')?.id === 'spotify');
  check('matches a packaged Apple Music AUMID', platformForAppId('AppleInc.AppleMusicWin_nzyj5cx40ttqa!App')?.id === 'apple-music', String(platformForAppId('AppleInc.AppleMusicWin_nzyj5cx40qa!App')?.id));
  check('prefers YouTube Music over YouTube', platformForAppId('YouTube Music.exe')?.id === 'youtube-music', String(platformForAppId('YouTube Music.exe')?.id));
  check('matches NetEase', platformForAppId('cloudmusic.exe')?.id === 'netease');
  check('returns null for an unknown app', platformForAppId('NotARealPlayer.exe') === null);
}

/* ------------------------------------------------------------------ *
 * Fallback when the main source has no lyrics
 * ------------------------------------------------------------------ */

section('Fallback when the main source has no lyrics');

{
  // A fake registry so the fallback policy can be tested with no network, and so
  // a chosen source can be made to return an empty lyric body on demand.
  const makeProvider = (id, candidates, { empty = false } = {}) => ({
    id,
    label: id,
    async search() {
      return candidates;
    },
    async fetchLyrics(candidate) {
      if (empty && candidate.key === 'empty') return { rawLyric: '', rawTranslation: null };
      return { rawLyric: `[00:01.00]${id} line for ${candidate.key}`, rawTranslation: null };
    },
  });

  const TRACK = { title: '晴天', artist: '周杰伦', durationMs: 269000 };
  const baseSettings = {
    enabled: ['lrclib', 'netease'],
    providerOrder: ['lrclib', 'netease'],
    preferredProvider: 'lrclib',
    acceptScore: 75,
    minScore: 40,
    durationToleranceMs: 8000,
    searchTimeoutMs: 5000,
    collectAlternatives: true,
    fallback: { enabled: false, minScore: 85 },
  };

  const perfectNetease = [{ key: 'n1', title: '晴天', artist: '周杰伦', album: '', durationMs: 269000 }];
  const emptyLrclib = [{ key: 'empty', title: '晴天', artist: '周杰伦', album: '', durationMs: 269000 }];
  const build = () =>
    createRegistry([
      makeProvider('lrclib', emptyLrclib, { empty: true }),
      makeProvider('netease', perfectNetease),
    ]);

  {
    const result = await resolveLyrics(build(), TRACK, baseSettings);
    // Without the option, a lyric-less main source must not silently hand over.
    check(
      'disabled: does not borrow from another source',
      result.status !== 'matched' || result.candidate?.provider === 'lrclib',
      `status=${result.status} provider=${result.candidate?.provider}`,
    );
  }

  {
    const result = await resolveLyrics(build(), TRACK, {
      ...baseSettings,
      fallback: { enabled: true, minScore: 85 },
    });
    check(
      'enabled: uses the best other source when the main one has no lyrics',
      result.status === 'matched' && result.candidate?.provider === 'netease',
      `status=${result.status} provider=${result.candidate?.provider}`,
    );
    check('enabled: flags the result as a fallback', result.viaFallback === true, String(result.viaFallback));
    check('enabled: the fallback carried real lyrics', String(result.candidate?.rawLyric).includes('netease'));
  }

  {
    // The only other-source candidate is a poor match, below the 85 threshold.
    const registry = createRegistry([
      makeProvider('lrclib', emptyLrclib, { empty: true }),
      makeProvider('netease', [{ key: 'w1', title: '晴天 (Live)', artist: 'Some Cover Band', album: '', durationMs: 200000 }]),
    ]);
    const result = await resolveLyrics(registry, TRACK, {
      ...baseSettings,
      fallback: { enabled: true, minScore: 85 },
    });
    check(
      'below threshold: stays blank instead of showing a weak match',
      result.status === 'notfound' && result.candidate === null,
      `status=${result.status} provider=${result.candidate?.provider}`,
    );
    check('below threshold: blank until the next track', result.blankUntilNextTrack === true, String(result.blankUntilNextTrack));
    check(
      'below threshold: explains why',
      typeof result.fallbackReason === 'string' && result.fallbackReason.length > 0,
      result.fallbackReason,
    );
  }

  {
    // A near-perfect match still has to clear the threshold: at 90 it is used,
    // at 99 it is rejected.
    const registry = createRegistry([
      makeProvider('lrclib', emptyLrclib, { empty: true }),
      makeProvider('netease', perfectNetease),
    ]);
    const at90 = await resolveLyrics(registry, TRACK, { ...baseSettings, fallback: { enabled: true, minScore: 90 } });
    check(
      'threshold 90 accepts a near-perfect fallback',
      at90.status === 'matched' && at90.candidate?.provider === 'netease',
      `status=${at90.status} provider=${at90.candidate?.provider}`,
    );

    const registry2 = createRegistry([
      makeProvider('lrclib', emptyLrclib, { empty: true }),
      makeProvider('netease', perfectNetease),
    ]);
    const at99 = await resolveLyrics(registry2, TRACK, { ...baseSettings, fallback: { enabled: true, minScore: 99 } });
    check(
      'threshold 99 rejects the same fallback',
      at99.status === 'notfound' && at99.blankUntilNextTrack === true,
      `status=${at99.status} score=${at99.topCandidateScore}`,
    );
  }

  {
    // Every source is lyric-less: nothing to fall back to.
    const registry = createRegistry([
      makeProvider('lrclib', emptyLrclib, { empty: true }),
      makeProvider('netease', [{ key: 'empty', title: '晴天', artist: '周杰伦', album: '', durationMs: 269000 }], { empty: true }),
    ]);
    const result = await resolveLyrics(registry, TRACK, {
      ...baseSettings,
      fallback: { enabled: true, minScore: 85 },
    });
    check(
      'enabled but every source is lyric-less: stays blank',
      result.status === 'notfound' && result.candidate === null,
      `status=${result.status} provider=${result.candidate?.provider}`,
    );
  }

  {
    // The main source works: the option must not change the outcome.
    const registry = createRegistry([
      makeProvider('lrclib', [{ key: 'g1', title: '晴天', artist: '周杰伦', album: '', durationMs: 269000 }]),
      makeProvider('netease', perfectNetease),
    ]);
    const result = await resolveLyrics(registry, TRACK, {
      ...baseSettings,
      fallback: { enabled: true, minScore: 85 },
    });
    check(
      'when the main source works, it is still used',
      result.status === 'matched' && result.candidate?.provider === 'lrclib' && !result.viaFallback,
      `status=${result.status} provider=${result.candidate?.provider} viaFallback=${result.viaFallback}`,
    );
  }

  {
    // A fallback must still respect the title gate: a different song cannot be
    // introduced merely because it is the best of a bad bunch.
    const registry = createRegistry([
      makeProvider('lrclib', emptyLrclib, { empty: true }),
      makeProvider('netease', [{ key: 'x1', title: 'ドラマチックガール', artist: '周杰伦', album: '', durationMs: 269000 }]),
    ]);
    const result = await resolveLyrics(registry, TRACK, {
      ...baseSettings,
      fallback: { enabled: true, minScore: 50 },
    });
    check(
      'a different song is never accepted as a fallback',
      result.status === 'notfound',
      `status=${result.status} provider=${result.candidate?.provider} title=${result.candidate?.title}`,
    );
  }

  {
    // The best result must win on SCORE, not on which provider happens to sit
    // earlier in the order. Both are eligible, but qq scores higher.
    const registry = createRegistry([
      makeProvider('lrclib', emptyLrclib, { empty: true }),
      makeProvider('netease', [{ key: 'ne-live', title: '晴天 (Live)', artist: '周杰伦', album: '', durationMs: 249000 }]),
      makeProvider('qq', [{ key: 'qq-studio', title: '晴天', artist: '周杰伦', album: '', durationMs: 269000 }]),
    ]);
    const result = await resolveLyrics(registry, TRACK, {
      ...baseSettings,
      enabled: ['lrclib', 'netease', 'qq'],
      providerOrder: ['lrclib', 'netease', 'qq'],
      fallback: { enabled: true, minScore: 80 },
    });
    check(
      'the highest-scoring fallback wins, not the earliest provider',
      result.status === 'matched' && result.candidate?.key === 'qq-studio',
      `chose ${result.candidate?.provider}/${result.candidate?.key} (score ${result.candidate?.score})`,
    );
  }

  {
    // A main-source result that genuinely scores highest must still win.
    const registry = createRegistry([
      makeProvider('lrclib', [{ key: 'main-ok', title: '晴天', artist: '周杰伦', album: '', durationMs: 269000 }]),
      makeProvider('qq', [{ key: 'qq-worse', title: '晴天', artist: '晴天', album: '', durationMs: 210000 }]),
    ]);
    const result = await resolveLyrics(registry, TRACK, {
      ...baseSettings,
      enabled: ['lrclib', 'qq'],
      providerOrder: ['lrclib', 'qq'],
      fallback: { enabled: true, minScore: 50 },
    });
    check(
      'the highest-scoring candidate wins even without borrowing',
      result.status === 'matched' && result.candidate?.provider === 'lrclib' && !result.viaFallback,
      `chose ${result.candidate?.provider}/${result.candidate?.key} viaFallback=${result.viaFallback}`,
    );
  }

  {
    /**
     * The regression from a real report: a 97-scoring LRCLIB entry lost to a
     * 63-scoring NetEase cover, purely because NetEase was the preferred source
     * and preferred candidates used to be tried first regardless of score.
     */
    const registry = createRegistry([
      makeProvider('netease', [{ key: 'ne-cover', title: '晴天 (Cover)', artist: '笹鎌里須子', album: 'Evergreen', durationMs: 269000 }]),
      makeProvider('lrclib', [
        { key: 'lr-original-a', title: '晴天', artist: '周杰伦', album: 'Album A', durationMs: 269000 },
        { key: 'lr-original-b', title: '晴天', artist: '周杰伦', album: 'Album B', durationMs: 269500 },
      ]),
    ]);
    const result = await resolveLyrics(registry, TRACK, {
      ...baseSettings,
      preferredProvider: 'netease',
      enabled: ['netease', 'lrclib'],
      providerOrder: ['netease', 'lrclib'],
      fallback: { enabled: false, minScore: 85 },
    });
    check(
      'a high-scoring other source beats a low-scoring preferred source',
      result.status === 'matched' && result.candidate?.provider === 'lrclib',
      `chose ${result.candidate?.provider}/${result.candidate?.key} (score ${result.candidate?.score})`,
    );
    check(
      'the winner is the top-scoring candidate of all of them',
      result.candidate?.score >= 90,
      String(result.candidate?.score),
    );
    check(
      'it is not treated as borrowing, because the preferred source was simply outscored',
      result.viaFallback === false,
      String(result.viaFallback),
    );
  }

  {
    // Score ties fall to the preferred provider.
    const registry = createRegistry([
      makeProvider('netease', [{ key: 'ne', title: '晴天', artist: '周杰伦', album: '', durationMs: 269000 }]),
      makeProvider('lrclib', [{ key: 'lr', title: '晴天', artist: '周杰伦', album: '', durationMs: 269000 }]),
    ]);
    const result = await resolveLyrics(registry, TRACK, {
      ...baseSettings,
      preferredProvider: 'netease',
      enabled: ['netease', 'lrclib'],
      providerOrder: ['netease', 'lrclib'],
      fallback: { enabled: false, minScore: 85 },
    });
    check(
      'on an exact score tie the preferred provider wins',
      result.candidate?.provider === 'netease',
      `chose ${result.candidate?.provider} (score ${result.candidate?.score})`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Untimed (plain) lyrics
 * ------------------------------------------------------------------ */

section('Plain lyrics converted to estimated timings');

{
  // LRCLIB often stores `syncedLyrics: null` with `plainLyrics` present.
  // Discarding that threw away the best match.
  const plain = 'First line here\nSecond line here\nThird line here';
  const lrc = plainToEstimatedLrc(plain, 240000);

  check('produces timed LRC output', /^\[\d{2}:\d{2}\.\d{2}\]/m.test(lrc), lrc.split('\n')[0]);
  check('keeps every line', (lrc.match(/^\[\d{2}:\d{2}\.\d{2}\]/gm) ?? []).length === 3, lrc.replace(/\n/g, ' | '));
  check('keeps the words intact', lrc.includes('First line here') && lrc.includes('Third line here'));

  const { lines: parsed } = parseLrc(lrc);
  check('the result re-parses into 3 lines', parsed.length === 3, String(parsed.length));
  check(
    'timings are ordered and inside the track',
    parsed.every((l, i) => (i === 0 || l.timeMs >= parsed[i - 1].timeMs) && l.timeMs < 240000),
    JSON.stringify(parsed.map((l) => l.timeMs)),
  );
  check('the first line does not start at zero (lead-in)', parsed[0].timeMs > 0, String(parsed[0].timeMs));
}

{
  check('empty input yields empty output', plainToEstimatedLrc('', 200000) === '');
  check('blank lines are dropped', (plainToEstimatedLrc('a\n\n\nb', 200000).match(/\]/g) ?? []).length === 2);
  // An unknown duration still has to produce usable timings rather than NaN.
  const noDuration = plainToEstimatedLrc('one\ntwo', 0);
  check('an unknown duration still yields valid timings', /\[\d{2}:\d{2}\.\d{2}\]/.test(noDuration) && !noDuration.includes('NaN'), noDuration.replace(/\n/g, ' | '));
}

{
  /**
   * The real failure: a 97-scoring match with only plain lyrics was skipped
   * entirely, so a 63-scoring timed match won. Plain lyrics must be usable, and a
   * materially higher score must still win.
   */
  const makeProvider = (id, candidates, body) => ({
    id,
    label: id,
    async search() {
      return candidates;
    },
    async fetchLyrics(candidate) {
      return body(candidate);
    },
  });
  const registry = createRegistry([
    makeProvider('netease', [{ key: 'timed-cover', title: 'Moonlight destiny', artist: 'Cover Band', album: '', durationMs: 269000 }], () => ({
      rawLyric: '[00:01.00]a\n[00:02.00]b\n[00:03.00]c',
      rawTranslation: null,
      hasSync: true,
    })),
    makeProvider('lrclib', [{ key: 'plain-original', title: 'Moonlight destiny', artist: '周杰伦', album: '', durationMs: 269000 }], (candidate) => ({
      // Untimed text, exactly as LRCLIB returns it.
      rawLyric: plainToEstimatedLrc('uno\ndos\ntres\ncuatro', 269000),
      rawTranslation: null,
      hasSync: false,
      estimated: true,
    })),
  ]);
  const track = { title: 'Moonlight destiny', artist: '周杰伦', durationMs: 269000 };
  const result = await resolveLyrics(registry, track, {
    enabled: ['netease', 'lrclib'],
    providerOrder: ['netease', 'lrclib'],
    preferredProvider: 'netease',
    acceptScore: 75,
    minScore: 40,
    durationToleranceMs: 8000,
    searchTimeoutMs: 5000,
    collectAlternatives: true,
    fallback: { enabled: false, minScore: 85 },
  });
  check(
    'the far better match wins even though its lyrics are untimed',
    result.status === 'matched' && result.candidate?.key === 'plain-original',
    `chose ${result.candidate?.key} (score ${result.candidate?.score})`,
  );
  check('the result is flagged as estimated', result.estimated === true, String(result.estimated));
  check(
    'the untimed text became usable lines',
    mergeLyrics(result.candidate.rawLyric, null).length === 4,
    String(mergeLyrics(result.candidate.rawLyric, null).length),
  );
}

/* ------------------------------------------------------------------ *
 * Network: real provider lookups
 * ------------------------------------------------------------------ */

if (!OFFLINE_ONLY) {
  section('Live provider lookups (network)');

  const registry = createRegistry(PROVIDERS);
  const liveSettings = {
    enabled: ['lrclib', 'netease', 'qq', 'kugou'],
    providerOrder: ['lrclib', 'netease', 'qq', 'kugou'],
    preferredProvider: 'lrclib',
    acceptScore: 75,
    minScore: 40,
    durationToleranceMs: 8000,
    searchTimeoutMs: 15000,
    collectAlternatives: true,
  };

  const CASES = [
    { label: 'CJK / Japanese (NetEase territory)', track: { title: 'マジックスマイル', artist: 'ゆな from STAR☆ANIS', durationMs: 219000 }, expectLines: true },
    { label: 'Western (LRCLIB territory)', track: { title: 'Creep', artist: 'Radiohead', durationMs: 238000 }, expectLines: true },
    { label: 'CJK / Chinese', track: { title: '晴天', artist: '周杰伦', durationMs: 269000 }, expectLines: true },
    { label: 'Obscure title that should not match', track: { title: 'zzzqqq nonexistent track 12345', artist: 'nobody at all', durationMs: 100000 }, expectLines: false },
  ];

  for (const testCase of CASES) {
    try {
      const result = await resolveLyrics(registry, testCase.track, liveSettings);
      const lines = result.candidate
        ? buildLyricDoc(mergeLyrics(result.candidate.rawLyric, result.candidate.rawTranslation), testCase.track.durationMs)
        : [];
      if (testCase.expectLines) {
        check(
          `${testCase.label}: found lyrics`,
          result.status === 'matched' && lines.length > 3,
          `status=${result.status} lines=${lines.length} errors=${result.errors.join('; ') || 'none'}`,
        );
        if (lines.length > 0) {
          check(
            `${testCase.label}: lines are time-ordered`,
            lines.every((l, i) => i === 0 || l.timeMs >= lines[i - 1].timeMs),
          );
          check(`${testCase.label}: first line starts within the track`, lines[0].timeMs < testCase.track.durationMs);
        }
        if (result.candidate) {
          check(
            `${testCase.label}: winning score is credible`,
            result.candidate.score >= 60,
            `score=${result.candidate.score} (${result.candidate.title} — ${result.candidate.artist})`,
          );
        }
      } else {
        check(`${testCase.label}: correctly reports no lyrics`, result.status !== 'matched' || lines.length === 0, `status=${result.status} lines=${lines.length}`);
      }
    } catch (err) {
      check(`${testCase.label}: lookup did not throw`, false, err.message);
    }
  }

  // A per-provider smoke test: each must return usable results for a track it owns.
  section('Per-provider smoke tests (network)');
  const SMOKE = [
    { provider: 'lrclib', track: { title: 'Creep', artist: 'Radiohead', durationMs: 238000 } },
    { provider: 'netease', track: { title: '晴天', artist: '周杰伦', durationMs: 269000 } },
    { provider: 'qq', track: { title: '晴天', artist: '周杰伦', durationMs: 269000 } },
    { provider: 'kugou', track: { title: '晴天', artist: '周杰伦', durationMs: 269000 } },
  ];
  for (const smoke of SMOKE) {
    const provider = registry.get(smoke.provider);
    try {
      const candidates = await provider.search(smoke.track, { searchTimeoutMs: 15000 });
      check(`${provider.label}: search returns candidates`, candidates.length > 0, `${candidates.length} candidates`);
      const best = candidates
        .map((c) => ({ c, s: scoreCandidate({ ...c, provider: provider.id }, smoke.track, liveSettings) }))
        .sort((a, b) => b.s.total - a.s.total)[0];
      if (best) {
        const body = await provider.fetchLyrics(best.c, smoke.track, liveSettings);
        const lines = mergeLyrics(body.rawLyric, body.rawTranslation);
        check(
          `${provider.label}: best candidate yields parsed lines`,
          lines.length > 0,
          `best="${best.c.title}" score=${best.s.total} lines=${lines.length}`,
        );
      }
    } catch (err) {
      check(`${provider.label}: search did not throw`, false, err.message);
    }
  }
} else {
  console.log('\n\u001b[33mSkipping live network tests (--offline)\u001b[0m');
}

/* ------------------------------------------------------------------ *
 * Update checking
 * ------------------------------------------------------------------ */

section('Update checking');

{
  // Version comparison decides whether an update is offered, so getting it wrong means
  // either missed updates or a permanent false "update available" prompt. GitHub release
  // tags carry a "v" prefix, which must not throw the comparison off.
  const cases = [
    ['1.2.0', '1.1.0', 1, 'newer minor'],
    ['1.1.0', '1.2.0', -1, 'older minor'],
    ['1.2.0', '1.2.0', 0, 'identical'],
    ['v1.3.0', '1.2.0', 1, 'v-prefixed tag'],
    ['1.2.0', 'v1.2.0', 0, 'prefix on either side'],
    ['1.2.1', '1.2.0', 1, 'patch bump'],
    ['1.10.0', '1.9.9', 1, 'numeric, not lexicographic'],
    ['2.0.0', '1.99.99', 1, 'major beats minor'],
    ['1.2.0-beta.1', '1.2.0', -1, 'pre-release is older than its release'],
    ['1.2.0', '1.2.0-beta.1', 1, 'release is newer than its pre-release'],
  ];

  for (const [a, b, want, label] of cases) {
    const got = compareVersions(a, b);
    check(`compare(${a}, ${b}) = ${want} (${label})`, got === want, `got ${got}`);
  }

  check('an unparseable version compares as equal', compareVersions('nonsense', '1.0.0') === 0);
  check('parseVersion splits a v-prefixed tag', JSON.stringify(parseVersion('v1.2.3')) === JSON.stringify({ major: 1, minor: 2, patch: 3, prerelease: null }));
  check('parseVersion rejects nonsense', parseVersion('not-a-version') === null);
  check('parseVersion reads a pre-release suffix', parseVersion('1.2.3-rc.1')?.prerelease === 'rc.1');
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) {
  console.log(`\u001b[32mAll ${passed} checks passed\u001b[0m`);
} else {
  console.log(`\u001b[31m${failed} failed\u001b[0m, ${passed} passed`);
  for (const failure of failures) console.log(`  \u001b[31m•\u001b[0m ${failure}`);
}
console.log(`${'─'.repeat(58)}\n`);
process.exit(failed === 0 ? 0 : 1);
