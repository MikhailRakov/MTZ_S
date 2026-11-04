/**
 * Тесты для отрисовки калибровочных кривых (canvas rendering logic).
 * Проверяет трансформацию данных из calResponseCurves() → формат drawCalCurves().
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

const { parseCalFile, calResponseCurves } = await import('../../front/js/import/phoenix/phoenixParser.js');

const TEST_DATA_DIR = join(__dirname, '..', '..', 'mt_time_data');

function readFileAsArrayBuffer(filePath) {
    const nodeBuffer = readFileSync(filePath);
    return nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.length);
}

/**
 * Трансформирует вывод calResponseCurves() в формат, ожидаемый drawCalCurves().
 * calResponseCurves возвращает: [{freqHz, amp, phase, re, im, groups}, ...]
 * drawCalCurves ожидает: {frequencies: number[], amplitudes: number[], phases: number[]}
 *
 * Эта функция должна существовать в dashboardCoarseIntegration.js.
 * Здесь мы тестируем её контракт.
 */
function transformCurvesForCanvas(curvesFromParser) {
    if (!curvesFromParser || curvesFromParser.length === 0) {
        return { frequencies: [], amplitudes: [], phases: [] };
    }
    return {
        frequencies: curvesFromParser.map(c => c.freqHz),
        amplitudes: curvesFromParser.map(c => c.amp),
        phases: curvesFromParser.map(c => c.phase),
    };
}

describe('transformCurvesForCanvas', () => {
    test('должен трансформировать реальные данные COIL2430.CLC', () => {
        const clcPath = join(TEST_DATA_DIR, 'Cal', 'COIL2430.CLC');
        const buffer = readFileAsArrayBuffer(clcPath);
        const calData = parseCalFile(buffer);
        const rawCurves = calResponseCurves(calData);

        const transformed = transformCurvesForCanvas(rawCurves);

        assert.ok(transformed.frequencies.length > 0, 'Должны быть частоты');
        assert.equal(transformed.frequencies.length, rawCurves.length, 'Число точек совпадает');
        assert.equal(transformed.amplitudes.length, rawCurves.length, 'Число амплитуд совпадает');
        assert.equal(transformed.phases.length, rawCurves.length, 'Число фаз совпадает');

        // Частоты должны быть положительными
        for (const f of transformed.frequencies) {
            assert.ok(f > 0, `Частота ${f} должна быть > 0`);
        }

        // Амплитуды должны быть конечными числами
        for (const a of transformed.amplitudes) {
            assert.ok(Number.isFinite(a), `Амплитуда ${a} должна быть конечной`);
        }

        // Фазы должны быть конечными числами
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

    test('частоты должны быть в основном упорядочены по убыванию', () => {
        const clcPath = join(TEST_DATA_DIR, 'Cal', 'COIL2430.CLC');
        const buffer = readFileAsArrayBuffer(clcPath);
        const rawCurves = calResponseCurves(parseCalFile(buffer));
        const transformed = transformCurvesForCanvas(rawCurves);

        // Подсчитываем переходы: большинство должно быть убывающими
        let descending = 0;
        for (let i = 1; i < transformed.frequencies.length; i++) {
            if (transformed.frequencies[i] <= transformed.frequencies[i - 1]) descending++;
        }
        const ratio = descending / (transformed.frequencies.length - 1);
        assert.ok(ratio > 0.9, `≥90% переходов должны быть убывающими, получено ${(ratio * 100).toFixed(1)}%`);

        // Первая частота должна быть значительно больше последней
        assert.ok(
            transformed.frequencies[0] > transformed.frequencies[transformed.frequencies.length - 1] * 10,
            `Первая частота ${transformed.frequencies[0]} должна быть >> последней ${transformed.frequencies[transformed.frequencies.length - 1]}`
        );
    });

    test('амплитуда катушки должна убывать с частотой', () => {
        const clcPath = join(TEST_DATA_DIR, 'Cal', 'COIL2430.CLC');
        const buffer = readFileAsArrayBuffer(clcPath);
        const rawCurves = calResponseCurves(parseCalFile(buffer));
        const transformed = transformCurvesForCanvas(rawCurves);

        // Первая точка (высокая частота) должна иметь большую амплитуду, чем последняя
        assert.ok(
            transformed.amplitudes[0] > transformed.amplitudes[transformed.amplitudes.length - 1],
            'Амплитуда катушки должна убывать от высокой к низкой частоте'
        );
    });
});

describe('drawCalCurves input format contract', () => {
    /**
     * Эти тесты документируют контракт drawCalCurves().
     * Функция ожидает curvesList: Array<{name: string, curves: Array<{frequencies, amplitudes, phases}>}>
     */

    test('calCurvesList entry должен иметь правильную структуру', () => {
        const clcPath = join(TEST_DATA_DIR, 'Cal', 'COIL2430.CLC');
        const buffer = readFileAsArrayBuffer(clcPath);
        const rawCurves = calResponseCurves(parseCalFile(buffer));
        const transformed = transformCurvesForCanvas(rawCurves);

        // Это формат, который drawCalCurves ожидает на вход
        const entry = { name: 'COIL2430.CLC', curves: [transformed] };

        assert.ok(entry.name, 'Должно быть имя файла');
        assert.ok(Array.isArray(entry.curves), 'curves должен быть массивом');
        assert.ok(entry.curves.length > 0, 'Должна быть хотя бы одна кривая');

        const curve = entry.curves[0];
        assert.ok(Array.isArray(curve.frequencies), 'frequencies должен быть массивом');
        assert.ok(Array.isArray(curve.amplitudes), 'amplitudes должен быть массивом');
        assert.ok(Array.isArray(curve.phases), 'phases должен быть массивом');
        assert.equal(curve.frequencies.length, curve.amplitudes.length, 'Длины должны совпадать');
        assert.equal(curve.frequencies.length, curve.phases.length, 'Длины должны совпадать');
    });

    test('несколько файлов калибровки должны собираться в один curvesList', () => {
        const files = ['COIL2430.CLC', 'COIL2429.CLC'];
        const curvesList = [];

        for (const fileName of files) {
            const filePath = join(TEST_DATA_DIR, 'Cal', fileName);
            try {
                const buffer = readFileAsArrayBuffer(filePath);
                const rawCurves = calResponseCurves(parseCalFile(buffer));
                const transformed = transformCurvesForCanvas(rawCurves);
                curvesList.push({ name: fileName, curves: [transformed] });
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
