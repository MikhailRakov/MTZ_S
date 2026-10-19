/**
 * Координатные оси с подписями и отметками для 3D-вьюверов сеток и моделей.
 *
 * Конвенция осей (одинакова в ResultViewer и CoarseGenerator):
 *   scene X = East  (model Y),
 *   scene Y = North (model X),
 *   scene -Z = Depth (глубина вниз).
 *
 * Модуль принимает THREE как параметр (dynamic import), поэтому не тянет
 * зависимость на этапе загрузки страницы.
 */

/**
 * Создаёт группу осей координат с стрелками, подписями и отметками в км.
 * @param {object} THREE — загруженный модуль three.js
 * @param {object} opts
 * @param {number} opts.xExtent — размер модели вдоль East (scene X), м
 * @param {number} opts.yExtent — размер модели вдоль North (scene Y), м
 * @param {number} opts.zExtent — размер модели по глубине (scene Z), м
 * @param {number} [opts.axisLength] — длина оси (по умолчанию 0.7 от max extent)
 * @returns {THREE.Group} группа, готовая для scene.add()
 */
export function createCoordinateAxes(THREE, { xExtent, yExtent, zExtent, axisLength = null }) {
    const maxExtent = Math.max(xExtent, yExtent, zExtent);
    const length = axisLength ?? maxExtent * 0.7;
    const arrowSize = length * 0.04;
    const labelDistance = length * 1.12;

    const axesGroup = new THREE.Group();
    axesGroup.renderOrder = 1;

    // --- Ось scene X = East (зелёная) ---
    _addAxisLine(THREE, axesGroup, [length, 0, 0], 0x00ff00);
    _addArrow(THREE, axesGroup, [length, 0, 0], { z: -Math.PI / 2 }, 0x00ff00, arrowSize);

    // --- Ось scene Y = North (красная) ---
    _addAxisLine(THREE, axesGroup, [0, length, 0], 0xff0000);
    _addArrow(THREE, axesGroup, [0, length, 0], {}, 0xff0000, arrowSize);

    // --- Ось scene -Z = Depth (синяя, направлена вниз) ---
    _addAxisLine(THREE, axesGroup, [0, 0, -length], 0x0088ff);
    _addArrow(THREE, axesGroup, [0, 0, -length], { x: Math.PI / 2 }, 0x0088ff, arrowSize);

    // --- Подписи осей ---
    addAxisLabel(THREE, 'Y (East)', [labelDistance, 0, 0], 0x00ff00, axesGroup);
    addAxisLabel(THREE, 'X (North)', [0, labelDistance, 0], 0xff0000, axesGroup);
    addAxisLabel(THREE, 'Z (Depth)', [0, 0, -labelDistance], 0x0088ff, axesGroup);

    // --- Координатные отметки (размеры в км) ---
    const eastKm = `${(xExtent / 1000).toFixed(1)} km`;
    const northKm = `${(yExtent / 1000).toFixed(1)} km`;
    const depthKm = `${(zExtent / 1000).toFixed(1)} km`;

    addAxisLabel(THREE, eastKm, [length * 0.5, -arrowSize * 3, 0], 0x66ff66, axesGroup, 0.7);
    addAxisLabel(THREE, northKm, [-arrowSize * 3, length * 0.5, 0], 0xff6666, axesGroup, 0.7);
    addAxisLabel(THREE, depthKm, [-arrowSize * 3, 0, -length * 0.5], 0x6666ff, axesGroup, 0.7);

    return axesGroup;
}

/**
 * Корректно освобождает ресурсы группы осей (геометрия, материалы, текстуры).
 */
export function disposeCoordinateAxes(THREE, axesGroup) {
    if (!axesGroup) return;
    axesGroup.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (obj.material.map) obj.material.map.dispose();
            obj.material.dispose();
        }
    });
}

/** Линия оси от начала координат до заданной точки. */
function _addAxisLine(THREE, parent, [ex, ey, ez], color) {
    const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(ex, ey, ez),
    ]);
    parent.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color, linewidth: 3 })));
}

/** Конус-стрелка на конце оси. */
function _addArrow(THREE, parent, [px, py, pz], rotation, color, arrowSize) {
    const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(arrowSize * 0.5, arrowSize * 2, 8),
        new THREE.MeshBasicMaterial({ color }),
    );
    arrow.position.set(px, py, pz);
    if (rotation.x != null) arrow.rotation.x = rotation.x;
    if (rotation.y != null) arrow.rotation.y = rotation.y;
    if (rotation.z != null) arrow.rotation.z = rotation.z;
    parent.add(arrow);
}

/**
 * Текстовая метка-спрайт (CanvasTexture — не зависит от веб-шрифтов).
 * @param {object} THREE
 * @param {string} text
 * @param {[number,number,number]} position
 * @param {number} color — 0xRRGGBB
 * @param {THREE.Object3D} parent
 * @param {number} [scale]
 */
export function addAxisLabel(THREE, text, [x, y, z], color, parent, scale = 1.0) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 128;

    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 64);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(x, y, z);
    sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
    parent.add(sprite);
}
