/**
 * curveSelect.test.js — тесты выбора конкретной кривой по индексу для редактирования.
 * Запуск: node --test MTZ_S/tests/js/*.test.js  (или: cd MTZ_S/tests/js && node --test)
 *
 * Проверяют РЕАЛЬНЫЕ экспорты phoenixImport.js (TDD: написаны ДО кода):
 *  - buildCurveOptions(curvesList) — список опций селектора
 *  - findNearestPoint(..., onlyCurveIdx) — поиск точки только на выбранной кривой
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { buildCurveOptions, findNearestPoint } =
    await import('../../front/js/import/phoenix/phoenixImport.js');

// Общий синтетический набор: 2 кривые (по одной curve в entry — как в calCurvesList)
function makeRanges() {
    return {
        area: { pad: { top: 30, right: 20, bottom: 40, left: 60 }, plotW: 520, plotH: 190, W: 600, H: 260 },
        logFMin: Math.log10(0.1),
        logFMax: Math.log10(10),
        ampMin: 0, ampRange: 1,
        phMin: 0, phRange: 90,
    };
}

function makeCurvesList() {
    const freqs = [0.1, 1, 10];
    const logX = f => 60 + ((Math.log10(f) - Math.log10(0.1)) / (Math.log10(10) - Math.log10(0.1))) * 520;
    return [
        { name: 'AAA.CLC', curves: [{ frequencies: freqs, amplitudes: [0, 0.5, 1], phases: [0, 45, 90] }] },
        { name: 'BBB.CLC', curves: [{ frequencies: freqs, amplitudes: [1, 0.5, 0], phases: [90, 45, 0] }] },
    ];
}

describe('buildCurveOptions', () => {
    test('пустой список → только опция «все кривые»', () => {
        const opts = buildCurveOptions([]);
        assert.equal(opts.length, 1);
        assert.equal(opts[0].value, -1);
    });

    test('null → не падает', () => {
        assert.equal(buildCurveOptions(null).length, 1);
    });

    test('N кривых → N+1 опция, индекс 1 = «1. AAA.CLC»', () => {
        const opts = buildCurveOptions(makeCurvesList());
        assert.equal(opts.length, 3);
        assert.equal(opts[0].value, -1);
        assert.equal(opts[1].value, 0);
        assert.match(opts[1].label, /^1\.\sAAA\.CLC$/);
        assert.equal(opts[2].value, 1);
        assert.match(opts[2].label, /^2\.\sBBB\.CLC$/);
    });
});

describe('findNearestPoint с onlyCurveIdx', () => {
    test('без ограничения (=-1) — как раньше: находит точку ближайшей кривой', () => {
        const list = makeCurvesList();
        const ranges = makeRanges();
        // Точка amp кривой 1 (BBB): f=10 → x=logX(10)=580; amp=0 → y=30+190-0=220
        const hit = findNearestPoint(580, 220, list, ranges, 12);
        assert.ok(hit);
        assert.equal(hit.curveIdx, 1);
        assert.equal(hit.channel, 'amp');
    });

    test('onlyCurveIdx=0 — точка на кривой 1 игнорируется', () => {
        const list = makeCurvesList();
        const ranges = makeRanges();
        const hit = findNearestPoint(580, 220, list, ranges, 12, 0);
        assert.equal(hit, null);
    });

    test('onlyCurveIdx=0 — точка на кривой 0 находится', () => {
        const list = makeCurvesList();
        const ranges = makeRanges();
        // Кривая 0, f=10, amp=1 → x=580, y=30+190-190=30
        const hit = findNearestPoint(580, 30, list, ranges, 12, 0);
        assert.ok(hit);
        assert.equal(hit.curveIdx, 0);
        assert.equal(hit.pointIdx, 2);
        assert.equal(hit.channel, 'amp');
    });

    test('onlyCurveIdx вне диапазона → null (защита)', () => {
        const list = makeCurvesList();
        const ranges = makeRanges();
        assert.equal(findNearestPoint(580, 30, list, ranges, 12, 99), null);
    });

    test('несколько curve в entry — индекс относится к позиции в curvesList', () => {
        const list = [
            { name: 'X', curves: [
                { frequencies: [0.1, 10], amplitudes: [0, 1], phases: [0, 90] },
                { frequencies: [0.1, 10], amplitudes: [1, 0], phases: [90, 0] },
            ] },
        ];
        const ranges = makeRanges();
        // Вторая внутренняя curve: f=10 amp=0 → x=580, y=220; onlyCurveIdx=0 (entry 0) — должна найтись
        const hit = findNearestPoint(580, 220, list, ranges, 12, 0);
        assert.ok(hit);
        assert.equal(hit.curveIdx, 0);
    });
});
