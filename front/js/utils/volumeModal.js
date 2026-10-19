/**
 * Модальное окно объёмного просмотра модели.
 * Переиспользует стиль готовых решений (файл-viewer-modal + ResultViewer):
 * тот же модальный шаблон, легенда, статистика и OrbitControls.
 *
 * modelData — объект формата { nX, nY, nZ, xCells, yCells, zCells, rhoValues }
 * (см. buildSimpegModelData в simpegProfilesConverter.js).
 *
 * options.editing (опционально) включает режим правки сопротивлений ячеек:
 * {
 *   defaultRho: фоновое ρ (для сброса),
 *   onCellsEdited(indices, rho): вызывается после правки ячеек,
 *   getModifiedCount(): сколько ячеек отличается от фона — для счётчика в панели
 * }
 */

import { ResultViewer } from './resultViewer.js';
import { formatRho } from './colorScaleLegend.js';

let _volumeViewerInstance = null;

export async function showVolumeModal(modelData, title = 'Объёмная модель', options = {}) {
    const editing = options.editing || null;
    const defaultRho = editing && editing.defaultRho > 0 ? editing.defaultRho : 100;

    const modal = document.createElement('div');
    modal.className = 'file-viewer-modal result-viewer-modal-large';
    modal.innerHTML = `
        <div class="file-viewer-content result-viewer-content-large">
            <div class="file-viewer-header">
                <h3>📊 ${title}</h3>
                <button class="file-viewer-close">&times;</button>
            </div>
            <div class="file-viewer-body">
                <div class="volume-3d-container" style="width: 100%; height: ${editing ? '55vh' : '70vh'}; position: relative;"></div>
                ${editing ? `
                <div class="volume-edit-toolbar" id="volume-edit-toolbar">
                    <div class="edit-row">
                        <span class="edit-group-label">✏️ Априорная информация</span>
                        <label class="edit-radio"><input type="radio" name="volume-edit-mode" value="paint" checked> 🖌 Кисть</label>
                        <label class="edit-radio"><input type="radio" name="volume-edit-mode" value="select"> ☑ Выделение</label>
                        <span class="edit-sep"></span>
                        <label class="edit-field">ρ =
                            <input type="number" id="volume-edit-rho" min="0.01" step="any" value="${defaultRho}">
                            <span class="edit-unit">Ом·м</span>
                        </label>
                        <label class="edit-check"><input type="checkbox" id="volume-edit-column"> вся колонка Z</label>
                    </div>
                    <div class="edit-row">
                        <span class="edit-group-label">🗂 Слой Z</span>
                        <label class="edit-check" title="Показывать и редактировать только выбранный слой; остальные скрыты и некликабельны"><input type="checkbox" id="volume-edit-layer-on"> только этот слой</label>
                        <input type="range" class="edit-layer-slider" id="volume-edit-layer" min="0" max="${Math.max(0, modelData.nZ - 1)}" step="1" value="0" title="Номер слоя: 0 — верхний (у поверхности)">
                        <span class="edit-layer-info" id="volume-edit-layer-info">—</span>
                        <span class="edit-sep"></span>
                        <label class="edit-check" title="Линии границ ячеек всей модели"><input type="checkbox" id="volume-edit-grid"> показать сетку</label>
                    </div>
                    <div class="edit-row">
                        <span class="edit-group-label" title="Показывать только ячейки с ρ в выбранном диапазоне; скрытые ячейки не кликабельны">🔍 Фильтр ρ</span>
                        <div class="edit-range-wrap">
                            <div class="edit-range-labels">
                                <span id="volume-edit-range-min-label">—</span>
                                <span class="edit-range-hint" id="volume-edit-range-hint">—</span>
                                <span id="volume-edit-range-max-label">—</span>
                            </div>
                            <div class="range-slider">
                                <div class="range-track"></div>
                                <div class="range-fill" id="volume-edit-range-fill"></div>
                                <input type="range" class="range-input range-min" id="volume-edit-range-min" min="0" max="10000" step="1" value="0" />
                                <input type="range" class="range-input range-max" id="volume-edit-range-max" min="0" max="10000" step="1" value="10000" />
                            </div>
                        </div>
                        <button type="button" class="btn btn-sm btn-secondary" id="volume-edit-range-reset" title="Показать ячейки всего диапазона сопротивлений">Весь диапазон</button>
                    </div>
                    <div class="edit-row">
                        <button type="button" class="btn btn-sm" id="volume-edit-apply" disabled>Применить к выделенным</button>
                        <button type="button" class="btn btn-sm btn-secondary" id="volume-edit-clear">Снять выделение</button>
                        <button type="button" class="btn btn-sm btn-danger-ghost" id="volume-edit-reset">↺ Сбросить все изменения</button>
                        <span class="edit-counter" id="volume-edit-count">Изменено ячеек: 0</span>
                    </div>
                    <div class="edit-row edit-hover-row" id="volume-edit-hover">
                        Наведите курсор на ячейку…
                    </div>
                </div>` : ''}
                <div class="volume-stats" style="margin-top: 16px; padding: 12px; background: var(--color-bg-secondary); border-radius: var(--radius-md);"></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const container = modal.querySelector('.volume-3d-container');
    const statsDiv = modal.querySelector('.volume-stats');

    try {
        if (_volumeViewerInstance) {
            _volumeViewerInstance.dispose();
            _volumeViewerInstance = null;
        }

        _volumeViewerInstance = new ResultViewer();
        await _volumeViewerInstance.init3DVisualization(container, modelData);

        // === Панель редактирования ===
        if (editing) {
            _setupEditingPanel(_volumeViewerInstance, modal, editing, defaultRho, modelData);
        }

        const totalCells = modelData.nX * modelData.nY * modelData.nZ;
        const xExtent = modelData.xCells.reduce((a, b) => a + b, 0);
        const yExtent = modelData.yCells.reduce((a, b) => a + b, 0);
        const zExtent = modelData.zCells.reduce((a, b) => a + b, 0);
        const validRho = modelData.rhoValues.filter(v => isFinite(v) && v > 0);
        const minRho = validRho.length ? Math.min(...validRho) : NaN;
        const maxRho = validRho.length ? Math.max(...validRho) : NaN;

        statsDiv.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; font-size: 0.9em;">
                <div>
                    <div style="color: var(--color-text-tertiary);">Размер модели</div>
                    <div style="color: var(--color-primary); font-weight: 600;">${modelData.nX} × ${modelData.nY} × ${modelData.nZ}</div>
                </div>
                <div>
                    <div style="color: var(--color-text-tertiary);">Всего ячеек</div>
                    <div style="color: var(--color-primary); font-weight: 600;">${totalCells.toLocaleString()}</div>
                </div>
                <div>
                    <div style="color: var(--color-text-tertiary);">Область (X × Y)</div>
                    <div style="color: var(--color-primary); font-weight: 600;">${Math.round(xExtent).toLocaleString('ru-RU')} × ${Math.round(yExtent).toLocaleString('ru-RU')} м</div>
                </div>
                <div>
                    <div style="color: var(--color-text-tertiary);">Глубина</div>
                    <div style="color: var(--color-primary); font-weight: 600;">${Math.round(zExtent).toLocaleString('ru-RU')} м</div>
                </div>
                <div>
                    <div style="color: var(--color-text-tertiary);">Диапазон ρ</div>
                    <div style="color: var(--color-primary); font-weight: 600;">${isFinite(minRho) ? minRho.toFixed(1) : '—'} — ${isFinite(maxRho) ? maxRho.toFixed(1) : '—'} Ω·м</div>
                </div>
            </div>
            <div style="margin-top: 12px; color: var(--color-text-tertiary); font-size: 0.85em;">
                ${editing
                    ? '💡 <strong>Кисть</strong>: зажмите левую кнопку и ведите по ячейкам — ρ применяется сразу. ' +
                      '<strong>Выделение</strong>: клик по ячейке, Ctrl/Shift+клик — добавить; затем «Применить к выделенным» (пурпурный контур). ' +
                      '<strong>Слой Z</strong>: включите «только этот слой» — остальные слои скроются, правки попадут строго в выбранный срез. ' +
                      '<strong>Сетка</strong> — линии границ ячеек. Колесо — масштаб, правая кнопка — панорама.'
                    : '💡 Используйте мышь для вращения, масштабирования и панорамирования модели'}
            </div>
        `;
    } catch (error) {
        console.error('Error rendering volume modal:', error);
        statsDiv.innerHTML = `<p style="color: var(--color-danger);">Ошибка отображения: ${error.message}</p>`;
    }

    const close = () => {
        if (_volumeViewerInstance) {
            _volumeViewerInstance.dispose();
            _volumeViewerInstance = null;
        }
        if (modal.parentNode) modal.parentNode.removeChild(modal);
    };

    modal.querySelector('.file-viewer-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) close();
    });
}

// ================================================================
// Внутренняя функция: привязка UI панели редактирования к viewer
// ================================================================
function _setupEditingPanel(viewer, modal, editing, defaultRho, modelData) {
    const rhoInput = modal.querySelector('#volume-edit-rho');
    const countEl = modal.querySelector('#volume-edit-count');
    const hoverEl = modal.querySelector('#volume-edit-hover');
    const applyBtn = modal.querySelector('#volume-edit-apply');

    const updateCount = () => {
        const n = editing.getModifiedCount ? editing.getModifiedCount() : 0;
        countEl.textContent = `Изменено ячеек: ${n.toLocaleString('ru-RU')}`;
        countEl.classList.toggle('has-edits', n > 0);
    };

    viewer.enableEditing({
        defaultRho,
        brushRho: parseFloat(rhoInput.value) || defaultRho,
        onCellsEdited: (indices, rho) => {
            if (editing.onCellsEdited) {
                try { editing.onCellsEdited(indices, rho); }
                catch (err) { console.error('[VOLUME EDIT] onCellsEdited failed:', err); }
            }
            updateCount();
            if (typeof syncRangeUI === 'function') syncRangeUI();
        },
        onHoverCell: (info) => {
            if (!info) {
                hoverEl.textContent = 'Наведите курсор на ячейку…';
                return;
            }
            const dTop = Math.round(info.depthTop).toLocaleString('ru-RU');
            const dBot = Math.round(info.depthBottom).toLocaleString('ru-RU');
            hoverEl.textContent =
                `Ячейка [X:${info.ix}, Y:${info.iy}, Z:${info.iz}] · ` +
                `глубина ${dTop}–${dBot} м · ρ = ${formatRho(info.rho)} Ом·м`;
        },
        onSelectionChanged: (n) => {
            applyBtn.disabled = n === 0;
            applyBtn.textContent = n > 0
                ? `Применить к выделенным (${n.toLocaleString('ru-RU')})`
                : 'Применить к выделенным';
        },
    });

    // Режим: кисть / выделение
    modal.querySelectorAll('input[name="volume-edit-mode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.checked) viewer.setEditMode(radio.value);
        });
    });

    // Значение кисти
    rhoInput.addEventListener('input', () => {
        viewer.setBrushRho(parseFloat(rhoInput.value));
    });

    // Режим колонки
    modal.querySelector('#volume-edit-column').addEventListener('change', (e) => {
        viewer.setColumnMode(e.target.checked);
    });

    // === Выбор Z-слоя ===
    const layerSlider = modal.querySelector('#volume-edit-layer');
    const layerOn = modal.querySelector('#volume-edit-layer-on');
    const layerInfo = modal.querySelector('#volume-edit-layer-info');
    const fmtM = (v) => Math.round(v).toLocaleString('ru-RU');
    const updateLayerInfo = () => {
        const k = parseInt(layerSlider.value, 10);
        const dr = viewer.getLayerDepthRange(k);
        layerInfo.innerHTML = dr
            ? `<strong>${k + 1}</strong> / ${modelData.nZ} · глубина ${fmtM(dr.top)}–${fmtM(dr.bottom)} м`
            : '—';
    };
    let layerRaf = 0;
    layerSlider.addEventListener('input', () => {
        updateLayerInfo();
        if (!layerOn.checked) return;
        if (layerRaf) return;
        layerRaf = requestAnimationFrame(() => {
            layerRaf = 0;
            viewer.setLayerFilter(parseInt(layerSlider.value, 10));
        });
    });
    layerOn.addEventListener('change', () => {
        viewer.setLayerFilter(layerOn.checked ? parseInt(layerSlider.value, 10) : null);
    });
    updateLayerInfo();

    // Сетка границ ячеек
    modal.querySelector('#volume-edit-grid').addEventListener('change', (e) => {
        viewer.setWireframe(e.target.checked);
    });

    // === Фильтр сопротивлений (dual range-slider, лог-шкала) ===
    const rMinInput = modal.querySelector('#volume-edit-range-min');
    const rMaxInput = modal.querySelector('#volume-edit-range-max');
    const rFill = modal.querySelector('#volume-edit-range-fill');
    const rMinLabel = modal.querySelector('#volume-edit-range-min-label');
    const rMaxLabel = modal.querySelector('#volume-edit-range-max-label');
    const rHint = modal.querySelector('#volume-edit-range-hint');

    const rangeBounds = () => {
        let lo = viewer.colorScale.dataMin;
        let hi = viewer.colorScale.dataMax;
        if (!(hi > lo)) { lo = lo / 10; hi = hi * 10; }
        return [Math.log10(lo), Math.log10(hi)];
    };

    const applyRangeFromSlider = () => {
        const [logLo, logHi] = rangeBounds();
        const span = (logHi - logLo) || 1;
        let vMin = parseInt(rMinInput.value, 10);
        let vMax = parseInt(rMaxInput.value, 10);
        if (vMin > vMax) [vMin, vMax] = [vMax, vMin];
        const minRho = Math.pow(10, logLo + (vMin / 10000) * span);
        const maxRho = Math.pow(10, logLo + (vMax / 10000) * span);
        if (maxRho > minRho) viewer.setRange(minRho, maxRho);
        rFill.style.left = `${vMin / 100}%`;
        rFill.style.width = `${(vMax - vMin) / 100}%`;
        rMinLabel.textContent = formatRho(minRho);
        rMaxLabel.textContent = formatRho(maxRho);
        rHint.textContent = `${formatRho(minRho)} … ${formatRho(maxRho)} Ω·м`;
    };

    const syncRangeUI = () => {
        const [logLo, logHi] = rangeBounds();
        const span = (logHi - logLo) || 1;
        const toSlider = (rho) => Math.max(0, Math.min(10000,
            Math.round(((Math.log10(rho) - logLo) / span) * 10000)));
        let vMin = toSlider(viewer.settings.minRho);
        let vMax = toSlider(viewer.settings.maxRho);
        if (vMin > vMax) [vMin, vMax] = [vMax, vMin];
        rMinInput.value = vMin;
        rMaxInput.value = vMax;
        applyRangeFromSlider();
    };

    const showFullRange = () => {
        const [logLo, logHi] = rangeBounds();
        const lo = Math.pow(10, logLo);
        const hi = Math.pow(10, logHi);
        if (hi > lo) viewer.setRange(lo, hi);
        syncRangeUI();
    };

    let rangeRaf = 0;
    const onRangeInput = () => {
        if (rangeRaf) return;
        rangeRaf = requestAnimationFrame(() => {
            rangeRaf = 0;
            applyRangeFromSlider();
        });
    };
    rMinInput.addEventListener('input', onRangeInput);
    rMaxInput.addEventListener('input', onRangeInput);
    modal.querySelector('#volume-edit-range-reset').addEventListener('click', showFullRange);

    showFullRange();

    applyBtn.addEventListener('click', () => {
        const rho = parseFloat(rhoInput.value);
        if (!(rho > 0) || !isFinite(rho)) {
            alert('Введите корректное положительное сопротивление');
            return;
        }
        viewer.applyRhoToSelection(rho);
    });

    modal.querySelector('#volume-edit-clear').addEventListener('click', () => {
        viewer.clearSelection();
    });

    modal.querySelector('#volume-edit-reset').addEventListener('click', () => {
        const n = viewer.resetAllCells();
        if (n > 0) updateCount();
    });

    updateCount();
}
