/**
 * Wireframe-оверлей для объёмных моделей.
 * Строит контурную сетку (LineSegments) по разрежённым выборкам ячеек.
 * Модуль принимает THREE как параметр (ленивая загрузка).
 */

import { calculatePositions } from './gridUtils.js';

/**
 * Добавляет 10 рёбер куба (контур ячейки) в массивы вершин/цветов.
 * Рёбра: 4 снизу, 4 сверху, 2 вертикальных (диагональные пары).
 */
export function addCubeWireframe(vertices, colors, x1, x2, y1, y2, z1, z2, color) {
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

/**
 * Строит wireframe-оверлей модели.
 * @param {object} THREE — загруженный модуль three.js
 * @param {object} modelData — { nX, nY, nZ, xCells, yCells, zCells }
 * @param {object} [opts]
 * @param {number[]} [opts.color] — цвет рёбер [r,g,b] в [0,1], по умолчанию [0.8, 0.85, 0.9]
 * @param {number} [opts.opacity] — прозрачность, по умолчанию 0.5
 * @param {number} [opts.maxPerAxis] — максимум линий на горизонтальную ось (~шаг прореживания)
 * @returns {THREE.LineSegments}
 */
export function buildWireframe(THREE, modelData, opts = {}) {
    const { nX, nY, nZ, xCells, yCells, zCells } = modelData;
    const color = opts.color ?? [0.8, 0.85, 0.9];
    const opacity = opts.opacity ?? 0.5;
    const maxPerAxis = opts.maxPerAxis ?? 30;

    const eastPositions = calculatePositions(yCells);   // scene X = East  (model Y)
    const northPositions = calculatePositions(xCells);  // scene Y = North (model X)
    const zPositions = calculatePositions(zCells);
    const eastOffset = -(eastPositions[eastPositions.length - 1] / 2);
    const northOffset = -(northPositions[northPositions.length - 1] / 2);

    const vertices = [];
    const colors = [];
    const xStep = Math.max(1, Math.floor(nX / maxPerAxis));
    const yStep = Math.max(1, Math.floor(nY / maxPerAxis));
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
                addCubeWireframe(vertices, colors, x1, x2, y1, y2, z1, z2, color);
            }
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity,
    });
    return new THREE.LineSegments(geometry, material);
}
