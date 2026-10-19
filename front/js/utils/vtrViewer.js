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
                <div class="viewer-3d-wrap">
                    <div id="vtr-3d-container" class="vtr-3d-container"></div>
                </div>
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
                            <input type="range" class="range-input range-min" id="settings-range-min" min="0" max="10000" step="1" value="0" />
                            <input type="range" class="range-input range-max" id="settings-range-max" min="0" max="10000" step="1" value="10000" />
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
    // Слайдер диапазона работает в лог-шкале: внутреннее значение [0..10000]
    // маппится в [log10(dataMin), log10(dataMax)], а из него в Ω·м.
    // 10000 шагов вместо 1000 — на широком слайдере даёт плавную настройку
    // без пропуска значений.
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
        const t = (v, lo, hi) => lo + (v / 10000) * (hi - lo);
        const logLo = Math.log10(dataMinRho);
        const logHi = Math.log10(dataMaxRho);
        const minRho = Math.pow(10, t(vMin, logLo, logHi));
        const maxRho = Math.pow(10, t(vMax, logLo, logHi));
        vtrViewerInstance.setRange(minRho, maxRho);
        rangeFill.style.left = `${vMin / 100}%`;
        rangeFill.style.width = `${(vMax - vMin) / 100}%`;
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
        rangeMaxInput.value = 10000;
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
                    <div class="vtr-stats-value">${formatMeters(xExtent)} × ${formatMeters(yExtent)} м</div>
                </div>
                <div>
                    <div class="vtr-stats-label">Глубина</div>
                    <div class="vtr-stats-value">${formatMeters(zExtent)} м</div>
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

        // Lazy-init: 3D-рендер создаётся только по кнопке, чтобы не тормозить
        // открытие решения на мобильных / слабых устройствах.
        container.innerHTML = '';
        const totalCells = modelData.nX * modelData.nY * modelData.nZ;
        const isMobile = ResultViewer._detectMobile();
        const placeholder = document.createElement('div');
        placeholder.className = 'vtr-lazy-placeholder';
        placeholder.innerHTML = `
            <div class="vtr-lazy-icon">🧊</div>
            <div class="vtr-lazy-title">3D-модель готова к просмотру</div>
            <div class="vtr-lazy-info">${modelData.nX}×${modelData.nY}×${modelData.nZ} · ${(totalCells).toLocaleString()} ячеек</div>
            ${isMobile ? '<div class="vtr-lazy-warn">⚠️ На мобильном устройстве рендер может работать медленнее</div>' : ''}
            <button type="button" class="btn btn-primary vtr-lazy-btn">🔍 Посмотреть в 3D</button>
        `;
        container.appendChild(placeholder);

        let initialized = false;
        const initRenderer = async () => {
            if (initialized) return;
            initialized = true;
            container.innerHTML = '';
            await vtrViewerInstance.init3DVisualization(container, modelData);
            updateRangeFromSlider();
        };

        placeholder.querySelector('.vtr-lazy-btn').addEventListener('click', initRenderer);

    } catch (error) {
        console.error('Ошибка парсинга .vtr файла:', error);
        statsDiv.innerHTML = `<p style="color: var(--color-danger);">Ошибка при парсинге файла: ${error.message}</p>`;
    }
}

// Форматирует метры с группировкой разрядов: 2193934 -> "2 193 934"
function formatMeters(v) {
    if (!isFinite(v)) return '—';
    return Math.round(v).toLocaleString('ru-RU');
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

// === Inline Web Worker для тяжёлых операций парсинга ===
// Выносит CPU-intensive работу (парсинг чисел из текста, zlib-декомпрессию)
// из main thread, чтобы не блокировать UI на мобильных / слабых устройствах.
const _vtrWorkerCode = `
self.onmessage = async function(e) {
    const { id, task, data } = e.data;
    try {
        if (task === 'parseNumbers') {
            // Парсинг чисел из текста (ascii format DataArray)
            const text = data.text;
            const parts = text.trim().split(/\\s+/);
            const result = new Float64Array(parts.length);
            for (let i = 0; i < parts.length; i++) result[i] = +parts[i];
            self.postMessage({ id, buffer: result.buffer }, [result.buffer]);
        } else if (task === 'decompress') {
            // Zlib-декомпрессия через DecompressionStream
            const bytes = new Uint8Array(data.bytes);
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
            const buffer = await new Response(stream).arrayBuffer();
            self.postMessage({ id, buffer }, [buffer]);
        } else if (task === 'typedConvert') {
            // Конвертация ArrayBuffer в нужный TypedArray → Float64Array
            const buf = data.buffer;
            const type = data.type;
            let arr;
            switch (type) {
                case 'Float64': case 'Double':
                    arr = new Float64Array(buf); break;
                case 'Int32':
                    arr = new Int32Array(buf); break;
                case 'Float32': case 'Float': default:
                    arr = new Float32Array(buf); break;
            }
            const out = new Float64Array(arr.length);
            for (let i = 0; i < arr.length; i++) out[i] = arr[i];
            self.postMessage({ id, buffer: out.buffer }, [out.buffer]);
        }
    } catch (err) {
        self.postMessage({ id, error: err.message || String(err) });
    }
};
`;

let _vtrWorker = null;
let _vtrWorkerReqId = 0;
const _vtrWorkerCallbacks = new Map();

function _getVtrWorker() {
    if (_vtrWorker) return _vtrWorker;
    try {
        const blob = new Blob([_vtrWorkerCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        _vtrWorker = new Worker(url);
        URL.revokeObjectURL(url);
        _vtrWorker.onmessage = (e) => {
            const { id, buffer, error } = e.data;
            const cb = _vtrWorkerCallbacks.get(id);
            if (cb) {
                _vtrWorkerCallbacks.delete(id);
                if (error) cb.reject(new Error(error));
                else cb.resolve(buffer);
            }
        };
        _vtrWorker.onerror = (err) => {
            console.warn('[VTR WORKER] Worker error, falling back to main thread:', err);
            _vtrWorker.terminate();
            _vtrWorker = null;
            // Reject all pending
            for (const [id, cb] of _vtrWorkerCallbacks) {
                cb.reject(new Error('Worker terminated'));
            }
            _vtrWorkerCallbacks.clear();
        };
        return _vtrWorker;
    } catch (err) {
        console.warn('[VTR WORKER] Cannot create worker, using main thread:', err);
        return null;
    }
}

function _workerTask(task, data, transferables) {
    return new Promise((resolve, reject) => {
        const worker = _getVtrWorker();
        if (!worker) { reject(new Error('No worker')); return; }
        const id = ++_vtrWorkerReqId;
        _vtrWorkerCallbacks.set(id, { resolve, reject });
        worker.postMessage({ id, task, data }, transferables || []);
    });
}

/** Парсит числа из текста в worker (fallback: main thread). */
async function parseNumbersInWorker(text) {
    try {
        const buf = await _workerTask('parseNumbers', { text });
        return new Float64Array(buf);
    } catch (_) {
        // Fallback: main thread
        return text.trim().split(/\s+/).filter(Boolean).map(Number);
    }
}

/** Декомпрессия zlib в worker (fallback: main thread). */
async function decompressInWorker(bytes) {
    try {
        const copy = new Uint8Array(bytes); // can't transfer shared buffer
        const buf = await _workerTask('decompress', { bytes: copy.buffer }, [copy.buffer]);
        return new Uint8Array(buf);
    } catch (_) {
        return decompressZlib(bytes);
    }
}

/** Конвертация typed array в worker (fallback: main thread). */
async function typedConvertInWorker(buffer, type) {
    try {
        const copy = buffer.slice(0);
        const buf = await _workerTask('typedConvert', { buffer: copy, type }, [copy]);
        return Array.from(new Float64Array(buf));
    } catch (_) {
        return typedArrayToArray(buffer, type);
    }
}

// Читает DataArray в зависимости от формата: ascii, binary (inline base64), appended.
// Если у элемента есть атрибут compressor (например, "vtkZLibDataCompressor") —
// либо на самом DataArray, либо на корневом <VTKFile>, — данные лежат в формате
// сжатых блоков VTK и читаются отдельно.
// Тяжёлые операции (парсинг чисел, декомпрессия) вынесены в Web Worker.
function readDataArray(el, doc, fileCompressor) {
    const format = el.getAttribute('format') || 'ascii';
    const type = el.getAttribute('type') || 'Float32';
    const compressor = el.getAttribute('compressor') || fileCompressor;

    if (format === 'ascii') {
        // Тяжёлая операция — вынесена в Web Worker для неблокирующего UI
        return parseNumbersInWorker(el.textContent);
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

    return typedConvertInWorker(data, type);
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

    return typedConvertInWorker(result.buffer, type);
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