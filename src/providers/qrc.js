/**
 * QQ Music QRC lyrics: cipher plus the syllable syntax.
 *
 * QRC is neither LRC nor base64: the payload is a hex string, encrypted with a
 * 3DES variant whose key schedule differs from the standard one (des-ecb and
 * des-cbc are also unavailable in Node's OpenSSL build, so the cipher is
 * implemented here rather than delegated), then deflated. Ported from
 * WXRIW/QQMusicDecoder (Decrypter.cs + DESHelper.cs) and cross-checked against
 * L-1124/QQMusicApi's Python port on a live payload before being adopted.
 *
 * The plaintext is XML whose <Lyric_1 LyricContent="..."> attribute holds lines
 * shaped `[lineStart,lineDuration]chunk(offset,duration)chunk(offset,duration)`,
 * i.e. per-syllable timings relative to the line start — the karaoke timings the
 * overlay needs.
 */

const QQ_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'ascii');

const KEY_PERM_C = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35];

const KEY_PERM_D = [62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3];

const KEY_COMPRESSION = [13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1, 40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31];

const SBOX = [
  // box 0
  [
  14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
  0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
  4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
  15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  // box 1
  [
  15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
  3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
  0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
  13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  // box 2
  [
  10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
  13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
  13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
  1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  // box 3
  [
  7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
  13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
  10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
  3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  // box 4
  [
  2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
  14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
  4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
  11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  // box 5
  [
  12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
  10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
  9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
  4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  // box 6
  [
  4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
  13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
  1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
  6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  // box 7
  [
  13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
  1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
  7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
  2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

import zlib from 'node:zlib';



const SHIFT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

function sboxBit(a) {
  return ((a & 32) | ((a & 31) >>> 1) | ((a & 1) << 4)) & 0x3f;
}

function initialPermutation(bytes) {
  const v0 = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  const v1 = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  const bit = (value, shift) => ((value >>> shift) & 1) >>> 0;

  let s0 = 0;
  let s1 = 0;
  const put0 = [bit(v1, 6), bit(v1, 14), bit(v1, 22), bit(v1, 30), bit(v0, 6), bit(v0, 14), bit(v0, 22), bit(v0, 30),
    bit(v1, 4), bit(v1, 12), bit(v1, 20), bit(v1, 28), bit(v0, 4), bit(v0, 12), bit(v0, 20), bit(v0, 28),
    bit(v1, 2), bit(v1, 10), bit(v1, 18), bit(v1, 26), bit(v0, 2), bit(v0, 10), bit(v0, 18), bit(v0, 26),
    bit(v1, 0), bit(v1, 8), bit(v1, 16), bit(v1, 24), bit(v0, 0), bit(v0, 8), bit(v0, 16), bit(v0, 24)];
  const put1 = [bit(v1, 7), bit(v1, 15), bit(v1, 23), bit(v1, 31), bit(v0, 7), bit(v0, 15), bit(v0, 23), bit(v0, 31),
    bit(v1, 5), bit(v1, 13), bit(v1, 21), bit(v1, 29), bit(v0, 5), bit(v0, 13), bit(v0, 21), bit(v0, 29),
    bit(v1, 3), bit(v1, 11), bit(v1, 19), bit(v1, 27), bit(v0, 3), bit(v0, 11), bit(v0, 19), bit(v0, 27),
    bit(v1, 1), bit(v1, 9), bit(v1, 17), bit(v1, 25), bit(v0, 1), bit(v0, 9), bit(v0, 17), bit(v0, 25)];

  for (let i = 0; i < 32; i += 1) {
    s0 |= put0[i] << (31 - i);
    s1 |= put1[i] << (31 - i);
  }
  return [s0 >>> 0, s1 >>> 0];
}

function inversePermutation(s0, s1) {
  const data = Buffer.alloc(8);
  const bit = (value, shift) => ((value >>> shift) & 1) >>> 0;

  const pack = (pairs) => {
    let byte = 0;
    for (let i = 0; i < 8; i += 1) byte |= (pairs[i] & 1) << (7 - i);
    return byte;
  };

  data[3] = pack([bit(s1, 24), bit(s0, 24), bit(s1, 16), bit(s0, 16), bit(s1, 8), bit(s0, 8), bit(s1, 0), bit(s0, 0)]);
  data[2] = pack([bit(s1, 25), bit(s0, 25), bit(s1, 17), bit(s0, 17), bit(s1, 9), bit(s0, 9), bit(s1, 1), bit(s0, 1)]);
  data[1] = pack([bit(s1, 26), bit(s0, 26), bit(s1, 18), bit(s0, 18), bit(s1, 10), bit(s0, 10), bit(s1, 2), bit(s0, 2)]);
  data[0] = pack([bit(s1, 27), bit(s0, 27), bit(s1, 19), bit(s0, 19), bit(s1, 11), bit(s0, 11), bit(s1, 3), bit(s0, 3)]);
  data[7] = pack([bit(s1, 28), bit(s0, 28), bit(s1, 20), bit(s0, 20), bit(s1, 12), bit(s0, 12), bit(s1, 4), bit(s0, 4)]);
  data[6] = pack([bit(s1, 29), bit(s0, 29), bit(s1, 21), bit(s0, 21), bit(s1, 13), bit(s0, 13), bit(s1, 5), bit(s0, 5)]);
  data[5] = pack([bit(s1, 30), bit(s0, 30), bit(s1, 22), bit(s0, 22), bit(s1, 14), bit(s0, 14), bit(s1, 6), bit(s0, 6)]);
  data[4] = pack([bit(s1, 31), bit(s0, 31), bit(s1, 23), bit(s0, 23), bit(s1, 15), bit(s0, 15), bit(s1, 7), bit(s0, 7)]);
  return data;
}

function f(state, key) {
  const t1 = (((state & 1) << 31) | ((state & 0xf8000000) >>> 1) | ((state & 0x1f800000) >>> 3)
    | ((state & 0x01f80000) >>> 5) | ((state & 0x001f8000) >>> 7)) >>> 0;
  const t2 = (((state & 0x0001f800) << 15) | ((state & 0x00001f80) << 13) | ((state & 0x000001f8) << 11)
    | ((state & 0x0000001f) << 9) | ((state & 0x80000000) >>> 23)) >>> 0;

  const k0 = ((t1 >>> 24) & 0xff) ^ key[0];
  const k1 = ((t1 >>> 16) & 0xff) ^ key[1];
  const k2 = ((t1 >>> 8) & 0xff) ^ key[2];
  const k3 = ((t2 >>> 24) & 0xff) ^ key[3];
  const k4 = ((t2 >>> 16) & 0xff) ^ key[4];
  const k5 = ((t2 >>> 8) & 0xff) ^ key[5];

  const s = SBOX;
  const mixed = ((s[0][sboxBit(k0 >>> 2)] << 28)
    | (s[1][sboxBit(((k0 & 0x03) << 4) | (k1 >>> 4))] << 24)
    | (s[2][sboxBit(((k1 & 0x0f) << 2) | (k2 >>> 6))] << 20)
    | (s[3][sboxBit(k2 & 0x3f)] << 16)
    | (s[4][sboxBit(k3 >>> 2)] << 12)
    | (s[5][sboxBit(((k3 & 0x03) << 4) | (k4 >>> 4))] << 8)
    | (s[6][sboxBit(((k4 & 0x0f) << 2) | (k5 >>> 6))] << 4)
    | s[7][sboxBit(k5 & 0x3f)]) >>> 0;

  const order = [16, 25, 12, 11, 3, 20, 4, 15, 31, 17, 9, 6, 27, 14, 1, 22,
    30, 24, 8, 18, 0, 5, 29, 23, 13, 19, 2, 26, 10, 21, 28, 7];
  let out = 0;
  for (let i = 0; i < 32; i += 1) out |= ((mixed >>> order[i]) & 1) << (31 - i);
  return out >>> 0;
}

function crypt(block, schedule) {
  let [s0, s1] = initialPermutation(block);
  for (let round = 0; round < 15; round += 1) {
    const previous = s1;
    s1 = (f(s1, schedule[round]) ^ s0) >>> 0;
    s0 = previous;
  }
  s0 = (f(s1, schedule[15]) ^ s0) >>> 0;
  return inversePermutation(s0, s1);
}

function keySchedule(key, mode) {
  const schedule = Array.from({ length: 16 }, () => [0, 0, 0, 0, 0, 0]);
  const v0 = (key[0] | (key[1] << 8) | (key[2] << 16) | (key[3] << 24)) >>> 0;
  const v1 = (key[4] | (key[5] << 8) | (key[6] << 16) | (key[7] << 24)) >>> 0;
  const readBit = (b) => (b < 32 ? (v0 >>> (31 - b)) & 1 : (v1 >>> (63 - b)) & 1);

  let c = 0;
  KEY_PERM_C.forEach((b, i) => { c |= readBit(b) << (31 - i); });
  let d = 0;
  KEY_PERM_D.forEach((b, i) => { d |= readBit(b) << (31 - i); });
  c >>>= 0;
  d >>>= 0;

  for (let i = 0; i < 16; i += 1) {
    const shift = SHIFT[i];
    c = (((c << shift) | (c >>> (28 - shift))) & 0xfffffff0) >>> 0;
    d = (((d << shift) | (d >>> (28 - shift))) & 0xfffffff0) >>> 0;
    const target = mode === 1 ? i : 15 - i;
    schedule[target] = [0, 0, 0, 0, 0, 0];
    for (let j = 0; j < 24; j += 1) {
      const b = (c >>> (31 - KEY_COMPRESSION[j])) & 1;
      schedule[target][(j / 8) | 0] |= b << (7 - (j % 8));
    }
    for (let j = 24; j < 48; j += 1) {
      const b = (d >>> (31 - (KEY_COMPRESSION[j] - 27))) & 1;
      schedule[target][(j / 8) | 0] |= b << (7 - (j % 8));
    }
  }
  return schedule;
}

export function tripleDesSetup(key, mode) {
  if (mode === 1) {
    return [keySchedule(key.subarray(0, 8), 1), keySchedule(key.subarray(8, 16), 0), keySchedule(key.subarray(16, 24), 1)];
  }
  return [keySchedule(key.subarray(16, 24), 0), keySchedule(key.subarray(8, 16), 1), keySchedule(key.subarray(0, 8), 0)];
}

function tripleDesCrypt(block, keys) {
  let data = block;
  for (let i = 0; i < 3; i += 1) data = crypt(data, keys[i]);
  return data;
}

function inflate(bytes) {
  for (const attempt of [
    () => zlib.inflateSync(bytes),
    () => zlib.inflateRawSync(bytes),
    () => zlib.gunzipSync(bytes),
  ]) {
    try {
      return attempt();
    } catch {
      /* try the next wrapper */
    }
  }
  return null;
}

/** Decrypt a QRC payload (hex or base64) into its XML text, or '' when it is not one. */
export function decryptQrc(payload) {
  const text = String(payload ?? '').trim();
  if (!text) return '';

  let encrypted = null;
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) encrypted = Buffer.from(text, 'hex');
  else {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length >= 8) encrypted = decoded;
  }
  if (!encrypted || encrypted.length < 8) return '';

  const keys = tripleDesSetup(QQ_KEY, 0);
  const plain = Buffer.alloc(encrypted.length);
  for (let offset = 0; offset + 8 <= encrypted.length; offset += 8) {
    tripleDesCrypt(encrypted.subarray(offset, offset + 8), keys).copy(plain, offset);
  }

  const inflated = inflate(plain);
  const body = inflated ? inflated : plain;
  const xml = body.toString('utf8');
  return xml.includes('<QrcInfos') || xml.trimStart().startsWith('<') ? xml : '';
}

const WORD_TAG = /([^()]*)\((\d+),(\d+)\)/g;
const LINE_PREFIX = /^\[(\d+),(\d+)\](.*)$/;

function xmlUnescape(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function stamp(ms) {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}]`;
}

function wordStamp(ms) {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return `<${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}>`;
}

/**
 * Turn QRC XML into enhanced LRC the parser already understands.
 * Metadata lines ([ti:], [ar:], [offset:]) are dropped; a line whose syllables
 * do not line up is emitted as plain LRC so it still shows, just without a
 * per-syllable fill.
 */
export function qrcToLrc(xml) {
  const text = String(xml ?? '');
  if (!text) return '';

  const content = text.match(/<Lyric_\d+[^>]*LyricContent="([\s\S]*?)"/);
  const body = xmlUnescape(content ? content[1] : text);

  const out = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(LINE_PREFIX);
    if (!match) continue;

    const lineStart = Number(match[1]);
    const lineDuration = Number(match[2]);
    const chunks = match[3];

    const words = [];
    WORD_TAG.lastIndex = 0;
    let found;
    while ((found = WORD_TAG.exec(chunks)) !== null) {
      const syllable = found[1];
      if (!syllable) continue;
      words.push({
        // QRC offsets are absolute milliseconds from the start of the track,
        // not relative to the line — the first syllable of a line repeats the
        // line's own start value.
        at: Number(found[2]),
        duration: Number(found[3]),
        text: syllable,
      });
    }

    const plain = words.map((word) => word.text).join('').trim();
    if (!plain) continue;

    if (words.length < 2) {
      out.push(`${stamp(lineStart)}${plain}`);
      continue;
    }

    const parts = words.map((word) => `${wordStamp(word.at)}${word.text}`);
    const close = lineDuration > 0 ? wordStamp(lineStart + lineDuration) : '';
    out.push(`${stamp(lineStart)}${parts.join('')}${close}`);
  }

  return out.join('\n');
}
