// Вьювер .vtr файлов (VTK XML RectilinearGrid)
// Парсит XML, извлекает координаты и значения удельного сопротивления
// и отображает 3D модель через общий ResultViewer
import { ResultViewer } from './resultViewer.js';

let vtrViewerInstance = null;

// Парсит содержимое .vtr файла и возвращает модель в формате,
// который понимает ResultViewer ({nX, nY, nZ, xCells, yCells, zCells, rhoValues})
export async function parseVtrFile(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) {
        throw new Error('Некорректный XML в .vtr файле');
    }

    const grid = doc.querySelector('RectilinearGrid');
    const piece = doc.querySelector('Piece');
    if (!grid || !piece) {
        throw new Error('Файл не похож на VTK RectilinearGrid (.vtr)');
    }

    // Атрибут compressor обычно лежит на корневом <VTKFile>, а не на каждом DataArray
    const compressor = doc.documentElement?.getAttribute('compressor') || null;

    // Extent: "x0 x1 y0 y1 z0 z1" — индексы узлов
    const extentAttr = piece.getAttribute('Extent') || grid.getAttribute('WholeExtent');
    if (!extentAttr) {
        throw new Error('Не найден атрибут Extent в .vtr файле');
    }
    const ext = extentAttr.trim().split(/\s+/).map(Number);
    let nX = ext[1] - ext[0];
    let nY = ext[3] - ext[2];
    let nZ = ext[5] - ext[4];

    // Координатные массивы (узлы): X, Y, Z
    const coordEls = doc.querySelectorAll('Coordinates > DataArray');
    if (coordEls.length < 3) {
        throw new Error('Не найдены координатные массивы (Coordinates)');
    }
    const xCoords = await readDataArray(coordEls[0], doc, compressor);
    const yCoords = await readDataArray(coordEls[1], doc, compressor);
    const zCoords = await readDataArray(coordEls[2], doc, compressor);

    // Если координат не совпадает с Extent — доверяем координатам
    if (xCoords.length !== nX + 1) nX = Math.max(1, xCoords.length - 1);
    if (yCoords.length !== nY + 1) nY = Math.max(1, yCoords.length - 1);
    if (zCoords.length !== nZ + 1) nZ = Math.max(1, zCoords.length - 1);

    // Данные ячеек: ищем массив с именем, содержащим 'rho' (сопротивление),
    // иначе берём первый попавшийся
    const cellDataEls = doc.querySelectorAll('CellData > DataArray');
    if (cellDataEls.length === 0) {
        throw new Error('В .vtr файле нет данных ячеек (CellData)');
    }
    const valueEl =
        Array.from(cellDataEls).find(el => (el.getAttribute('Name') || '').toLowerCase().includes('rho')) ||
        cellDataEls[0];

    const rhoValues = await readDataArray(valueEl, doc, compressor);
    if (rhoValues.length < nX * nY * nZ) {
        throw new Error(`Недостаточно значений данных: ${rhoValues.length} из ${nX * nY * nZ}`);
    }

    return {
        nX, nY, nZ,
        xCells: toCellSizes(xCoords),
        yCells: toCellSizes(yCoords),
        zCells: toCellSizes(zCoords),
        rhoValues,
        dataName: valueEl.getAttribute('Name') || 'data'
    };
}

// Открывает модальное окно с 3D визуализацией .vtr файла
export async function showVtrViewer(vtrText, fileName) {
    const modal = document.createElement('div');
    modal.className = 'file-viewer-modal result-viewer-modal-large';
    modal.innerHTML = `
        <div class="file-viewer-content result-viewer-content-large">
            <div class="file-viewer-header">
                <h3>📊 3D Визуализация: ${fileName}</h3>
                <button class="file-viewer-close">&times;</button>
            </div>
            <div class="result-viewer-layout">
                <aside class="viewer-settings-panel" id="viewer-settings-panel">
                    <div class="settings-section">
                        <label class="settings-label" for="settings-colormap">Цветовая палитра</label>
                        <select class="viewer-select" id="settings-colormap"></select>
                    </div>
                    <div class="settings-section">
                        <div class="settings-label-row">
                            <span class="settings-label">Диапазон сопротивления (Ω·м)</span>
                            <span class="settings-hint" id="settings-range-hint"></span>
                        </div>
                        <div class="range-slider" data-min-input="settings-range-min" data-max-input="settings-range-max">
                            <div class="range-track"></div>
                            <div class="range-fill" id="settings-range-fill"></div>
                            <input type="range" class="range-input range-min" id="settings-range-min" min="0" max="1000" step="1" value="0" />
                            <input type="range" class="range-input range-max" id="settings-range-max" min="0" max="1000" step="1" value="1000" />
                        </div>
                        <div class="range-bounds">
                            <span id="settings-range-min-label"></span>
                            <span id="settings-range-max-label"></span>
                        </div>
                    </div>
                    <div class="settings-section">
                        <div class="settings-label-row">
                            <span class="settings-label">Прозрачность</span>
                            <span class="settings-hint" id="settings-opacity-hint">100%</span>
                        </div>
                        <input type="range" class="opacity-slider" id="settings-opacity" min="0" max="100" step="1" value="100" />
                    </div>
                    <div class="settings-section">
                        <label class="settings-toggle">
                            <input type="checkbox" id="settings-wireframe" />
                            <span class="toggle-track"><span class="toggle-thumb"></span></span>
                            <span class="settings-label">Контур (wireframe)</span>
                        </label>
                    </div>
                    <div class="settings-section">
                        <button class="viewer-reset-btn" id="settings-reset">↺ Сбросить настройки</button>
                    </div>
                </aside>
                <div class="viewer-3d-wrap">
                    <div id="vtr-3d-container" class="vtr-3d-container"></div>
                </div>
            </div>
            <div id="vtr-stats" class="vtr-stats">
                <p style="color: var(--color-text-tertiary);">⏳ Чтение .vtr файла…</p>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const container = modal.querySelector('#vtr-3d-container');
    const statsDiv = modal.querySelector('#vtr-stats');
    const colormapSelect = modal.querySelector('#settings-colormap');
    const rangeMinInput = modal.querySelector('#settings-range-min');
    const rangeMaxInput = modal.querySelector('#settings-range-max');
    const rangeFill = modal.querySelector('#settings-range-fill');
    const rangeMinLabel = modal.querySelector('#settings-range-min-label');
    const rangeMaxLabel = modal.querySelector('#settings-range-max-label');
    const rangeHint = modal.querySelector('#settings-range-hint');
    const opacityInput = modal.querySelector('#settings-opacity');
    const opacityHint = modal.querySelector('#settings-opacity-hint');
    const wireframeInput = modal.querySelector('#settings-wireframe');
    const resetBtn = modal.querySelector('#settings-reset');

    // Заполняем список палитр
    for (const name of ResultViewer.getColormapNames()) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        if (name === 'jet') opt.selected = true;
        colormapSelect.appendChild(opt);
    }

    const closeModal = () => {
        if (vtrViewerInstance) {
            vtrViewerInstance.dispose();
            vtrViewerInstance = null;
        }
        if (modal.parentNode) {
            document.body.removeChild(modal);
        }
    };

    modal.querySelector('.file-viewer-close').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // === Обработчики панели настроек ===
    // Слайдер диапазона работает в лог-шкале: внутреннее значение [0..1000]
    // маппится в [log10(dataMin), log10(dataMax)], а из него в Ω·м.
    let dataMinRho = 1;
    let dataMaxRho = 10;
    const updateRangeFromSlider = () => {
        if (!vtrViewerInstance) return;
        let vMin = parseInt(rangeMinInput.value, 10);
        let vMax = parseInt(rangeMaxInput.value, 10);
        if (vMin > vMax) {
            // визуально не даём ползункам меняться местами
            [vMin, vMax] = [vMax, vMin];
        }
        const t = (v, lo, hi) => lo + (v / 1000) * (hi - lo);
        const logLo = Math.log10(dataMinRho);
        const logHi = Math.log10(dataMaxRho);
        const minRho = Math.pow(10, t(vMin, logLo, logHi));
        const maxRho = Math.pow(10, t(vMax, logLo, logHi));
        vtrViewerInstance.setRange(minRho, maxRho);
        rangeFill.style.left = `${vMin / 10}%`;
        rangeFill.style.width = `${(vMax - vMin) / 10}%`;
        rangeMinLabel.textContent = formatRho(minRho);
        rangeMaxLabel.textContent = formatRho(maxRho);
        rangeHint.textContent = `${formatRho(minRho)} … ${formatRho(maxRho)} Ω·м`;
    };

    rangeMinInput.addEventListener('input', updateRangeFromSlider);
    rangeMaxInput.addEventListener('input', updateRangeFromSlider);

    opacityInput.addEventListener('input', () => {
        const alpha = parseInt(opacityInput.value, 10) / 100;
        if (vtrViewerInstance) vtrViewerInstance.setOpacity(alpha);
        opacityHint.textContent = `${opacityInput.value}%`;
    });

    wireframeInput.addEventListener('change', () => {
        if (vtrViewerInstance) vtrViewerInstance.setWireframe(wireframeInput.checked);
    });

    colormapSelect.addEventListener('change', () => {
        if (vtrViewerInstance) vtrViewerInstance.setColormap(colormapSelect.value);
    });

    resetBtn.addEventListener('click', () => {
        if (!vtrViewerInstance) return;
        vtrViewerInstance.resetSettings();
        // Синхронизируем UI с восстановленными значениями
        rangeMinInput.value = 0;
        rangeMaxInput.value = 1000;
        opacityInput.value = 100;
        opacityHint.textContent = '100%';
        wireframeInput.checked = false;
        colormapSelect.value = vtrViewerInstance.settings.colormap;
        updateRangeFromSlider();
    });

    try {
        if (vtrViewerInstance) {
            vtrViewerInstance.dispose();
        }

        vtrViewerInstance = new ResultViewer();
        const modelData = await parseVtrFile(vtrText);

        // Статистика
        let minRho = Infinity;
        let maxRho = -Infinity;
        let sum = 0;
        let count = 0;
        for (const v of modelData.rhoValues) {
            if (isFinite(v) && v > 0) {
                if (v < minRho) minRho = v;
                if (v > maxRho) maxRho = v;
                sum += v;
                count++;
            }
        }
        const avgRho = count > 0 ? sum / count : 0;
        if (count > 0) {
            dataMinRho = minRho;
            dataMaxRho = maxRho;
        }

        const xExtent = modelData.xCells.reduce((a, b) => a + b, 0);
        const yExtent = modelData.yCells.reduce((a, b) => a + b, 0);
        const zExtent = modelData.zCells.reduce((a, b) => a + b, 0);

        statsDiv.innerHTML = `
            <div class="vtr-stats-grid">
                <div>
                    <div class="vtr-stats-label">Размер модели</div>
                    <div class="vtr-stats-value">${modelData.nX} × ${modelData.nY} × ${modelData.nZ}</div>
                </div>
                <div>
                    <div class="vtr-stats-label">Всего ячеек</div>
                    <div class="vtr-stats-value">${(modelData.nX * modelData.nY * modelData.nZ).toLocaleString()}</div>
                </div>
                <div>
                    <div class="vtr-stats-label">Область (X × Y)</div>
                    <div class="vtr-stats-value">${(xExtent / 1000).toFixed(1)} × ${(yExtent / 1000).toFixed(1)} км</div>
                </div>
                <div>
                    <div class="vtr-stats-label">Глубина</div>
                    <div class="vtr-stats-value">${(zExtent / 1000).toFixed(1)} км</div>
                </div>
                <div>
                    <div class="vtr-stats-label">Мин. сопротивление</div>
                    <div class="vtr-stats-value">${count > 0 ? minRho.toFixed(2) : '—'} Ω·м</div>
                </div>
                <div>
                    <div class="vtr-stats-label">Макс. сопротивление</div>
                    <div class="vtr-stats-value">${count > 0 ? maxRho.toFixed(2) : '—'} Ω·м</div>
                </div>
                <div>
                    <div class="vtr-stats-label">Среднее</div>
                    <div class="vtr-stats-value">${count > 0 ? avgRho.toFixed(2) : '—'} Ω·м</div>
                </div>
            </div>
            <div class="vtr-stats-hint">
                💡 Используйте мышь для вращения, масштабирования и панорамирования модели
            </div>
        `;

        vtrViewerInstance.init3DVisualization(container, modelData);
        // Применяем текущие значения слайдеров после инициализации сцены
        updateRangeFromSlider();

    } catch (error) {
        console.error('Ошибка парсинга .vtr файла:', error);
        statsDiv.innerHTML = `<p style="color: var(--color-danger);">Ошибка при парсинге файла: ${error.message}</p>`;
    }
}

// Форматирует Ω·м для подписей: 1.23, 12.3, 123, 1.2K, 1.2e+4
function formatRho(v) {
    if (!isFinite(v) || v <= 0) return '—';
    if (v < 10) return v.toFixed(2);
    if (v < 100) return v.toFixed(1);
    if (v < 1000) return v.toFixed(0);
    if (v < 10000) return v.toFixed(0);
    return v.toExponential(1);
}

// === Вспомогательные функции парсинга VTK XML ===

// Читает DataArray в зависимости от формата: ascii, binary (inline base64), appended.
// Если у элемента есть атрибут compressor (например, "vtkZLibDataCompressor") —
// либо на самом DataArray, либо на корневом <VTKFile>, — данные лежат в формате
// сжатых блоков VTK и читаются отдельно.
function readDataArray(el, doc, fileCompressor) {
    const format = el.getAttribute('format') || 'ascii';
    const type = el.getAttribute('type') || 'Float32';
    const compressor = el.getAttribute('compressor') || fileCompressor;

    if (format === 'ascii') {
        return el.textContent.trim().split(/\s+/).filter(Boolean).map(Number);
    }

    if (format === 'binary') {
        const bytes = base64ToBytes(el.textContent.trim());
        if (compressor) {
            return readCompressedDataArray(bytes, type);
        }
        return decodeBlock(bytes, type);
    }

    if (format === 'appended') {
        const appendedBytes = getAppendedBytes(doc);
        if (!appendedBytes) {
            throw new Error('Не найден блок AppendedData для format="appended"');
        }
        const offset = parseInt(el.getAttribute('offset') || '0', 10);
        const data = appendedBytes.subarray(offset);
        if (compressor) {
            return readCompressedDataArray(data, type);
        }
        return decodeBlock(data, type);
    }

    throw new Error(`Не поддерживаемый формат данных: ${format}`);
}

// Бинарный блок начинается с 4-байтового заголовка (размер данных в байтах)
function decodeBlock(bytes, type) {
    if (bytes.length < 4) {
        throw new Error('Слишком короткий бинарный блок');
    }
    const headerView = new DataView(bytes.buffer, bytes.byteOffset, 4);
    const dataSize = headerView.getUint32(0, true);

    // Копируем в новый буфер, чтобы гарантировать выравнивание для TypedArray
    const data = bytes.buffer.slice(bytes.byteOffset + 4, bytes.byteOffset + 4 + dataSize);

    return typedArrayToArray(data, type);
}

function typedArrayToArray(buffer, type) {
    switch (type) {
        case 'Float64':
        case 'Double':
            return Array.from(new Float64Array(buffer));
        case 'Int32':
            return Array.from(new Int32Array(buffer));
        case 'Int64':
            return Array.from(new BigInt64Array(buffer), Number);
        case 'Float32':
        case 'Float':
        default:
            return Array.from(new Float32Array(buffer));
    }
}

// Распаковывает сжатые данные VTK (vtkZLibDataCompressor):
// заголовок = [numBlocks:u32, maxBlockSize:u32, lastBlockUncompressedSize:u32,
//               compressedSize[0..numBlocks-1]:u32],
// затем numBlocks zlib-блоков, лежащих подряд.
async function readCompressedDataArray(bytes, type) {
    if (bytes.length < 12) {
        throw new Error('Слишком короткий сжатый блок VTK');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numBlocks = view.getUint32(0, true);
    const maxBlockSize = view.getUint32(4, true);
    const lastBlockUncompressedSize = view.getUint32(8, true);
    if (numBlocks === 0 || numBlocks > 1_000_000) {
        throw new Error(`Подозрительное число блоков: ${numBlocks}`);
    }

    const headerSize = 12 + numBlocks * 4;
    if (bytes.length < headerSize) {
        throw new Error('Обрезанный заголовок сжатого блока VTK');
    }
    const sizes = [];
    for (let i = 0; i < numBlocks; i++) {
        sizes.push(view.getUint32(12 + i * 4, true));
    }

    // Суммарный распакованный размер
    const totalUncompressed = maxBlockSize * (numBlocks - 1) + lastBlockUncompressedSize;
    const result = new Uint8Array(totalUncompressed);
    let outOffset = 0;
    let inOffset = headerSize;
    for (let i = 0; i < numBlocks; i++) {
        const sz = sizes[i];
        const compressed = bytes.subarray(inOffset, inOffset + sz);
        inOffset += sz;
        const expected = (i === numBlocks - 1) ? lastBlockUncompressedSize : maxBlockSize;
        const decompressed = await decompressZlib(compressed, expected);
        result.set(decompressed, outOffset);
        outOffset += decompressed.length;
    }

    return typedArrayToArray(result.buffer, type);
}

// Декодирует zlib-обёртку (0x78 0x9c/0x01/0x5e и т.п.) через браузерный DecompressionStream.
async function decompressZlib(bytes, expectedSize) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('Браузер не поддерживает DecompressionStream (нужен Chrome 80+, Firefox 113+, Safari 16.4+)');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    const out = new Uint8Array(buffer);
    if (expectedSize != null && out.length !== expectedSize) {
        throw new Error(`Размер после распаковки ${out.length} не совпадает с ожидаемым ${expectedSize}`);
    }
    return out;
}

// Извлекает байты из блока AppendedData (поддерживается encoding="base64")
function getAppendedBytes(doc) {
    const appended = doc.querySelector('AppendedData');
    if (!appended) return null;

    const encoding = appended.getAttribute('encoding') || 'base64';
    if (encoding !== 'base64') {
        throw new Error('Поддерживается только base64-кодирование AppendedData');
    }

    // Содержимое начинается с символа "_"
    const text = appended.textContent.trim().replace(/^_/, '');
    return base64ToBytes(text);
}

function base64ToBytes(base64) {
    // В XML тексте внутри блоков встречаются переносы строк и пробелы —
    // убираем их все, иначе atob бросает InvalidCharacterError.
    const clean = base64.replace(/\s+/g, '');

    // Обычный случай: один корректный base64-блоб (format="binary" у DataArray).
    // atob спокойно переваривает padding "==" в конце строки.
    try {
        return decodeBase64Chunk(clean);
    } catch (e) {
        // падаем в ветку для сцепленных фрагментов ниже
    }

    // Сцепленные base64-фрагменты (AppendedData с несколькими блоками):
    // '=' в base64 — только padding, данных не несёт, поэтому режем по нему
    // и дописываем каждому куску ровно столько '=', сколько не хватает
    // до кратности 4 (а не всегда "==", как было раньше).
    const parts = clean.split('=').filter(Boolean);
    const buffers = [];
    let totalLen = 0;
    for (const part of parts) {
        const pad = (4 - (part.length % 4)) % 4;
        const decoded = decodeBase64Chunk(part + '='.repeat(pad));
        buffers.push(decoded);
        totalLen += decoded.length;
    }
    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const b of buffers) {
        out.set(b, off);
        off += b.length;
    }
    return out;
}

function decodeBase64Chunk(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Размеры ячеек из координат узлов. Берём модуль разности — на случай,
// если координаты записаны в порядке убывания (например, отметки высоты)
function toCellSizes(coords) {
    const cells = [];
    for (let i = 1; i < coords.length; i++) {
        cells.push(Math.abs(coords[i] - coords[i - 1]));
    }
    return cells;
}