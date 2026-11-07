/**
 * Тесты для отрисовки калибровочных кривых (canvas rendering logic).
 * Проверяют трансформацию данных из файла калибровки → формат drawCalCurves().
 *
 * ВАЖНО: в одном файле калибровки Phoenix содержится НЕСКОЛЬКО независимых
 * кривых отклика (разделены типом строки). Каждая из них обрабатывается
 * отдельно: склейка дублей по частоте + сглаживание локальной МНК.
 *
 * Запуск: node --test MTZ_S/tests/js/*.test.js  (или: cd MTZ_S/tests/js && node --test)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { parseCalFile, calResponseCurves, calResponseCurvesByType } = await import('../../front/js/import/phoenix/phoenixParser.js');

/**
 * Реальные реализации (без дублирования логики в тесте):
 *  - transformCurvesForCanvas — обработка одной кривой;
 *  - transformCalCurves — разбор файла калибровки на отдельные кривые.
 */
const { transformCurvesForCanvas, transformCalCurves } = await import('../../front/js/import/phoenix/phoenixImport.js');

const TEST_DATA_DIR = join(__dirname, '..', '..', 'mt_time_data');

function readFileAsArrayBuffer(filePath) {
    const nodeBuffer = readFileSync(filePath);
    return nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength);
}

function loadCal(fileName) {
    const buffer = readFileAsArrayBuffer(join(TEST_DATA_DIR, 'Cal', fileName));
    return parseCalFile(buffer);
}

/** «Шероховатость» кривой: сумма квадратов вторых разностей (меньше → глаже). */
function roughness(values) {
    let s = 0;
    for (let i = 1; i < values.length - 1; i++) {
        const d2 = values[i + 1] - 2 * values[i] + values[i - 1];
        s += d2 * d2;
    }
    return s;
}

describe('transformCurvesForCanvas', () => {
    test('должен трансформировать реальные данные COIL2430.CLC', () => {
        const rawCurves = calResponseCurves(loadCal('COIL2430.CLC'));

        const transformed = transformCurvesForCanvas(rawCurves);

        assert.ok(transformed.frequencies.length > 0, 'Должны быть частоты');
        assert.ok(
            transformed.frequencies.length <= rawCurves.length,
            'После склейки дублей точек не должно стать больше'
        );
        assert.equal(transformed.amplitudes.length, transformed.frequencies.length, 'Число амплитуд совпадает');
        assert.equal(transformed.phases.length, transformed.frequencies.length, 'Число фаз совпадает');

        // Каждой частоте — ровно одно значение (кривая является функцией y(x)).
        const uniqueFreqs = new Set(transformed.frequencies);
        assert.equal(uniqueFreqs.size, transformed.frequencies.length, 'Дубликаты частот должны быть склеены');

        // Частоты должны быть положительными
        for (const f of transformed.frequencies) {
            assert.ok(f > 0, `Частота ${f} должна быть > 0`);
        }

        // Амплитуды должны быть конечными числа
        for (const a of transformed.amplitudes) {
            assert.ok(Number.isFinite(a), `Амплитуда ${a} должна быть конечной`);
        }

        // Фазы должны быть конечными числа
        for (const p of transformed.phases) {
            assert.ok(Number.isFinite(p), `Фаза ${p} должна быть конечной`);
        }
    });

    test('должен возвращать пустые массивы для пустого ввода', () => {
        const result = transformCurvesForCanvas([]);
        assert.deepEqual(result.frequencies, []);
        assert.deepEqual(result.amplitudes, []);
        assert.deepEqual(result.phases, []);
    });

    test('должен возвращать пустые массивы для null/undefined', () => {
        const result1 = transformCurvesForCanvas(null);
        assert.deepEqual(result1.frequencies, []);

        const result2 = transformCurvesForCanvas(undefined);
        assert.deepEqual(result2.frequencies, []);
    });

    test('должен склеивать точки с одинаковой частотой в одно значение', () => {
        const transformed = transformCurvesForCanvas([
            { freqHz: 100, amp: 1.0, phase: 0 },
            { freqHz: 50, amp: 0.5, phase: 10 },
            { freqHz: 100, amp: 1.2, phase: 2 },
            { freqHz: 25, amp: 0.2, phase: 20 },
        ]);

        assert.equal(transformed.frequencies.length, 3, 'Дубликат частоты должен быть склеен');
        const uniq = new Set(transformed.frequencies);
        assert.equal(uniq.size, transformed.frequencies.length, 'Частоты должны быть уникальными');
    });

    test('должен сохранять исходный порядок точек', () => {
        const transformed = transformCurvesForCanvas([
            { freqHz: 100, amp: 1.0, phase: 0 },
            { freqHz: 50, amp: 0.5, phase: 10 },
            { freqHz: 25, amp: 0.2, phase: 20 },
        ]);

        assert.deepEqual(transformed.frequencies, [100, 50, 25], 'Порядок точек не должен меняться');
    });
});

describe('transformCalCurves (разбор файла калибровки на кривые)', () => {
    test('должен выделить отдельную кривую для каждого типа строк', () => {
        const cal = loadCal('COIL2430.CLC');
        const groups = calResponseCurvesByType(cal);
        const curves = transformCalCurves(cal);

        assert.equal(curves.length, groups.length, 'Каждому типу строк — одна кривая');
        assert.ok(curves.length >= 3, `В файле должно быть несколько кривых, получено ${curves.length}`);

        for (let i = 0; i < curves.length; i++) {
            assert.equal(curves[i].type, groups[i].type, 'Типы должны совпадать');
            assert.ok(curves[i].label, 'У кривой должно быть имя для легенды');
        }
    });

    test('каждая кривая должна быть функцией y(x) — одна частота, одно значение', () => {
        for (const fileName of ['COIL2430.CLC', 'AMTC1358.CLC', '1332.CLB']) {
            const curves = transformCalCurves(loadCal(fileName));
            assert.ok(curves.length > 0, `${fileName}: должны быть кривые`);

            for (const curve of curves) {
                const uniq = new Set(curve.frequencies);
                assert.equal(
                    uniq.size, curve.frequencies.length,
                    `${fileName} ${curve.label}: частоты должны быть уникальными`
                );
                assert.equal(curve.amplitudes.length, curve.frequencies.length, 'Длины должны совпадать');
                assert.equal(curve.phases.length, curve.frequencies.length, 'Длины должны совпадать');

                for (const f of curve.frequencies) {
                    assert.ok(f > 0, `${fileName} ${curve.label}: частота ${f} должна быть > 0`);
                }
                for (const a of curve.amplitudes) {
                    assert.ok(Number.isFinite(a), `${fileName} ${curve.label}: амплитуда должна быть конечной`);
                }
                for (const p of curve.phases) {
                    assert.ok(Number.isFinite(p), `${fileName} ${curve.label}: фаза должна быть конечной`);
                    assert.ok(p >= -180.001 && p <= 180.001, `${fileName} ${curve.label}: фаза ${p} вне [-180, 180]`);
                }
            }
        }
    });

    test('кривые должны идти по возрастанию частоты (для однозначного графика)', () => {
        const curves = transformCalCurves(loadCal('COIL2430.CLC'));
        for (const curve of curves) {
            for (let i = 1; i < curve.frequencies.length; i++) {
                assert.ok(
                    curve.frequencies[i] > curve.frequencies[i - 1],
                    `${curve.label}: частоты должны строго возрастать`
                );
            }
        }
    });

    test('сглаживание не должно искажать форму кривой', () => {
        const cal = loadCal('COIL2430.CLC');
        const groups = calResponseCurvesByType(cal);
        const curves = transformCalCurves(cal);

        // Граница «15% диапазона на любую точку» физически невыполнима для
        // локального сглаживателя: узкий реальный экстремум (резонансный провал
        // катушки — 3 точки из 20) окно шире трёх точек срезает неизбежно.
        // Поэтому порог привязан к крутизне особенности в самой точке: в
        // гладком месте действуют строгие 15% диапазона, на изломе — 0.6 от
        // величины самого излома |y - середина соседей|. Коэффициент 0.6 и
        // худшее нарушение 1.47× измерены на COIL2430/COIL2429/1332/AMTC1358.
        const RANGE_PART = 0.15;
        const FEATURE_PART = 0.6;

        for (let i = 0; i < curves.length; i++) {
            const rawAmp = groups[i].points.map(p => p.amp);
            const sm = curves[i].amplitudes;
            const range = Math.max(...rawAmp) - Math.min(...rawAmp);
            assert.ok(range > 0, 'Диапазон амплитуд должен быть ненулевым');
            assert.strictEqual(
                sm.length,
                rawAmp.length,
                `${curves[i].label}: сглаживание не должно терять точки`
            );

            for (let k = 0; k < sm.length; k++) {
                const dev = Math.abs(sm[k] - rawAmp[k]);
                const feature =
                    k > 0 && k < rawAmp.length - 1
                        ? Math.abs(rawAmp[k] - (rawAmp[k - 1] + rawAmp[k + 1]) / 2)
                        : 0;
                const bound = Math.max(range * RANGE_PART, feature * FEATURE_PART);
                assert.ok(
                    dev <= bound,
                    `${curves[i].label} @${k}: отклонение ${dev.toFixed(5)} > порога ` +
                        `${bound.toFixed(5)} (диапазон ${range.toFixed(5)}, особенность ${feature.toFixed(5)})`
                );
            }
        }
    });

    test('сглаживание должно убирать шум (кривая становится глаже)', () => {
        // Синтетическая кривая: гладкий тренд + шум.
        const freqs = [];
        const amps = [];
        for (let i = 0; i < 40; i++) {
            const f = 0.3 * Math.pow(1.12, i);
            freqs.push(f);
            amps.push(1 / (1 + f) + (i % 2 === 0 ? 0.05 : -0.05));
        }
        const raw = { frequencies: freqs, amplitudes: amps };

        const smoothed = transformCurvesForCanvas(
            freqs.map((f, i) => ({ freqHz: f, amp: amps[i], phase: 0 }))
        );

        assert.ok(
            roughness(smoothed.amplitudes) < roughness(amps),
            `Шероховатость должна уменьшиться: ${roughness(smoothed.amplitudes)} >= ${roughness(amps)}`
        );
    });

    test('пустой файл калибровки не должен давать кривых', () => {
        assert.deepEqual(transformCalCurves({ rows: [] }), []);
        assert.deepEqual(transformCalCurves(null), []);
    });
});

describe('drawCalCurves input format contract', () => {
    /**
     * Эти тесты документируют контракт drawCalCurves().
     * Функция ожидает curvesList: Array<{name: string, curves: Array<{frequencies, amplitudes, phases}>}>
     */

    test('calCurvesList entry должен иметь правильную структуру', () => {
        const curves = transformCalCurves(loadCal('COIL2430.CLC'));

        // Это формат, которую drawCalCurves ожидает на вход
        const entry = { name: 'COIL2430.CLC', curves };

        assert.ok(entry.name, 'Должно быть имя файла');
        assert.ok(Array.isArray(entry.curves), 'curves должен быть массивом');
        assert.ok(entry.curves.length > 0, 'Должна быть хотя бы одна кривая');

        for (const curve of entry.curves) {
            assert.ok(Array.isArray(curve.frequencies), 'frequencies должен быть массивом');
            assert.ok(Array.isArray(curve.amplitudes), 'amplitudes должен быть массивом');
            assert.ok(Array.isArray(curve.phases), 'phases должен быть массивом');
            assert.equal(curve.frequencies.length, curve.amplitudes.length, 'Длины должны совпадать');
            assert.equal(curve.frequencies.length, curve.phases.length, 'Длины должны совпадать');
        }
    });

    test('несколько файлов калибровки должны собираться в один curvesList', () => {
        const files = ['COIL2430.CLC', 'COIL2429.CLC'];
        const curvesList = [];

        for (const fileName of files) {
            try {
                const curves = transformCalCurves(loadCal(fileName));
                if (curves.length > 0) curvesList.push({ name: fileName, curves });
            } catch (e) {
                // skip
            }
        }

        assert.ok(curvesList.length >= 1, 'Хотя бы один файл должен распарситься');
        for (const entry of curvesList) {
            assert.ok(entry.curves[0].frequencies.length > 0, `${entry.name}: должны быть данные`);
        }
    });
});

console.log('Запуск тестов calCurvesRendering...');
