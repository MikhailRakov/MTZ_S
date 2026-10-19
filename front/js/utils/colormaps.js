/**
 * Научные цветовые палитры для визуализации удельного сопротивления.
 * Каждая функция принимает t ∈ [0, 1] и возвращает [r, g, b] в [0, 1].
 * Применяется на log10(rho), нормированном в текущий видимый диапазон.
 */

export const colormaps = {
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

export const COLORMAP_NAMES = Object.keys(colormaps);
