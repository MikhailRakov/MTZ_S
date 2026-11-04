/**
 * stationPlot.test.js — тесты 2D-схемы расположения станций (вид сверху, физические метры).
 * TDD: тесты написаны ДО реализации.
 * Запуск: node --test MTZ_S/tests/js/*.test.js  (или: cd MTZ_S/tests/js && node --test)
 *
 * Проверяют РЕАЛЬНЫЕ функции из front/js/import/phoenix/stationPlot.js:
 *  - stationsToLocalMeters(stations)   — lat/lon → локальные метры (север/восток)
 *  - stationPlotLayout(stations, w, h)  — размещение точек в пикселях (равный масштаб)
 *  - chooseGridStep(scale)              — «красивый» шаг сетки в метрах
 *  - formatDistance(m)                 — форматирование расстояния
 *  - findNearestStationPoint(...)      — попадание клика по точке
 *  - drawStationPlot(ctx, layout)      — отрисовка схемы (на фейковом ctx)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
    EARTH_RADIUS_M,
    stationsToLocalMeters,
    stationPlotLayout,
    chooseGridStep,
    formatDistance,
    formatOffset,
    findNearestStationPoint,
    drawStationPlot,
} = await import('../../front/js/import/phoenix/stationPlot.js');

const DEG = Math.PI / 180;

function makeCtx() {
    const ops = [];
    const ctx = {
        ops,
        fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
        globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic', lineCap: 'butt',
        setLineDash() { ops.push({ op: 'setLineDash' }); },
        save() { ops.push({ op: 'save' }); },
        restore() { ops.push({ op: 'restore' }); },
        clearRect(...a) { ops.push({ op: 'clearRect', a }); },
        fillRect(...a) { ops.push({ op: 'fillRect', a, fill: this.fillStyle }); },
        beginPath() { ops.push({ op: 'beginPath' }); },
        closePath() { ops.push({ op: 'closePath' }); },
        moveTo(...a) { ops.push({ op: 'moveTo', a }); },
        lineTo(...a) { ops.push({ op: 'lineTo', a }); },
        stroke() { ops.push({ op: 'stroke', stroke: this.strokeStyle }); },
        fill() { ops.push({ op: 'fill', fill: this.fillStyle }); },
        arc(...a) { ops.push({ op: 'arc', a, fill: this.fillStyle, stroke: this.strokeStyle }); },
        fillText(...a) { ops.push({ op: 'fillText', text: a[0] }); },
        measureText(t) { return { width: String(t).length * 6 }; },
    };
    return ctx;
}

describe('stationsToLocalMeters', () => {
    test('пустой/не-массив → null', () => {
        assert.equal(stationsToLocalMeters([]), null);
        assert.equal(stationsToLocalMeters(null), null);
        assert.equal(stationsToLocalMeters(undefined), null);
    });

    test('станции без координат → null', () => {
        assert.equal(stationsToLocalMeters([{ stationId: 'A', latitude: null, longitude: null }]), null);
        assert.equal(stationsToLocalMeters([{ stationId: 'A', latitude: NaN, longitude: 10 }]), null);
    });

    test('одна станция → ноль в локальных метрах, origin = её координаты', () => {
        const r = stationsToLocalMeters([{ stationId: 'A', latitude: 56.28, longitude: 99.28 }]);
        assert.equal(r.points.length, 1);
        assert.equal(r.points[0].x, 0);
        assert.equal(r.points[0].y, 0);
        assert.ok(Math.abs(r.origin.lat - 56.28) < 1e-9);
        assert.ok(Math.abs(r.origin.lon - 99.28) < 1e-9);
    });

    test('смещение на восток → разница по x ≈ 622 м на 0.01° долготы (56° с.ш.)', () => {
        const r = stationsToLocalMeters([
            { stationId: 'A', latitude: 56.0, longitude: 99.0 },
            { stationId: 'B', latitude: 56.0, longitude: 99.01 },
        ]);
        const a = r.points.find(p => p.stationId === 'A');
        const b = r.points.find(p => p.stationId === 'B');
        const expected = EARTH_RADIUS_M * Math.cos(56 * DEG) * 0.01 * DEG;
        assert.ok(Math.abs((b.x - a.x) - expected) < 0.5, `Δx=${b.x - a.x} expected≈${expected}`);
        assert.ok(Math.abs((b.x - a.x) - 622) < 5, `Δx=${b.x - a.x} должен быть ≈622 м`);
        assert.ok(Math.abs(b.y - a.y) < 1e-6, 'Δy должен быть ≈0');
    });

    test('смещение на север → разница по y ≈ 111 м на 0.001° широты', () => {
        const r = stationsToLocalMeters([
            { stationId: 'A', latitude: 56.0, longitude: 99.0 },
            { stationId: 'B', latitude: 56.001, longitude: 99.0 },
        ]);
        const a = r.points.find(p => p.stationId === 'A');
        const b = r.points.find(p => p.stationId === 'B');
        assert.ok(Math.abs((b.y - a.y) - 111.19) < 1, `Δy=${b.y - a.y} должен быть ≈111 м`);
        assert.ok(Math.abs(b.x - a.x) < 1e-6, 'Δx должен быть ≈0');
    });

    test('origin = среднее по валидным станциям, индексы сохраняются', () => {
        const r = stationsToLocalMeters([
            { stationId: 'A', latitude: 56.0, longitude: 99.0 },
            { stationId: 'BAD', latitude: null, longitude: null },
            { stationId: 'C', latitude: 56.2, longitude: 99.2 },
        ]);
        assert.equal(r.points.length, 2);
        assert.equal(r.points[0].index, 0);
        assert.equal(r.points[1].index, 2, 'индекс в исходном массиве сохраняется');
        assert.ok(Math.abs(r.origin.lat - 56.1) < 1e-9);
        assert.ok(Math.abs(r.origin.lon - 99.1) < 1e-9);
    });

    test('физическое расстояние между станциями (Пифагор по метрам)', () => {
        const r = stationsToLocalMeters([
            { stationId: 'A', latitude: 56.0, longitude: 99.0 },
            { stationId: 'B', latitude: 56.01, longitude: 99.01 },
        ]);
        const a = r.points[0], b = r.points[1];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        // 0.01° широты ≈ 1112 м, 0.01° долготы на 56° с.ш. ≈ 622 м
        const expected = EARTH_RADIUS_M * DEG * 0.01 * Math.hypot(Math.cos(56 * DEG), 1);
        assert.ok(Math.abs(d - expected) < 1, `d=${d} expected≈${expected}`);
        assert.ok(d > 1200 && d < 1350, `d=${d} должен быть ≈1.27 км`);
    });
});

describe('stationPlotLayout', () => {
    test('нет валидных станций → null', () => {
        assert.equal(stationPlotLayout([], 600, 260), null);
        assert.equal(stationPlotLayout(null, 600, 260), null);
    });

    test('некорректный размер холста → null', () => {
        assert.equal(stationPlotLayout([{ stationId: 'A', latitude: 56, longitude: 99 }], 0, 260), null);
        assert.equal(stationPlotLayout([{ stationId: 'A', latitude: 56, longitude: 99 }], 600, -5), null);
    });

    test('одна станция → в центре холста', () => {
        const L = stationPlotLayout([{ stationId: 'A', latitude: 56, longitude: 99 }], 600, 260, 30);
        assert.ok(L);
        assert.equal(L.points.length, 1);
        assert.ok(Math.abs(L.points[0].px - 300) < 1, `px=${L.points[0].px}`);
        assert.ok(Math.abs(L.points[0].py - 130) < 1, `py=${L.points[0].py}`);
    });

    test('точки не выходят за пределы холста (с учётом padding)', () => {
        const stations = [
            { stationId: 'A', latitude: 56.0, longitude: 99.0 },
            { stationId: 'B', latitude: 56.5, longitude: 99.5 },
            { stationId: 'C', latitude: 55.5, longitude: 98.5 },
        ];
        const L = stationPlotLayout(stations, 600, 260, 30);
        for (const p of L.points) {
            assert.ok(p.px >= 0 && p.px <= 600, `px=${p.px}`);
            assert.ok(p.py >= 0 && p.py <= 260, `py=${p.py}`);
        }
    });

    test('равный масштаб по обеим осям (квадрат в метрах → квадрат в пикселях)', () => {
        const stations = [
            { stationId: 'A', latitude: 56.000, longitude: 99.000 },
            { stationId: 'B', latitude: 56.001, longitude: 99.000 },
            { stationId: 'C', latitude: 56.000, longitude: 99.001 },
        ];
        const L = stationPlotLayout(stations, 600, 260, 30);
        const A = L.points.find(p => p.stationId === 'A');
        const B = L.points.find(p => p.stationId === 'B');
        const C = L.points.find(p => p.stationId === 'C');
        const dxPx = Math.abs(C.px - A.px);
        const dyPx = Math.abs(A.py - B.py);
        // одинаковый угловой шаг (0.001°) → физические смещения 62.2 м (вдоль долготы) и 111.2 м (вдоль широты)
        const mEast = EARTH_RADIUS_M * Math.cos(56 * DEG) * 0.001 * DEG;
        const mNorth = EARTH_RADIUS_M * 0.001 * DEG;
        const ratio = dxPx / dyPx;
        assert.ok(Math.abs(ratio - mEast / mNorth) < 0.005, `ratio=${ratio}`);
        // и общий масштаб один и тот же по осям
        const scaleX = dxPx / Math.abs(C.x - A.x);
        const scaleY = dyPx / Math.abs(B.y - A.y);
        assert.ok(Math.abs(scaleX - scaleY) / scaleX < 1e-9, 'масштаб X и Y должен совпадать');
        assert.ok(Math.abs(scaleX - L.scale) < 1e-9, 'scale в layout совпадает с фактическим');
    });

    test('север — вверх (меньший py), восток — вправо', () => {
        const stations = [
            { stationId: 'S', latitude: 56.0, longitude: 99.0 },
            { stationId: 'N', latitude: 56.1, longitude: 99.0 },
            { stationId: 'E', latitude: 56.0, longitude: 99.1 },
        ];
        const L = stationPlotLayout(stations, 600, 260, 30);
        const S = L.points.find(p => p.stationId === 'S');
        const N = L.points.find(p => p.stationId === 'N');
        const E = L.points.find(p => p.stationId === 'E');
        assert.ok(N.py < S.py, 'север должен быть выше по экрану');
        assert.ok(E.px > S.px, 'восток должен быть правее');
    });

    test('layout детерминирован (одинаковый вход → одинаковый выход)', () => {
        const stations = [{ stationId: 'A', latitude: 56, longitude: 99 }, { stationId: 'B', latitude: 56.4, longitude: 99.3 }];
        const a = stationPlotLayout(stations, 600, 260, 30);
        const b = stationPlotLayout(stations, 600, 260, 30);
        assert.deepEqual(a.points, b.points);
        assert.equal(a.scale, b.scale);
    });
});

describe('chooseGridStep', () => {
    test('подбирает шаг так, чтобы линии шли не реже ~45 px', () => {
        const step = chooseGridStep(0.5); // 1 м ≈ 0.5 px → нужен шаг ~100 м
        assert.ok(step >= 45 / 0.5 * 0.9, `step=${step}`);
    });

    test('на «красивых» числах (1/2/5 × 10^n)', () => {
        for (const s of [0.1, 1, 10, 100]) {
            const step = chooseGridStep(s);
            assert.ok(step >= 45 / s, `step=${step} при scale=${s}`);
        }
    });

    test('всегда положительное конечное число', () => {
        assert.ok(chooseGridStep(0) > 0);
        assert.ok(Number.isFinite(chooseGridStep(1e9)));
    });
});

describe('formatDistance', () => {
    test('метры до 1 км → целые метры', () => {
        assert.equal(formatDistance(0), '0 м');
        assert.equal(formatDistance(123.4), '123 м');
        assert.equal(formatDistance(999), '999 м');
    });

    test('больше километра → км', () => {
        assert.ok(formatDistance(1500).startsWith('1.5'), formatDistance(1500));
        assert.ok(formatDistance(1500).endsWith('км'));
        assert.ok(formatDistance(25000).startsWith('25'), formatDistance(25000));
    });
});

describe('formatOffset', () => {
    test('ноль → без знака', () => {
        assert.equal(formatOffset(0), '0 м');
    });

    test('положительное смещение → со знаком «+»', () => {
        assert.equal(formatOffset(500), '+500 м');
    });

    test('отрицательное смещение → со знаком «−»', () => {
        assert.equal(formatOffset(-250), '−250 м');
    });

    test('километры сохраняют знак и формат', () => {
        assert.equal(formatOffset(1500), '+1.5 км');
        assert.equal(formatOffset(-1500), '−1.5 км');
    });

    test('нечисловое значение → «—»', () => {
        assert.equal(formatOffset(NaN), '—');
    });
});

describe('findNearestStationPoint', () => {
    const stations = [
        { stationId: 'A', latitude: 56.0, longitude: 99.0 },
        { stationId: 'B', latitude: 56.02, longitude: 99.02 },
    ];
    const L = stationPlotLayout(stations, 600, 260, 30);

    test('клик рядом с точкой → эта точка', () => {
        const p = L.points[0];
        const hit = findNearestStationPoint(p.px + 3, p.py - 2, L, 12);
        assert.ok(hit);
        assert.equal(hit.stationId, 'A');
    });

    test('клик далеко от всех точек → null', () => {
        assert.equal(findNearestStationPoint(5, 5, L, 12), null);
    });

    test('нулевой layout → null', () => {
        assert.equal(findNearestStationPoint(10, 10, null, 12), null);
    });
});

describe('drawStationPlot', () => {
    const stations = [
        { stationId: 'A', latitude: 56.0, longitude: 99.0 },
        { stationId: 'B', latitude: 56.02, longitude: 99.02 },
    ];

    test('рисует очистку, сетку, точки и подписи', () => {
        const ctx = makeCtx();
        const L = stationPlotLayout(stations, 600, 260, 30);
        drawStationPlot(ctx, L, { activeIndex: 0, width: 600, height: 260 });
        assert.ok(ctx.ops.some(o => o.op === 'clearRect'));
        assert.ok(ctx.ops.some(o => o.op === 'stroke'), 'должны быть линии сетки/осей');
        const arcs = ctx.ops.filter(o => o.op === 'arc');
        assert.equal(arcs.length, 2, 'по одной окружности на станцию');
        const texts = ctx.ops.filter(o => o.op === 'fillText').map(o => String(o.text));
        assert.ok(texts.some(t => t.includes('A')), 'подпись станции A');
        assert.ok(texts.some(t => t.includes('B')), 'подпись станции B');
    });

    test('активная станция рисуется крупнее и красным', () => {
        const ctx = makeCtx();
        const L = stationPlotLayout(stations, 600, 260, 30);
        drawStationPlot(ctx, L, { activeIndex: 0, width: 600, height: 260 });
        const arcs = ctx.ops.filter(o => o.op === 'arc');
        const active = arcs.find(o => o.fill && /dc2626|ef4444/i.test(o.fill));
        assert.ok(active, 'активная точка должна быть красной');
        assert.ok(active.a[2] > arcs.find(o => o !== active).a[2], 'активная точка должна быть крупнее');
    });

    test('без layout → ничего не рисует, исключений нет', () => {
        const ctx = makeCtx();
        drawStationPlot(ctx, null, { width: 600, height: 260 });
        assert.equal(ctx.ops.length, 0);
    });

    test('сетка покрывает весь холст, а не только габариты станций', () => {
        const ctx = makeCtx();
        // Одна станция: габариты данных вырождены (0×0 м) — сетка всё равно должна заполнить холст.
        const L = stationPlotLayout([{ stationId: 'A', latitude: 56, longitude: 99 }], 600, 260, 30);
        drawStationPlot(ctx, L, { width: 600, height: 260 });
        const verticals = [];
        for (let i = 0; i < ctx.ops.length - 1; i++) {
            const a = ctx.ops[i], b = ctx.ops[i + 1];
            if (a.op === 'moveTo' && b.op === 'lineTo' && a.a[0] === b.a[0] && a.a[1] !== b.a[1]) {
                verticals.push(a.a[0]);
            }
        }
        assert.ok(verticals.length >= 3, `вертикальных линий сетки: ${verticals.length}`);
        assert.ok(Math.min(...verticals) <= 1, `левая линия сетки: ${Math.min(...verticals)}`);
        assert.ok(Math.max(...verticals) >= 599, `правая линия сетки: ${Math.max(...verticals)}`);
    });

    test('подписи осей — смещения от центра со знаком', () => {
        const ctx = makeCtx();
        const L = stationPlotLayout([
            { stationId: 'A', latitude: 56.0, longitude: 99.0 },
            { stationId: 'B', latitude: 56.05, longitude: 99.05 },
        ], 600, 260, 30);
        drawStationPlot(ctx, L, { width: 600, height: 260 });
        const texts = ctx.ops.filter(o => o.op === 'fillText').map(o => String(o.text));
        assert.ok(texts.some(t => /^[+−]\d/.test(t)), `подписи смещений: ${texts.join('|')}`);
    });
});
