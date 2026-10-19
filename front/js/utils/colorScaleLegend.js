/**
 * Цветовая шкала-легенда для 3D-вьюверов удельного сопротивления.
 * Чистый DOM-модуль: не зависит от Three.js и от класса ResultViewer.
 */

import { colormaps } from './colormaps.js';

/**
 * Форматирует значение сопротивления для подписей шкалы:
 * < 10 — два знака, 10..100 — один знак, 100..10000 — без дробной,
 * остальное — экспоненциальная запись.
 * @param {number} v — значение в Ω·м
 * @returns {string}
 */
export function formatRho(v) {
    if (!isFinite(v) || v <= 0) return '—';
    if (v < 10) return v.toFixed(2);
    if (v < 100) return v.toFixed(1);
    if (v < 1000) return v.toFixed(0);
    if (v < 10000) return v.toFixed(0);
    return v.toExponential(1);
}

/**
 * Создаёт DOM-элемент легенды и добавляет его в контейнер.
 * @param {HTMLElement} containerElement
 * @param {{minRho:number, maxRho:number, paletteName:string}} colorScale
 * @returns {HTMLElement} элемент легенды
 */
export function createLegend(containerElement, colorScale) {
    const legend = document.createElement('div');
    legend.className = 'result-viewer-legend';
    legend.innerHTML = `
        <div class="legend-title">Удельное сопротивление (Ω·м)</div>
        <div class="color-scale-bar"></div>
        <div class="color-scale-labels">
            <span class="cs-min">${colorScale.minRho.toFixed(1)}</span>
            <span class="cs-mid"></span>
            <span class="cs-max">${colorScale.maxRho.toFixed(1)}</span>
        </div>
        <div class="legend-meta">
            <span>Палитра: <strong class="cs-palette">${colorScale.paletteName}</strong></span>
            <span>Всего: <strong class="cs-visible">—</strong> / <span class="cs-total">—</span></span>
        </div>
    `;
    containerElement.appendChild(legend);
    return legend;
}

/**
 * Обновляет легенду: градиент палитры, подписи min/mid/max,
 * счётчик видимых ячеек в текущем диапазоне.
 * @param {HTMLElement} legendEl
 * @param {{minRho:number, maxRho:number, paletteName:string}} colorScale
 * @param {Float32Array} logRho — log10(rho) каждой ячейки
 * @param {Uint8Array} valid — 1, если ячейка валидна
 */
export function updateLegend(legendEl, colorScale, logRho, valid) {
    if (!legendEl || !colorScale) return;
    const { minRho, maxRho, paletteName } = colorScale;

    const bar = legendEl.querySelector('.color-scale-bar');
    if (bar) {
        // Градиент по выбранной палитре (17 опорных точек)
        const palette = colormaps[paletteName] || colormaps.jet;
        const stops = [];
        for (let i = 0; i <= 16; i++) {
            const t = i / 16;
            const [r, g, b] = palette(t);
            const rr = Math.round(r * 255), gg = Math.round(g * 255), bb = Math.round(b * 255);
            stops.push(`rgb(${rr},${gg},${bb}) ${(t * 100).toFixed(1)}%`);
        }
        bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    }

    const minEl = legendEl.querySelector('.cs-min');
    const maxEl = legendEl.querySelector('.cs-max');
    const midEl = legendEl.querySelector('.cs-mid');
    if (minEl) minEl.textContent = formatRho(minRho);
    if (maxEl) maxEl.textContent = formatRho(maxRho);
    if (midEl) midEl.textContent = formatRho(Math.sqrt(minRho * maxRho));

    const palEl = legendEl.querySelector('.cs-palette');
    if (palEl) palEl.textContent = paletteName;

    // Сколько ячеек попадает в текущий диапазон
    if (logRho && valid) {
        const logMin = Math.log10(minRho);
        const logMax = Math.log10(maxRho);
        let visible = 0;
        const total = logRho.length;
        for (let i = 0; i < total; i++) {
            if (!valid[i]) continue;
            const lr = logRho[i];
            if (lr >= logMin && lr <= logMax) visible++;
        }
        const visEl = legendEl.querySelector('.cs-visible');
        const totEl = legendEl.querySelector('.cs-total');
        if (visEl) visEl.textContent = visible.toLocaleString();
        if (totEl) totEl.textContent = total.toLocaleString();
    }
}

/** Удаляет легенду из DOM. */
export function removeLegend(legendEl) {
    if (legendEl && legendEl.parentNode) {
        legendEl.parentNode.removeChild(legendEl);
    }
}
