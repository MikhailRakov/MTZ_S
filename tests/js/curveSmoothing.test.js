/**
 * Тесты модуля статистической обработки кривых:
 *   front/js/import/phoenix/curveSmoothing.js
 *
 * Покрывают:
 *  - склейку точек с одинаковой частотой (однозначность y(x));
 *  - сглаживание локальным методом наименьших квадратов (LOWESS) с робастными
 *    итерациями: шум подавляется, сигнал не искажается;
 *  - разворот фазы по ±180° до сглаживания и обратный свёрт;
 *  - корректность на вырожденных входных данных.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    smoothCurve,
    smoothCurvesList,
    unwrapPhaseDeg,
    wrapPhaseDeg,
} from '../../front/js/import/phoenix/curveSmoothing.js';

// ---------------------------------------------------------------------------
// Вспомогательные конструкторы
// ---------------------------------------------------------------------------

/** Геометрическая серия частот с заданным шагом в октавах. */
function logSeries(n, f0, octavesPerStep) {
    const f = [];
    for (let i = 0; i < n; i++) f.push(f0 * Math.pow(2, i * octavesPerStep));
    return f;
}

/** Детерминированный «шум» (без Math.random — тесты должны быть повторяемы). */
function pseudoNoise(i, seed = 1) {
    const s = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    return (s - Math.floor(s)) - 0.5;
}

// ---------------------------------------------------------------------------
// Склейка дублей по частоте
// ---------------------------------------------------------------------------

test('smoothCurve: одинаковые частоты склеиваются в одну точку (однозначность y(x))', () => {
    const frequencies = [10, 20, 20, 40, 40, 40, 80];
    const amplitudes = [1.0, 0.8, 0.6, 0.5, 0.45, 0.55, 0.4];
    const phases = [10, 20, 22, 30, 31, 29, 40];

    const out = smoothCurve({ frequencies, amplitudes, phases });

    assert.equal(out.frequencies.length, 4);
    // Частоты строго возрастают — повторов нет.
    for (let i = 1; i < out.frequencies.length; i++) {
        assert.ok(out.frequencies[i] > out.frequencies[i - 1], 'x должен строго возрастать');
    }
    // Длина всех трёх массивов одинакова.
    assert.equal(out.amplitudes.length, out.frequencies.length);
    assert.equal(out.phases.length, out.frequencies.length);
    // Значения конечны.
    for (const v of out.amplitudes) assert.ok(Number.isFinite(v));
    for (const v of out.phases) assert.ok(Number.isFinite(v));
});

test('smoothCurve: невалидные точки отбрасываются, пустой вход даёт пустой выход', () => {
    assert.deepEqual(
        smoothCurve({ frequencies: [], amplitudes: [], phases: [] }),
        { frequencies: [], amplitudes: [], phases: [] }
    );

    const out = smoothCurve({
        frequencies: [10, 0, -5, 20, NaN],
        amplitudes: [1, 1, 1, 0.5, 1],
        phases: [0, 0, 0, 10, 0],
    });
    assert.equal(out.frequencies.length, 2);
    assert.ok(out.frequencies.every(f => f > 0 && Number.isFinite(f)));
});

// ---------------------------------------------------------------------------
// Сглаживание
// ---------------------------------------------------------------------------

test('smoothCurve: сглаживание убирает шум, не искажая тренд', () => {
    const n = 60;
    const frequencies = logSeries(n, 1, 1 / 12); // 1 Гц → ~32 Гц
    const truth = frequencies.map((_, i) => Math.log10(i + 1)); // гладкий тренд

    const amplitudes = truth.map((v, i) => v + 0.35 * pseudoNoise(i));

    const out = smoothCurve({ frequencies, amplitudes, phases: truth.slice() });

    // Ошибка сглаженной кривой заметно меньше ошибки исходной.
    const rmse = (arr) => {
        let s = 0;
        for (let i = 0; i < truth.length; i++) s += (arr[i] - truth[i]) ** 2;
        return Math.sqrt(s / truth.length);
    };
    const rawErr = rmse(amplitudes);
    const smoothErr = rmse(out.amplitudes);

    assert.ok(smoothErr < rawErr * 0.5, `smoothErr=${smoothErr} rawErr=${rawErr}`);
    // Тренд не «съехал»: среднее и размах почти те же.
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    assert.ok(Math.abs(mean(out.amplitudes) - mean(truth)) < 0.25);
    assert.ok(out.amplitudes.length === frequencies.length);
});

test('smoothCurve: гладкая кривая остаётся гладкой (малое изменение соседних значений)', () => {
    const n = 40;
    const frequencies = logSeries(n, 1, 1 / 10);
    const smoothTruth = frequencies.map((_, i) => 2 + 0.5 * Math.sin(i / 4));

    const out = smoothCurve({
        frequencies,
        amplitudes: smoothTruth,
        phases: smoothTruth,
    });

    let maxStep = 0;
    for (let i = 1; i < out.amplitudes.length; i++) {
        maxStep = Math.max(maxStep, Math.abs(out.amplitudes[i] - out.amplitudes[i - 1]));
    }
    assert.ok(maxStep < 0.2, `maxStep=${maxStep}`);
});

// ---------------------------------------------------------------------------
// Фаза
// ---------------------------------------------------------------------------

test('unwrapPhaseDeg / wrapPhaseDeg: разворот через ±180°', () => {
    const unwrapped = unwrapPhaseDeg([170, -175, 178, 179]);
    assert.ok(Math.abs(unwrapped[1] - 185) < 1e-9);
    assert.ok(Math.abs(unwrapped[2] - 178) < 1e-9);
    assert.ok(Math.abs(unwrapped[3] - 179) < 1e-9);

    assert.ok(Math.abs(wrapPhaseDeg(185) - (-175)) < 1e-9);
    assert.ok(Math.abs(wrapPhaseDeg(-185) - 175) < 1e-9);
    assert.ok(Math.abs(wrapPhaseDeg(45) - 45) < 1e-9);
});

test('smoothCurve: фаза с разворотом остаётся непрерывной по значению', () => {
    const n = 30;
    const frequencies = logSeries(n, 1, 1 / 10);
    // Фаза «прыгает» через +180/-180.
    const phases = frequencies.map((_, i) => 170 + i * 1.5);

    const out = smoothCurve({ frequencies, amplitudes: frequencies.map(() => 1), phases });

    // В развёрнутом виде разрыва нет: соседние отличаются не больше, чем на шаг данных.
    for (let i = 1; i < out.phases.length; i++) {
        const d = Math.abs(out.phases[i] - out.phases[i - 1]);
        const wrapped = d > 180 ? 360 - d : d;
        assert.ok(wrapped < 10, `разрыв фазы ${wrapped} между ${i - 1} и ${i}`);
    }
    for (const v of out.phases) {
        assert.ok(v >= -180.0000001 && v <= 180.0000001, `фаза вне [-180,180]: ${v}`);
    }
});

// ---------------------------------------------------------------------------
// Список кривых
// ---------------------------------------------------------------------------

test('smoothCurvesList: обрабатывает каждую кривую списка', () => {
    const list = [
        {
            name: 'a.clc',
            curves: [{
                frequencies: [10, 20, 20, 40],
                amplitudes: [1, 0.9, 0.8, 0.7],
                phases: [0, 5, 6, 10],
            }],
        },
        {
            name: 'b.clc',
            curves: [{
                frequencies: [5, 10, 20],
                amplitudes: [2, 1.5, 1],
                phases: [1, 2, 3],
            }],
        },
    ];

    const out = smoothCurvesList(list);
    assert.equal(out.length, 2);
    assert.equal(out[0].name, 'a.clc');
    assert.equal(out[0].curves[0].frequencies.length, 3);
    assert.equal(out[1].curves[0].frequencies.length, 3);
    // Исходный список не мутируется.
    assert.equal(list[0].curves[0].frequencies.length, 4);
});

// --- Регрессия на РЕАЛЬНЫХ данных (1332.CLB, тип 5): редкая хвостовая сетка ---
// Частоты логарифмически неравномерны (0.88 … 12.25 Гц), значения почти монотонны.
// Локальная квадратичная регрессия на таком хвосте давала выброс 0.59 вместо 1.0009.
const REAL_TAIL = {
    frequencies: [0.8844, 1.0, 1.151, 1.356, 1.649, 2.104, 2.907, 4.697, 12.25],
    amplitudes: [1.0191, 1.0159, 1.0107, 1.0078, 1.0053, 1.0029, 1.0009, 0.9995, 0.9989],
    phases: [0, 1, 2, 3, 4, 5, 6, 7, 8],
};

test('не создаёт выброс на редком лог-хвосте (реальные 1332.CLB тип 5)', () => {
    const sm = smoothCurve(REAL_TAIL);
    for (let i = 0; i < sm.amplitudes.length; i++) {
        assert.ok(
            Math.abs(sm.amplitudes[i] - REAL_TAIL.amplitudes[i]) < 0.01,
            `точка ${i}: ${sm.amplitudes[i]} далеко от raw ${REAL_TAIL.amplitudes[i]}`
        );
    }
    let maxStep = 0;
    for (let i = 1; i < sm.amplitudes.length; i++) {
        maxStep = Math.max(maxStep, Math.abs(sm.amplitudes[i] - sm.amplitudes[i - 1]));
    }
    assert.ok(maxStep < 0.02, `maxStep=${maxStep}`);
});

test('сглаживание не выходит за локальный разброс значений', () => {
    // Синтетика: монотонная кривая с большим зазором между последними узлами.
    const x = [1, 2, 3, 4, 5, 6, 7, 20];
    const y = x.map((v, i) => 1 - i * 0.01);
    const sm = smoothCurve({ frequencies: x, amplitudes: y, phases: y.map(() => 0) });
    const lo = Math.min(...y), hi = Math.max(...y);
    for (const v of sm.amplitudes) assert.ok(v >= lo - 1e-12 && v <= hi + 1e-12, `${v} вне [${lo},${hi}]`);
});
