// 3D Result Viewer for MTZ Inversion Results
//
// Текущая реализация: объёмный рендеринг через THREE.InstancedMesh —
// по одной инстанс-ячейке на каждый воксель модели. На каждую ячейку
// хранится матрица (центр + размер) и цвет. Ячейки вне текущего
// диапазона сопротивления прячутся scale=0, что даёт чёткую картину
// аномалий. Поверх можно включить опциональный wireframe-оверлей.
//
// Three.js загружается лениво (dynamic import) — только при первом вызове
// init3DVisualization(). Это экономит ~600 KB в начальной загрузке страницы.

// Colormaps вынесены в отдельный модуль
import { colormaps, COLORMAP_NAMES } from './colormaps.js';
import { createCoordinateAxes, disposeCoordinateAxes } from './coordinateAxes.js';
import { loadThree } from './threeLoader.js';
import { buildWireframe } from './wireframeBuilder.js';
import { calculatePositions as sharedCalculatePositions } from './gridUtils.js';
import { createLegend, updateLegend, removeLegend, formatRho } from './colorScaleLegend.js';

export class ResultViewer {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.modelMesh = null;       // InstancedMesh — заливка объёма
        this.wireframeMesh = null;   // LineSegments — опциональный контур
        this.colorScale = null;      // { dataMin, dataMax, minRho, maxRho, gradient, paletteName }
        this.modelData = null;

        // Текущие настройки отображения
        this.settings = {
            minRho: null,            // нижний порог cutoff (Ω·м)
            maxRho: null,            // верхний порог cutoff (Ω·м)
            opacity: 1.0,            // прозрачность объёма
            colormap: 'jet',         // имя палитры
            wireframe: false,        // показывать ли контур
        };

        // Кэш позиций/размеров/значений — чтобы не пересчитывать при смене настроек
        this._cellCenters = null;   // Float32Array [x0,y0,z0, x1,y1,z1, ...]
        this._cellSizes = null;     // Float32Array [sx,sy,sz, ...]
        this._logRho = null;        // Float32Array — log10(rho) для каждой ячейки
        this._valid = null;         // Uint8Array — 1, если rho>0 и конечно
        this._tmpMatrix = null;     // THREE.Matrix4 (создаётся в _ensureThree)
        this._tmpColor = null;      // THREE.Color (создаётся в _ensureThree)

        // Границы сетки в координатах сцены (для DDA-пика) и глубины слоёв
        this._boundsX = null;       // [nY+1] scene X (восток, из yCells)
        this._boundsY = null;       // [nX+1] scene Y (север, из xCells)
        this._boundsZ = null;       // [nZ+1] scene Z (возрастающий: -zExtent..0)
        this._zCum = null;          // [nZ+1] накопительная глубина слоёв, м
        this._nXY = 0;              // nX * nY — число ячеек в одном Z-слое

        // === Режим редактирования сопротивлений ячеек ===
        this.editing = false;
        this.editMode = 'paint';    // 'paint' (кисть) | 'select' (выделение)
        this.brushRho = null;       // текущее значение ρ кисти, Ом·м
        this.columnMode = false;    // красить всю колонку по Z
        this.layerFilter = null;    // номер модельного слоя k или null (весь объём)
        this.selection = new Set(); // выбранные ячейки (плоские индексы)
        this._editOptions = {};     // колбэки: onCellsEdited, onHoverCell, onSelectionChanged
        this._hoverIdx = -1;
        this._hoverBox = null;
        this._selectionLines = null;
        this._layerGridMesh = null; // LineSegments — сетка границ ячеек активного слоя
        this._strokeCells = null;   // ячейки текущей кисти (коммитятся на pointerup)
        this._raycaster = null;
        this._editHandlers = null;

        // === Оптимизации для мобильных / больших моделей ===
        this._isMobile = ResultViewer._detectMobile();
        this._resizeTimer = null;
        this._lastRaycastTime = 0;
        this._raycastThrottleMs = this._isMobile ? 50 : 16; // 20 fps на мобильных, 60 на десктопе
        this._animationId = null;
    }

    /** Определение мобильного устройства (touch + маленький экран или UA). */
    static _detectMobile() {
        if (typeof navigator === 'undefined') return false;
        const ua = navigator.userAgent || '';
        const isTouchPrimary = typeof matchMedia !== 'undefined' &&
            matchMedia('(pointer: coarse)').matches;
        const isSmallScreen = typeof window !== 'undefined' &&
            Math.min(window.screen?.width || 9999, window.screen?.height || 9999) < 900;
        const isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
        return (isTouchPrimary && isSmallScreen) || isMobileUA;
    }

    /**
     * Ленивая загрузка Three.js (общий загрузчик ./threeLoader.js).
     * Вызывается один раз перед первым использованием.
     * Возвращает { THREE, OrbitControls }.
     */
    async _ensureThree() {
        if (this._THREE) return { THREE: this._THREE, OrbitControls: this._OrbitControls };
        const { THREE, OrbitControls } = await loadThree();
        this._THREE = THREE;
        this._OrbitControls = OrbitControls;
        // Создаём переиспользуемые объекты
        this._tmpMatrix = new THREE.Matrix4();
        this._tmpColor = new THREE.Color();
        return { THREE: this._THREE, OrbitControls: this._OrbitControls };
    }

    // === Парсинг (оставлен для совместимости с coarse-интеграцией) ===
    parseResultFile(fileContent) {
        const lines = fileContent.split('\n');
        let lineIndex = 0;

        while (lineIndex < lines.length && !lines[lineIndex].trim().match(/^\d+\s+\d+\s+\d+/)) {
            lineIndex++;
        }
        if (lineIndex >= lines.length) {
            throw new Error('Invalid file format: grid dimensions not found');
        }

        const dimParts = lines[lineIndex].trim().split(/\s+/);
        const nX = parseInt(dimParts[0]);
        const nY = parseInt(dimParts[1]);
        const nZ = parseInt(dimParts[2]);
        lineIndex++;

        const xCells = [];
        while (xCells.length < nX && lineIndex < lines.length) {
            const parts = lines[lineIndex].trim().split(/\s+/);
            xCells.push(...parts.map(v => parseFloat(v)));
            lineIndex++;
        }
        const yCells = [];
        while (yCells.length < nY && lineIndex < lines.length) {
            const parts = lines[lineIndex].trim().split(/\s+/);
            yCells.push(...parts.map(v => parseFloat(v)));
            lineIndex++;
        }
        const zCells = [];
        while (zCells.length < nZ && lineIndex < lines.length) {
            const parts = lines[lineIndex].trim().split(/\s+/);
            zCells.push(...parts.map(v => parseFloat(v)));
            lineIndex++;
        }

        const rhoValues = [];
        while (rhoValues.length < nX * nY * nZ && lineIndex < lines.length) {
            const line = lines[lineIndex].trim();
            if (!line || line.startsWith('#')) { lineIndex++; continue; }
            const parts = line.split(/\s+/);
            for (const part of parts) {
                if (part) {
                    const value = parseFloat(part);
                    if (!isNaN(value)) rhoValues.push(value);
                }
            }
            lineIndex++;
        }

        return { nX, nY, nZ, xCells, yCells, zCells, rhoValues };
    }

    // === Инициализация 3D-сцены ===
    async init3DVisualization(containerElement, modelData) {
        if (!modelData || !Array.isArray(modelData.rhoValues)) {
            throw new Error('modelData.rhoValues отсутствует или не массив — обновите страницу (Ctrl+Shift+R), возможно браузер использует кэш старых модулей');
        }

        // Ленивая загрузка Three.js (~600 KB загружается только здесь)
        const { THREE, OrbitControls } = await this._ensureThree();
        this.modelData = modelData;
        this._prepareCellCache(modelData);

        // Стартовые настройки: показываем весь диапазон данных
        if (this.settings.minRho == null) this.settings.minRho = this.colorScale.dataMin;
        if (this.settings.maxRho == null) this.settings.maxRho = this.colorScale.dataMax;

        const width = containerElement.clientWidth;
        const height = containerElement.clientHeight;

        this.scene = new this._THREE.Scene();
        this.scene.background = new this._THREE.Color(0x0a0a0f);

        const xExtent = modelData.xCells.reduce((a, b) => a + b, 0);
        const yExtent = modelData.yCells.reduce((a, b) => a + b, 0);
        const zExtent = modelData.zCells.reduce((a, b) => a + b, 0);
        const maxExtent = Math.max(xExtent, yExtent, zExtent);

        this.camera = new this._THREE.PerspectiveCamera(50, width / height, maxExtent * 0.01, maxExtent * 10);
        const cameraDistance = maxExtent * 1.8;
        this.camera.position.set(cameraDistance * 0.8, cameraDistance * 0.8, cameraDistance * 1.0);
        this.camera.lookAt(0, 0, -zExtent * 0.3);
        this.camera.up.set(0, 0, 1);

        // Оптимизации рендера для мобильных / больших моделей
        const totalCells = modelData.nX * modelData.nY * modelData.nZ;
        const useAntialias = !this._isMobile && totalCells < 50000;
        const maxPixelRatio = this._isMobile ? 1.0 : (totalCells > 50000 ? 1.5 : 2);

        this.renderer = new this._THREE.WebGLRenderer({
            antialias: useAntialias,
            alpha: true,
            powerPreference: this._isMobile ? 'low-power' : 'high-performance',
        });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
        containerElement.innerHTML = '';
        containerElement.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.maxDistance = maxExtent * 5;
        this.controls.minDistance = maxExtent * 0.1;
        // На мобильных отключаем инерцию вращения для экономии CPU
        if (this._isMobile) {
            this.controls.enableDamping = false;
        }

        // Тусклый ambient — заливка ячеек не использует свет, но он нужен
        // для возможного wireframe-оверлея (LineBasicMaterial не зависит
        // от света, но если в будущем добавим MeshNormalMaterial — будет готов).
        const ambientLight = new this._THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        this.addModelToScene(modelData);
        this._addCoordinateAxes(modelData);
        this.addColorScale(containerElement);

        // Throttled animation loop — на мобильных рендерим только при движении камеры
        let needsRender = true;
        this.controls.addEventListener('change', () => { needsRender = true; });

        const animate = () => {
            this._animationId = requestAnimationFrame(animate);
            this.controls.update();
            if (needsRender || !this._isMobile) {
                this.renderer.render(this.scene, this.camera);
                needsRender = false;
            }
        };
        animate();

        // Debounced resize — не пересоздаём renderer на каждый пиксель
        const handleResize = () => {
            if (this._resizeTimer) clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => {
                const newWidth = containerElement.clientWidth;
                const newHeight = containerElement.clientHeight;
                if (newWidth > 0 && newHeight > 0) {
                    this.camera.aspect = newWidth / newHeight;
                    this.camera.updateProjectionMatrix();
                    this.renderer.setSize(newWidth, newHeight);
                    needsRender = true;
                }
            }, 150);
        };
        window.addEventListener('resize', handleResize);
        this.resizeHandler = handleResize;
    }

    // Кэшируем центры, размеры и log10(rho) для всех ячеек — чтобы
    // смена диапазона/палитры/прозрачности не пересчитывала геометрию.
    _prepareCellCache(modelData) {
        const { nX, nY, nZ, xCells, yCells, zCells, rhoValues } = modelData;
        const total = nX * nY * nZ;
        const eastPositions = this.calculatePositions(yCells);   // scene X
        const northPositions = this.calculatePositions(xCells);  // scene Y
        const zPositions = this.calculatePositions(zCells);

        const eastOffset = -(eastPositions[eastPositions.length - 1] / 2);
        const northOffset = -(northPositions[northPositions.length - 1] / 2);

        this._cellCenters = new Float32Array(total * 3);
        this._cellSizes = new Float32Array(total * 3);
        this._logRho = new Float32Array(total);
        this._valid = new Uint8Array(total);

        let dataMin = Infinity;
        let dataMax = -Infinity;

        for (let k = 0; k < nZ; k++) {
            for (let j = 0; j < nY; j++) {
                for (let i = 0; i < nX; i++) {
                    const idx = k * nX * nY + j * nX + i;
                    const rho = rhoValues[idx];

                    // scene X = east (модель Y), scene Y = north (модель X)
                    const xCenter = (eastPositions[j] + eastPositions[j + 1]) / 2 + eastOffset;
                    const yCenter = (northPositions[i] + northPositions[i + 1]) / 2 + northOffset;
                    const zCenter = -(zPositions[k] + zPositions[k + 1]) / 2;
                    const sx = eastPositions[j + 1] - eastPositions[j];
                    const sy = northPositions[i + 1] - northPositions[i];
                    const sz = zPositions[k + 1] - zPositions[k];

                    const off3 = idx * 3;
                    this._cellCenters[off3] = xCenter;
                    this._cellCenters[off3 + 1] = yCenter;
                    this._cellCenters[off3 + 2] = zCenter;
                    this._cellSizes[off3] = sx;
                    this._cellSizes[off3 + 1] = sy;
                    this._cellSizes[off3 + 2] = sz;

                    if (isFinite(rho) && rho > 0) {
                        this._logRho[idx] = Math.log10(rho);
                        this._valid[idx] = 1;
                        if (rho < dataMin) dataMin = rho;
                        if (rho > dataMax) dataMax = rho;
                    } else {
                        this._logRho[idx] = NaN;
                        this._valid[idx] = 0;
                    }
                }
            }
        }

        if (!isFinite(dataMin)) dataMin = 1;
        if (!isFinite(dataMax)) dataMax = 10;

        this.colorScale = {
            dataMin,
            dataMax,
            minRho: this.settings.minRho ?? dataMin,
            maxRho: this.settings.maxRho ?? dataMax,
            paletteName: this.settings.colormap,
        };

        // Границы ячеек в координатах сцены — для быстрого аналитического
        // пика лучом (DDA-обход регулярной сетки вместо raycast по InstancedMesh).
        //   scene X (восток)  -> границы из yCells, индекс ячейки = model j (Y)
        //   scene Y (север)   -> границы из xCells, индекс ячейки = model i (X)
        //   scene Z (вверх)   -> возрастающий массив от -zExtent до 0,
        //                        индекс scene-ячейки kz = nZ-1-k (k — слой модели)
        this._boundsX = eastPositions.map(v => v + eastOffset);
        this._boundsY = northPositions.map(v => v + northOffset);
        const bz = new Array(zPositions.length);
        for (let m = 0; m < zPositions.length; m++) {
            bz[m] = -zPositions[zPositions.length - 1 - m];
        }
        this._boundsZ = bz;
        this._zCum = zPositions.slice(); // накопительные глубины (м, от поверхности)
        this._nXY = nX * nY;             // ячеек в одном Z-слое (для layer-фильтра)
    }

    // === Построение InstancedMesh ===
    addModelToScene(modelData) {
        const { nX, nY, nZ } = modelData;
        const total = nX * nY * nZ;

        const boxGeom = new this._THREE.BoxGeometry(1, 1, 1);
        const material = new this._THREE.MeshBasicMaterial({
            // ВАЖНО: для InstancedMesh.instanceColor параметр vertexColors
            // НЕ нужен (и вреден) — Three.js включает USE_INSTANCING_COLOR
            // автоматически по наличию атрибута instanceColor. Если же
            // включить vertexColors, шейдер сделает vColor *= color, где
            // color — атрибут геометрии; у BoxGeometry его нет, и WebGL
            // читает vec3(0), из-за чего вся заливка получается чёрной.
            color: 0xffffff,
            transparent: true,
            opacity: this.settings.opacity,
            side: this._THREE.DoubleSide,
            depthWrite: this.settings.opacity >= 0.999,
        });

        this.modelMesh = new this._THREE.InstancedMesh(boxGeom, material, total);
        this.modelMesh.instanceMatrix.setUsage(this._THREE.DynamicDrawUsage);
        // instanceColor заведётся ленивым setColorAt в _rebuildAllInstances
        this._rebuildAllInstances();

        this.scene.add(this.modelMesh);

        // Опциональный wireframe-оверлей — та же сетка, но линиями.
        // Скрыт по умолчанию, переключается из панели.
        this.wireframeMesh = this._buildWireframe(modelData);
        this.wireframeMesh.visible = this.settings.wireframe;
        this.scene.add(this.wireframeMesh);
    }

    // Полный пересчёт матриц и цветов всех ячеек (дорогая операция).
    _rebuildAllInstances() {
        const total = this._cellCenters.length / 3;
        for (let i = 0; i < total; i++) {
            this._updateInstance(i);
        }
        this.modelMesh.instanceMatrix.needsUpdate = true;
        if (this.modelMesh.instanceColor) this.modelMesh.instanceColor.needsUpdate = true;
    }

    // Пересчёт матрицы и цвета ОДНОЙ ячейки (для точечных правок при редактировании).
    _updateInstance(idx) {
        const { minRho, maxRho, colormap } = this.settings;
        const logMin = Math.log10(minRho);
        const logMax = Math.log10(maxRho);
        const logSpan = logMax - logMin;
        const palette = colormaps[colormap] || colormaps.jet;

        const off3 = idx * 3;
        const valid = this._valid[idx];
        const logR = this._logRho[idx];

        // Layer-фильтр: если активен конкретный Z-слой, остальные скрыты
        const layerHidden = this.layerFilter != null &&
            this._nXY > 0 &&
            ((idx / this._nXY) | 0) !== this.layerFilter;

        if (!valid || layerHidden || logR < logMin || logR > logMax) {
            // Скрытая ячейка — scale 0
            this._tmpMatrix.makeScale(0, 0, 0);
        } else {
            const t = logSpan > 0 ? (logR - logMin) / logSpan : 0.5;
            const [r, g, b] = palette(Math.max(0, Math.min(1, t)));
            this._tmpColor.setRGB(r, g, b);
            this.modelMesh.setColorAt(idx, this._tmpColor);

            this._tmpMatrix.makeScale(
                this._cellSizes[off3],
                this._cellSizes[off3 + 1],
                this._cellSizes[off3 + 2],
            );
            this._tmpMatrix.setPosition(
                this._cellCenters[off3],
                this._cellCenters[off3 + 1],
                this._cellCenters[off3 + 2],
            );
        }
        this.modelMesh.setMatrixAt(idx, this._tmpMatrix);
        this.modelMesh.instanceMatrix.needsUpdate = true;
        if (this.modelMesh.instanceColor) this.modelMesh.instanceColor.needsUpdate = true;
    }

    // === Публичные методы панели настроек ===

    // Меняет cutoff-диапазон и пересчитывает матрицы (скрытые ячейки = scale 0).
    setRange(minRho, maxRho) {
        if (!this.colorScale) return; // сцена ещё не инициализирована
        if (!(minRho > 0) || !(maxRho > 0) || minRho >= maxRho) return;
        this.settings.minRho = minRho;
        this.settings.maxRho = maxRho;
        this.colorScale.minRho = minRho;
        this.colorScale.maxRho = maxRho;
        this._rebuildAllInstances();
        this._updateColorScaleLegend();
    }

    // Прозрачность заливки. depthWrite выключаем при прозрачности < 1,
    // чтобы корректно отрисовывать перекрывающиеся ячейки.
    setOpacity(alpha) {
        this.settings.opacity = Math.max(0, Math.min(1, alpha));
        if (!this.modelMesh) return;
        this.modelMesh.material.opacity = this.settings.opacity;
        this.modelMesh.material.depthWrite = this.settings.opacity >= 0.999;
        this.modelMesh.material.needsUpdate = true;
    }

    // Меняет палитру и пересчитывает только цвета (без перестроения матриц).
    setColormap(name) {
        if (!colormaps[name]) return;
        this.settings.colormap = name;
        if (!this.colorScale) return; // сцена ещё не инициализирована
        this.colorScale.paletteName = name;
        this._rebuildAllInstances();
        this._updateColorScaleLegend();
    }

    // Показывает/прячет wireframe-контур.
    setWireframe(visible) {
        this.settings.wireframe = !!visible;
        if (this.wireframeMesh) this.wireframeMesh.visible = this.settings.wireframe;
    }

    // Сбрасывает все настройки к полному диапазону данных.
    resetSettings() {
        this.setColormap('jet');
        this.setRange(this.colorScale.dataMin, this.colorScale.dataMax);
        this.setOpacity(1.0);
        this.setWireframe(false);
    }

    // === Выбор Z-слоя: изоляция и редактирование одного слоя ===

    // Устанавливает фильтр слоя: k — номер модельного слоя (0 = верхний),
    // null — показывать весь объём. Скрытые слои не видны и некликабельны.
    setLayerFilter(k) {
        const nZ = this.modelData ? this.modelData.nZ : 0;
        this.layerFilter = (k == null || k < 0 || k >= nZ) ? null : (k | 0);
        this._rebuildAllInstances();
        // Сетка границ ячеек активного слоя — помогает точно попадать в ячейки
        this._disposeLayerGrid();
        if (this.layerFilter != null) {
            this._layerGridMesh = this._buildLayerGrid(this.layerFilter);
            this.scene.add(this._layerGridMesh);
        }
    }

    // Диапазон глубин слоя k (метры от поверхности, положительное вниз).
    getLayerDepthRange(k) {
        if (!this._zCum || k < 0 || k + 1 >= this._zCum.length) return null;
        return { top: this._zCum[k], bottom: this._zCum[k + 1] };
    }

    // Линии границ ВСЕХ ячеек слоя k на его верхней грани.
    // (nX+1)+(nY+1) отрезков — дёшево даже для большой сетки.
    _buildLayerGrid(k) {
        const { nX, nY } = this.modelData;
        const zTop = -this._zCum[k];
        const positions = [];
        // Линии вдоль scene X на каждой границе scene Y (границы из xCells)
        const x0 = this._boundsX[0];
        const x1 = this._boundsX[nY];
        for (let i = 0; i <= nX; i++) {
            const y = this._boundsY[i];
            positions.push(x0, y, zTop, x1, y, zTop);
        }
        // Линии вдоль scene Y на каждой границе scene X (границы из yCells)
        const y0 = this._boundsY[0];
        const y1 = this._boundsY[nX];
        for (let j = 0; j <= nY; j++) {
            const x = this._boundsX[j];
            positions.push(x, y0, zTop, x, y1, zTop);
        }
        const geom = new this._THREE.BufferGeometry();
        geom.setAttribute('position', new this._THREE.Float32BufferAttribute(positions, 3));
        const mat = new this._THREE.LineBasicMaterial({
            color: 0x8be9fd, transparent: true, opacity: 0.4, depthTest: false,
        });
        const lines = new this._THREE.LineSegments(geom, mat);
        lines.renderOrder = 996; // под выделением (998) и hover (999)
        return lines;
    }

    _disposeLayerGrid() {
        if (this._layerGridMesh) {
            this.scene.remove(this._layerGridMesh);
            this._layerGridMesh.geometry.dispose();
            this._layerGridMesh.material.dispose();
            this._layerGridMesh = null;
        }
    }

    // Возвращает список доступных палитр (для заполнения <select> в UI).
    static getColormapNames() {
        return [...COLORMAP_NAMES];
    }

    // ================================================================
    // === РЕДАКТИРОВАНИЕ ЯЧЕЕК (априорная информация) ================
    // ================================================================

    // Включает режим редактирования: пик ячеек лучом, кисть/выделение.
    // options: {
    //   defaultRho: число — фоновое сопротивление (для "сбросить всё"),
    //   brushRho: начальное значение кисти,
    //   onCellsEdited(indices, rho) — после применения ρ к ячейкам,
    //   onHoverCell(info|null) — наведение на ячейку,
    //   onSelectionChanged(count) — изменение выделения
    // }
    enableEditing(options = {}) {
        if (!this.modelMesh || !this.modelData) {
            throw new Error('enableEditing: сцена не инициализирована');
        }
        this.editing = true;
        this._editOptions = options;
        this.brushRho = (options.brushRho > 0) ? options.brushRho : (options.defaultRho > 0 ? options.defaultRho : 100);
        this.selection = new Set();
        this._strokeCells = null;
        this._hoverIdx = -1;
        this._raycaster = new this._THREE.Raycaster();
        this._ndcVec = new this._THREE.Vector2();

        // Подсветка ячейки под курсором — белый контур
        const hoverGeo = new this._THREE.EdgesGeometry(new this._THREE.BoxGeometry(1, 1, 1));
        const hoverMat = new this._THREE.LineBasicMaterial({
            color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9,
        });
        this._hoverBox = new this._THREE.LineSegments(hoverGeo, hoverMat);
        this._hoverBox.visible = false;
        this._hoverBox.renderOrder = 999;
        this.scene.add(this._hoverBox);

        // Подсветка выбранных ячеек — ядовито-пурпурные контуры (единая геометрия).
        // Magenta (0xff00ff) отсутствует в палитре jet (blue→cyan→green→yellow→red),
        // поэтому выделение контрастно на фоне ячеек любого сопротивления.
        this._selectionLines = new this._THREE.LineSegments(
            new this._THREE.BufferGeometry(),
            new this._THREE.LineBasicMaterial({
                color: 0xff00ff, depthTest: false, transparent: true, opacity: 1.0,
            })
        );
        this._selectionLines.renderOrder = 998;
        this._selectionLines.frustumCulled = false;
        this.scene.add(this._selectionLines);

        // Обработчики указателя.
        // ВАЖНО: pointerdown вешаем на РОДИТЕЛЬСКИЙ контейнер в capture-фазе —
        // он срабатывает раньше обработчика OrbitControls (тот висит на canvas),
        // и stopPropagation() не даёт камере вращаться при клике по ячейке.
        const el = this.renderer.domElement;
        const downEl = el.parentElement || el;
        const handlers = {
            move: (e) => this._onEditPointerMove(e),
            down: (e) => this._onEditPointerDown(e),
            up: (e) => this._onEditPointerUp(e),
            leave: () => this._setHoverCell(-1),
        };
        el.addEventListener('pointermove', handlers.move);
        el.addEventListener('pointerleave', handlers.leave);
        downEl.addEventListener('pointerdown', handlers.down, true);
        window.addEventListener('pointerup', handlers.up);
        this._editHandlers = { el, downEl, ...handlers };

        el.style.cursor = 'crosshair';
        console.log('[RESULT VIEWER] Editing enabled');
    }

    // Полностью выключает режим редактирования
    disableEditing() {
        if (!this.editing) return;
        this.editing = false;
        if (this._editHandlers) {
            const { el, downEl, move, down, up, leave } = this._editHandlers;
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerleave', leave);
            downEl.removeEventListener('pointerdown', down, true);
            window.removeEventListener('pointerup', up);
            el.style.cursor = '';
            this._editHandlers = null;
        }
        if (this._hoverBox) {
            this.scene.remove(this._hoverBox);
            this._hoverBox.geometry.dispose();
            this._hoverBox.material.dispose();
            this._hoverBox = null;
        }
        if (this._selectionLines) {
            this.scene.remove(this._selectionLines);
            this._selectionLines.geometry.dispose();
            this._selectionLines.material.dispose();
            this._selectionLines = null;
        }
        this.selection.clear();
        this._strokeCells = null;
    }

    setEditMode(mode) {
        this.editMode = (mode === 'select') ? 'select' : 'paint';
    }

    setBrushRho(rho) {
        if (isFinite(rho) && rho > 0) this.brushRho = rho;
    }

    setColumnMode(on) {
        this.columnMode = !!on;
    }

    // --- Пик ячейки лучом: аналитический DDA-обход регулярной сетки ---
    // (Raycaster по InstancedMesh из ~100k экземпляров был бы слишком медленным
    // для hover, поэтому луч шагает прямо по ячейкам сетки.)
    _ndcFromEvent(e) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this._ndcVec.set(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        return this._ndcVec;
    }

    _pickCellFromEvent(e) {
        if (!this._boundsX || !this.modelMesh) return -1;
        this._raycaster.setFromCamera(this._ndcFromEvent(e), this.camera);
        return this._pickCellByRay(this._raycaster.ray);
    }

    _pickCellByRay(ray) {
        const BX = this._boundsX, BY = this._boundsY, BZ = this._boundsZ;
        const { nX, nY, nZ } = this.modelData;
        const o = ray.origin, d = ray.direction;

        // Пересечение луча с общим боксом сетки (slab-метод)
        let tEnter = -Infinity, tExit = Infinity;
        const slab = (op, dp, lo, hi) => {
            if (Math.abs(dp) < 1e-14) {
                return (op >= lo && op <= hi) ? [-Infinity, Infinity] : null;
            }
            let t1 = (lo - op) / dp, t2 = (hi - op) / dp;
            if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
            return [t1, t2];
        };
        for (const [op, dp, lo, hi] of [
            [o.x, d.x, BX[0], BX[BX.length - 1]],
            [o.y, d.y, BY[0], BY[BY.length - 1]],
            [o.z, d.z, BZ[0], BZ[BZ.length - 1]],
        ]) {
            const s = slab(op, dp, lo, hi);
            if (!s) return -1;
            if (s[0] > tEnter) tEnter = s[0];
            if (s[1] < tExit) tExit = s[1];
        }
        if (tEnter > tExit) return -1;
        if (tEnter < 0) tEnter = 0; // камера внутри сетки

        // Точка входа и стартовая ячейка (бинарный поиск по границам)
        const px = o.x + d.x * tEnter;
        const py = o.y + d.y * tEnter;
        const pz = o.z + d.z * tEnter;
        const findCell = (B, p, n) => {
            let lo = 0, hi = n - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (B[mid] <= p) lo = mid; else hi = mid - 1;
            }
            return lo;
        };
        let cx = findCell(BX, px, nY);   // scene X -> model j
        let cy = findCell(BY, py, nX);   // scene Y -> model i
        let cz = findCell(BZ, pz, nZ);   // scene Z -> model k = nZ-1-cz

        const stepX = d.x > 0 ? 1 : (d.x < 0 ? -1 : 0);
        const stepY = d.y > 0 ? 1 : (d.y < 0 ? -1 : 0);
        const stepZ = d.z > 0 ? 1 : (d.z < 0 ? -1 : 0);

        // t выхода за следующую границу по каждой оси (абсолютный параметр луча)
        const nextT = (B, c, step, op, dp) => {
            if (step === 0) return Infinity;
            const b = step > 0 ? B[c + 1] : B[c];
            return (b - op) / dp;
        };
        let tX = nextT(BX, cx, stepX, o.x, d.x);
        let tY = nextT(BY, cy, stepY, o.y, d.y);
        let tZ = nextT(BZ, cz, stepZ, o.z, d.z);

        const maxSteps = nX + nY + nZ + 8;
        for (let s = 0; s < maxSteps; s++) {
            const k = nZ - 1 - cz;
            const idx = k * nX * nY + cx * nX + cy; // j=cx (Y), i=cy (X)
            if (this._isCellPickable(idx)) return idx;

            // Шаг в соседнюю ячейку через ближайшую границу
            if (tX <= tY && tX <= tZ) {
                if (tX > tExit) break;
                cx += stepX;
                if (cx < 0 || cx >= nY) break;
                tX = nextT(BX, cx, stepX, o.x, d.x);
            } else if (tY <= tZ) {
                if (tY > tExit) break;
                cy += stepY;
                if (cy < 0 || cy >= nX) break;
                tY = nextT(BY, cy, stepY, o.y, d.y);
            } else {
                if (tZ > tExit) break;
                cz += stepZ;
                if (cz < 0 || cz >= nZ) break;
                tZ = nextT(BZ, cz, stepZ, o.z, d.z);
            }
        }
        return -1;
    }

    // Видима ли ячейка сейчас (не скрыта cutoff-диапазоном) — только такие можно выбирать
    _isCellPickable(idx) {
        if (!this._valid[idx]) return false;
        // При активном layer-фильтре ячейки других слоёв некликабельны —
        // луч проходит сквозь них к видимому слою
        if (this.layerFilter != null && this._nXY > 0 &&
            ((idx / this._nXY) | 0) !== this.layerFilter) {
            return false;
        }
        const logR = this._logRho[idx];
        const logMin = Math.log10(this.settings.minRho);
        const logMax = Math.log10(this.settings.maxRho);
        return logR >= logMin && logR <= logMax;
    }

    // Все ячейки вертикальной колонки (все Z) для данного плоского индекса
    _columnIndices(idx) {
        const { nX, nY, nZ } = this.modelData;
        const rem = idx % (nX * nY);
        const out = [];
        for (let k = 0; k < nZ; k++) out.push(k * nX * nY + rem);
        return out;
    }

    // Информация о ячейке для UI: индексы, глубина, текущее ρ
    getCellInfo(idx) {
        if (idx < 0 || !this.modelData) return null;
        const { nX, nY, nZ, rhoValues } = this.modelData;
        const k = Math.floor(idx / (nX * nY));
        const rem = idx % (nX * nY);
        const j = Math.floor(rem / nX);
        const i = rem % nX;
        const zCum = this._zCum;
        return {
            idx,
            ix: i, iy: j, iz: k,
            depthTop: zCum ? zCum[k] : 0,
            depthBottom: zCum ? zCum[k + 1] : 0,
            rho: rhoValues[idx],
            nX, nY, nZ,
        };
    }

    // --- Подсветка ---
    _setHoverCell(idx) {
        if (idx === this._hoverIdx) return;
        this._hoverIdx = idx;
        if (idx < 0 || !this._hoverBox) {
            if (this._hoverBox) this._hoverBox.visible = false;
            if (this._editOptions.onHoverCell) this._editOptions.onHoverCell(null);
            return;
        }
        const off3 = idx * 3;
        this._hoverBox.scale.set(
            this._cellSizes[off3] * 1.005,
            this._cellSizes[off3 + 1] * 1.005,
            this._cellSizes[off3 + 2] * 1.005
        );
        this._hoverBox.position.set(
            this._cellCenters[off3],
            this._cellCenters[off3 + 1],
            this._cellCenters[off3 + 2]
        );
        this._hoverBox.visible = true;
        if (this._editOptions.onHoverCell) {
            this._editOptions.onHoverCell(this.getCellInfo(idx));
        }
    }

    _updateSelectionHighlight() {
        if (!this._selectionLines) return;
        const verts = [];
        for (const idx of this.selection) {
            const off3 = idx * 3;
            const cx = this._cellCenters[off3], cy = this._cellCenters[off3 + 1], cz = this._cellCenters[off3 + 2];
            // Контур чуть крупнее ячейки (1.03) — заметен на фоне соседей
            const hx = this._cellSizes[off3] / 2 * 1.03;
            const hy = this._cellSizes[off3 + 1] / 2 * 1.03;
            const hz = this._cellSizes[off3 + 2] / 2 * 1.03;
            const x1 = cx - hx, x2 = cx + hx;
            const y1 = cy - hy, y2 = cy + hy;
            const z1 = cz - hz, z2 = cz + hz;
            // 12 рёбер бокса
            const p = [
                [[x1,y1,z1],[x2,y1,z1]], [[x2,y1,z1],[x2,y2,z1]],
                [[x2,y2,z1],[x1,y2,z1]], [[x1,y2,z1],[x1,y1,z1]],
                [[x1,y1,z2],[x2,y1,z2]], [[x2,y1,z2],[x2,y2,z2]],
                [[x2,y2,z2],[x1,y2,z2]], [[x1,y2,z2],[x1,y1,z2]],
                [[x1,y1,z1],[x1,y1,z2]], [[x2,y1,z1],[x2,y1,z2]],
                [[x2,y2,z1],[x2,y2,z2]], [[x1,y2,z1],[x1,y2,z2]],
            ];
            for (const [a, b] of p) verts.push(...a, ...b);
        }
        this._selectionLines.geometry.dispose();
        const geo = new this._THREE.BufferGeometry();
        geo.setAttribute('position', new this._THREE.Float32BufferAttribute(verts, 3));
        this._selectionLines.geometry = geo;
        if (this._editOptions.onSelectionChanged) {
            this._editOptions.onSelectionChanged(this.selection.size);
        }
    }

    // --- Обработчики указателя ---
    _onEditPointerMove(e) {
        // Throttle: на мобильных ограничиваем частоту raycast до _raycastThrottleMs
        const now = performance.now();
        if (now - this._lastRaycastTime < this._raycastThrottleMs) return;
        this._lastRaycastTime = now;

        // hover — с троттлингом на requestAnimationFrame
        this._lastMoveEvent = e;
        if (this._hoverRafPending) return;
        this._hoverRafPending = true;
        requestAnimationFrame(() => {
            this._hoverRafPending = false;
            if (!this.editing || !this._lastMoveEvent) return;
            const idx = this._pickCellFromEvent(this._lastMoveEvent);
            this._setHoverCell(idx);
            // Продолжение кистевого мазка
            if (this._strokeCells && idx >= 0) {
                this._paintCells(this.columnMode ? this._columnIndices(idx) : [idx]);
            }
        });
    }

    _onEditPointerDown(e) {
        if (e.button !== 0 || !this.editing) return;
        const idx = this._pickCellFromEvent(e);
        if (idx < 0) {
            // Мимо сетки: в режиме выделения без модификаторов — снять выделение
            if (this.editMode === 'select' && !e.ctrlKey && !e.metaKey && !e.shiftKey
                && this.selection.size > 0) {
                this.clearSelection();
            }
            return;
        }

        if (this.editMode === 'paint') {
            if (!(this.brushRho > 0)) return;
            e.preventDefault();
            e.stopPropagation();
            // Отключаем орбит-контролы на время мазка, чтобы камера не вращалась
            if (this.controls) this.controls.enabled = false;
            this._strokeCells = new Set();
            this._strokeRho = this.brushRho;
            this._paintCells(this.columnMode ? this._columnIndices(idx) : [idx]);
        } else {
            // Режим выделения
            e.preventDefault();
            e.stopPropagation();
            const targets = this.columnMode ? this._columnIndices(idx) : [idx];
            const additive = e.ctrlKey || e.metaKey || e.shiftKey;
            const allSelected = targets.every(t => this.selection.has(t));
            if (additive) {
                if (allSelected) targets.forEach(t => this.selection.delete(t));
                else targets.forEach(t => this.selection.add(t));
            } else if (allSelected && this.selection.size === targets.length) {
                this.selection.clear();
            } else {
                this.selection.clear();
                targets.forEach(t => this.selection.add(t));
            }
            this._updateSelectionHighlight();
        }
    }

    _onEditPointerUp() {
        if (this._strokeCells) {
            const painted = this._strokeCells;
            this._strokeCells = null;
            if (this.controls) this.controls.enabled = true;
            if (painted.size > 0) {
                this._rebuildAllInstances();       // согласованные цвета в новом диапазоне
                this._updateColorScaleLegend();
                if (this._editOptions.onCellsEdited) {
                    this._editOptions.onCellsEdited([...painted], this._strokeRho);
                }
            }
        }
    }

    // Применяет brushRho к ячейкам (визуально + в modelData) во время мазка
    _paintCells(indices) {
        const rho = this._strokeCells ? this._strokeRho : this.brushRho;
        if (!(rho > 0)) return;
        this._ensureRangeIncludes(rho);
        const fresh = [];
        for (const idx of indices) {
            if (this._strokeCells && this._strokeCells.has(idx)) continue;
            fresh.push(idx);
            if (this._strokeCells) this._strokeCells.add(idx);
        }
        if (fresh.length === 0) return;
        this._setCellsRhoVisual(fresh, rho);
    }

    // Запись ρ в modelData + точечное обновление инстансов
    _setCellsRhoVisual(indices, rho) {
        const { rhoValues } = this.modelData;
        const logR = Math.log10(rho);
        for (const idx of indices) {
            rhoValues[idx] = rho;
            this._logRho[idx] = logR;
            this._valid[idx] = 1;
            this._updateInstance(idx);
        }
    }

    // Расширяет видимый диапазон и границы данных, чтобы новая ρ не "пропала"
    _ensureRangeIncludes(rho) {
        let rangeChanged = false;
        if (rho < this.colorScale.dataMin) this.colorScale.dataMin = rho;
        if (rho > this.colorScale.dataMax) this.colorScale.dataMax = rho;
        if (rho < this.settings.minRho) {
            this.settings.minRho = rho;
            this.colorScale.minRho = rho;
            rangeChanged = true;
        }
        if (rho > this.settings.maxRho) {
            this.settings.maxRho = rho;
            this.colorScale.maxRho = rho;
            rangeChanged = true;
        }
        if (rangeChanged) this._rebuildAllInstances();
    }

    // --- Публичное API панели редактирования ---

    // Применить ρ ко всем выбранным ячейкам. Возвращает число ячеек.
    applyRhoToSelection(rho) {
        if (!this.editing || this.selection.size === 0) return 0;
        if (!(rho > 0) || !isFinite(rho)) return 0;
        const indices = [...this.selection];
        this._ensureRangeIncludes(rho);
        this._setCellsRhoVisual(indices, rho);
        this._rebuildAllInstances();
        this._updateColorScaleLegend();
        if (this._editOptions.onCellsEdited) this._editOptions.onCellsEdited(indices, rho);
        return indices.length;
    }

    clearSelection() {
        this.selection.clear();
        this._updateSelectionHighlight();
    }

    // Сбросить ВСЕ изменённые ячейки к фоновому ρ. Возвращает число сброшенных.
    resetAllCells() {
        const def = this._editOptions.defaultRho;
        if (!(def > 0)) return 0;
        const { rhoValues } = this.modelData;
        const changed = [];
        for (let i = 0; i < rhoValues.length; i++) {
            if (rhoValues[i] !== def) changed.push(i);
        }
        if (changed.length === 0) return 0;
        this._setCellsRhoVisual(changed, def);
        this._rebuildAllInstances();
        this._updateColorScaleLegend();
        if (this._editOptions.onCellsEdited) this._editOptions.onCellsEdited(changed, def);
        return changed.length;
    }

    // ================================================================

    // === Wireframe-оверлей ===
    // Реализация вынесена в ./wireframeBuilder.js
    _buildWireframe(modelData) {
        return buildWireframe(this._THREE, modelData);
    }

    // === Координатные оси с отметками ===
    // Реализация вынесена в ./coordinateAxes.js (общая с CoarseGenerator).
    _addCoordinateAxes(modelData) {
        if (!this._THREE || !this.scene) return;

        const xExtent = modelData.yCells.reduce((a, b) => a + b, 0); // scene X = East
        const yExtent = modelData.xCells.reduce((a, b) => a + b, 0); // scene Y = North
        const zExtent = modelData.zCells.reduce((a, b) => a + b, 0);

        this._axesGroup = createCoordinateAxes(this._THREE, { xExtent, yExtent, zExtent });
        this.scene.add(this._axesGroup);
    }

    // === Цветовая шкала-легенда (реализация в ./colorScaleLegend.js) ===
    addColorScale(containerElement) {
        if (!this.colorScale) return;
        this._legendEl = createLegend(containerElement, this.colorScale);
        this._updateColorScaleLegend();
    }

    _updateColorScaleLegend() {
        updateLegend(this._legendEl, this.colorScale, this._logRho, this._valid);
    }

    // === Утилиты ===
    calculatePositions(cells) {
        return sharedCalculatePositions(cells);
    }

    dispose() {
        // Выключаем редактирование (снимает обработчики и удаляет подсветку)
        this.disableEditing();
        // Останавливаем animation loop
        if (this._animationId != null) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }
        // Очищаем debounced resize timer
        if (this._resizeTimer) {
            clearTimeout(this._resizeTimer);
            this._resizeTimer = null;
        }
        if (this.renderer) this.renderer.dispose();
        if (this.controls) this.controls.dispose();
        if (this.modelMesh) {
            this.modelMesh.geometry.dispose();
            this.modelMesh.material.dispose();
        }
        if (this.wireframeMesh) {
            this.wireframeMesh.geometry.dispose();
            this.wireframeMesh.material.dispose();
        }
        this._disposeLayerGrid();
        // Очистка осей координат (общая функция из coordinateAxes.js)
        if (this._axesGroup) {
            this.scene.remove(this._axesGroup);
            disposeCoordinateAxes(this._THREE, this._axesGroup);
            this._axesGroup = null;
        }
        this.layerFilter = null;
        removeLegend(this._legendEl);
        this._legendEl = null;
        this._cellCenters = null;
        this._cellSizes = null;
        this._logRho = null;
        this._valid = null;
        this._boundsX = null;
        this._boundsY = null;
        this._boundsZ = null;
        this._zCum = null;
        this.modelMesh = null;
        this.wireframeMesh = null;
        if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    }
}

// showVolumeModal вынесен в ./volumeModal.js
export { showVolumeModal } from './volumeModal.js';

