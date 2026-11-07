/**
 * curveSmoothing.js — статистическая обработка кривых «калибровка / импеданс».
 *
 * Задача: кривая, снятая с прибора, не годится для отрисовки «как есть»:
 *   - в одном x (частоте) может оказаться несколько значений y (дубли точек,
 *     наложенные кривые разных групп датчиков) → кривая перестаёт быть функцией;
 *   - точки «шумят» (измерительная погрешность, джиттер) → линия рваная.
 *
 * Решение — три шага, все построены на методе наименьших квадратов:
 *
 *   1. Очистка. Отбрасываются нефинитные точки и f <= 0. Затем точки сортируются
 *      по частоте, и точки с практически одинаковой частотой склеиваются в одну:
 *      амплитуда усредняется, фаза — сначала разворачивается (unwrap) по ±180°,
 *      усредняется и сворачивается обратно. После этого кривая — однозначная
 *      функция y(x) с строго возрастающим x.
 *
 *   2. Сглаживание. Применяется LOWESS (локальная взвешенная регрессия
 *      с трикубным ядром): в скользящем окне по log10(f) решается взвешенная
 *      задача линейной регрессии (метод наименьших квадратов) и берётся
 *      предсказание в центре окна. Это лучше простого скользящего среднего:
 *      окно адаптивно, а линейная аппроксимация внутри окна не «замыливает»
 *      тренд и корректно работает при неравномерной сетке частот.
 *
 *   3. Робастность. После первой оценки повторяем регрессию с весами по
 *      остаткам (бисквадратичный вес, масштаб — 6·median|остаток|). Так
 *      выбросы (отдельные «провалы» амплитуды) почти не влияют на результат.
 *
 * Фаза обрабатывается отдельно: разворачивается по ±180° (иначе на скачках
 * сглаживание «размажет» переход), сглаживается в развёрнутом виде и
 * сворачивается обратно в [-180, 180].
 *
 * Модуль чистый (без DOM) и тестируется через node --test.
 */

// ---------------------------------------------------------------------------
// Базовые статистические помощники
// ---------------------------------------------------------------------------

/** Медиана массива (не мутирует вход). */
export function median(values) {
    if (!values || values.length === 0) return NaN;
    const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (a.length === 0) return NaN;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Развернуть фазу по ±180°: убрать скачки вида 179° → -179°.
 * @param {number[]} phasesDeg
 * @returns {number[]} непрерывная (развёрнутая) фаза в градусах
 */
export function unwrapPhaseDeg(phasesDeg) {
    if (!Array.isArray(phasesDeg) || phasesDeg.length === 0) return [];
    const out = new Array(phasesDeg.length);
    let acc = Number(phasesDeg[0]);
    if (!Number.isFinite(acc)) acc = 0;
    out[0] = acc;
    for (let i = 1; i < phasesDeg.length; i++) {
        let delta = Number(phasesDeg[i]) - acc;
        if (!Number.isFinite(delta)) delta = 0;
        if (delta > 180) delta -= 360;
        else if (delta < -180) delta += 360;
        acc += delta;
        out[i] = acc;
    }
    return out;
}

/**
 * Свернуть фазу обратно в диапазон [-180, 180].
 * @param {number} deg
 * @returns {number}
 */
export function wrapPhaseDeg(deg) {
    if (!Number.isFinite(deg)) return NaN;
    return ((deg + 180) % 360 + 360) % 360 - 180;
}

/** Трикубное ядро (0 на краю окна, 1 в центре). */
function tricube(u) {
    if (u >= 1) return 0;
    const t = 1 - u * u * u;
    return t * t * t;
}

/** Бисквадратичный вес по остаткам (0 для выбросов). */
function bisquare(r, scale) {
    if (!(scale > 0) || !Number.isFinite(r)) return 0;
    const u = r / scale;
    if (u >= 1) return 0;
    const t = 1 - u * u;
    return t * t;
}

/**
 * Минимальное число точек в окне регрессии.
 * Для линейной модели нужно ≥2, для квадратичной — ≥4 (иначе модель
 * интерполирует окно и сглаживания не даёт).
 */
function minPointsForDegree(degree) {
    return degree >= 2 ? 5 : 3;
}

/**
 * Решение симметричной системы нормальных уравнений методом Гаусса
 * с выбором ведущего элемента. Матрица small (2x2 или 3x3).
 * @param {number[][]} A
 * @param {number[]} b
 * @returns {?number[]} null, если система вырождена
 */
function solveLinearSystem(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
        // Ведущий элемент по модулю.
        let piv = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        }
        if (Math.abs(M[piv][col]) < 1e-300) return null;
        if (piv !== col) {
            const t = M[piv];
            M[piv] = M[col];
            M[col] = t;
        }
        const p = M[col][col];
        for (let r = col + 1; r < n; r++) {
            const f = M[r][col] / p;
            if (f === 0) continue;
            for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
        }
    }

    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = M[r][n];
        for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
        x[r] = s / M[r][r];
    }
    return x;
}

/**
 * Локальная взвешенная полиномиальная аппроксимация (степень 1 или 2)
 * в точке x0. Возвращает предсказание в x0 (значение свободного члена).
 *
 * @param {number[]} xs узлы окна
 * @param {number[]} ys значения в узлах
 * @param {number[]} ws веса
 * @param {number} x0 точка предсказания
 * @param {number} degree степень полинома
 * @returns {?number} null, если система вырождена
 */
function localPolyFit(xs, ys, ws, x0, degree) {
    const k = degree + 1;
    const A = Array.from({ length: k }, () => new Array(k).fill(0));
    const b = new Array(k).fill(0);

    // Масштаб окна — для устойчивости нормальных уравнений.
    let scale = 0;
    for (const xv of xs) scale = Math.max(scale, Math.abs(xv - x0));
    if (!(scale > 0)) return null;
    const inv = 1 / scale;

    for (let i = 0; i < xs.length; i++) {
        const w = ws[i];
        if (!(w > 0)) continue;
        const u = (xs[i] - x0) * inv; // нормированная координата в [-1, 1]
        const basis = [1, u];
        if (degree >= 2) basis.push(u * u);
        for (let r = 0; r < k; r++) {
            b[r] += w * basis[r] * ys[i];
            for (let c = 0; c < k; c++) A[r][c] += w * basis[r] * basis[c];
        }
    }

    // Слабая регуляризация (ридж) — защита от вырожденности при
    // почти совпадающих узлах; на вес существенно не влияет.
    let trace = 0;
    for (let r = 0; r < k; r++) trace += Math.abs(A[r][r]);
    const lambda = 1e-10 * (trace / k);
    for (let r = 0; r < k; r++) A[r][r] += lambda;

    const sol = solveLinearSystem(A, b);
    if (!sol) return null;
    return sol[0]; // значение в x0 (u = 0)
}

// ---------------------------------------------------------------------------
// Сглаживание
// ---------------------------------------------------------------------------

/**
 * LOWESS: локальная взвешенная линейная регрессия в координате x.
 * Значения y возвращаются в узлах x (те же, что во входе).
 *
 * Окно адаптивное: для каждого узла берутся q ближайших соседей
 * (q = round(bandwidth · n), не меньше MIN_POINTS), веса — трикубные по
 * расстоянию до самого дальнего из выбранных соседей. Так окно всегда
 * содержит достаточно точек для регрессии даже при сильно неравномерной
 * сетке частот (в отличие от «фиксированного» окна в координате x).
 *
 * @param {number[]} x строго возрастающие узлы (после очистки)
 * @param {number[]} y значения в этих узлах
 * @param {object} [opts]
 * @param {number} [opts.bandwidth=0.2] доля точек, попадающих в окно
 * @param {number} [opts.robustIterations=2] число робастных итераций
 * @returns {number[]} сглаженные значения
 */
export function lowess(x, y, opts = {}) {
    const n = x.length;
    if (n === 0) return [];
    if (n < 3) return y.slice();

    const bandwidthFrac = Number.isFinite(opts.bandwidth) ? opts.bandwidth : 0.2;
    const robustIterations = Number.isFinite(opts.robustIterations) ? opts.robustIterations : 2;
    const degree = Number.isFinite(opts.degree) ? (opts.degree >= 2 ? 2 : 1) : 2;

    // Число соседей в окне: не меньше необходимого для модели, не больше n.
    const minPts = minPointsForDegree(degree);
    const q = Math.max(minPts, Math.min(n, Math.round(bandwidthFrac * n)));

    // Адаптивное сужение окна у реальных изломов. Ширина окна в LOESS — доля
    // ТОЧЕК, а не доля диапазона x: на узком V-провале (резонанс катушки,
    // COIL2430 тип 3: -0.094 → -0.521 → -0.143 за 3 точки) широкое окно
    // усредняет противоположные склоны и срезает провал на ~25% диапазона.
    // Ориентир — не кривизна (она велика и на гладкой части лог-сетки), а
    // невязка первого прохода относительно робастного масштаба этих невязок:
    // где сглаживание «не может сойтись» с данными, там окно укорачивается.
    const adaptive = opts.adaptive !== false;
    const windowScale = new Array(n).fill(1);

    // Начальные робастные веса (1 на первой итерации).
    const robustWeights = new Array(n).fill(1);
    const out = new Array(n);

    const wx = [];
    const wy = [];
    const ww = [];

    function fitPass() {

    for (let iter = 0; iter <= robustIterations; iter++) {
        for (let i = 0; i < n; i++) {
            // q ближайших соседей по |x[j] - x[i]| (узлы отсортированы).
            let lo = i;
            let hi = i;
            let qi = Math.max(3, Math.min(n, Math.round(q * windowScale[i])));
            let count = 1;
            while (count < qi) {
                const dl = lo > 0 ? x[i] - x[lo - 1] : Infinity;
                const dr = hi < n - 1 ? x[hi + 1] - x[i] : Infinity;
                if (dl <= dr) lo--;
                else hi++;
                count++;
            }

            const dMax = Math.max(Math.abs(x[lo] - x[i]), Math.abs(x[hi] - x[i]));
            if (!(dMax > 0)) {
                // Все совпавшие узлы — взвешенное среднее.
                let s = 0;
                let c = 0;
                for (let j = lo; j <= hi; j++) {
                    const w = robustWeights[j];
                    s += w * y[j];
                    c += w;
                }
                out[i] = c > 0 ? s / c : y[i];
                continue;
            }

            wx.length = 0;
            wy.length = 0;
            ww.length = 0;
            for (let j = lo; j <= hi; j++) {
                // Нижний порог робастного веса ставится при обновлении весов,
                // а не здесь: иначе узкий реальный излом (резонанс, обрыв
                // характеристики на краю диапазона) обесценивается и
                // сглаживается «в прямую».
                let rw = robustWeights[j];
                // Оценка в самой точке не должна обесцениваться: иначе робастная
                // итерация «срезает» узкий реальный экстремум (резонанс катушки,
                // COIL2430 тип 3: -0.521 превращался в -0.35, 23% диапазона).
                if (j === i && rw < 0.5) rw = 0.5;
                const w = tricube(Math.abs(x[j] - x[i]) / dMax) * rw;
                if (!(w > 0)) continue;
                wx.push(x[j]);
                wy.push(y[j]);
                ww.push(w);
            }

            // На редкой лог-сетке tricube крайних узлов окна обращается почти в 0
            // (u→1): узлы формально участвуют, но не несут информации, и
            // квадратичная регрессия по такой вырожденной выборке «выстреливает»
            // (на реальных 1332.CLB тип 5 — 0.59 вместо 1.0009 при исходной
            // монотонной кривой). Лечится степенью по числу СУЩЕСТВЕННЫХ узлов.
            // Точки при этом НЕ выбрасываем: потеря узлов срезает вершину
            // резонанса на других кривых.
            let maxW = 0;
            for (const w of ww) if (w > maxW) maxW = w;
            let nEff = 0;
            if (maxW > 0) {
                const cut = 1e-3 * maxW;
                for (const w of ww) if (w >= cut) nEff++;
            }
            if (nEff < 2) {
                // Существенных узлов нет — окно вырождено, оставляем исходную точку.
                out[i] = y[i];
                continue;
            }
            // Степень локальной модели. Квадратика требует не просто «пяти узлов
            // в окне», а пяти РАЗНОЦВЕТНЫХ по вкладу: на редкой лог-сетке окно из
            // 3–4 узлов с весами 0.07/0.67/1.0 задаёт квадратный полином точно, и
            // он экстраполирует выброс (1332.CLB тип 5: 0.59 вместо 1.0009).
            const effDegree = degree >= 2 && nEff >= 5 ? 2 : 1;

            const pred = localPolyFit(wx, wy, ww, x[i], effDegree);

            // Сглаживание не должно порождать значений вне локального разброса:
            // это отсечь любой экстраполяционный выстрел на краях/разрывах сетки.
            let loV = Infinity, hiV = -Infinity;
            for (const v of wy) { if (v < loV) loV = v; if (v > hiV) hiV = v; }
            if (pred == null || !Number.isFinite(pred)) {
                out[i] = y[i];
            } else {
                out[i] = Math.min(hiV, Math.max(loV, pred));
            }
        }

        if (iter < robustIterations) {
            // Робастные веса по остаткам текущей оценки.
            const resid = new Array(n);
            for (let i = 0; i < n; i++) resid[i] = y[i] - out[i];
            const scale = 6 * median(resid.map(Math.abs));
            for (let i = 0; i < n; i++) {
                let rw = scale > 0 ? bisquare(resid[i], scale) : 1;
                // Собственная точка не обесценивается ниже порога: иначе
                // робастная итерация «срезает» узкий реальный экстремум
                // (резонансный провал COIL2430 тип 3: -0.521 → -0.402).
                if (rw < 0.35) rw = 0.35;
                robustWeights[i] = rw;
            }
        }
    }
    }

    fitPass();

    if (adaptive && n >= 5) {
        // Невязки первого прохода: их робастный масштаб — «что этот оператор
        // в принципе не может прогладить». Там, где точка не сходится с окном
        // в несколько раз сильнее типичной невязки, окно укорачиваем; соседям
        // тоже достаётся уже укороченное окно, иначе они «тянут» излом к себе.
        const absResid = out.map((v, i) => Math.abs(y[i] - v));
        const s = 1.4826 * median(absResid);
        let changed = false;
        if (s > 0) {
            const pointScale = absResid.map((r) => {
                const k = r / s;
                return k > 2 ? Math.max(0.3, 2 / k) : 1;
            });
            for (let i = 0; i < n; i++) {
                let sc = 1;
                for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
                    sc = Math.min(sc, pointScale[j]);
                }
                if (sc < windowScale[i]) windowScale[i] = sc;
                if (windowScale[i] < 1) changed = true;
            }
        }
        // В редких кривых (несколько точек на декаду) широкое окно всегда
        // «не сходится» с данными: там сглаживать нечего, и любое усреднение
        // режет реальный излом. Окно уменьшаем только если оно достаточно
        // широкое, чтобы успеть прогладить шум.
        if (changed && q >= 8) {
            for (let i = 0; i < n; i++) robustWeights[i] = 1;
            fitPass();
        }
    }

    return out;
}

// ---------------------------------------------------------------------------
// Сборка кривой
// ---------------------------------------------------------------------------

/**
 * Склеить точки с одинаковой (почти) частотой.
 * @param {Array<{x:number, f:number, amp:number, pha:number, order:number}>} pts точки,
 *        отсортированные по x; order — исходный индекс точки
 * @param {number} xTol допуск по log10(f)
 * @returns {Array} точки после склейки (в порядке возрастания x)
 */
function mergeByFrequency(pts, xTol) {
    const out = [];
    let group = [];

    const flush = () => {
        if (group.length === 0) return;
        if (group.length === 1) {
            out.push(group[0]);
        } else {
            const amps = group.map(g => g.amp);
            const phases = group.map(g => g.pha);
            const meanAmp = amps.reduce((s, v) => s + v, 0) / amps.length;
            // Фазы усредняем в развёрнутом виде, иначе среднее «размажется».
            const unwrapped = unwrapPhaseDeg(phases);
            const meanPhase = unwrapped.reduce((s, v) => s + v, 0) / unwrapped.length;
            out.push({
                x: group.reduce((s, g) => s + g.x, 0) / group.length,
                f: group.reduce((s, g) => s + g.f, 0) / group.length,
                amp: meanAmp,
                pha: wrapPhaseDeg(meanPhase),
                order: group.reduce((s, g) => s + g.order, 0) / group.length,
            });
        }
        group = [];
    };

    for (const p of pts) {
        if (group.length === 0) {
            group.push(p);
            continue;
        }
        const ref = group[0].x;
        if (Math.abs(p.x - ref) <= xTol) group.push(p);
        else {
            flush();
            group.push(p);
        }
    }
    flush();
    return out;
}

/**
 * Обработать одну кривую: очистить, склеить дубли по частоте и сгладить.
 *
 * Гарантии на выходе:
 *   - одна частота — одно значение (кривая является функцией y(x));
 *   - значения конечны, фаза лежит в [-180, 180];
 *   - кривая гладкая (локальная МНК-аппроксимация, робастные веса).
 *
 * @param {{frequencies:number[], amplitudes:number[], phases:number[]}} curve
 * @param {object} [opts]
 * @param {number} [opts.bandwidth=0.2] доля точек в окне регрессии
 * @param {number} [opts.degree=2] степень локального полинома (1 или 2)
 * @param {number} [opts.robustIterations=2] число робастных итераций
 * @param {number} [opts.frequencyTolerance=1e-6] допуск «одинаковой» частоты (log10)
 * @param {boolean} [opts.smooth=true] сглаживать (false — только склейка)
 * @param {boolean} [opts.preserveOrder=true] сохранить исходный порядок точек
 * @returns {{frequencies:number[], amplitudes:number[], phases:number[]}}
 */
export function smoothCurve(curve, opts = {}) {
    const src = curve || {};
    const freqs = Array.isArray(src.frequencies) ? src.frequencies : [];
    const amps = Array.isArray(src.amplitudes) ? src.amplitudes : [];
    const phases = Array.isArray(src.phases) ? src.phases : [];

    const empty = { frequencies: [], amplitudes: [], phases: [] };
    if (freqs.length === 0) return empty;

    const xTol = Number.isFinite(opts.frequencyTolerance) ? opts.frequencyTolerance : 1e-6;
    const doSmooth = opts.smooth !== false;
    const preserveOrder = opts.preserveOrder !== false;

    // 1. Очистка и приведение к общему виду.
    const pts = [];
    for (let i = 0; i < freqs.length; i++) {
        const f = Number(freqs[i]);
        const amp = Number(amps[i]);
        const pha = Number(phases[i]);
        if (!Number.isFinite(f) || f <= 0) continue;
        if (!Number.isFinite(amp) || !Number.isFinite(pha)) continue;
        pts.push({ x: Math.log10(f), f, amp, pha, order: i });
    }
    if (pts.length === 0) return empty;

    pts.sort((a, b) => a.x - b.x);

    // 2. Склейка дублей по частоте → кривая становится функцией y(x).
    const merged = mergeByFrequency(pts, xTol);
    if (merged.length === 0) return empty;

    const xs = merged.map(p => p.x);
    const ampIn = merged.map(p => p.amp);

    // Фаза: развернуть → сгладить в развёрнутом виде → свернуть обратно.
    const phaUnwrapped = unwrapPhaseDeg(merged.map(p => p.pha));

    let ampOut = ampIn;
    let phaOut = phaUnwrapped;
    if (doSmooth && merged.length >= 3) {
        ampOut = lowess(xs, ampIn, opts);
        phaOut = lowess(xs, phaUnwrapped, opts);
    }

    // 3. Возврат в исходный порядок точек (кривые рисуются в порядке
    //    убывания частоты, как их отдаёт парсер калибровок).
    let order = merged.map((_, i) => i);
    if (preserveOrder) {
        order = merged.map((p, i) => i).sort((a, b) => merged[a].order - merged[b].order);
    }

    return {
        frequencies: order.map(i => merged[i].f),
        amplitudes: order.map(i => (Number.isFinite(ampOut[i]) ? ampOut[i] : 0)),
        phases: order.map(i => (Number.isFinite(phaOut[i]) ? wrapPhaseDeg(phaOut[i]) : 0)),
    };
}

/**
 * Обработать список кривых (например, calCurvesList: [{name, curves:[...]}]).
 * Исходные объекты не мутируются.
 *
 * @param {Array<{name?:string, curves:Array}>} curvesList
 * @param {object} [opts] см. smoothCurve
 * @returns {Array<{name?:string, curves:Array}>}
 */
export function smoothCurvesList(curvesList, opts = {}) {
    if (!Array.isArray(curvesList)) return [];
    return curvesList.map(entry => {
        if (!entry) return entry;
        const curves = Array.isArray(entry.curves) ? entry.curves : [];
        const out = { ...entry };
        out.curves = curves.map(c => smoothCurve(c, opts));
        return out;
    });
}
