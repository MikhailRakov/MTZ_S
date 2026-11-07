/**
 * curveVisibility.test.js — тесты скрытия остальных кривых при выборе конкретной кривой.
 * Запуск: node --test MTZ_S/tests/js/*.test.js  (или: cd MTZ_S/tests/js && node --test)
 *
 * Требование: «при выборе конкретной кривой все остальные перестают отображаться вообще».
 * Проверяют РЕАЛЬНЫЕ экспорты phoenixImport.js (TDD: написаны ДО кода):
 *  - visibleCurveIndices(curvesList, selectedCurveIdx) — какие кривые отображать
 *  - computeCurveRanges(curvesList, visibleIndices) — масштаб осей только по видимым кривым
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { visibleCurveIndices, computeCurveRanges } =
    await import('../../front/js/import/phoenix/phoenixImport.js');

/** Три кривые с разными диапазонами (как реальные CLC-файлы Phoenix) */
function makeCurvesList() {
    return [
        { name: 'AAA.CLC', curves: [{ frequencies: [0.1, 1, 10], amplitudes: [0, 0.5, 1], phases: [0, 45, 90] }] },
        { name: 'BBB.CLC', curves: [{ frequencies: [0.1, 1, 10], amplitudes: [10, 20, 30], phases: [100, 150, 200] }] },
        { name: 'CCC.CLC', curves: [{ frequencies: [0.1, 1, 10], amplitudes: [-5, 0, 5], phases: [-90, 0, 90] }] },
    ];
}

describe('visibleCurveIndices', () => {
    test('selectedCurveIdx = -1 → видны все кривые', () => {
        assert.deepEqual(visibleCurveIndices(makeCurvesList(), -1), [0, 1, 2]);
    });

    test('выбрана кривая 0 → видна только она', () => {
        assert.deepEqual(visibleCurveIndices(makeCurvesList(), 0), [0]);
    });

    test('выбрана кривая 1 → видна только она', () => {
        assert.deepEqual(visibleCurveIndices(makeCurvesList(), 1), [1]);
    });

    test('выбрана последняя кривая → видна только она', () => {
        assert.deepEqual(visibleCurveIndices(makeCurvesList(), 2), [2]);
    });

    test('индекс за пределами списка → безопасный фолбэк (все кривые)', () => {
        assert.deepEqual(visibleCurveIndices(makeCurvesList(), 99), [0, 1, 2]);
        assert.deepEqual(visibleCurveIndices(makeCurvesList(), -5), [0, 1, 2]);
    });

    test('пустой список → пустой массив', () => {
        assert.deepEqual(visibleCurveIndices([], 0), []);
        assert.deepEqual(visibleCurveIndices([], -1), []);
    });

    test('null/undefined → пустой массив, без исключения', () => {
        assert.deepEqual(visibleCurveIndices(null, 0), []);
        assert.deepEqual(visibleCurveIndices(undefined, -1), []);
    });

    test('дробный индекс → округление вниз до целого', () => {
        assert.deepEqual(visibleCurveIndices(makeCurvesList(), 1.9), [1]);
    });
});

describe('computeCurveRanges', () => {
    test('масштаб считается только по видимой кривой (чужая кривая не влияет)', () => {
        const list = makeCurvesList();
        const r = computeCurveRanges(list, [1]);
        assert.equal(r.ampMin, 10);
        assert.equal(r.ampMax, 30);
        assert.equal(r.ampRange, 20);
    });

    test('при «все кривые» диапазон объединяет все кривые', () => {
        const list = makeCurvesList();
        const r = computeCurveRanges(list, [0, 1, 2]);
        assert.equal(r.ampMin, -5);
        assert.equal(r.ampMax, 30);
        assert.equal(r.ampRange, 35);
    });

    test('фаза считается по видимым кривым', () => {
        const list = makeCurvesList();
        const r = computeCurveRanges(list, [2]);
        assert.equal(r.phMin, -90);
        assert.equal(r.phMax, 90);
        assert.equal(r.phRange, 180);
    });

    test('частотный диапазон — log-шкала по видимым кривым', () => {
        const list = [
            { name: 'A', curves: [{ frequencies: [1, 100], amplitudes: [0, 1], phases: [0, 90] }] },
            { name: 'B', curves: [{ frequencies: [0.01, 0.1], amplitudes: [0, 1], phases: [0, 90] }] },
        ];
        const onlyA = computeCurveRanges(list, [0]);
        assert.equal(onlyA.logFMin, Math.log10(1));
        assert.equal(onlyA.logFMax, Math.log10(100));

        const all = computeCurveRanges(list, [0, 1]);
        assert.equal(all.logFMin, Math.log10(0.01));
        assert.equal(all.logFMax, Math.log10(100));
    });

    test('нулевой разброс → единичный диапазон (без деления на 0)', () => {
        const list = [{ name: 'A', curves: [{ frequencies: [1, 10], amplitudes: [5, 5], phases: [30, 30] }] }];
        const r = computeCurveRanges(list, [0]);
        assert.equal(r.ampRange, 1);
        assert.equal(r.phRange, 1);
    });

    test('невидимые кривые с огромной амплитудой не ломают масштаб выбранной', () => {
        const list = [
            { name: 'A', curves: [{ frequencies: [1, 10], amplitudes: [0, 1], phases: [0, 90] }] },
            { name: 'B', curves: [{ frequencies: [1, 10], amplitudes: [1e9, 2e9], phases: [0, 90] }] },
        ];
        const r = computeCurveRanges(list, [0]);
        assert.equal(r.ampMin, 0);
        assert.equal(r.ampMax, 1);
    });

    test('нет видимых кривых → null', () => {
        assert.equal(computeCurveRanges(makeCurvesList(), []), null);
    });

    test('нет данных (пустые кривые) → null', () => {
        assert.equal(computeCurveRanges([{ name: 'A', curves: [] }], [0]), null);
    });

    test('без явного списка индексов → учитываются все кривые', () => {
        const r = computeCurveRanges(makeCurvesList());
        assert.equal(r.ampMin, -5);
        assert.equal(r.ampMax, 30);
    });
});
