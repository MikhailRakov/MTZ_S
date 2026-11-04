/**
 * Тесты для редактора калибровочных кривых (drag-and-drop точек).
 * Проверяет математику преобразования координат и применение изменений.
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

// ---------------------------------------------------------------------------
// Логика редактора (будет реализована в dashboardCoarseIntegration.js)
// Эти функции тестируются изолированно от DOM/canvas.
// ---------------------------------------------------------------------------

/**
 * Параметры области графика (те же что в drawCalCurves).
 */
function computePlotArea(canvasW, canvasH) {
    const pad = { top: 30, right: 20, bottom: 40, left: 60 };
    return {
        pad,
        plotW: canvasW - pad.left - pad.right,
        plotH: canvasH - pad.top - pad.bottom,
    };
}

/**
 * Преобразование индекса точки → экранные координаты (для амплитуды).
 */
function pointToScreen(index, frequencies, amplitudes, plotArea, logFMin, logFMax, ampMin, ampRange) {
    const f = frequencies[index];
    const a = amplitudes[index];
    if (f <= 0) return null;
    const x = plotArea.pad.left + ((Math.log10(f) - logFMin) / (logFMax - logFMin)) * plotArea.plotW;
    const y = plotArea.pad.top + plotArea.plotH - ((a - ampMin) / ampRange) * plotArea.plotH;
    return { x, y };
}

/**
 * Поиск ближайшей точки к курсору мыши.
 * @returns {{index: number, distance: number, channel: 'amp'|'phase'}|null}
 */
function findNearestPoint(mouseX, mouseY, frequencies, amplitudes, phases, plotArea, logFMin, logFMax, ampMin, ampRange, phMin, phRange, hitRadius = 10) {
    let best = null;
    for (let i = 0; i < frequencies.length; i++) {
        if (frequencies[i] <= 0) continue;
        const logF = Math.log10(frequencies[i]);
        const x = plotArea.pad.left + ((logF - logFMin) / (logFMax - logFMin)) * plotArea.plotW;

        // Амплитуда
        const yAmp = plotArea.pad.top + plotArea.plotH - ((amplitudes[i] - ampMin) / ampRange) * plotArea.plotH;
        const distAmp = Math.hypot(mouseX - x, mouseY - yAmp);
        if (distAmp <= hitRadius && (!best || distAmp < best.distance)) {
            best = { index: i, distance: distAmp, channel: 'amp' };
        }

        // Фаза
        const yPh = plotArea.pad.top + plotArea.plotH - ((phases[i] - phMin) / phRange) * plotArea.plotH;
        const distPh = Math.hypot(mouseX - x, mouseY - yPh);
        if (distPh <= hitRadius && (!best || distPh < best.distance)) {
            best = { index: i, distance: distPh, channel: 'phase' };
        }
    }
    return best;
}

/**
 * Применение drag: пересчёт Y-координаты мыши → новое значение амплитуды или фазы.
 * X не меняется (частота фиксирована при drag).
 */
function screenYtoValue(screenY, plotArea, valMin, valRange) {
    const ratio = (plotArea.pad.top + plotArea.plotH - screenY) / plotArea.plotH;
    return valMin + ratio * valRange;
}

/**
 * Создание копии данных кривой для undo.
 */
function cloneCurveData(curve) {
    return {
        frequencies: [...curve.frequencies],
        amplitudes: [...curve.amplitudes],
        phases: [...curve.phases],
    };
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

describe('computePlotArea', () => {
    test('должен вычислять правильные размеры области графика', () => {
        const area = computePlotArea(600, 260);
        assert.equal(area.plotW, 600 - 60 - 20, 'plotW = W - left - right');
        assert.equal(area.plotH, 260 - 30 - 40, 'plotH = H - top - bottom');
        assert.equal(area.pad.top, 30);
        assert.equal(area.pad.left, 60);
    });
});

describe('pointToScreen', () => {
    test('должен корректно преобразовывать точку в экранные координаты', () => {
        const freqs = [10, 1, 0.1];
        const amps = [1.0, 0.5, 0.1];
        const area = computePlotArea(600, 260);
        const logFMin = Math.log10(0.1);
        const logFMax = Math.log10(10);
        const ampMin = 0.1;
        const ampRange = 1.0 - 0.1;

        // Первая точка (f=10, amp=1.0) — верхний правый угол
        const p0 = pointToScreen(0, freqs, amps, area, logFMin, logFMax, ampMin, ampRange);
        assert.ok(Math.abs(p0.x - (area.pad.left + area.plotW)) < 1, 'x должен быть у правого края');
        assert.ok(Math.abs(p0.y - area.pad.top) < 1, 'y должен быть у верхнего края (max amp)');

        // Последняя точка (f=0.1, amp=0.1) — нижний левый угол
        const p2 = pointToScreen(2, freqs, amps, area, logFMin, logFMax, ampMin, ampRange);
        assert.ok(Math.abs(p2.x - area.pad.left) < 1, 'x должен быть у левого края');
        assert.ok(Math.abs(p2.y - (area.pad.top + area.plotH)) < 1, 'y должен быть у нижнего края (min amp)');
    });

    test('должен возвращать null для неположительной частоты', () => {
        const result = pointToScreen(0, [0], [1], computePlotArea(600, 260), -1, 1, 0, 1);
        assert.equal(result, null);
    });
});

describe('findNearestPoint', () => {
    const freqs = [10, 1, 0.1];
    const amps = [1.0, 0.5, 0.1];
    const phases = [0.5, 0.3, 0.1];
    const area = computePlotArea(600, 260);
    const logFMin = Math.log10(0.1);
    const logFMax = Math.log10(10);
    const ampMin = 0.1, ampRange = 0.9;
    const phMin = 0.1, phRange = 0.4;

    test('должен находить ближайшую точку по амплитуде', () => {
        // Координаты точки 0 (amp)
        const screen = pointToScreen(0, freqs, amps, area, logFMin, logFMax, ampMin, ampRange);
        const hit = findNearestPoint(screen.x, screen.y, freqs, amps, phases, area, logFMin, logFMax, ampMin, ampRange, phMin, phRange);
        assert.ok(hit, 'Должна найтись точка');
        assert.equal(hit.index, 0);
        assert.equal(hit.channel, 'amp');
        assert.ok(hit.distance < 1, 'Расстояние должно быть ~0');
    });

    test('должен находить ближайшую точку по фазе', () => {
        // Координаты точки 1 (phase)
        const f = freqs[1];
        const x = area.pad.left + ((Math.log10(f) - logFMin) / (logFMax - logFMin)) * area.plotW;
        const y = area.pad.top + area.plotH - ((phases[1] - phMin) / phRange) * area.plotH;
        const hit = findNearestPoint(x, y, freqs, amps, phases, area, logFMin, logFMax, ampMin, ampRange, phMin, phRange);
        assert.ok(hit, 'Должна найтись точка');
        assert.equal(hit.index, 1);
        assert.equal(hit.channel, 'phase');
    });

    test('должен возвращать null если курсор далеко от всех точек', () => {
        const hit = findNearestPoint(0, 0, freqs, amps, phases, area, logFMin, logFMax, ampMin, ampRange, phMin, phRange, 10);
        assert.equal(hit, null, 'Не должно быть попаданий');
    });

    test('должен предпочитать ближайшую точку при перекрытии', () => {
        // Курсор точно на точке 2 (amp)
        const screen = pointToScreen(2, freqs, amps, area, logFMin, logFMax, ampMin, ampRange);
        const hit = findNearestPoint(screen.x, screen.y, freqs, amps, phases, area, logFMin, logFMax, ampMin, ampRange, phMin, phRange);
        assert.equal(hit.index, 2);
    });

    test('hitRadius должен ограничивать зону захвата', () => {
        const screen = pointToScreen(0, freqs, amps, area, logFMin, logFMax, ampMin, ampRange);
        // Сдвигаем на 15px — за пределами дефолтного hitRadius=10
        const hit = findNearestPoint(screen.x + 15, screen.y, freqs, amps, phases, area, logFMin, logFMax, ampMin, ampRange, phMin, phRange, 10);
        assert.equal(hit, null, 'За пределами hitRadius не должно быть попаданий');

        // Но с увеличенным radius=20 должно найтись
        const hit2 = findNearestPoint(screen.x + 15, screen.y, freqs, amps, phases, area, logFMin, logFMax, ampMin, ampRange, phMin, phRange, 20);
        assert.ok(hit2, 'С увеличенным radius должна найтись точка');
    });
});

describe('screenYtoValue', () => {
    test('верхний край → максимальное значение', () => {
        const area = computePlotArea(600, 260);
        const val = screenYtoValue(area.pad.top, area, 0, 10);
        assert.ok(Math.abs(val - 10) < 0.01, `Верхний край → max, получено ${val}`);
    });

    test('нижний край → минимальное значение', () => {
        const area = computePlotArea(600, 260);
        const val = screenYtoValue(area.pad.top + area.plotH, area, 0, 10);
        assert.ok(Math.abs(val - 0) < 0.01, `Нижний край → min, получено ${val}`);
    });

    test('середина → среднее значение', () => {
        const area = computePlotArea(600, 260);
        const midY = area.pad.top + area.plotH / 2;
        const val = screenYtoValue(midY, area, 0, 10);
        assert.ok(Math.abs(val - 5) < 0.01, `Середина → 5, получено ${val}`);
    });

    test('должен работать с отрицательными диапазонами (фаза)', () => {
        const area = computePlotArea(600, 260);
        const valTop = screenYtoValue(area.pad.top, area, -Math.PI, 2 * Math.PI);
        assert.ok(Math.abs(valTop - Math.PI) < 0.01, `Верх → π, получено ${valTop}`);
        const valBot = screenYtoValue(area.pad.top + area.plotH, area, -Math.PI, 2 * Math.PI);
        assert.ok(Math.abs(valBot - (-Math.PI)) < 0.01, `Низ → -π, получено ${valBot}`);
    });
});

describe('cloneCurveData', () => {
    test('должен создавать независимую копию', () => {
        const original = {
            frequencies: [10, 1, 0.1],
            amplitudes: [1.0, 0.5, 0.1],
            phases: [0.5, 0.3, 0.1],
        };
        const clone = cloneCurveData(original);

        assert.deepEqual(clone.frequencies, original.frequencies);
        assert.deepEqual(clone.amplitudes, original.amplitudes);
        assert.deepEqual(clone.phases, original.phases);

        // Изменение клона не влияет на оригинал
        clone.amplitudes[0] = 999;
        assert.equal(original.amplitudes[0], 1.0, 'Оригинал не должен измениться');
    });
});

describe('drag-and-drop on real data', () => {
    test('полный цикл: найти точку → перетащить → проверить новое значение', () => {
        const clcPath = join(TEST_DATA_DIR, 'Cal', 'COIL2430.CLC');
        const buffer = readFileAsArrayBuffer(clcPath);
        const rawCurves = calResponseCurves(parseCalFile(buffer));

        const freqs = rawCurves.map(c => c.freqHz);
        const amps = rawCurves.map(c => c.amp);
        const phases = rawCurves.map(c => c.phase);

        const area = computePlotArea(600, 260);
        const fMin = Math.min(...freqs.filter(f => f > 0));
        const fMax = Math.max(...freqs);
        const logFMin = Math.log10(fMin);
        const logFMax = Math.log10(fMax);
        const ampMin = Math.min(...amps);
        const ampMax = Math.max(...amps);
        const ampRange = ampMax - ampMin || 1;
        const phMin = Math.min(...phases);
        const phMax = Math.max(...phases);
        const phRange = phMax - phMin || 1;

        // 1. Находим точку в середине
        const midIdx = Math.floor(freqs.length / 2);
        const screen = pointToScreen(midIdx, freqs, amps, area, logFMin, logFMax, ampMin, ampRange);
        assert.ok(screen, 'Точка должна иметь экранные координаты');

        // 2. Ищем ближайшую точку к этим координатам
        const hit = findNearestPoint(screen.x, screen.y, freqs, amps, phases, area, logFMin, logFMax, ampMin, ampRange, phMin, phRange);
        assert.ok(hit, 'Должна найтись точка');
        assert.equal(hit.index, midIdx, 'Должна найтись именно средняя точка');
        assert.equal(hit.channel, 'amp');

        // 3. Симулируем drag вверх на 20px
        const newY = screen.y - 20;
        const newAmp = screenYtoValue(newY, area, ampMin, ampRange);
        assert.ok(newAmp > amps[midIdx], `Новая амплитуда ${newAmp} должна быть больше старой ${amps[midIdx]} (drag вверх)`);

        // 4. Применяем изменение
        const editedAmps = [...amps];
        editedAmps[midIdx] = newAmp;
        assert.notEqual(editedAmps[midIdx], amps[midIdx], 'Значение должно измениться');
        assert.equal(editedAmps[midIdx - 1], amps[midIdx - 1], 'Соседние точки не должны измениться');
    });

    test('undo: восстановление из клона', () => {
        const original = {
            frequencies: [10, 1, 0.1],
            amplitudes: [1.0, 0.5, 0.1],
            phases: [0.5, 0.3, 0.1],
        };
        const backup = cloneCurveData(original);

        // "Редактируем"
        original.amplitudes[1] = 999;
        assert.equal(original.amplitudes[1], 999);

        // Undo
        original.amplitudes[1] = backup.amplitudes[1];
        assert.equal(original.amplitudes[1], 0.5, 'Undo должен восстановить значение');
    });
});

console.log('Запуск тестов calCurvesEditor...');
