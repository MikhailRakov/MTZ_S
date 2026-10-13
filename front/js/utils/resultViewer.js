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
        const { minRho, maxRho, colormap } = this.settings;
        const logMin = Math.log10(minRho);
        const logMax = Math.log10(maxRho);
        const logSpan = logMax - logMin;
        const palette = colormaps[colormap] || colormaps.jet;

        for (let i = 0; i < total; i++) {
            const off3 = i * 3;
            const valid = this._valid[i];
            const logR = this._logRho[i];

            if (!valid || logR < logMin || logR > logMax) {
                // Скрытая ячейка — scale 0
                this._tmpMatrix.makeScale(0, 0, 0);
            } else {
                const t = logSpan > 0 ? (logR - logMin) / logSpan : 0.5;
                const [r, g, b] = palette(Math.max(0, Math.min(1, t)));
                this._tmpColor.setRGB(r, g, b);
                this.modelMesh.setColorAt(i, this._tmpColor);

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
            this.modelMesh.setMatrixAt(i, this._tmpMatrix);
        }
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

    // Возвращает список доступных палитр (для заполнения <select> в UI).
    static getColormapNames() {
        return [...COLORMAP_NAMES];
    }

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
        if (this._legendEl && this._legendEl.parentNode) {
            this._legendEl.parentNode.removeChild(this._legendEl);
        }
        this._legendEl = null;
        this._cellCenters = null;
        this._cellSizes = null;
        this._logRho = null;
        this._valid = null;
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
let _volumeViewerInstance = null;

export function showVolumeModal(modelData, title = 'Объёмная модель') {
    const modal = document.createElement('div');
    modal.className = 'file-viewer-modal result-viewer-modal-large';
    modal.innerHTML = `
        <div class="file-viewer-content result-viewer-content-large">
            <div class="file-viewer-header">
                <h3>📊 ${title}</h3>
                <button class="file-viewer-close">&times;</button>
            </div>
            <div class="file-viewer-body">
                <div class="volume-3d-container" style="width: 100%; height: 70vh; position: relative;"></div>
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
                    <div style="color: var(--color-primary); font-weight: 600;">${(xExtent / 1000).toFixed(1)} × ${(yExtent / 1000).toFixed(1)} км</div>
                </div>
                <div>
                    <div style="color: var(--color-text-tertiary);">Глубина</div>
                    <div style="color: var(--color-primary); font-weight: 600;">${(zExtent / 1000).toFixed(1)} км</div>
                </div>
                <div>
                    <div style="color: var(--color-text-tertiary);">Диапазон ρ</div>
                    <div style="color: var(--color-primary); font-weight: 600;">${isFinite(minRho) ? minRho.toFixed(1) : '—'} — ${isFinite(maxRho) ? maxRho.toFixed(1) : '—'} Ω·м</div>
                </div>
            </div>
            <div style="margin-top: 12px; color: var(--color-text-tertiary); font-size: 0.85em;">
                💡 Используйте мышь для вращения, масштабирования и панорамирования модели
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
