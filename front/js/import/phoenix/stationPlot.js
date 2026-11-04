/**
 * stationPlot.js — 2D-схема расположения станций наблюдений (вид сверху).
 *
 * Принцип: географические координаты (lat/lon) переводятся в ЛОКАЛЬНУЮ
 * прямоугольную систему в метрах относительно центра масс станций
 * (плоское приближение: x — восток, y — север). Схема показывает физическое
 * (а не географическое) расположение станций: равные расстояния на графике
 * соответствуют равным расстояниям на местности, масштаб один по обеим осям.
 *
 * Модуль не зависит от DOM и внешних библиотек — вся математика чистая и тестируема.
 */

/** Радиус Земли (м), средний по эллипсоиду — достаточно для локальных схем. */
export const EARTH_RADIUS_M = 6371008.8;

const DEG = Math.PI / 180;

/** Минимальный размах схемы (м): иначе одна станция растянет масштаб до бесконечности. */
const MIN_SPAN_M = 10;

/** Целевое расстояние между линиями сетки (px). */
const GRID_TARGET_PX = 45;

const COLORS = {
    grid: '#e2e8f0',
    axis: '#94a3b8',
    point: '#2563eb',
    pointActive: '#dc2626',
    text: '#334155',
    textMuted: '#64748b',
    halo: '#ffffff',
};

/**
 * Перевести координаты станций в локальные метры относительно центра масс.
 * @param {Array<{stationId?: string, latitude?: number|null, longitude?: number|null}>} stations
 * @returns {{origin: {lat: number, lon: number}, points: Array<{index: number, stationId: string, x: number, y: number}>}|null}
 *   null — если нет ни одной станции с валидными координатами.
 */
export function stationsToLocalMeters(stations) {
    if (!Array.isArray(stations) || stations.length === 0) return null;

    const valid = [];
    stations.forEach((s, index) => {
        if (!s) return;
        // null/undefined/'' — это «координат нет», а не 0 (Number(null) === 0!)
        if (s.latitude == null || s.longitude == null) return;
        if (s.latitude === '' || s.longitude === '') return;
        const lat = Number(s.latitude);
        const lon = Number(s.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
        valid.push({ index, stationId: String(s.stationId || `№${index + 1}`), lat, lon });
    });
    if (valid.length === 0) return null;

    const lat0 = valid.reduce((a, p) => a + p.lat, 0) / valid.length;
    const lon0 = valid.reduce((a, p) => a + p.lon, 0) / valid.length;
    const cosLat = Math.cos(lat0 * DEG);

    const points = valid.map(p => ({
        index: p.index,
        stationId: p.stationId,
        // восток (x) и север (y) в метрах
        x: EARTH_RADIUS_M * cosLat * (p.lon - lon0) * DEG,
        y: EARTH_RADIUS_M * (p.lat - lat0) * DEG,
    }));

    return { origin: { lat: lat0, lon: lon0 }, points };
}

/**
 * Разместить станции на холсте: единый масштаб по обеим осям, содержимое по центру.
 * @param {Array} stations
 * @param {number} width  — ширина холста (CSS-пиксели)
 * @param {number} height — высота холста (CSS-пиксели)
 * @param {number} [padding=30]
 * @returns {object|null} layout или null (нет станций / некорректный размер)
 */
export function stationPlotLayout(stations, width, height, padding = 30) {
    const local = stationsToLocalMeters(stations);
    if (!local) return null;

    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;

    const pad = Math.max(0, Math.min(Number(padding) || 0, Math.min(w, h) / 2 - 1));
    const usableW = Math.max(1, w - 2 * pad);
    const usableH = Math.max(1, h - 2 * pad);

    const xs = local.points.map(p => p.x);
    const ys = local.points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const contentW = Math.max(maxX - minX, 0);
    const contentH = Math.max(maxY - minY, 0);
    const spanX = Math.max(contentW, MIN_SPAN_M);
    const spanY = Math.max(contentH, MIN_SPAN_M);

    // Один масштаб для обеих осей → физические пропорции сохраняются.
    const scale = Math.min(usableW / spanX, usableH / spanY);

    const points = local.points.map(p => ({
        index: p.index,
        stationId: p.stationId,
        x: p.x,
        y: p.y,
        px: w / 2 + (p.x - centerX) * scale,
        py: h / 2 - (p.y - centerY) * scale, // север — вверх
    }));

    return {
        points,
        scale,
        gridStep: chooseGridStep(scale),
        width: w,
        height: h,
        padding: pad,
        minX,
        maxX,
        minY,
        maxY,
        centerX,
        centerY,
        origin: local.origin,
    };
}

/**
 * «Красивый» шаг сетки в метрах (1/2/5 × 10^n), чтобы линии шли не реже GRID_TARGET_PX.
 * @param {number} scale — пикселей на метр
 * @returns {number} шаг в метрах
 */
export function chooseGridStep(scale) {
    const s = Number(scale);
    if (!Number.isFinite(s) || s <= 0) return 1;
    const raw = GRID_TARGET_PX / s;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let mult;
    if (norm <= 1) mult = 1;
    else if (norm <= 2) mult = 2;
    else if (norm <= 5) mult = 5;
    else mult = 10;
    return mult * mag;
}

/**
 * Форматировать расстояние: метры до километра, дальше — километры.
 * @param {number} meters
 * @returns {string}
 */
export function formatDistance(meters) {
    const m = Number(meters);
    if (!Number.isFinite(m)) return '—';
    const abs = Math.abs(m);
    if (abs < 1000) return `${Math.round(m)} м`;
    const km = m / 1000;
    if (Math.abs(km) < 10) return `${km.toFixed(1)} км`;
    return `${Math.round(km)} км`;
}

/**
 * Форматировать смещение от центра схемы со знаком: '+500 м', '−250 м', '0 м'.
 * @param {number} meters
 * @returns {string}
 */
export function formatOffset(meters) {
    const m = Number(meters);
    if (!Number.isFinite(m)) return '—';
    if (m === 0) return '0 м';
    const sign = m > 0 ? '+' : '−';
    return sign + formatDistance(Math.abs(m));
}

/**
 * Ближайшая точка станции к координате на холсте (попадание клика/тапа).
 * @param {number} px
 * @param {number} py
 * @param {object|null} layout
 * @param {number} [radius=12] — радиус попадания (px)
 * @returns {object|null} точка станции или null
 */
export function findNearestStationPoint(px, py, layout, radius = 12) {
    if (!layout || !Array.isArray(layout.points)) return null;
    const x = Number(px);
    const y = Number(py);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const r = Number(radius) || 12;
    let best = null;
    let bestDist = Infinity;
    for (const p of layout.points) {
        const d = Math.hypot(p.px - x, p.py - y);
        if (d <= r && d < bestDist) {
            best = p;
            bestDist = d;
        }
    }
    return best;
}

/**
 * Нарисовать схему расположения станций на 2D-контексте.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object|null} layout — результат stationPlotLayout
 * @param {{activeIndex?: number, width?: number, height?: number}} [opts]
 */
export function drawStationPlot(ctx, layout, opts = {}) {
    if (!ctx || !layout || !Array.isArray(layout.points)) return;

    const width = Number(opts.width) || layout.width;
    const height = Number(opts.height) || layout.height;
    const activeIndex = Number.isInteger(opts.activeIndex) ? opts.activeIndex : -1;

    ctx.clearRect(0, 0, width, height);

    const { scale, gridStep, points } = layout;
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(gridStep) || gridStep <= 0) return;

    // --- сетка по всему холсту (шаг в метрах, линии от центра схемы) ---
    const stepPx = gridStep * scale;
    const kMaxX = Math.ceil((width / 2) / stepPx) + 1;
    const kMaxY = Math.ceil((height / 2) / stepPx) + 1;
    // Подписи ставим не чаще, чем раз в ~60 px, иначе текст сливается.
    const labelEveryX = Math.max(1, Math.ceil(60 / stepPx));
    const labelEveryY = Math.max(1, Math.ceil(60 / stepPx));

    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';

    // Вертикальные линии (смещение по горизонтали, восток- запад)
    for (let k = -kMaxX; k <= kMaxX; k++) {
        const x = width / 2 + k * stepPx;
        ctx.strokeStyle = k === 0 ? COLORS.axis : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        if (k % labelEveryX === 0 && x >= 26 && x <= width - 26) {
            ctx.fillStyle = COLORS.textMuted;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(formatOffset(k * gridStep), x, height - 4);
        }
    }

    // Горизонтальные линии (смещение по вертикали, север-юг)
    for (let k = -kMaxY; k <= kMaxY; k++) {
        const y = height / 2 - k * stepPx;
        ctx.strokeStyle = k === 0 ? COLORS.axis : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        if (k % labelEveryY === 0 && y >= 8 && y <= height - 20) {
            ctx.fillStyle = COLORS.textMuted;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(formatOffset(k * gridStep), 3, y);
        }
    }
    ctx.restore();

    // --- станции ---
    ctx.save();
    for (const p of points) {
        const active = p.index === activeIndex;
        const r = active ? 9 : 6;
        ctx.beginPath();
        ctx.fillStyle = active ? COLORS.pointActive : COLORS.point;
        ctx.strokeStyle = COLORS.halo;
        ctx.lineWidth = 2;
        ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();

    // --- подписи станций + расстояние от центра схемы ---
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (const p of points) {
        ctx.fillStyle = p.index === activeIndex ? COLORS.pointActive : COLORS.text;
        // Подпись держим внутри холста: если точка у правого края — прижимаем текст слева.
        const nearRight = p.px + 10 + 60 > width;
        ctx.textAlign = nearRight ? 'right' : 'left';
        const x = nearRight ? p.px - 10 : p.px + 10;
        ctx.fillText(p.stationId, x, Math.max(14, p.py - 4));
    }
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = COLORS.textMuted;
    ctx.textBaseline = 'top';
    for (const p of points) {
        const d = Math.hypot(p.x - layout.centerX, p.y - layout.centerY);
        const nearRight = p.px + 10 + 60 > width;
        ctx.textAlign = nearRight ? 'right' : 'left';
        const x = nearRight ? p.px - 10 : p.px + 10;
        ctx.fillText(formatDistance(d), x, Math.min(height - 14, p.py + 3));
    }
    ctx.restore();

    // --- стрелка «север» и масштабная линейка ---
    drawNorthArrow(ctx, width, height);
    drawScaleBar(ctx, layout, width, height);
}

function drawNorthArrow(ctx, width, height) {
    const x = width - 22;
    const y = 22;
    ctx.save();
    ctx.strokeStyle = COLORS.axis;
    ctx.fillStyle = COLORS.text;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y + 12);
    ctx.lineTo(x, y - 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - 12);
    ctx.lineTo(x - 4, y - 4);
    ctx.lineTo(x + 4, y - 4);
    ctx.closePath();
    ctx.fill();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('С', x, y + 26);
    ctx.restore();
}

function drawScaleBar(ctx, layout, width, height) {
    const step = layout.gridStep;
    const lenPx = step * layout.scale;
    if (!Number.isFinite(lenPx) || lenPx <= 0) return;
    const x = 14;
    const y = height - 16;
    ctx.save();
    ctx.strokeStyle = COLORS.axis;
    ctx.fillStyle = COLORS.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + lenPx, y);
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.moveTo(x + lenPx, y - 4);
    ctx.lineTo(x + lenPx, y + 4);
    ctx.stroke();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatDistance(step), x, y - 5);
    ctx.restore();
}
