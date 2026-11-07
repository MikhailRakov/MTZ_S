import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dictionary, { VERSION } from '../../front/js/i18n/dictionary.js';
import {
    LANGS,
    LANG_LABELS,
    normalizeLang,
    detectBrowserLang,
    compileDictionary,
    translateString,
    applyParams,
} from '../../front/js/i18n/i18nCore.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dictKeys = Object.keys(dictionary);

/* ------------------------------ словарь ------------------------------ */

test('i18n: словарь непустой и версия задана', () => {
    assert.ok(dictKeys.length > 200, `строк в словаре слишком мало: ${dictKeys.length}`);
    assert.equal(typeof VERSION, 'number');
});

test('i18n: у каждого ключа есть en/zh/ja, все значения непустые', () => {
    const bad = [];
    for (const [ru, val] of Object.entries(dictionary)) {
        if (!ru || !ru.trim()) bad.push('<пустой ключ>');
        for (const lang of ['en', 'zh', 'ja']) {
            const v = val && val[lang];
            if (typeof v !== 'string' || !v.trim()) bad.push(`${lang}: ${JSON.stringify(ru).slice(0, 60)}`);
        }
    }
    assert.deepEqual(bad, [], 'незаполненные переводы');
});

test('i18n: ключ — кириллица (ключуем русский исходный текст)', () => {
    const nonCyr = dictKeys.filter((k) => !/[\u0400-\u04FF]/.test(k));
    assert.deepEqual(nonCyr, [], 'ключи без русских букв');
});

test('i18n: плейсхолдеры {N} сохранены во всех языках', () => {
    const multiset = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
    const bad = [];
    for (const [ru, val] of Object.entries(dictionary)) {
        const want = multiset(ru);
        for (const lang of ['en', 'zh', 'ja']) {
            if (multiset(val[lang]) !== want) bad.push(`${lang}: ${JSON.stringify(ru).slice(0, 50)} → ${JSON.stringify(val[lang]).slice(0, 50)}`);
        }
    }
    assert.deepEqual(bad, [], 'расхождение {N}-плейсхолдеров');
});

test('i18n: эмодзи исходной строки остаются в переводе', () => {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
    const set = (s) => (s.match(EMOJI) || []).slice().sort().join('');
    const bad = [];
    for (const [ru, val] of Object.entries(dictionary)) {
        const want = set(ru);
        if (!want) continue;
        for (const lang of ['en', 'zh', 'ja']) {
            if (set(val[lang]) !== want) bad.push(`${lang}: ${JSON.stringify(ru).slice(0, 40)}`);
        }
    }
    assert.deepEqual(bad, [], 'потеряны эмодзи');
});

test('i18n: переводы не совпадают с русским текстом (кроме технических строк)', () => {
    // Разрешаем совпадение только если строка не содержит кириллицы после
    // отбрасывания латинских токенов — иначе это незаполненный перевод.
    const suspicious = [];
    for (const [ru, val] of Object.entries(dictionary)) {
        for (const lang of ['en', 'zh', 'ja']) {
            if (val[lang] === ru && /[а-яё]{4,}/i.test(ru)) suspicious.push(`${lang}: ${ru.slice(0, 50)}`);
        }
    }
    assert.deepEqual(suspicious, [], 'похоже на машинный пропуск перевода');
});

test('i18n: терминология глоссария выдержана в обязательных парах', () => {
    const mustContain = [
        [/сопротивлени/i, 'en', 'resist'],
        [/импеданс/i, 'en', 'impedance'],
        [/инверси/i, 'en', 'invers'],
        [/калибров/i, 'en', 'calibrat'],
        [/калибров/i, 'ja', '校正'],
        [/станци/i, 'zh', '站点'],
        [/станци/i, 'ja', '観測点'],
        [/решени|задач/i, 'en', 'solution|task|run'],
    ];
    for (const [re, lang, needle] of mustContain) {
        const hits = dictKeys.filter((k) => re.test(k));
        assert.ok(hits.length > 0, `в словаре нет ключа, подходящего под ${re}`);
        const alt = needle.split('|');
        const found = hits.some((k) => alt.some((a) => dictionary[k][lang].toLowerCase().includes(a.toLowerCase())));
        assert.ok(found, `ни один перевод «${re}» не содержит «${needle}» (${lang})`);
    }
});

/* --------------------------- ядро перевода --------------------------- */

test('i18n: normalizeLang приводит коды браузера к_supported', () => {
    assert.equal(normalizeLang('en-US'), 'en');
    assert.equal(normalizeLang('zh-Hans-CN'), 'zh');
    assert.equal(normalizeLang('ja'), 'ja');
    assert.equal(normalizeLang('RU'), 'ru');
    assert.equal(normalizeLang('de'), 'ru', 'неподдерживаемый язык → русский по умолчанию');
    assert.equal(normalizeLang(''), 'ru');
    assert.equal(normalizeLang(undefined), 'ru');
});

test('i18n: detectBrowserLang берёт первый поддерживаемый язык', () => {
    assert.equal(detectBrowserLang({ languages: ['de-DE', 'ja-JP', 'en'] }), 'ja');
    assert.equal(detectBrowserLang({ languages: [] , language: 'en-GB'}), 'en');
    assert.equal(detectBrowserLang({ languages: ['ru-RU', 'en'] }), 'ru');
    assert.equal(detectBrowserLang({}), 'ru');
});

test('i18n: точное совпадение ключа переводится', () => {
    const c = compileDictionary(dictionary);
    const key = dictKeys.find((k) => !/\{\d\}/.test(k));
    assert.equal(translateString(key, 'en', c), dictionary[key].en);
    assert.equal(translateString(key, 'ru', c), key, 'русский всегда без изменений');
});

test('i18n: шаблон с {0} переводится, значение подставляется', () => {
    const fake = { 'Станция {0} — ошибка': { en: 'Station {0} — error', zh: '站点{0}出错', ja: '観測点{0}エラー' } };
    const c = compileDictionary(fake);
    assert.equal(translateString('Станция 1369712A — ошибка', 'en', c), 'Station 1369712A — error');
    assert.equal(translateString('Станция 1369712A — ошибка', 'ja', c), '観測点1369712Aエラー');
    assert.equal(translateString('Станция X — ошибка', 'ru', c), 'Станция X — ошибка');
});

test('i18n: несколько плейсхолдеров сохраняют порядок значений', () => {
    const fake = { 'Загружено {0} из {1}': { en: 'Loaded {1} of {0}', zh: '已加载 {1} / {0}', ja: '{0} 件中 {1} 件読み込み' } };
    const c = compileDictionary(fake);
    // Первый {0}=10, второй {1}=3 → в английском порядке меняются местами.
    assert.equal(translateString('Загружено 10 из 3', 'en', c), 'Loaded 3 of 10');
    assert.equal(translateString('Загружено 10 из 3', 'zh', c), '已加载 3 / 10');
});

test('i18n: более длинный ключ выигрывает у короткого', () => {
    const fake = {
        'Ошибка': { en: 'Error', zh: '错误', ja: 'エラー' },
        'Ошибка сети': { en: 'Network error', zh: '网络错误', ja: 'ネットワークエラー' },
    };
    const c = compileDictionary(fake);
    assert.equal(translateString('Ошибка сети', 'en', c), 'Network error');
    assert.equal(translateString('Ошибка', 'en', c), 'Error');
});

test('i18n: неизвестный текст остаётся как есть', () => {
    const c = compileDictionary(dictionary);
    assert.equal(translateString('Совсем не похожая строка 12345', 'en', c), 'Совсем не похожая строка 12345');
    assert.equal(translateString('', 'en', c), '');
});

test('i18n: applyParams подставляет параметры и бережёт лишние {N}', () => {
    assert.equal(applyParams('a {0} b {1}', ['X', 'Y']), 'a X b Y');
    assert.equal(applyParams('a {0} b', []), 'a {0} b');
    assert.equal(applyParams('a {0} b', [0]), 'a 0 b');
    assert.equal(applyParams('a {5} b', ['x']), 'a {5} b');
});

test('i18n: отступы внутри текстового узла сохраняются при переводе', () => {
    const fake = { 'Сохранить': { en: 'Save', zh: '保存', ja: '保存' } };
    const c = compileDictionary(fake);
    assert.equal(translateString('  Сохранить\n', 'en', c), '  Save\n');
});

/* ------------------- полнота: статичная разметка ------------------- */

test('i18n: текстовые узлы static HTML покрыты словарём', () => {
    const pages = ['dashboard.html', 'login.html', 'index.html', 'coarse-generator.html', 'mesh.html'];
    const missing = [];
    for (const page of pages) {
        const file = path.join(HERE, '..', '..', 'front', page);
        if (!fs.existsSync(file)) continue;
        let html = fs.readFileSync(file, 'utf8');
        html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                   .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                   .replace(/<!--[\s\S]*?-->/g, ' ');
        const texts = html.split(/<[^>]+>/).map((s) => s.replace(/\s+/g, ' ').trim());
        for (const t of texts) {
            if (!/[\u0400-\u04FF]/.test(t)) continue;
            if (t.length > 240) continue;
            if (dictionary[t]) continue;
            missing.push(`${page}: ${JSON.stringify(t.slice(0, 70))}`);
        }
    }
    assert.deepEqual(missing, [], 'эти строки не найдены в словаре');
});

test('i18n: LANGS и LANG_LABELS согласованы', () => {
    assert.deepEqual(LANGS, ['ru', 'en', 'zh', 'ja']);
    for (const l of LANGS) assert.ok(LANG_LABELS[l], `нет подписи для ${l}`);
});
