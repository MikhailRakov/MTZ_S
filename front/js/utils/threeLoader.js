/**
 * Ленивый загрузчик Three.js (общий для всех 3D-вьюверов).
 *
 * Three.js (~600 KB) загружается только при первом обращении к 3D,
 * а не на этапе загрузки страницы. Модуль кэширует promise загрузки,
 * поэтому параллельные вызовы не приводят к повторным загрузкам.
 */

let threePromise = null;
let controlsPromise = null;

/** @returns {Promise<object>} модуль three.js */
export function getThree() {
    if (!threePromise) {
        threePromise = import('three');
    }
    return threePromise;
}

/** @returns {Promise<Function>} конструктор OrbitControls */
export function getOrbitControls() {
    if (!controlsPromise) {
        controlsPromise = import('three/addons/controls/OrbitControls.js')
            .then((mod) => mod.OrbitControls);
    }
    return controlsPromise;
}

/**
 * Загружает Three.js и OrbitControls параллельно.
 * @returns {Promise<{THREE: object, OrbitControls: Function}>}
 */
export async function loadThree() {
    const [THREE, OrbitControls] = await Promise.all([getThree(), getOrbitControls()]);
    return { THREE, OrbitControls };
}
