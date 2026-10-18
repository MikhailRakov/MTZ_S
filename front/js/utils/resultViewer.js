// 3D Result Viewer for MTZ Inversion Results
//
// Текущая реализация: объёмный рендеринг через THREE.InstancedMesh —
// по одной инстанс-ячейке на каждый воксель модели. На каждую ячейку
// хранится матрица (центр + размер) и цвет. Ячейки вне текущего
// диапазона сопротивления прячутся scale=0, что даёт чёткую картину
// аномалий. Поверх можно включить опциональный wireframe-оверлей.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// === Научные палитры ===
// Каждая функция принимает t ∈ [0, 1] и возвращает [r, g, b] в [0, 1].
// Применяется на log10(rho), нормированном в текущий видимый диапазон.

const colormaps = {
    jet(t) {
        // blue (низкое) -> cyan -> green -> yellow -> red (высокое)
        let r, g, b;
        if (t < 0.25) {
            const k = t / 0.25;
            r = 0; g = k * 0.5; b = 1;
        } else if (t < 0.5) {
            const k = (t - 0.25) / 0.25;
            r = 0; g = 0.5 + k * 0.5; b = 1 - k;
        } else if (t < 0.75) {
            const k = (t - 0.5) / 0.25;
            r = k; g = 1; b = 0;
        } else {
            const k = (t - 0.75) / 0.25;
            r = 1; g = 1 - k; b = 0;
        }
        return [r, g, b];
    },

    viridis(t) {
        // Полиномиальная аппроксимация matplotlib viridis
        // (оригинал — численные коэффициенты из mpl colormaps)
        const c0 = [0.267004, 0.004874, 0.329415];
        const c1 = [0.282623, 0.140926, 0.457517];
        const c2 = [0.253935, 0.265254, 0.529983];
        const c3 = [0.163625, 0.471133, 0.558148];
        const c4 = [0.134692, 0.658636, 0.517649];
        const c5 = [0.477504, 0.821444, 0.318195];
        const c6 = [0.993248, 0.906157, 0.143936];
        const stops = [c0, c1, c2, c3, c4, c5, c6];
        const idx = t * (stops.length - 1);
        const i = Math.min(stops.length - 2, Math.floor(idx));
        const f = idx - i;
        const a = stops[i], b = stops[i + 1];
        return [
            a[0] + (b[0] - a[0]) * f,
            a[1] + (b[1] - a[1]) * f,
            a[2] + (b[2] - a[2]) * f,
        ];
    },

    hot(t) {
        // black -> red -> yellow -> white
        const r = Math.min(1, 3 * t);
        const g = Math.min(1, Math.max(0, 3 * t - 1));
        const b = Math.min(1, Math.max(0, 3 * t - 2));
        return [r, g, b];
    },

    cool(t) {
        // cyan -> magenta (cosine-палитра)
        return [t, 1 - t, 1];
    },

    gray(t) {
        return [t, t, t];
    },
};

const COLORMAP_NAMES = Object.keys(colormaps);

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
        this._tmpMatrix = new THREE.Matrix4();
        this._tmpColor = new THREE.Color();

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
    init3DVisualization(containerElement, modelData) {
        if (!modelData || !Array.isArray(modelData.rhoValues)) {
            throw new Error('modelData.rhoValues отсутствует или не массив — обновите страницу (Ctrl+Shift+R), возможно браузер использует кэш старых модулей');
        }
        this.modelData = modelData;
        this._prepareCellCache(modelData);

        // Стартовые настройки: показываем весь диапазон данных
        if (this.settings.minRho == null) this.settings.minRho = this.colorScale.dataMin;
        if (this.settings.maxRho == null) this.settings.maxRho = this.colorScale.dataMax;

        const width = containerElement.clientWidth;
        const height = containerElement.clientHeight;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0f);

        const xExtent = modelData.xCells.reduce((a, b) => a + b, 0);
        const yExtent = modelData.yCells.reduce((a, b) => a + b, 0);
        const zExtent = modelData.zCells.reduce((a, b) => a + b, 0);
        const maxExtent = Math.max(xExtent, yExtent, zExtent);

        this.camera = new THREE.PerspectiveCamera(50, width / height, maxExtent * 0.01, maxExtent * 10);
        const cameraDistance = maxExtent * 1.8;
        this.camera.position.set(cameraDistance * 0.8, cameraDistance * 0.8, cameraDistance * 1.0);
        this.camera.lookAt(0, 0, -zExtent * 0.3);
        this.camera.up.set(0, 0, 1);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        containerElement.innerHTML = '';
        containerElement.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.maxDistance = maxExtent * 5;
        this.controls.minDistance = maxExtent * 0.1;

        // Тусклый ambient — заливка ячеек не использует свет, но он нужен
        // для возможного wireframe-оверлея (LineBasicMaterial не зависит
        // от света, но если в будущем добавим MeshNormalMaterial — будет готов).
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        this.addModelToScene(modelData);
        this.addColorScale(containerElement);

        const animate = () => {
            requestAnimationFrame(animate);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        animate();

        const handleResize = () => {
            const newWidth = containerElement.clientWidth;
            const newHeight = containerElement.clientHeight;
            this.camera.aspect = newWidth / newHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(newWidth, newHeight);
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

        const boxGeom = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshBasicMaterial({
            // ВАЖНО: для InstancedMesh.instanceColor параметр vertexColors
            // НЕ нужен (и вреден) — Three.js включает USE_INSTANCING_COLOR
            // автоматически по наличию атрибута instanceColor. Если же
            // включить vertexColors, шейдер сделает vColor *= color, где
            // color — атрибут геометрии; у BoxGeometry его нет, и WebGL
            // читает vec3(0), из-за чего вся заливка получается чёрной.
            color: 0xffffff,
            transparent: true,
            opacity: this.settings.opacity,
            side: THREE.DoubleSide,
            depthWrite: this.settings.opacity >= 0.999,
        });

        this.modelMesh = new THREE.InstancedMesh(boxGeom, material, total);
        this.modelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const mat = new THREE.LineBasicMaterial({
            color: 0x8be9fd, transparent: true, opacity: 0.4, depthTest: false,
        });
        const lines = new THREE.LineSegments(geom, mat);
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
        this._raycaster = new THREE.Raycaster();
        this._ndcVec = new THREE.Vector2();

        // Подсветка ячейки под курсором — белый контур
        const hoverGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
        const hoverMat = new THREE.LineBasicMaterial({
            color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9,
        });
        this._hoverBox = new THREE.LineSegments(hoverGeo, hoverMat);
        this._hoverBox.visible = false;
        this._hoverBox.renderOrder = 999;
        this.scene.add(this._hoverBox);

        // Подсветка выбранных ячеек — ядовито-пурпурные контуры (единая геометрия).
        // Magenta (0xff00ff) отсутствует в палитре jet (blue→cyan→green→yellow→red),
        // поэтому выделение контрастно на фоне ячеек любого сопротивления.
        this._selectionLines = new THREE.LineSegments(
            new THREE.BufferGeometry(),
            new THREE.LineBasicMaterial({
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
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        this._selectionLines.geometry = geo;
        if (this._editOptions.onSelectionChanged) {
            this._editOptions.onSelectionChanged(this.selection.size);
        }
    }

    // --- Обработчики указателя ---
    _onEditPointerMove(e) {
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
    // Строит контурную сетку, как в предыдущей версии, но отдельным объектом.
    _buildWireframe(modelData) {
        const { nX, nY, nZ, xCells, yCells, zCells } = modelData;
        const eastPositions = this.calculatePositions(yCells);
        const northPositions = this.calculatePositions(xCells);
        const zPositions = this.calculatePositions(zCells);
        const eastOffset = -(eastPositions[eastPositions.length - 1] / 2);
        const northOffset = -(northPositions[northPositions.length - 1] / 2);

        const vertices = [];
        const colors = [];
        const xStep = Math.max(1, Math.floor(nX / 30));
        const yStep = Math.max(1, Math.floor(nY / 30));
        const zLayers = [0, 2, 5, 10, 15, 20, 30, Math.floor(nZ * 0.7), Math.floor(nZ - 1)];

        for (const k of zLayers) {
            if (k >= nZ) continue;
            for (let i = 0; i < nX; i += xStep) {
                for (let j = 0; j < nY; j += yStep) {
                    const x1 = eastPositions[j] + eastOffset;
                    const x2 = eastPositions[j + 1] + eastOffset;
                    const y1 = northPositions[i] + northOffset;
                    const y2 = northPositions[i + 1] + northOffset;
                    const z1 = -zPositions[k];
                    const z2 = -zPositions[k + 1];
                    this._addCubeWireframe(vertices, colors, x1, x2, y1, y2, z1, z2, [0.8, 0.85, 0.9]);
                }
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const material = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.5,
        });
        return new THREE.LineSegments(geometry, material);
    }

    _addCubeWireframe(vertices, colors, x1, x2, y1, y2, z1, z2, color) {
        const addLine = (p1, p2) => {
            vertices.push(...p1, ...p2);
            colors.push(...color, ...color);
        };
        // Bottom face
        addLine([x1, y1, z1], [x2, y1, z1]);
        addLine([x2, y1, z1], [x2, y2, z1]);
        addLine([x2, y2, z1], [x1, y2, z1]);
        addLine([x1, y2, z1], [x1, y1, z1]);
        // Top face
        addLine([x1, y1, z2], [x2, y1, z2]);
        addLine([x2, y1, z2], [x2, y2, z2]);
        addLine([x2, y2, z2], [x1, y2, z2]);
        addLine([x1, y2, z2], [x1, y1, z2]);
        // Vertical edges
        addLine([x1, y1, z1], [x1, y1, z2]);
        addLine([x2, y2, z1], [x2, y2, z2]);
    }

    // === Цветовая шкала-легенда ===
    addColorScale(containerElement) {
        if (!this.colorScale) return;
        const legend = document.createElement('div');
        legend.className = 'result-viewer-legend';
        legend.innerHTML = `
            <div class="legend-title">Удельное сопротивление (Ω·м)</div>
            <div class="color-scale-bar"></div>
            <div class="color-scale-labels">
                <span class="cs-min">${this.colorScale.minRho.toFixed(1)}</span>
                <span class="cs-mid"></span>
                <span class="cs-max">${this.colorScale.maxRho.toFixed(1)}</span>
            </div>
            <div class="legend-meta">
                <span>Палитра: <strong class="cs-palette">${this.colorScale.paletteName}</strong></span>
                <span>Всего: <strong class="cs-visible">—</strong> / <span class="cs-total">—</span></span>
            </div>
        `;
        containerElement.appendChild(legend);
        this._legendEl = legend;
        this._updateColorScaleLegend();
    }

    _updateColorScaleLegend() {
        if (!this._legendEl || !this.colorScale) return;
        const { minRho, maxRho, dataMin, dataMax, paletteName } = this.colorScale;
        const bar = this._legendEl.querySelector('.color-scale-bar');
        if (bar) {
            // Градиент по выбранной палитре. Длина по 64 точкам.
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
        const minEl = this._legendEl.querySelector('.cs-min');
        const maxEl = this._legendEl.querySelector('.cs-max');
        const midEl = this._legendEl.querySelector('.cs-mid');
        if (minEl) minEl.textContent = formatRho(minRho);
        if (maxEl) maxEl.textContent = formatRho(maxRho);
        if (midEl) midEl.textContent = formatRho(Math.sqrt(minRho * maxRho));
        const palEl = this._legendEl.querySelector('.cs-palette');
        if (palEl) palEl.textContent = paletteName;

        // Сколько ячеек попадает в текущий диапазон
        const logMin = Math.log10(minRho);
        const logMax = Math.log10(maxRho);
        let visible = 0;
        const total = this._logRho.length;
        for (let i = 0; i < total; i++) {
            if (!this._valid[i]) continue;
            const lr = this._logRho[i];
            if (lr >= logMin && lr <= logMax) visible++;
        }
        const visEl = this._legendEl.querySelector('.cs-visible');
        const totEl = this._legendEl.querySelector('.cs-total');
        if (visEl) visEl.textContent = visible.toLocaleString();
        if (totEl) totEl.textContent = total.toLocaleString();
    }

    // === Утилиты ===
    calculatePositions(cells) {
        const positions = [0];
        let cumulative = 0;
        for (const cell of cells) cumulative += cell, positions.push(cumulative);
        return positions;
    }

    dispose() {
        // Выключаем редактирование (снимает обработчики и удаляет подсветку)
        this.disableEditing();
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
        this.layerFilter = null;
        if (this._legendEl && this._legendEl.parentNode) {
            this._legendEl.parentNode.removeChild(this._legendEl);
        }
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

// Форматирует значение сопротивления для подписей шкалы:
// < 10 — один знак, 10..1000 — без дробной, остальное — экспонента.
function formatRho(v) {
    if (!isFinite(v) || v <= 0) return '—';
    if (v < 10) return v.toFixed(2);
    if (v < 100) return v.toFixed(1);
    if (v < 1000) return v.toFixed(0);
    if (v < 10000) return v.toFixed(0);
    return v.toExponential(1);
}

// === Модальное окно объёмного просмотра модели ===
// Переиспользует стиль готовых решений (файл-viewer-modal + ResultViewer):
// тот же модальный шаблон, легенда, статистика и OrbitControls.
// modelData — объект формата { nX, nY, nZ, xCells, yCells, zCells, rhoValues }
// (см. buildSimpegModelData в simpegProfilesConverter.js).
//
// options.editing (опционально) включает режим правки сопротивлений ячеек:
// {
//   defaultRho: фоновое ρ (для сброса),
//   onCellsEdited(indices, rho): вызывается после правки ячеек,
//   getModifiedCount(): сколько ячеек отличается от фона — для счётчика в панели
// }
let _volumeViewerInstance = null;

export function showVolumeModal(modelData, title = 'Объёмная модель', options = {}) {
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
        _volumeViewerInstance.init3DVisualization(container, modelData);

        // === Панель редактирования ===
        if (editing) {
            const viewer = _volumeViewerInstance;
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
                        try {
                            editing.onCellsEdited(indices, rho);
                        } catch (err) {
                            console.error('[VOLUME EDIT] onCellsEdited failed:', err);
                        }
                    }
                    updateCount();
                    // Правка могла расширить диапазон данных (_ensureRangeIncludes) —
                    // пересинхронизируем фильтр-слайдер с новыми границами
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

            // === Выбор Z-слоя: изоляция + точная правка одного среза ===
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
                // Перестройка 100k+ инстансов недешёвая — не чаще кадра
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

            // Сетка границ ячеек всего объёма
            modal.querySelector('#volume-edit-grid').addEventListener('change', (e) => {
                viewer.setWireframe(e.target.checked);
            });

            // === Фильтр сопротивлений (dual range-slider, лог-шкала) ===
            // Тот же компонент, что в панели VTR-вьюера: внутренние значения
            // [0..10000] маппятся в [log10(lo), log10(hi)] текущего диапазона данных.
            const rMinInput = modal.querySelector('#volume-edit-range-min');
            const rMaxInput = modal.querySelector('#volume-edit-range-max');
            const rFill = modal.querySelector('#volume-edit-range-fill');
            const rMinLabel = modal.querySelector('#volume-edit-range-min-label');
            const rMaxLabel = modal.querySelector('#volume-edit-range-max-label');
            const rHint = modal.querySelector('#volume-edit-range-hint');

            // Границы лог-шкалы. ВАЖНО: свежая coarse-сетка однородна
            // (все ρ = defaultRho → dataMin == dataMax), поэтому вырожденный
            // диапазон расширяем по декаде в обе стороны.
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
                if (vMin > vMax) [vMin, vMax] = [vMax, vMin]; // не даём меняться местами
                const minRho = Math.pow(10, logLo + (vMin / 10000) * span);
                const maxRho = Math.pow(10, logLo + (vMax / 10000) * span);
                if (maxRho > minRho) viewer.setRange(minRho, maxRho);
                rFill.style.left = `${vMin / 100}%`;
                rFill.style.width = `${(vMax - vMin) / 100}%`;
                rMinLabel.textContent = formatRho(minRho);
                rMaxLabel.textContent = formatRho(maxRho);
                rHint.textContent = `${formatRho(minRho)} … ${formatRho(maxRho)} Ω·м`;
            };

            // Синхронизация ползунков с текущим состоянием viewer
            // (после правок _ensureRangeIncludes может расширить границы данных)
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

            // Перестройка 100k+ инстансов на каждое input-событие тяжела — rAF-троттлинг
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

            showFullRange(); // стартовое состояние — виден весь диапазон

            // Применить к выделенным
            applyBtn.addEventListener('click', () => {
                const rho = parseFloat(rhoInput.value);
                if (!(rho > 0) || !isFinite(rho)) {
                    alert('Введите корректное положительное сопротивление');
                    return;
                }
                viewer.applyRhoToSelection(rho);
            });

            // Снять выделение
            modal.querySelector('#volume-edit-clear').addEventListener('click', () => {
                viewer.clearSelection();
            });

            // Сбросить все изменения
            modal.querySelector('#volume-edit-reset').addEventListener('click', () => {
                const n = viewer.resetAllCells();
                if (n > 0) updateCount();
            });

            updateCount();
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
