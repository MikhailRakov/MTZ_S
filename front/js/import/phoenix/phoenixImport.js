// Import UI: сырые данные Phoenix MT (.zip с .TBL + Cal/*)
import { parseTbl, extractStationInfo, parseCalFile, calResponseCurves, buildStationList } from './phoenixParser.js';
import { stationPlotLayout, findNearestStationPoint, drawStationPlot } from './stationPlot.js';
import { showHint } from '../../utils/onboardingHints.js';
import { getCurrentSolutionID } from '../../utils/currentSolution.js';

/** Состояние редактора калибровочных кривых (модульный уровень для доступа из resetPhoenixUI) */
let _calEditorState = null;
let _calCanvasRef = null;
/**
 * Замороженные диапазоны осей на время перетаскивания точки.
 * Пока точка тянется, масштаб не пересчитывается — иначе значение «убегает» к краю
 * (амплитуда/фаза меняются → диапазон меняется → точка снова на краю).
 */
let _calFrozenRanges = null;
/** Текущий layout схемы (нужен для попадания клика по точке) */
let _stationPlotLayout = null;
/** Наблюдатель размеров контейнера схемы (перерисовка при resize) */
let _stationPlotObserver = null;

/**
 * Уничтожить схему расположения станций (сброс/смена решения). Безопасно вызывать без схемы.
 */
export function destroyStationMap() {
    _stationPlotLayout = null;
    if (_stationPlotObserver) {
        _stationPlotObserver.disconnect();
        _stationPlotObserver = null;
    }
    const div = document.getElementById('phoenix-station-map');
    if (div) {
        div.innerHTML = '';
        div.classList.remove('phoenix-map-fallback');
    }
}

/**
 * Список опций селектора кривых: «все» (-1) + нумерованные кривые.
 * @param {{name: string}[]} curvesList
 * @returns {{value: number, label: string}[]}
 */
export function buildCurveOptions(curvesList) {
    const opts = [{ value: -1, label: '✏️ Все кривые' }];
    if (Array.isArray(curvesList)) {
        curvesList.forEach((entry, i) => {
            opts.push({ value: i, label: `${i + 1}. ${entry && entry.name ? entry.name : 'кривая ' + (i + 1)}` });
        });
    }
    return opts;
}

/**
 * Индексы кривых, которые должны отображаться на графике.
 * selectedCurveIdx = -1 → видны все кривые; иначе — только выбранная
 * (остальные полностью скрыты, а не «приглушены»).
 * @param {?Array} curvesList
 * @param {number} [selectedCurveIdx=-1]
 * @returns {number[]}
 */
export function visibleCurveIndices(curvesList, selectedCurveIdx = -1) {
    if (!Array.isArray(curvesList) || curvesList.length === 0) return [];
    const all = curvesList.map((_, i) => i);
    const raw = Number(selectedCurveIdx);
    if (!Number.isFinite(raw) || raw < 0) return all;   // -1 (все кривые) и любой отрицательный
    const idx = Math.floor(raw);
    if (idx >= curvesList.length) return all;            // защита от несуществующей кривой
    return [idx];
}

/**
 * Диапазоны осей, посчитанные ТОЛЬКО по видимым кривым.
 * @param {?Array} curvesList
 * @param {?number[]} [visibleIndices] — если не задано, учитываются все кривые
 * @returns {?{fMin:number,fMax:number,logFMin:number,logFMax:number,ampMin:number,ampMax:number,ampRange:number,phMin:number,phMax:number,phRange:number}}
 */
export function computeCurveRanges(curvesList, visibleIndices = null) {
    if (!Array.isArray(curvesList) || curvesList.length === 0) return null;

    const indices = Array.isArray(visibleIndices) ? visibleIndices : curvesList.map((_, i) => i);

    const freqs = [];
    const amps = [];
    const phases = [];
    for (const ci of indices) {
        const entry = curvesList[ci];
        if (!entry || !Array.isArray(entry.curves)) continue;
        for (const curve of entry.curves) {
            if (Array.isArray(curve.frequencies)) freqs.push(...curve.frequencies);
            if (Array.isArray(curve.amplitudes)) amps.push(...curve.amplitudes);
            if (Array.isArray(curve.phases)) phases.push(...curve.phases);
        }
    }

    const posFreqs = freqs.filter(f => Number.isFinite(f) && f > 0);
    if (posFreqs.length === 0) return null;

    const fMin = Math.min(...posFreqs);
    const fMax = Math.max(...freqs.filter(f => Number.isFinite(f) && f > 0));
    const logFMin = Math.log10(fMin);
    // Защита от деления на ноль, если частота единственная
    const logFMax = logFMin === Math.log10(fMax) ? logFMin + 1 : Math.log10(fMax);

    const ampMin = amps.length ? Math.min(...amps) : 0;
    const ampMax = amps.length ? Math.max(...amps) : 0;
    const ampRange = (ampMax - ampMin) || 1;

    const phMin = phases.length ? Math.min(...phases) : 0;
    const phMax = phases.length ? Math.max(...phases) : 0;
    const phRange = (phMax - phMin) || 1;

    return { fMin, fMax, logFMin, logFMax, ampMin, ampMax, ampRange, phMin, phMax, phRange };
}

/**
/**
 * Координаты указателя во внутренней системе canvas.
 * Canvas может быть растянут CSS (width:100% на мобильных) — client-координаты
 * нужно пересчитать обратно во внутренние пиксели, иначе попадание курсора
 * «плывёт». Чистая функция — тестируется напрямую.
 *
 * @param {?{left:number,top:number,width:number,height:number}} rect getBoundingClientRect() (или null)
 * @param {number} canvasW canvas.width (внутренние пиксели)
 * @param {number} canvasH canvas.height
 * @returns {{x: number, y: number, inside: boolean}}
 */
export function pointerToCanvas(rect, canvasW, canvasH, clientX, clientY) {
    const left = rect && Number.isFinite(rect.left) ? rect.left : 0;
    const top = rect && Number.isFinite(rect.top) ? rect.top : 0;
    const w = rect && rect.width > 0 ? rect.width : canvasW;
    const h = rect && rect.height > 0 ? rect.height : canvasH;
    const sx = w > 0 ? canvasW / w : 1;
    const sy = h > 0 ? canvasH / h : 1;
    const x = (clientX - left) * sx;
    const y = (clientY - top) * sy;
    return { x, y, inside: x >= 0 && x <= canvasW && y >= 0 && y <= canvasH };
}

/**
 * Один шаг перетаскивания точки при ЗАМОРОЖЕННОМ масштабе оси.
 *
 * Значение меняется 1:1 с движением мыши (scale — единиц значения на пиксель,
 * фиксируется в момент захвата). Окно оси (min) сдвигается (панорамируется),
 * если точка вышла бы за границы графика — иначе пересчёт масштаба «прижимал»
 * её к краю и увести значение выше старого максимума было невозможно.
 *
 * @param {number} scale  — valuePerPx (valRange / plotH на момент захвата)
 * @param {{pad: {top: number}, plotH: number}} area — геометрия графика
 * @param {number} grabValue — значение точки в момент захвата
 * @param {number} grabY     — экранная Y курсора в момент захвата
 * @param {number} currentY  — текущая экранная Y курсора
 * @returns {{value: number, min: number, targetY: number}}
 */
export function computeDragUpdate(scale, area, grabValue, grabY, currentY) {
    const value = grabValue + (grabY - currentY) * scale;
    const plotTop = (area && area.pad ? area.pad.top : 0);
    const plotH = area && Number.isFinite(area.plotH) && area.plotH > 0 ? area.plotH : 0;
    const plotBottom = plotTop + plotH;
    const targetY = Math.max(plotTop, Math.min(plotBottom, currentY));
    const min = value - (plotBottom - targetY) * scale;
    return { value, min, targetY };
}

/**
 * Поиск ближайшей точки к курсору мыши (модульный уровень — тестируется напрямую).
 * @param {number} [onlyCurveIdx=-1] — если >= 0, искать только на кривой с этим индексом
 * @returns {?{curveIdx: number, subIdx: number, pointIdx: number, distance: number, channel: 'amp'|'phase', x: number, y: number}}
 */
export function findNearestPoint(mouseX, mouseY, curvesList, ranges, hitRadius = 12, onlyCurveIdx = -1) {
    if (!Array.isArray(curvesList)) return null;
    if (onlyCurveIdx >= curvesList.length) return null; // защита от «выбранной» несуществующей кривой
    let best = null;
    for (let ci = 0; ci < curvesList.length; ci++) {
        if (onlyCurveIdx >= 0 && ci !== onlyCurveIdx) continue;
        const entry = curvesList[ci];
        if (!entry || !Array.isArray(entry.curves)) continue;
        for (let si = 0; si < entry.curves.length; si++) {
            const curve = entry.curves[si];
            const { frequencies, amplitudes, phases } = curve;
            for (let i = 0; i < frequencies.length; i++) {
                if (frequencies[i] <= 0) continue;
                const logF = Math.log10(frequencies[i]);
                const x = ranges.area.pad.left + ((logF - ranges.logFMin) / (ranges.logFMax - ranges.logFMin)) * ranges.area.plotW;

                // Амплитуда
                const yAmp = ranges.area.pad.top + ranges.area.plotH - ((amplitudes[i] - ranges.ampMin) / ranges.ampRange) * ranges.area.plotH;
                const distAmp = Math.hypot(mouseX - x, mouseY - yAmp);
                if (distAmp <= hitRadius && (!best || distAmp < best.distance)) {
                    best = { curveIdx: ci, subIdx: si, pointIdx: i, distance: distAmp, channel: 'amp', x, y: yAmp };
                }

                // Фаза
                const yPh = ranges.area.pad.top + ranges.area.plotH - ((phases[i] - ranges.phMin) / ranges.phRange) * ranges.area.plotH;
                const distPh = Math.hypot(mouseX - x, mouseY - yPh);
                if (distPh <= hitRadius && (!best || distPh < best.distance)) {
                    best = { curveIdx: ci, subIdx: si, pointIdx: i, distance: distPh, channel: 'phase', x, y: yPh };
                }
            }
        }
    }
    return best;
}

/**
 * Отключение редактора калибровочных кривых (при сбросе формы).
 * Экспортируется для вызова из resetCoarseGenerator.
 */
export function disableCalCurvesEditor() {
    if (_calCanvasRef) {
        const c = _calCanvasRef;
        if (c._calEditorPointerDown) c.removeEventListener('pointerdown', c._calEditorPointerDown);
        if (c._calEditorPointerMove) c.removeEventListener('pointermove', c._calEditorPointerMove);
        if (c._calEditorPointerUp) c.removeEventListener('pointerup', c._calEditorPointerUp);
        if (c._calEditorPointerCancel) c.removeEventListener('pointercancel', c._calEditorPointerCancel);
        if (c._calEditorPointerLeave) c.removeEventListener('pointerleave', c._calEditorPointerLeave);
        // legacy mouse-слушатели (на случай старых страниц в кэше)
        if (c._calEditorMouseDown) c.removeEventListener('mousedown', c._calEditorMouseDown);
        if (c._calEditorMouseMove) c.removeEventListener('mousemove', c._calEditorMouseMove);
        if (c._calEditorMouseUp) c.removeEventListener('mouseup', c._calEditorMouseUp);
        if (c._calEditorMouseLeave) c.removeEventListener('mouseleave', c._calEditorMouseLeave);
        if (typeof document !== 'undefined' && c._calEditorKeyDown) {
            document.removeEventListener('keydown', c._calEditorKeyDown);
        }
        c.style.cursor = '';
        c._calEditorBound = false;
    }
    _calEditorState = null;
    _calFrozenRanges = null; // замороженный масштаб не должен пережить сброс
}

/** Сброс Phoenix UI при переключении решений (переменные локальны для initPhoenixImport, запрошиваем DOM напрямую) */
/** Хук сброса состояния замыкания initPhoenixImport (ставится при инициализации) */
let _closureResetHook = null;

export function resetPhoenixUI() {
    const phoenixPreview = document.getElementById('phoenix-preview');
    const phoenixMessage = document.getElementById('phoenix-upload-message');
    const phoenixProgress = document.getElementById('phoenix-upload-progress');
    const phoenixFileInput = document.getElementById('phoenix-file-input');
    const curveSel = document.getElementById('phoenix-curve-select');
    const stationSel = document.getElementById('phoenix-station-select');
    if (phoenixPreview) phoenixPreview.classList.add('hidden');
    if (phoenixMessage) {
        phoenixMessage.textContent = '';
        phoenixMessage.className = 'upload-message hidden';
    }
    if (phoenixProgress) phoenixProgress.classList.add('hidden');
    if (phoenixFileInput) phoenixFileInput.value = '';
    if (curveSel) curveSel.innerHTML = '';
    if (stationSel) stationSel.innerHTML = '';

    // Отключаем редактор калибровочных кривых и уничтожаем карту станций
    disableCalCurvesEditor();
    destroyStationMap();

    // Сброс приватного состояния замыкания (zipBlob/stations и т.д.) — чистый лист
    if (_closureResetHook) _closureResetHook();
}

// ===== Phoenix Import Logic =====

/**
 * Инициализация обработчиков импорта Phoenix.
 * Вызывается один раз при загрузке dashboard.
 */
export function initPhoenixImport() {
    const uploadArea = document.getElementById('phoenix-upload-area');
    const fileInput = document.getElementById('phoenix-file-input');
    const preview = document.getElementById('phoenix-preview');
    const stationInfo = document.getElementById('phoenix-station-info');
    const calCanvas = document.getElementById('phoenix-cal-canvas');
    const calLegend = document.getElementById('phoenix-cal-legend');
    const resetBtn = document.getElementById('phoenix-reset-btn');
    const submitBtn = document.getElementById('phoenix-submit-btn');
    const progressEl = document.getElementById('phoenix-upload-progress');
    const progressBar = document.getElementById('phoenix-progress-bar');
    const progressPercent = document.getElementById('phoenix-progress-percent');
    const messageEl = document.getElementById('phoenix-upload-message');
    const latInput = document.getElementById('phoenix-lat');
    const lonInput = document.getElementById('phoenix-lon');
    const elevInput = document.getElementById('phoenix-elev');
    const declInput = document.getElementById('phoenix-decl');
    const curveSelect = document.getElementById('phoenix-curve-select');
    const stationSelect = document.getElementById('phoenix-station-select');
    const mapDiv = document.getElementById('phoenix-station-map');

    if (!uploadArea || !fileInput) {
        console.warn('[PHOENIX] Upload area or file input not found in DOM — Phoenix import disabled');
        return;
    }

    let zipBlob = null;
    let stationData = null;        // объединённая активная станция для формы/метаданных
    let calCurvesList = [];
    let stationInfos = [];         // сырые результаты extractStationInfo по индексам
    let stations = [];             // нормализованный список (buildStationList)
    let activeStationIdx = 0;
    let selectedCurveIdx = -1;     // -1 = редактируем все кривые

    // Click to upload
    uploadArea.addEventListener('click', () => fileInput.click());

    // Drag and drop
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = 'var(--color-warning)';
    });
    uploadArea.addEventListener('dragleave', () => {
        uploadArea.style.borderColor = '';
    });
    uploadArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '';
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].name.toLowerCase().endsWith('.zip')) {
            await handlePhoenixZip(files[0]);
        } else {
            showMessage('Пожалуйста, загрузите .zip архив', 'error');
        }
    });

    // File input change
    fileInput.addEventListener('change', async (e) => {
        if (e.target.files.length > 0) {
            await handlePhoenixZip(e.target.files[0]);
        }
    });

    // Reset button
    resetBtn?.addEventListener('click', () => {
        zipBlob = null;
        stationData = null;
        calCurvesList = [];
        stationInfos = [];
        stations = [];
        activeStationIdx = 0;
        selectedCurveIdx = -1;
        preview.classList.add('hidden');
        fileInput.value = '';
        showMessage('', '');
        progressEl?.classList.add('hidden');
        destroyStationMap();
    });

    // Выбор конкретной кривой для редактирования
    curveSelect?.addEventListener('change', () => {
        selectedCurveIdx = parseInt(curveSelect.value, 10);
        if (Number.isNaN(selectedCurveIdx)) selectedCurveIdx = -1;
        if (calCurvesList.length > 0) drawCalCurves(calCurvesList);
    });

    // Переключение активной станции (список + маркер на карте)
    stationSelect?.addEventListener('change', () => {
        const idx = parseInt(stationSelect.value, 10);
        if (!Number.isNaN(idx)) selectStation(idx);
    });

    // Submit button
    submitBtn?.addEventListener('click', async () => {
        if (!zipBlob) {
            showMessage('Сначала загрузите архив', 'error');
            return;
        }
        await submitPhoenixData();
    });

    /**
     * Обработка загруженного zip-архива Phoenix.
     */
    async function handlePhoenixZip(file) {
        try {
            showMessage('Распаковка архива...', 'info');
            zipBlob = file;

            // Динамический импорт JSZip (уже загружен в dashboard.html, но используем dynamic для безопасности)
            const JSZip = window.JSZip;
            if (!JSZip) {
                showMessage('Ошибка: JSZip не загружен', 'error');
                return;
            }

            const zip = await JSZip.loadAsync(file);
            const fileNames = Object.keys(zip.files);

            // Найти все TBL файлы (по расширению, игнорируя регистр и директории)
            const tblCandidates = fileNames.filter(n => {
                const upper = n.toUpperCase();
                return upper.endsWith('.TBL') && !zip.files[n].dir;
            });
            if (tblCandidates.length === 0) {
                showMessage('Архив не содержит .TBL файлов. Содержимое: ' + fileNames.slice(0, 10).join(', '), 'error');
                return;
            }

            // Парсить ВСЕ непустые TBL: в архиве может быть несколько станций
            stationInfos = [];
            const tblFallbackNames = [];
            for (const candidate of tblCandidates) {
                const buf = await zip.file(candidate).async('arraybuffer');
                if (buf.byteLength === 0) {
                    console.warn(`[PHOENIX] Skipping empty TBL: ${candidate}`);
                    continue;
                }
                try {
                    stationInfos.push(extractStationInfo(parseTbl(buf)));
                    const base = candidate.split('/').pop() || candidate;
                    tblFallbackNames.push(base.replace(/\.tbl$/i, ''));
                } catch (err) {
                    console.warn(`[PHOENIX] Failed to parse TBL ${candidate}:`, err);
                }
            }

            stations = buildStationList(stationInfos, tblFallbackNames);
            if (stations.length === 0) {
                showMessage('Не удалось распознать ни одной станции из .TBL файлов архива', 'error');
                return;
            }
            activeStationIdx = 0;

            // Найти Cal файлы
            const calPaths = fileNames.filter(n => {
                const upper = n.toUpperCase();
                return (upper.endsWith('.CLC') || upper.endsWith('.CLB') || upper.endsWith('.CLE'))
                    && upper.includes('CAL');
            });

            // Парсинг калибровок
            calCurvesList = [];
            for (const calPath of calPaths) {
                try {
                    const calBuffer = await zip.file(calPath).async('arraybuffer');
                    const calData = parseCalFile(calBuffer);
                    const curves = calResponseCurves(calData);
                    if (curves && curves.length > 0) {
                        const fileName = calPath.split('/').pop() || calPath;
                        const transformed = transformCurvesForCanvas(curves);
                        calCurvesList.push({ name: fileName, curves: [transformed] });
                    }
                } catch (err) {
                    console.warn(`[PHOENIX] Failed to parse cal file ${calPath}:`, err);
                }
            }

            // Заполнить UI: станции, кривые, схему расположения
            populateStationSelect();
            selectStation(0);
            selectedCurveIdx = -1;
            populateCurveSelect();
            drawCalCurves(calCurvesList);
            renderStationPlot();

            preview.classList.remove('hidden');
            showMessage('Архив успешно распознан. Проверьте данные и нажмите «Отправить».', 'success');

        } catch (err) {
            console.error('[PHOENIX] Zip processing error:', err);
            showMessage(`Ошибка обработки архива: ${err.message}`, 'error');
        }
    }

    /**
     * Отрисовать схему расположения станций (вид сверху, физические метры).
     * Работает офлайн: canvas + собственная отрисовка, без внешних карт.
     */
    function renderStationPlot() {
        if (!mapDiv) return;
        const canvas = ensureStationPlotCanvas();
        if (!canvas) return;

        // Размеры берём из контейнера (canvas позиционирован абсолютно и не влияет на его высоту).
        const cssW = Math.max(320, mapDiv.clientWidth || Math.round(mapDiv.getBoundingClientRect().width) || 600);
        let cssH = Math.round(mapDiv.getBoundingClientRect().height);
        if (cssH < 40) {
            // Контейнер без заданной высоты (нет стилей) — задаём минимальный размер один раз.
            cssH = 260;
            mapDiv.style.height = cssH + 'px';
        }
        cssH = Math.max(180, cssH);

        const layout = stationPlotLayout(stations, cssW, cssH, 34);
        const note = document.getElementById('phoenix-station-plot-note');
        if (!layout) {
            mapDiv.classList.add('phoenix-map-fallback');
            mapDiv.innerHTML = '<div class="phoenix-map-fallback-inner">Ни одна станция в архиве не имеет валидных координат — схему показать нельзя.</div>';
            _stationPlotLayout = null;
            if (note) {
                note.textContent = '';
                note.style.display = 'none';
            }
            return;
        }
        mapDiv.classList.remove('phoenix-map-fallback');

        // Какие станции не попали на схему (нет координат) — показываем подпись под схемой.
        if (note) {
            const noCoords = stations.filter(s => !Number.isFinite(s.latitude) || !Number.isFinite(s.longitude));
            note.textContent = noCoords.length
                ? `Без координат (на схеме не показаны): ${noCoords.map(s => s.stationId || '—').join(', ')}`
                : '';
            note.style.display = noCoords.length ? '' : 'none';
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawStationPlot(ctx, layout, { activeIndex: activeStationIdx, width: cssW, height: cssH });
        _stationPlotLayout = layout;
    }

    /**
     * Создать canvas схемы внутри контейнера (однократно) и навесить обработчики.
     */
    function ensureStationPlotCanvas() {
        if (!mapDiv) return null;
        let canvas = mapDiv.querySelector('canvas.phoenix-station-plot');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.className = 'phoenix-station-plot';
            // Позиционируем canvas абсолютно: его размеры не должны влиять на высоту контейнера
            // (иначе контейнер растёт вместе с canvas по кругу).
            canvas.style.cssText = 'position:absolute;left:0;top:0;display:block;width:100%;height:100%;touch-action:manipulation;cursor:pointer;';
            mapDiv.innerHTML = '';
            mapDiv.appendChild(canvas);
            // Контейнер должен быть позиционирован и обрезать содержимое (canvas не должен «вылезать»).
            const mcs = window.getComputedStyle(mapDiv);
            if (mcs.position === 'static') mapDiv.style.position = 'relative';
            if (mcs.overflow === 'visible') mapDiv.style.overflow = 'hidden';
            canvas.addEventListener('click', onStationPlotClick);
            // Перерисовка при изменении размеров контейнера (resize окна, смена вкладки)
            if (typeof ResizeObserver !== 'undefined') {
                _stationPlotObserver = new ResizeObserver(() => renderStationPlot());
                _stationPlotObserver.observe(mapDiv);
            }
        }
        return canvas;
    }

    /**
     * Клик по схеме → выбрать ближайшую станцию.
     */
    function onStationPlotClick(e) {
        const layout = _stationPlotLayout;
        if (!layout) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = (e.clientX - rect.left) * (layout.width / rect.width);
        const y = (e.clientY - rect.top) * (layout.height / rect.height);
        const hit = findNearestStationPoint(x, y, layout, 16);
        if (hit) selectStation(hit.index);
    }

    /**
     * Отображение информации о станции.
     */
    function populateStationInfo(info) {
        if (!stationInfo || !info) return;
        const rows = [
            ['Станция', info.stationId || '—'],
            ['Прибор', `${info.instrument || '—'} (FW: ${info.firmware || '—'})`],
            ['Координаты', `${info.latitude?.toFixed(4) ?? '—'}°N, ${info.longitude?.toFixed(4) ?? '—'}°E`],
            ['Высота', info.elevation != null ? `${info.elevation} м` : '—'],
            ['Длина диполей', `Ex=${info.exLength ?? '?'} м, Ey=${info.eyLength ?? '?'} м`],
            ['Магнитные датчики', `Hx=${info.hxSensor || '—'}, Hy=${info.hySensor || '—'}, Hz=${info.hzSensor || '—'}`],
            ['Начало записи', info.startTime || '—'],
            ['Частота дискретизации', info.sampleRate ? `${info.sampleRate} Гц` : '—'],
            ['Магн. склонение', info.declination != null ? `${info.declination}°` : '—'],
        ];
        stationInfo.innerHTML = rows.map(([k, v]) =>
            `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--color-border-light);">
                <span style="color:var(--color-text-secondary);font-size:var(--text-sm);">${k}</span>
                <span style="font-weight:500;font-size:var(--text-sm);">${v}</span>
            </div>`
        ).join('');
    }

    /**
     * Слияние сырого extractStationInfo + нормализованной записи списка станций
     * в один объект для populateStationInfo/fillEditableFields/метаданных отправки.
     */
    function mergeStation(i) {
        const raw = stationInfos[i] || {};
        const st = stations[i] || {};
        return {
            ...raw,
            stationId: st.stationId || raw.fileName || '—',
            latitude: st.latitude != null ? st.latitude : null,
            longitude: st.longitude != null ? st.longitude : null,
            elevation: st.elevation != null ? st.elevation : null,
            declination: st.declination != null ? st.declination : raw.declination,
            exLength: raw.exLine,
            eyLength: raw.eyLine,
        };
    }

    /**
     * Сделать станцию idx активной: обновить инфо-блок, поля формы, селектор, схему расположения.
     */
    function selectStation(idx) {
        if (idx < 0 || idx >= stations.length) return;
        activeStationIdx = idx;
        stationData = mergeStation(idx);
        populateStationInfo(stationData);
        fillEditableFields(stationData);
        if (stationSelect) stationSelect.value = String(idx);
        renderStationPlot();
    }

    /**
     * Наполнить селектор станций; скрыть строку, если станция одна.
     */
    function populateStationSelect() {
        if (!stationSelect) return;
        stationSelect.innerHTML = stations.map((s, i) =>
            `<option value="${i}">${s.stationId}</option>`).join('');
        const row = stationSelect.closest('.phoenix-station-row');
        if (row) row.style.display = stations.length > 1 ? '' : 'none';
    }

    /**
     * Наполнить селектор кривых («все» + каждая по индексу).
     */
    function populateCurveSelect() {
        if (!curveSelect) return;
        curveSelect.innerHTML = buildCurveOptions(calCurvesList).map(o =>
            `<option value="${o.value}">${o.label}</option>`).join('');
        curveSelect.value = String(selectedCurveIdx);
        const row = curveSelect.closest('.phoenix-curve-row');
        if (row) row.style.display = calCurvesList.length > 0 ? '' : 'none';
    }

    /**
     * Трансформация вывода calResponseCurves() в формат drawCalCurves().
     * calResponseCurves → [{freqHz, amp, phase, re, im, groups}, ...]
     * drawCalCurves ожидает → {frequencies: [], amplitudes: [], phases: []}
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

    /**
     * Отрисовка калибровочных кривых на canvas.
     */
    function drawCalCurves(curvesList) {
        if (!calCanvas || curvesList.length === 0) {
            if (calLegend) calLegend.textContent = 'Калибровочные кривые не найдены в архиве';
            return;
        }

        const ctx = calCanvas.getContext('2d');
        const W = calCanvas.width;
        const H = calCanvas.height;
        const pad = { top: 30, right: 20, bottom: 40, left: 60 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;

        ctx.clearRect(0, 0, W, H);

        const colors = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];

        // Какие кривые показываем: -1 → все; иначе — только выбранная (остальные скрыты полностью)
        const visibleIdx = visibleCurveIndices(curvesList, selectedCurveIdx);

        // Масштаб осей считаем ТОЛЬКО по видимым кривым.
        // Во время перетаскивания диапазоны заморожены (_calFrozenRanges), иначе точка «прилипает» к краю.
        const dataRanges = _calFrozenRanges || computeCurveRanges(curvesList, visibleIdx);
        if (!dataRanges) {
            if (calLegend) calLegend.textContent = 'Нет данных для отрисовки';
            return;
        }

        const { logFMin, logFMax, ampMin, ampRange, phMin, phRange } = dataRanges;

        // Оси
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, pad.top);
        ctx.lineTo(pad.left, H - pad.bottom);
        ctx.lineTo(W - pad.right, H - pad.bottom);
        ctx.stroke();

        // Подписи осей
        ctx.fillStyle = '#64748b';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Частота (Гц)', W / 2, H - 5);

        ctx.save();
        ctx.translate(14, H / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('|H(f)| / φ(f)', 0, 0);
        ctx.restore();

        // Логарифмические метки частоты
        const logTicks = [];
        for (let p = Math.floor(logFMin); p <= Math.ceil(logFMax); p++) {
            logTicks.push(p);
        }
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px sans-serif';
        for (const p of logTicks) {
            const x = pad.left + ((p - logFMin) / (logFMax - logFMin)) * plotW;
            if (x >= pad.left && x <= W - pad.right) {
                ctx.fillText(`10^${p}`, x, H - pad.bottom + 14);
                ctx.strokeStyle = '#e2e8f0';
                ctx.beginPath();
                ctx.moveTo(x, pad.top);
                ctx.lineTo(x, H - pad.bottom);
                ctx.stroke();
            }
        }

        // Рисуем кривые: невидимые (не выбранные) НЕ рисуются вовсе
        // Цвет считается по абсолютному порядковому номеру кривой — стабилен при смене выбора
        const colorOfCurve = new Map();
        {
            let absIdx = 0;
            for (let ci = 0; ci < curvesList.length; ci++) {
                const entry = curvesList[ci];
                const list = entry && Array.isArray(entry.curves) ? entry.curves : [];
                for (let k = 0; k < list.length; k++) {
                    colorOfCurve.set(`${ci}:${k}`, colors[absIdx % colors.length]);
                    absIdx++;
                }
            }
        }

        const visibleSet = new Set(visibleIdx);
        const legendParts = [];

        for (let ci = 0; ci < curvesList.length; ci++) {
            const entry = curvesList[ci];
            if (!visibleSet.has(ci)) continue;   // скрытые кривые не рисуем и не подписываем
            const list = entry && Array.isArray(entry.curves) ? entry.curves : [];
            for (let k = 0; k < list.length; k++) {
                const curve = list[k];
                const color = colorOfCurve.get(`${ci}:${k}`);
                ctx.globalAlpha = 1;

                // Амплитуда (сплошная линия)
                if (curve.frequencies && curve.amplitudes && curve.frequencies.length > 0) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = selectedCurveIdx >= 0 ? 2.5 : 2;
                    ctx.beginPath();
                    for (let i = 0; i < curve.frequencies.length; i++) {
                        const f = curve.frequencies[i];
                        if (f <= 0) continue;
                        const x = pad.left + ((Math.log10(f) - logFMin) / (logFMax - logFMin)) * plotW;
                        const y = pad.top + plotH - ((curve.amplitudes[i] - ampMin) / ampRange) * plotH;
                        if (i === 0 || curve.frequencies[i - 1] <= 0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                }

                // Фаза (пунктирная линия)
                if (curve.frequencies && curve.phases && curve.frequencies.length > 0) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth = selectedCurveIdx >= 0 ? 1.5 : 1;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    for (let i = 0; i < curve.frequencies.length; i++) {
                        const f = curve.frequencies[i];
                        if (f <= 0) continue;
                        const x = pad.left + ((Math.log10(f) - logFMin) / (logFMax - logFMin)) * plotW;
                        const y = pad.top + plotH - ((curve.phases[i] - phMin) / phRange) * plotH;
                        if (i === 0 || curve.frequencies[i - 1] <= 0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                legendParts.push(`<span style="color:${color};">■</span> ${ci === selectedCurveIdx ? '✏️ ' : ''}${entry.name}`);
            }
        }
        ctx.globalAlpha = 1;

        if (calLegend) {
            const hint = selectedCurveIdx >= 0
                ? '(сплошная = амплитуда, пунктир = фаза; показана только выбранная кривая, остальные скрыты)'
                : '(сплошная = амплитуда, пунктир = фаза; выберите кривую в списке — перетаскивайте её точки)';
            calLegend.innerHTML = legendParts.join(' &nbsp;|&nbsp; ') +
                ` <span style="color:#94a3b8;">${hint}</span>`;
        }

        // Активируем редактор после отрисовки
        enableCalCurvesEditor(curvesList);
    }

    // -----------------------------------------------------------------------
    // Редактор калибровочных кривых (drag-and-drop точек)
    // -----------------------------------------------------------------------

    /**
     * Вычисляет параметры области графика (совпадает с drawCalCurves).
     */
    function computePlotArea() {
        const W = calCanvas.width;
        const H = calCanvas.height;
        const pad = { top: 30, right: 20, bottom: 40, left: 60 };
        return { pad, plotW: W - pad.left - pad.right, plotH: H - pad.top - pad.bottom, W, H };
    }

    /**
     * Преобразование индекса точки → экранные координаты.
     */
    function pointToScreen(index, frequencies, amplitudes, area, logFMin, logFMax, valMin, valRange) {
        const f = frequencies[index];
        const v = amplitudes[index];
        if (f <= 0) return null;
        const x = area.pad.left + ((Math.log10(f) - logFMin) / (logFMax - logFMin)) * area.plotW;
        const y = area.pad.top + area.plotH - ((v - valMin) / valRange) * area.plotH;
        return { x, y };
    }

    // findNearestPoint — на уровне модуля (тестируется напрямую), вызывается из замыкания.

    /**
     * Обратное преобразование Y-координаты экрана → значение.
     */
    function screenYtoValue(screenY, area, valMin, valRange) {
        const ratio = (area.pad.top + area.plotH - screenY) / area.plotH;
        return valMin + ratio * valRange;
    }

    /**
     * Сохранение backup для undo.
     */
    function cloneCurveData(curve) {
        return {
            frequencies: [...curve.frequencies],
            amplitudes: [...curve.amplitudes],
            phases: [...curve.phases],
        };
    }

    /**
     * Подсветка выбранной точки на canvas.
     */
    function highlightPoint(ctx, x, y, color) {
        ctx.save();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    /**
     * Включение режима редактирования на canvas (pointer events + заморозка масштаба).
     * Слушатели навешиваются ОДИН раз; перерисовки (рекурсивный вызов из drawCalCurves)
     * лишь обновляют _calEditorState.ranges, сохраняя активный drag/hover — иначе
     * перетаскивание «умирало» после первого mousemove.
     */
    function enableCalCurvesEditor(curvesList, visibleIdxIn = null, dataRangesIn = null) {
        if (!calCanvas || curvesList.length === 0) return;

        // Диапазоны должны совпадать с drawCalCurves: считаем по ВИДИМЫМ кривым,
        // а во время drag — по замороженному окну (один объект на отрисовку и hit-test).
        const visibleIdx = visibleIdxIn || visibleCurveIndices(curvesList, selectedCurveIdx);
        const dataRanges = dataRangesIn || _calFrozenRanges || computeCurveRanges(curvesList, visibleIdx);
        if (!dataRanges) return;

        const area = computePlotArea();
        const colors = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
        const ranges = {
            area,
            logFMin: dataRanges.logFMin, logFMax: dataRanges.logFMax,
            ampMin: dataRanges.ampMin, ampRange: dataRanges.ampRange,
            phMin: dataRanges.phMin, phRange: dataRanges.phRange,
        };

        const prev = _calEditorState;
        const sameList = !!(prev && prev.curvesList === curvesList);
        _calEditorState = {
            curvesList,
            ranges,
            colors,
            dragging: sameList ? prev.dragging : null, // {curveIdx, subIdx, pointIdx, channel, grabValue, grabY, scale, baseRange, originalValue}
            hovered: sameList ? prev.hovered : null,
        };
        _calCanvasRef = calCanvas; // чтобы модульный disableCalCurvesEditor снял слушатели

        if (!calCanvas._calEditorBound) {
            bindCalEditorListeners();
            calCanvas._calEditorBound = true;
        }
        if (!_calEditorState.dragging) {
            calCanvas.style.cursor = _calEditorState.hovered ? 'grab' : 'crosshair';
        }
    }

    /** Координаты события — во внутренние пиксели canvas (растянут CSS). */
    const editorPointerPos = (evt) => {
        const rect = calCanvas.getBoundingClientRect();
        return pointerToCanvas(rect, calCanvas.width, calCanvas.height, evt.clientX, evt.clientY);
    };

    /** Радиус попадания в экранных px canvas (на сжатом CSS canvas — крупнее). */
    const editorHitRadius = () => {
        const rect = calCanvas.getBoundingClientRect();
        const k = rect.width > 0 ? calCanvas.width / rect.width : 1;
        return 12 * Math.max(1, k);
    };

    /** Однократная привязка слушателей редактора (см. _calEditorBound). */
    function bindCalEditorListeners() {
        const onPointerDown = (evt) => {
            const st = _calEditorState;
            if (!st || (evt.button !== undefined && evt.button !== 0)) return;
            const pos = editorPointerPos(evt);
            const hit = findNearestPoint(pos.x, pos.y, st.curvesList, st.ranges, editorHitRadius(), selectedCurveIdx);
            if (!hit) return;
            const entry = st.curvesList[hit.curveIdx];
            const curve = entry && entry.curves[hit.subIdx || 0];
            if (!curve) return;

            const isAmp = hit.channel === 'amp';
            const grabValue = isAmp ? curve.amplitudes[hit.pointIdx] : curve.phases[hit.pointIdx];
            const plotH = st.ranges.area.plotH > 0 ? st.ranges.area.plotH : 1;
            const baseRange = isAmp ? st.ranges.ampRange : st.ranges.phRange;

            // Заморозка: фиксированный масштаб обеих осей на всю длительность drag.
            _calFrozenRanges = {
                logFMin: st.ranges.logFMin, logFMax: st.ranges.logFMax,
                ampMin: st.ranges.ampMin, ampMax: st.ranges.ampMin + st.ranges.ampRange, ampRange: st.ranges.ampRange,
                phMin: st.ranges.phMin, phMax: st.ranges.phMin + st.ranges.phRange, phRange: st.ranges.phRange,
            };

            st.dragging = {
                curveIdx: hit.curveIdx,
                subIdx: hit.subIdx || 0,
                pointIdx: hit.pointIdx,
                channel: hit.channel,
                grabValue,
                grabY: pos.y,
                scale: baseRange / plotH, // единиц значения на пиксель
                baseRange,
                originalValue: grabValue,
            };
            calCanvas.style.cursor = 'grabbing';
            try {
                if (evt.pointerId !== undefined && calCanvas.setPointerCapture) calCanvas.setPointerCapture(evt.pointerId);
            } catch (err) { /* не критично */ }
            evt.preventDefault();
        };

        const onPointerMove = (evt) => {
            const st = _calEditorState;
            if (!st) return;
            const pos = editorPointerPos(evt);

            if (st.dragging && _calFrozenRanges) {
                const drag = st.dragging;
                const entry = st.curvesList[drag.curveIdx];
                const curve = entry && entry.curves[drag.subIdx];
                if (!curve) { st.dragging = null; _calFrozenRanges = null; return; }

                // Точка следует за курсором 1:1; окно оси панорамируется, если точка вышла за график.
                const upd = computeDragUpdate(drag.scale, st.ranges.area, drag.grabValue, drag.grabY, pos.y);
                if (drag.channel === 'amp') {
                    curve.amplitudes[drag.pointIdx] = upd.value;
                    _calFrozenRanges.ampMin = upd.min;
                    _calFrozenRanges.ampMax = upd.min + drag.baseRange;
                } else {
                    curve.phases[drag.pointIdx] = upd.value;
                    _calFrozenRanges.phMin = upd.min;
                    _calFrozenRanges.phMax = upd.min + drag.baseRange;
                }

                drawCalCurves(st.curvesList); // перерисовка по замороженным диапазонам
                const after = _calEditorState; // мог обновиться внутри drawCalCurves
                if (after && after.dragging && _calFrozenRanges) {
                    const ctx = calCanvas.getContext('2d');
                    const vals = drag.channel === 'amp' ? curve.amplitudes : curve.phases;
                    const vMin = drag.channel === 'amp' ? _calFrozenRanges.ampMin : _calFrozenRanges.phMin;
                    const scr = pointToScreen(drag.pointIdx, curve.frequencies, vals, st.ranges.area,
                        _calFrozenRanges.logFMin, _calFrozenRanges.logFMax, vMin, drag.baseRange);
                    if (scr) highlightPoint(ctx, scr.x, scr.y, st.colors[drag.curveIdx % st.colors.length]);
                }
                evt.preventDefault();
                return;
            }

            // Hover: подсвечиваем ближайшую точку (перерисовка только при смене — экономим кадры).
            const hit = findNearestPoint(pos.x, pos.y, st.curvesList, st.ranges, editorHitRadius(), selectedCurveIdx);
            const prevH = st.hovered;
            const changed = (!!hit !== !!prevH) ||
                (hit && prevH && (hit.curveIdx !== prevH.curveIdx || (hit.subIdx || 0) !== (prevH.subIdx || 0) ||
                 hit.pointIdx !== prevH.pointIdx || hit.channel !== prevH.channel));
            st.hovered = hit ? { curveIdx: hit.curveIdx, subIdx: hit.subIdx, pointIdx: hit.pointIdx, channel: hit.channel } : null;
            if (changed) {
                drawCalCurves(st.curvesList);
                if (hit) {
                    const ctx = calCanvas.getContext('2d');
                    highlightPoint(ctx, hit.x, hit.y, st.colors[hit.curveIdx % st.colors.length]);
                }
            }
            calCanvas.style.cursor = hit ? 'grab' : 'crosshair';
        };

        const finishDrag = (evt, cancel) => {
            const st = _calEditorState;
            if (!st || !st.dragging) return;
            const drag = st.dragging;
            if (cancel) {
                const entry = st.curvesList[drag.curveIdx];
                const curve = entry && entry.curves[drag.subIdx];
                if (curve) {
                    if (drag.channel === 'amp') curve.amplitudes[drag.pointIdx] = drag.originalValue;
                    else curve.phases[drag.pointIdx] = drag.originalValue;
                }
            }
            st.dragging = null;
            _calFrozenRanges = null; // после отпускания оси снова подгоняются авто
            if (evt && evt.pointerId !== undefined && calCanvas.releasePointerCapture) {
                try { calCanvas.releasePointerCapture(evt.pointerId); } catch (err) { /* уже отпущен */ }
            }
            calCanvas.style.cursor = 'crosshair';
            drawCalCurves(st.curvesList);
        };

        const onPointerUp = (evt) => finishDrag(evt, false);
        const onPointerCancel = (evt) => finishDrag(evt, true);
        const onPointerLeave = () => {
            const st = _calEditorState;
            if (!st || st.dragging) return; // capture не даёт leave во время drag; на всякий случай не отменяем
            if (st.hovered) {
                st.hovered = null;
                drawCalCurves(st.curvesList);
            }
            calCanvas.style.cursor = 'crosshair';
        };
        const onKeyDown = (evt) => {
            if (evt.key === 'Escape' && _calEditorState && _calEditorState.dragging) finishDrag(null, true);
        };

        calCanvas._calEditorPointerDown = onPointerDown;
        calCanvas._calEditorPointerMove = onPointerMove;
        calCanvas._calEditorPointerUp = onPointerUp;
        calCanvas._calEditorPointerCancel = onPointerCancel;
        calCanvas._calEditorPointerLeave = onPointerLeave;
        calCanvas._calEditorKeyDown = onKeyDown;

        calCanvas.addEventListener('pointerdown', onPointerDown);
        calCanvas.addEventListener('pointermove', onPointerMove);
        calCanvas.addEventListener('pointerup', onPointerUp);
        calCanvas.addEventListener('pointercancel', onPointerCancel);
        calCanvas.addEventListener('pointerleave', onPointerLeave);
        document.addEventListener('keydown', onKeyDown);
    }

    /**
     * Заполнение редактируемых полей из распарсенных данных.
     */
    function fillEditableFields(info) {
        if (!info) return;
        if (latInput) latInput.value = info.latitude != null ? info.latitude.toFixed(4) : '';
        if (lonInput) lonInput.value = info.longitude != null ? info.longitude.toFixed(4) : '';
        if (elevInput) elevInput.value = info.elevation != null ? info.elevation : '';
        if (declInput && info.declination != null) declInput.value = info.declination;
    }

    /**
     * Отправка архива и метаданных на сервер.
     */
    async function submitPhoenixData() {
        const solutionId = getCurrentSolutionId();
        if (!solutionId) {
            showMessage('Не выбрана задача. Создайте новую задачу или выберите существующую.', 'error');
            return;
        }

        const token = localStorage.getItem('authToken');
        if (!token) {
            showMessage('Необходима авторизация', 'error');
            return;
        }

        // Собрать отредактированные метаданные
        const metadata = {
            latitude: parseFloat(latInput?.value) || stationData?.latitude,
            longitude: parseFloat(lonInput?.value) || stationData?.longitude,
            elevation: parseFloat(elevInput?.value) || stationData?.elevation,
            declination: parseFloat(declInput?.value) || stationData?.declination,
            stationId: stationData?.stationId,
            instrument: stationData?.instrument,
            firmware: stationData?.firmware,
            startTime: stationData?.startTime,
            exLength: stationData?.exLength,
            eyLength: stationData?.eyLength,
            hxSensor: stationData?.hxSensor,
            hySensor: stationData?.hySensor,
            hzSensor: stationData?.hzSensor,
            sampleRate: stationData?.sampleRate,
        };

        const formData = new FormData();
        formData.append('file', zipBlob, zipBlob.name || 'phoenix_data.zip');
        formData.append('metadata', JSON.stringify(metadata));

        progressEl?.classList.remove('hidden');
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ Загрузка...';

        try {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/api/users/self/solutions/${solutionId}/raw-upload`);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    if (progressBar) progressBar.style.width = `${pct}%`;
                    if (progressPercent) progressPercent.textContent = `${pct}%`;
                }
            };

            xhr.onload = () => {
                submitBtn.disabled = false;
                submitBtn.textContent = '🚀 Отправить на обработку';
                progressEl?.classList.add('hidden');

                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const resp = JSON.parse(xhr.responseText);
                        showMessage(` Архив загружен! Task ID: ${resp.task_id || '—'}. Данные поставлены в очередь на обработку.`, 'success');
                        showHint('phoenix-submitted', submitBtn, 'Архив отправлен! Отслеживайте статус задачи в списке решений.', { position: 'top', autoHideMs: 6000 });
                    } catch {
                        showMessage(' Архив загружен успешно!', 'success');
                    }
                } else {
                    let errMsg = `Ошибка сервера (${xhr.status})`;
                    try {
                        const err = JSON.parse(xhr.responseText);
                        errMsg = err.error || err.message || errMsg;
                    } catch {}
                    showMessage(errMsg, 'error');
                }
            };

            xhr.onerror = () => {
                submitBtn.disabled = false;
                submitBtn.textContent = '🚀 Отправить на обработку';
                progressEl?.classList.add('hidden');
                showMessage('Ошибка сети при загрузке', 'error');
            };

            xhr.send(formData);

        } catch (err) {
            submitBtn.disabled = false;
            submitBtn.textContent = '🚀 Отправить на обработку';
            progressEl?.classList.add('hidden');
            showMessage(`Ошибка: ${err.message}`, 'error');
        }
    }

    /**
     * Показать сообщение пользователю.
     */
    function showMessage(text, type) {
        if (!messageEl) return;
        messageEl.textContent = text;
        messageEl.className = 'upload-message';
        if (type === 'error') messageEl.classList.add('error');
        else if (type === 'success') messageEl.classList.add('success');
        else if (type === 'info') messageEl.classList.add('info');
        if (!text) messageEl.classList.add('hidden');
    }

    /**
     * Получить ID текущей выбранной задачи.
     * Основной источник — модуль upload_file_form (устанавливается при выборе решения
     * в loadAndDisplaySolutionDetails). Остальное — запасные варианты.
     */
    function getCurrentSolutionId() {
        try {
            const fromModule = getCurrentSolutionID();
            if (fromModule) return fromModule;
        } catch {}

        // Проверяем URL параметр
        const urlParams = new URLSearchParams(window.location.search);
        const fromUrl = urlParams.get('solutionId');
        if (fromUrl) return fromUrl;

        // Проверяем localStorage
        const fromStorage = localStorage.getItem('currentSolutionId');
        if (fromStorage) return fromStorage;

        // Проверяем глобальную переменную
        if (window.currentSolutionId) return window.currentSolutionId;

        return null;
    }

    // Регистрируем хук: resetPhoenixUI (при смене решения) чистит наше состояние,
    // чтобы старый zip/станции не остались в памяти.
    _closureResetHook = () => {
        zipBlob = null;
        stationData = null;
        calCurvesList = [];
        stationInfos = [];
        stations = [];
        activeStationIdx = 0;
        selectedCurveIdx = -1;
    };
}
