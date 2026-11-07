/**
 * i18nCore.js — чистая логика перевода (без DOM), чтобы её можно было тестировать в node.
 *
 * Словарь: ключ = русский исходный текст, значение = { en, zh, ja }.
 * Два механизма подстановки:
 *   1. точное совпадение всего текста узла/строки с ключом;
 *   2. шаблоны с плейсхолдерами {0}, {1} — когда в русскую строку уже вставлены
 *      динамические значения («Станция 1369712A», «Решений: 5»). Такие ключи
 *      компилируются в регулярки, значения перехватываются и переносятся в перевод.
 */

export const LANGS = ['ru', 'en', 'zh', 'ja'];

/**нативные названия языков для селектора */
export const LANG_LABELS = {
    ru: 'Русский',
    en: 'English',
    zh: '中文',
    ja: '日本語',
};

const PLACEHOLDER_RE = /\{(\d+)\}/g;

/** Нормализовать код языка из navigator.language / localStorage в один из LANGS. */
export function normalizeLang(input) {
    const v = String(input || '').trim().toLowerCase();
    if (!v) return 'ru';
    const base = v.split(/[-_]/)[0];
    if (LANGS.includes(base)) return base;
    if (base === 'zho' || base === 'chi') return 'zh';
    if (base === 'jpn') return 'ja';
    if (base === 'rus') return 'ru';
    return 'ru';
}

/**
 * Определить язык браузера.
 * @param {{languages?: string[], language?: string}} [nav]
 */
export function detectBrowserLang(nav) {
    const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    if (!n) return 'ru';
    const list = (Array.isArray(n.languages) && n.languages.length)
        ? n.languages
        : (n.language ? [n.language] : []);
    for (const item of list) {
        const v = String(item || '').trim().toLowerCase();
        if (!v) continue;
        const base = v.split(/[-_]/)[0];
        // Не идём через normalizeLang: он недоступный язык сводит к русскому
        // как к умолчанию, а здесь нужно различать «браузер русский» и
        // «браузер немецкий» (второй тоже остаётся на русском, но позже).
        if (base === 'ru' || base === 'rus') return 'ru';
        if (base === 'en') return 'en';
        if (base === 'zh' || base === 'zho' || base === 'chi') return 'zh';
        if (base === 'ja' || base === 'jpn') return 'ja';
    }
    return 'ru';
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Схлопнуть всеruns of whitespace в один пробел (DOM-узлы почти всегда с переносами). */
function collapseWs(s) {
    return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * Скомпилировать словарь в структуру для поиска.
 * @param {Record<string, {en:string, zh:string, ja:string}>} dict
 * @returns {{exact: Map<string, object>, normalized: Map<string, object>, patterns: Array<{re: RegExp, key: string, groups: string[]}>}}
 */
export function compileDictionary(dict) {
    const exact = new Map();
    const normalized = new Map();
    const templates = [];

    for (const [key, val] of Object.entries(dict || {})) {
        if (!key || !val) continue;
        exact.set(key, val);
        const norm = collapseWs(key);
        // При коллизии (два ключа совпадают после схлопывания) оставляем первый:
        // словарь отсортирован по убыванию длины, т.е. выигрывает более конкретный.
        if (!normalized.has(norm)) normalized.set(norm, val);
        if (PLACEHOLDER_RE.test(key)) {
            PLACEHOLDER_RE.lastIndex = 0;
            templates.push({ key, val });
        }
    }

    // Более длинные (специфичные) шаблоны должны проверяться первыми,
    // иначе короткий ключ съест часть длинной строки.
    templates.sort((a, b) => b.key.length - a.key.length);

    const patterns = templates.map(({ key, val }) => {
        // Ключ с плейсхолдерами → регулярка: {0} → ([\s\S]+?)
        let source = '';
        let last = 0;
        PLACEHOLDER_RE.lastIndex = 0;
        let m;
        const groups = [];
        const addLiteral = (literal) => {
            // Пробелы ключа заменяем на \s+: в разметке между словами перенос строки
            // и отступ, а в словаре — одиночный пробел.
            source += escapeRegExp(literal).replace(/ /g, '\\s+');
        };
        while ((m = PLACEHOLDER_RE.exec(key)) !== null) {
            addLiteral(key.slice(last, m.index));
            source += '([\\s\\S]+?)';
            groups.push(m[1]);
            last = m.index + m[0].length;
        }
        addLiteral(key.slice(last));
        return { re: new RegExp('^\\s*' + source + '\\s*$', ''), key, val, groups };
    });

    return { exact, normalized, patterns };
}

/** Перевести одну строку, подставив параметры. */
export function applyParams(text, params) {
    if (!params || !params.length) return text;
    return text.replace(PLACEHOLDER_RE, (whole, idx) => {
        const v = params[Number(idx)];
        return v === undefined || v === null ? whole : String(v);
    });
}

/**
 * Перевести произвольный текст (в т.ч. с уже подставленными значениями).
 * @param {string} text
 * @param {string} lang - 'ru' | 'en' | 'zh' | 'ja'
 * @param {object} compiled - результат compileDictionary
 * @returns {string}
 */
export function translateString(text, lang, compiled) {
    if (lang === 'ru' || !text) return text;
    if (!compiled) return text;

    const exactHit = compiled.exact.get(text);
    if (exactHit && exactHit[lang]) return exactHit[lang];

    // Шаблоны с плейсхолдерами: регулярки привязаны к началу/концу строки,
    // поэтому перевод заменяет узел целиком (значения подставляются из групп).
    if (compiled.patterns) {
        for (const { re, val, groups } of compiled.patterns) {
            const hit = val && val[lang];
            if (!hit) continue;
            const m = re.exec(text);
            if (!m) continue;
            const params = m.slice(1, groups.length + 1);
            return applyParams(hit, params);
        }
    }

    // Точное совпадение могло «спрятаться» за переносами строк и отступами:
    // узлы DOM почти всегда содержат их, поэтому сравниваем схлопнутую версию
    // и возвращаем перевод на том же месте (отступы исходного узла сохраняем).
    const trimmed = text.trim();
    if (trimmed) {
        const normHit = compiled.normalized && compiled.normalized.get(collapseWs(trimmed));
        if (normHit && normHit[lang]) {
            if (text === trimmed) return normHit[lang];
            const at = text.indexOf(trimmed);
            if (at >= 0) return text.slice(0, at) + normHit[lang] + text.slice(at + trimmed.length);
        }
    }
    return text;
}

/**
 * Функция перевода для вызова из кода: t('Станция {0}', id).
 * Ключ — всегда русская строка; если её нет в словаре, возвращаем как есть.
 */
export function makeT(getLang, compiled) {
    return function t(ruText, ...params) {
        if (!ruText) return '';
        const lang = typeof getLang === 'function' ? getLang() : 'ru';
        if (lang === 'ru' || !compiled) return applyParams(ruText, params);
        const hit = translateString(ruText, lang, compiled);
        return applyParams(hit, params);
    };
}
