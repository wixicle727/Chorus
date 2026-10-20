/**
 * Interface translation.
 *
 * The pages are plain HTML with no build step, so there is no string table to
 * compile: every user-visible string in the markup is already English, and a
 * dictionary maps that exact English text to the chosen language. Anything the
 * scripts build at runtime (status lines, notices) goes through `t()`.
 *
 * That keeps the English markup readable and means a missing translation fails
 * soft — the English text simply stays — while `test/i18n.js` proves that no
 * string is missing.
 *
 * Usage:
 *   import { setLanguage, t, LANGUAGES } from '/js/i18n.js';
 *   setLanguage('zh-Hans');            // repaints the whole document
 *   el.textContent = t('No lyrics');   // runtime strings
 */

import zhHans from './i18n.zh-Hans.js';
import zhHant from './i18n.zh-Hant.js';

export const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'zh-Hans', label: '简体中文' },
  { id: 'zh-Hant', label: '繁體中文' },
];

const DICTIONARIES = { 'zh-Hans': zhHans, 'zh-Hant': zhHant };

/** Attributes a user can read on screen or hear from a screen reader. */
const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];

/** Elements whose text must never be rewritten. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

let current = 'en';
let observer = null;
/** Original English text per node, so switching back to English is lossless. */
const originals = new WeakMap();
/** Original English attribute values per element. */
const attributeOriginals = new WeakMap();
/** Guards the mutation observer against re-translating its own writes. */
let writing = false;

/**
 * Accept the spellings people and platforms actually use: `zh`, `zh-CN`,
 * `zh_TW`, `zh-Hant-TW`, and so on. Unknown values fall back to English rather
 * than throwing, because a bad config must not break the panel.
 */
export function normaliseLanguage(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!raw) return 'en';
  if (raw === 'en' || raw.startsWith('en-')) return 'en';
  // Traditional first: zh-tw and zh-hk are Traditional, zh-hant says so outright.
  if (raw.includes('hant') || raw.endsWith('-tw') || raw.endsWith('-hk') || raw.endsWith('-mo')) return 'zh-Hant';
  if (raw === 'zh' || raw.includes('hans') || raw.startsWith('zh-')) return 'zh-Hans';
  return 'en';
}

export function language() {
  return current;
}

export function isTranslated() {
  return current !== 'en';
}

/**
 * Dictionaries are keyed by the English text *as written in the markup*, which
 * means escaped entities: the key is `Cache &amp; history` while the DOM text is
 * `Cache & history`. Decode once per language so lookups work against real text
 * nodes instead of forcing every call site to re-escape.
 */
const decoded = new Map();

/** Named entities that appear in the markup. */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  // Decoded by hand rather than through a throwaway element: this runs once per
  // key at startup, and a real decoder keeps the module usable outside a browser.
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED[body.toLowerCase()];
    return named ?? whole;
  });
}

function dictionaryFor(lang) {
  const table = DICTIONARIES[lang];
  if (!table) return null;
  if (!decoded.has(lang)) {
    const map = new Map();
    for (const [key, value] of Object.entries(table)) map.set(decodeEntities(key), value);
    decoded.set(lang, map);
  }
  return decoded.get(lang);
}

/** Translate one string. Unknown strings are returned unchanged. */
export function t(text) {
  if (!text) return text;
  return dictionaryFor(current)?.get(text) ?? text;
}

/** Same as `t`, but with `{name}` placeholders filled in. */
export function tf(text, values = {}) {
  return t(text).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
}

/** The dictionary entry for a trimmed English string, or undefined. */
function lookup(text) {
  if (current === 'en') return undefined;
  return dictionaryFor(current)?.get(text);
}

function paint(node, text) {
  if (node.nodeValue === text) return;
  writing = true;
  node.nodeValue = text;
  writing = false;
}

function translateTextNode(node) {
  const source = node.nodeValue;
  const trimmed = String(source ?? '').trim();
  if (!trimmed) return;

  if (!originals.has(node)) {
    // Only remember text that is actually translated, so numbers, track titles
    // and other data are never touched.
    if (lookup(trimmed) === undefined) return;
    originals.set(node, source);
  }

  const original = originals.get(node);
  if (current === 'en') {
    paint(node, original);
    return;
  }

  const originalTrimmed = original.trim();
  const translated = lookup(originalTrimmed);
  if (translated === undefined) {
    paint(node, original);
    return;
  }
  // Keep the original surrounding whitespace so inline text keeps its spacing.
  const start = original.indexOf(originalTrimmed);
  paint(node, original.slice(0, start) + translated + original.slice(start + originalTrimmed.length));
}

function translateAttributes(element) {
  for (const name of ATTRIBUTES) {
    if (typeof element.getAttribute !== 'function') continue;
    const value = element.getAttribute(name);
    if (!value) continue;

    let store = attributeOriginals.get(element);
    if (!store) {
      store = Object.create(null);
      attributeOriginals.set(element, store);
    }
    if (!(name in store)) {
      if (lookup(value.trim()) === undefined) continue;
      store[name] = value;
    }

    const original = store[name];
    const wanted = current === 'en' ? original : (lookup(original.trim()) ?? original);
    if (element.getAttribute(name) !== wanted) {
      writing = true;
      element.setAttribute(name, wanted);
      writing = false;
    }
  }
}

function walk(root) {
  if (!root) return;

  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE && SKIP.has(root.tagName)) return;

  if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root);
  for (const child of root.childNodes ?? []) walk(child);
}

/**
 * Switch language and repaint the document.
 *
 * `lang` accepts anything `normaliseLanguage` understands. Returns the id that
 * was actually applied, which is what callers should persist.
 */
export function setLanguage(lang, { root = typeof document === 'undefined' ? null : document.body } = {}) {
  current = normaliseLanguage(lang);

  // Guards for the test runner, which imports this module in Node where there is
  // no document: translation itself must still work headlessly.
  if (typeof document === 'undefined') return current;

  document.documentElement.setAttribute('lang', current);
  walk(root ?? document.body);

  /*
     The panel rewrites parts of itself constantly (status text, candidate rows,
     the update notice). Watching for changes is what keeps those translated
     without every render having to remember to call in here.
  */
  if (!observer && typeof MutationObserver === 'function') {
    observer = new MutationObserver((records) => {
      if (writing || current === 'en') return;
      for (const record of records) {
        if (record.type === 'characterData') translateTextNode(record.target);
        else for (const node of record.addedNodes) walk(node);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }
  return current;
}

/** Translate once, at startup, from a language id the caller already resolved. */
export function initLanguage(lang, options) {
  return setLanguage(lang, options);
}
