/**
 * calCurvesDrag.test.js — математика перетаскивания точки калибровочной кривой.
 * Запуск: node --test MTZ_S/tests/js/*.test.js  (или: cd MTZ_S/tests/js && node --test)
 *
 * Проверяют РЕАЛЬНЫЕ экспорты phoenixImport.js (TDD: написаны ДО кода).
 *
 * Баг, который исправляется: при перетаскивании точки диапазоны осей
 * пересчитывались на каждый кадр. Из-за этого значение максимальной точки
 * всегда становилось новым максимумом → точка рисовалась ровно у верхней
 * границы графика → «прилипала к краю» и её нельзя было увести выше.
 *
 * Ожидаемое поведение: на время перетаскивания масштаб (value-per-pixel)
 * ЗАМОРАЖИВАЕТСЯ, значение меняется 1:1 с движением мыши, а окно оси
 * панорамируется, если точка выходит за границы графика.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { computeDragUpdate, pointerToCanvas } =
    await import('../../front/js/import/phoenix/phoenixImport.js');

// Та же геометрия, что у drawCalCurves: 600×260, pad {top:30,right:20,bottom:40,left:60}
const AREA = {
    pad: { top: 30, right: 20, bottom: 40, left: 60 },
    plotW: 520,
    plotH: 190,
    W: 600,
    H: 260,
};

describe('computeDragUpdate', () => {
    test('движение мыши вверх увеличивает значение ровно 1:1 к замороженному масштабу', () => {
        const scale = 35 / 190;          // 35 единиц значения на всю высоту графика
        const grabValue = 30;            // значение точки в момент захвата
        const grabY = 100;

        const upd = computeDragUpdate(scale, AREA, grabValue, grabY, grabY - 20); // мышь на 20px выше

        assert.ok(Math.abs(upd.value - (30 + 20 * scale)) < 1e-9,
            `значение должно вырасти на 20*scale, получено ${upd.value}`);
    });

    test('движение вниз уменьшает значение (симметрично)', () => {
        const scale = 35 / 190;
        const upd = computeDragUpdate(scale, AREA, 30, 100, 120);
        assert.ok(Math.abs(upd.value - (30 - 20 * scale)) < 1e-9, `получено ${upd.value}`);
    });

    test('нулевое движение мыши не меняет значение', () => {
        const upd = computeDragUpdate(1, AREA, 7.5, 120, 120);
        assert.equal(upd.value, 7.5);
    });

    test('внутри графика точка остаётся ровно под курсором (нет «прилипания»)', () => {
        const scale = 35 / 190;
        const grabValue = 20;
        const grabY = 150;
        const currentY = 90;

        const upd = computeDragUpdate(scale, AREA, grabValue, grabY, currentY);

        // экранная позиция нового значения по обновлённому окну оси
        const plotBottom = AREA.pad.top + AREA.plotH;
        const drawnY = plotBottom - (upd.value - upd.min) / scale;
        assert.ok(Math.abs(drawnY - currentY) < 1e-6,
            `точка должна быть под курсором: drawnY=${drawnY}, currentY=${currentY}`);
    });

    test('перетаскивание ВЫШЕ максимума: значение продолжает расти (главная регрессия бага)', () => {
        const scale = 35 / 190;
        const grabValue = 30;   // это текущий максимум кривой
        const grabY = 30;       // максимум рисуется у верхней границы графика

        // тянем мышь на 40px выше верхней границы графика (за пределы оси)
        const upd = computeDragUpdate(scale, AREA, grabValue, grabY, -40);

        assert.ok(upd.value > grabValue + 30 * scale,
            `значение должно уйти за старый максимум: ${upd.value} > ${grabValue}`);
        // сама точка остаётся видимой — прижат к верхней границе, а не улетает за canvas
        assert.equal(upd.targetY, AREA.pad.top, 'точка не должна выходить за верхнюю границу графика');
        // и нарисована она именно там, где прижата
        const plotBottom = AREA.pad.top + AREA.plotH;
        const drawnY = plotBottom - (upd.value - upd.min) / scale;
        assert.ok(Math.abs(drawnY - AREA.pad.top) < 1e-6, `drawnY=${drawnY}`);
    });

    test('перетаскивание НИЖЕ минимума: симметричное поведение', () => {
        const scale = 35 / 190;
        const bottomY = AREA.pad.top + AREA.plotH;
        const upd = computeDragUpdate(scale, AREA, -5, bottomY, bottomY + 50);

        assert.ok(upd.value < -5 - 40 * scale, `получено ${upd.value}`);
        assert.equal(upd.targetY, bottomY, 'точка не должна уходить за нижнюю границу');
    });

    test('окно оси не меняет ширина/масштаб (только сдвиг) — range не возвращается', () => {
        const scale = 2;
        const upd = computeDragUpdate(scale, AREA, 100, 200, 0);
        assert.equal(typeof upd.min, 'number');
        assert.equal(typeof upd.value, 'number');
        assert.ok(Number.isFinite(upd.min) && Number.isFinite(upd.value));
    });

    test('плохой area (plotH = 0) не должен давать NaN', () => {
        const broken = { pad: { top: 0, right: 0, bottom: 0, left: 0 }, plotW: 0, plotH: 0, W: 0, H: 0 };
        const upd = computeDragUpdate(1, broken, 5, 0, 10);
        assert.ok(Number.isFinite(upd.value), 'значение конечно');
        assert.ok(Number.isFinite(upd.min), 'min конечен');
    });
});

describe('pointerToCanvas', () => {
    test('без CSS-масштабирования координаты просто смещаются на левый верхний угол', () => {
        const rect = { left: 100, top: 50, width: 600, height: 260 };
        const p = pointerToCanvas(rect, 600, 260, 160, 60);
        assert.ok(Math.abs(p.x - 60) < 1e-9, `x=${p.x}`);
        assert.ok(Math.abs(p.y - 10) < 1e-9, `y=${p.y}`);
        assert.equal(p.inside, true);
    });

    test('canvas, растянутый CSS (мобильный), масштабируется обратно', () => {
        // внутренние пиксели 600×260, на экране 300×130 → масштаб 2×
        const rect = { left: 0, top: 0, width: 300, height: 130 };
        const p = pointerToCanvas(rect, 600, 260, 150, 65);
        assert.ok(Math.abs(p.x - 300) < 1e-9, `x=${p.x}`);
        assert.ok(Math.abs(p.y - 130) < 1e-9, `y=${p.y}`);
        assert.equal(p.inside, true);
    });

    test('курсор вне canvas помечается как вне', () => {
        const rect = { left: 0, top: 0, width: 600, height: 260 };
        assert.equal(pointerToCanvas(rect, 600, 260, -5, 100).inside, false);
        assert.equal(pointerToCanvas(rect, 600, 260, 700, 100).inside, false);
    });

    test('нулевой rect (скрытый элемент) не даёт NaN', () => {
        const p = pointerToCanvas({ left: 0, top: 0, width: 0, height: 0 }, 600, 260, 10, 10);
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'координаты конечны');
    });

    test('null rect не роняет функцию', () => {
        const p = pointerToCanvas(null, 600, 260, 10, 10);
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    });
});

console.log('Запуск тестов calCurvesDrag...');
