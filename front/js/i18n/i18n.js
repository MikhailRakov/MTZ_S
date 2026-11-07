/**
 * i18n.js — применение словаря к DOM + переключатель языка.
 *
 * Как это работает:
 *  - при смене языка обходится всё дерево DOM: текстовые узлы и атрибуты
 *    (placeholder / title / aria-label / alt) ищутся в словаре и заменяются;
 *  - оригинальный русский текст запоминается в WeakMap, поэтому язык можно
 *    переключать туда-сюда без потери данных;
 *  - за динамическим контентом (JS дописывает узлы после загрузки) следит
 *    MutationObserver — новые узлы переводятся сразу, без перезагрузки;
 *  - выбранный язык хранится в localStorage('mtz_lang'), при следующем заходе
 *    применяется автоматически; по умолчанию — язык браузера (или русский).
 *
 * Публичный API: setLanguage / getLanguage / onChange / t / mountLanguageSelector.
 */

import dictionary from './dictionary.js';
import {
    LANGS,
    LANG_LABELS,
    compileDictionary,
    detectBrowserLang,
    normalizeLang,
    translateString,
    applyParams,
} from './i18nCore.js';

const STORAGE_KEY = 'mtz_lang';

const compiled = compileDictionary(dictionary);

/** Элементы/узлы, которые мы уже переводили: чтобы вернуть оригинал при смене языка. */
const originalText = new WeakMap();   // Text node → исходная строка
const originalAttr = new WeakMap();   // Element → { attrName: исходное значение }
const skipNodes = new WeakSet();      // узлы, помеченные data-i18n="skip"

let currentLang = 'ru';
const listeners = new Set();

/** Текущий язык. */
export function getLanguage() {
    return currentLang;
}

const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

function shouldSkip(node) {
    const el = node.nodeType === 3 ? node.parentElement : node;
    if (!el) return true;
    if (el.closest && el.closest('[data-i18n="skip"]')) return true;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') return true;
    return false;
}

function translateTextNode(node) {
    if (shouldSkip(node)) return;
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return;

    const base = originalText.has(node) ? originalText.get(node) : raw;
    if (!originalText.has(node)) originalText.set(node, raw);

    const next = translateString(base, currentLang, compiled);
    if (next !== raw) node.nodeValue = next;
}

function translateElementAttrs(el) {
    if (shouldSkip(el)) return;
    if (!originalAttr.has(el)) originalAttr.set(el, {});
    const store = originalAttr.get(el);

    for (const attr of TRANSLATABLE_ATTRS) {
        const raw = el.getAttribute && el.getAttribute(attr);
        if (!raw) continue;
        if (!(attr in store)) store[attr] = raw;
        const base = store[attr];
        const next = translateString(base, currentLang, compiled);
        if (next !== raw && el.setAttribute) el.setAttribute(attr, next);
    }
}

/** Обойти поддерево и перевести все текстовые узлы + атрибуты. */
export function translateTree(root) {
    const scope = root || document.body;
    if (!scope) return;

    if (scope.nodeType === 3) { translateTextNode(scope); return; }

    translateElementAttrs(scope);

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
            if (shouldSkip(node)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    let n;
    while ((n = walker.nextNode())) {
        if (n.nodeType === 3) translateTextNode(n);
        else translateElementAttrs(n);
    }
}

/** Отключить слежку за DOM (для тестов / разрушения страницы). */
let observer = null;
let queue = null;

function flushQueue() {
    queue = null;
    if (!pendingNodes.size) return;
    const nodes = [...pendingNodes];
    pendingNodes.clear();
    for (const node of nodes) {
        if (node.nodeType === 3) translateTextNode(node);
        else {
            translateElementAttrs(node);
            translateTree(node);
        }
    }
}

const pendingNodes = new Set();

function scheduleTranslate(node) {
    pendingNodes.add(node);
    if (queue) return;
    queue = requestAnimationFrame(flushQueue);
}

function ensureObserver() {
    if (observer || typeof MutationObserver === 'undefined' || !document.body) return;
    observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'characterData') {
                // Мы сами меняем текст — не трогать; чужая правка → пересчитать.
                const node = m.target;
                if (originalText.has(node) && node.nodeValue === translateString(originalText.get(node), currentLang, compiled)) continue;
                scheduleTranslate(node);
            } else if (m.type === 'childList') {
                m.addedNodes.forEach(scheduleTranslate);
            } else if (m.type === 'attributes' && TRANSLATABLE_ATTRS.includes(m.attributeName)) {
                const store = originalAttr.get(m.target);
                const val = m.target.getAttribute(m.attributeName);
                if (store && m.attributeName in store && store[m.attributeName] === val) continue;
                scheduleTranslate(m.target);
            }
        }
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATABLE_ATTRS,
    });
}

/** Сменить язык интерфейса. */
export function setLanguage(lang, { persist = true } = {}) {
    const next = normalizeLang(lang);
    if (!LANGS.includes(next)) return currentLang;
    currentLang = next;

    if (persist) {
        try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* приватный режим */ }
    }
    if (typeof document !== 'undefined') {
        document.documentElement.lang = next === 'zh' ? 'zh-CN' : next;
        if (document.body) translateTree(document.body);
        if (!titleOriginal && document.title) titleOriginal = document.title;
        if (titleOriginal) document.title = translateString(titleOriginal, next, compiled);
    }
    syncSelector();
    listeners.forEach((fn) => { try { fn(next); } catch (e) { console.error(e); } });
    return currentLang;
}

let titleOriginal = '';

/** Подписка на смену языка: onChange(fn) → fn(lang). */
export function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Перевести строку из JS: t('Станция {0}', id).
 * Ключ — всегда русская строка (как в dictionary.js).
 */
export function t(ruText, ...params) {
    if (!ruText) return '';
    if (currentLang === 'ru') return applyParams(ruText, params);
    const hit = translateString(ruText, currentLang, compiled);
    return applyParams(hit, params);
}

/* ------------------------------ переключатель ------------------------------ */

let selectorEl = null;

function syncSelector() {
    if (!selectorEl) return;
    const select = selectorEl.querySelector('select');
    if (select && select.value !== currentLang) select.value = currentLang;
    for (const btn of selectorEl.querySelectorAll('[data-lang]')) {
        btn.classList.toggle('is-active', btn.dataset.lang === currentLang);
        btn.setAttribute('aria-pressed', String(btn.dataset.lang === currentLang));
    }
}

/**
 * Поставить переключатель языка в контейнер.
 * @param {HTMLElement|string} container — элемент или CSS-селектор
 * @param {{style?: 'select'|'buttons'}} opts
 */
export function mountLanguageSelector(container, opts = {}) {
    const host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) return null;

    const style = opts.style === 'buttons' ? 'buttons' : 'select';
    const wrap = document.createElement('div');
    wrap.className = 'mtz-lang-switch';
    wrap.setAttribute('data-i18n', 'skip');

    if (style === 'select') {
        const icon = document.createElement('span');
        icon.className = 'mtz-lang-switch__icon';
        icon.textContent = '🌐';
        icon.setAttribute('aria-hidden', 'true');
        const select = document.createElement('select');
        select.className = 'mtz-lang-switch__select';
        select.setAttribute('aria-label', 'Язык интерфейса / Interface language / 界面语言 / 表示言語');
        for (const code of LANGS) {
            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = LANG_LABELS[code];
            select.appendChild(opt);
        }
        select.value = currentLang;
        select.addEventListener('change', () => setLanguage(select.value));
        wrap.appendChild(icon);
        wrap.appendChild(select);
    } else {
        for (const code of LANGS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mtz-lang-switch__btn';
            btn.dataset.lang = code;
            btn.textContent = code.toUpperCase();
            btn.title = LANG_LABELS[code];
            btn.addEventListener('click', () => setLanguage(code));
            wrap.appendChild(btn);
        }
    }

    host.appendChild(wrap);
    selectorEl = wrap;
    syncSelector();
    return wrap;
}

/* --------------------------------- старт ---------------------------------- */

function readStoredLang() {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v) return normalizeLang(v);
    } catch (e) { /* ignore */ }
    return null;
}

let started = false;

/**
 * Инициализация: применить язык к уже готовой разметке, поставить переключатели
 * в элементы .lang-switch-mount и включить наблюдатель за DOM.
 */
export function initI18n() {
    if (started || typeof document === 'undefined') return currentLang;
    started = true;

    const stored = readStoredLang();
    currentLang = stored || detectBrowserLang();
    if (!LANGS.includes(currentLang)) currentLang = 'ru';

    titleOriginal = document.title || '';
    document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : currentLang;

    // Переключатели: страница сама решает, где им быть.
    for (const host of document.querySelectorAll('.lang-switch-mount')) {
        mountLanguageSelector(host, { style: host.dataset.langStyle === 'buttons' ? 'buttons' : 'select' });
    }

    translateTree(document.body || document.documentElement);
    ensureObserver();

    // Доступ из консоли и из инлайновых скриптов страниц (без ES-модулей).
    if (typeof window !== 'undefined') {
        window.mtzI18n = { setLanguage, getLanguage, t, onChange, mountLanguageSelector };
    }
    return currentLang;
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initI18n(), { once: true });
    } else {
        initI18n();
    }
}
