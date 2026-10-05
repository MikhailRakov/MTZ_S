/**
 * Конвертер результатов SimPEG (.npz) в формат Profiles.dat (AP3DMT / Matlab).
 *
 * Модуль не зависит от DOM и JSZip на уровне чистых функций:
 *   - parseNpy(buf)                 -> { shape, data }
 *   - parseSimpegNpz(rawMap)        -> нормализованная структура
 *   - buildSimpegStations(npz)      -> станции с комплексными компонентами
 *   - buildProfilesDat(stations, periods) -> текст Profiles.dat
 *
 * Формат подтверждён построчно по эталонному Profiles.dat:
 *   файл состоит из двух секций (Full_Impedance и Full_Vertical_Components),
 *   каждая строка данных — 11 колонок фиксированной ширины:
 *     Period(12.6E) Code GG_Lat(12.7f) GG_Lon(12.7f) X(12.3f) Y(12.3f)
 *     Z(12.3f) Component Real(15.6E) Imag(15.6E) Error(15.6E)
 */

// ---------------------------------------------------------------------------
// .npy parser
// ---------------------------------------------------------------------------

/**
 * Разбор одного .npy-буфера.
 * @param {Uint8Array} buf
 * @returns {{shape:number[], data:number[]}}
 */
export function parseNpy(buf) {
    const textDecoder = new TextDecoder();
    if (buf[0] !== 0x93 || textDecoder.decode(buf.slice(1, 6)) !== 'NUMPY') {
        throw new Error('Bad .npy magic');
    }
    const version = buf[6];
    let headerLen;
    let headerStart;
    if (version === 1) {
        headerLen = buf[8] | (buf[9] << 8);
        headerStart = 10;
    } else {
        headerLen = (buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24)) >>> 0;
        headerStart = 12;
    }
    const headerStr = textDecoder.decode(buf.slice(headerStart, headerStart + headerLen));

    const shapeMatch = headerStr.match(/'shape':\s*\(([^)]*)\)/);
    if (!shapeMatch) throw new Error('No shape in header');
    const shapeStr = shapeMatch[1].trim();
    const shape = shapeStr
        ? shapeStr.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
        : [];

    const dtypeMatch = headerStr.match(/'descr':\s*'([^']+)'/);
    if (!dtypeMatch) throw new Error('No dtype in header');
    const dtype = dtypeMatch[1];
    const littleEndian = dtype[0] !== '>';

    const dataOffset = headerStart + headerLen;
    const view = new DataView(buf.buffer, buf.byteOffset + dataOffset);

    let count = 1;
    for (const s of shape) count *= s;

    let bytesPer;
    let getter;
    if (dtype.endsWith('f8')) {
        bytesPer = 8;
        getter = (o) => view.getFloat64(o, littleEndian);
    } else if (dtype.endsWith('f4')) {
        bytesPer = 4;
        getter = (o) => view.getFloat32(o, littleEndian);
    } else if (dtype.endsWith('i8')) {
        bytesPer = 8;
        getter = (o) => Number(view.getBigInt64(o, littleEndian));
    } else if (dtype.endsWith('i4')) {
        bytesPer = 4;
        getter = (o) => view.getInt32(o, littleEndian);
    } else {
        throw new Error('Неподдерживаемый dtype: ' + dtype);
    }

    if (count === 0) return { shape, data: [] };

    const data = new Array(count);
    for (let i = 0; i < count; i++) data[i] = getter(i * bytesPer);

    return { shape, data };
}

// ---------------------------------------------------------------------------
// .npz structure
// ---------------------------------------------------------------------------

/**
 * Нормализация содержимого SimPEG .npz.
 * @param {Object<string,Uint8Array>} raw map имя_файла -> байты
 */
export function parseSimpegNpz(raw) {
    const get = (name) => (raw[name] ? parseNpy(raw[name]) : null);

    const frequencies = get('frequencies.npy');
    if (!frequencies) throw new Error('В .npz нет массива frequencies');

    const names = ['Zxx', 'Zxy', 'Zyx', 'Zyy'];
    const comp = {};
    for (const c of names) {
        const re = get(`${c}_real.npy`);
        const im = get(`${c}_imag.npy`);
        if (re && im) comp[c] = { re: re.data, im: im.data, shape: re.shape };
    }

    if (!comp.Zxy || !comp.Zyx) {
        throw new Error('В .npz нет обязательных компонент Zxy/Zyx');
    }

    const nFreq = frequencies.data.length;
    // Станции: либо по форме (nFreq, nStations), либо одна станция
    let nStations = 1;
    if (comp.Zxy.shape.length === 2 && comp.Zxy.shape[1] > 0) {
        nStations = comp.Zxy.shape[1];
    }

    // Отсутствующие Zxx/Zyy добиваем нулями (старые файлы)
    for (const c of names) {
        if (!comp[c]) {
            comp[c] = {
                re: new Array(nFreq * nStations).fill(0),
                im: new Array(nFreq * nStations).fill(0),
                shape: [nFreq, nStations],
            };
        }
    }

    // Типпер — опционален, ключи могут называться по-разному
    const tipper = {};
    for (const keys of [['Tx', 'TZX', 'Zx'], ['Ty', 'TZY', 'Zy']]) {
        for (const k of keys) {
            const re = get(`${k}_real.npy`);
            const im = get(`${k}_imag.npy`);
            if (re && im) {
                tipper[k === 'Tx' || k === 'TZX' || k === 'Zx' ? 'Tx' : 'Ty'] =
                    { re: re.data, im: im.data };
                break;
            }
        }
    }

    // Координаты станций
    let rxLocs = null;
    const rx = get('rx_locs.npy');
    if (rx) {
        if (rx.shape.length === 2 && rx.shape[1] >= 3) {
            rxLocs = [];
            for (let i = 0; i < rx.shape[0]; i++) {
                rxLocs.push([rx.data[3 * i], rx.data[3 * i + 1], rx.data[3 * i + 2]]);
            }
        } else if (rx.shape.length === 1 && rx.shape[0] >= 3) {
            rxLocs = [[rx.data[0], rx.data[1], rx.data[2]]];
        }
    }

    // Периоды: берём из файла, иначе считаем как 1/f
    const periodsArr = get('periods.npy');
    const periods = periodsArr
        ? periodsArr.data
        : frequencies.data.map((f) => 1 / f);

    // Модель проводимости и сетка (для объёмного просмотра) — опционально:
    // старые .npz могут не содержать sigma_model/mesh_*
    const sigma = get('sigma_model.npy');
    const hx = get('mesh_hx.npy');
    const hy = get('mesh_hy.npy');
    const hz = get('mesh_hz.npy');
    let model = null;
    if (sigma && hx && hy && hz &&
        sigma.data.length === hx.data.length * hy.data.length * hz.data.length) {
        model = {
            sigma: sigma.data,
            hx: hx.data,
            hy: hy.data,
            hz: hz.data,
        };
    }

    return {
        frequencies: frequencies.data,
        periods,
        comp,
        tipper,
        rxLocs,
        nFreq,
        nStations,
        hasTipper: Boolean(tipper.Tx && tipper.Ty),
        model,
    };
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

/** Коды станций вида "006-034" (шаг 4, старт 6) по уникальным X и Y. */
export function assignStationCodes(stations) {
    const uniqX = Array.from(new Set(stations.map((s) => Math.round(s.x)))).sort((a, b) => a - b);
    const uniqY = Array.from(new Set(stations.map((s) => Math.round(s.y)))).sort((a, b) => a - b);

    const codeFor = (val, list) => {
        const i = list.indexOf(val);
        const num = 6 + i * 4;
        return String(num).padStart(3, '0');
    };

    for (const s of stations) {
        s.code = `${codeFor(Math.round(s.x), uniqX)}-${codeFor(Math.round(s.y), uniqY)}`;
    }
    return stations;
}

/** Сборка станций с комплексными значениями компонент. */
export function buildSimpegStations(npz) {
    const { nFreq, nStations, comp, tipper, rxLocs } = npz;
    const stations = [];

    for (let s = 0; s < nStations; s++) {
        let x;
        let y;
        let z;
        if (rxLocs && rxLocs[s]) {
            [x, y, z] = rxLocs[s];
        } else {
            x = s * 1000;
            y = 0;
            z = 0;
        }

        // Данные лежат как (nFreq, nStations), то есть плоский индекс k*nStations + s
        const pick = (c, k) => {
            const idx = k * nStations + s;
            return { re: comp[c].re[idx], im: comp[c].im[idx] };
        };

        const st = {
            x, y, z, code: null,
            Zxx: [], Zxy: [], Zyx: [], Zyy: [], Tx: [], Ty: [],
        };
        for (let k = 0; k < nFreq; k++) {
            st.Zxx.push(pick('Zxx', k));
            st.Zxy.push(pick('Zxy', k));
            st.Zyx.push(pick('Zyx', k));
            st.Zyy.push(pick('Zyy', k));
        }

        if (npz.hasTipper) {
            for (let k = 0; k < nFreq; k++) {
                const idx = k * nStations + s;
                st.Tx.push({ re: tipper.Tx.re[idx], im: tipper.Tx.im[idx] });
                st.Ty.push({ re: tipper.Ty.re[idx], im: tipper.Ty.im[idx] });
            }
        } else {
            st.Tx = null;
            st.Ty = null;
        }

        stations.push(st);
    }

    return assignStationCodes(stations);
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Число в формате Python `%.6E` (JS toExponential даёт строчную 'e' и одну
 * цифру степени, а эталон требует 'E' и минимум две цифры: 1.000000E+01).
 */
export function exp6(v) {
    if (!isFinite(v)) v = 0;
    const s = v.toExponential(6);          // "1.000000e+1" / "-3.089081e+2"
    const m = s.match(/^(-?[\d.]+)e([+-])(\d+)$/);
    if (!m) return s.toUpperCase();
    const mant = m[1];
    const sign = m[2];
    const digits = m[3].padStart(2, '0');  // минимум 2 цифры
    return `${mant}E${sign}${digits}`;
}

/** Строка данных фиксированной ширины (137 символов, как в эталоне). */
export function formatProfilesRow(period, code, lat, lon, X, Y, Z, comp, real, imag, err) {
    return (
        exp6(period).padStart(12, ' ') + ' ' +
        String(code).padEnd(7, ' ') + ' ' +
        lat.toFixed(7).padStart(12, ' ') + ' ' +
        lon.toFixed(7).padStart(12, ' ') + ' ' +
        X.toFixed(3).padStart(12, ' ') + ' ' +
        Y.toFixed(3).padStart(12, ' ') + ' ' +
        Z.toFixed(3).padStart(12, ' ') + ' ' +
        comp + ' ' +
        exp6(real).padStart(15, ' ') + ' ' +
        exp6(imag).padStart(15, ' ') + ' ' +
        exp6(err).padStart(15, ' ')
    );
}

/** Масса-молекулярная константа mu0 — конвертация SI (V/A) → AP3DMT ([V/m]/[T]). */
const MU0 = 4e-7 * Math.PI; // 1.2566370614359172e-6

/**
 * Конвенция знаков SimPEG → AP3DMT (проверено по эталонному Profiles.dat):
 *   - SimPEG (Simulation3DPrimarySecondary) выдаёт Z с фазой ≈ -134° для
 *     полупространства; AP3DMT-эталон имеет фазу ≈ -45°.
 *   - Преобразование: Z_AP3DMT = -conj(Z_SimPEG) / mu0
 *       re_AP3DMT = -re_SimPEG / mu0,  im_AP3DMT = +im_SimPEG / mu0.
 *   - Типпер T = Hz/Hx безразмерен (H/H), НЕ делится на mu0;
 *     преобразование: T_AP3DMT = conj(T_SimPEG).
 */
export function simpegToAp3dmtZ(re, im) {
    return { re: -re / MU0, im: im / MU0 };
}

export function simpegToAp3dmtT(re, im) {
    return { re, im: -im };
}

/** Полный текст Profiles.dat: секция импеданса + секция типпера. */
export function buildProfilesDat(stations, periods) {
    const nFreq = periods.length;
    // Ключи станций в смешанном регистре ('Zxy'), а в файл пишется верхний ('ZXY')
    const comps = ['Zxx', 'Zxy', 'Zyx', 'Zyy'];

    // Шапка секции. Строка единиц отличается: у импеданса '[V/m]/[T]',
    // у вертикальных компонент — '[]'. Строки '[V/A]' в эталоне НЕТ.
    const sectionHeader = (section, unitsLine) =>
        '#  Synthetic 3D MT data written in Matlab\n' +
        '#  Period(s) Code GG_Lat GG_Lon X(m) Y(m) Z(m) Component Real Imag Error\n' +
        `>  ${section}\n` +
        '>  exp(-i\\omega t)         \n' +
        `>  ${unitsLine}\n`;

    const sectionTail = (nStations) =>
        '>   0.000\n' +
        '>     0.0000000    0.0000000    0.000\n' +
        `>  ${nFreq} ${nStations}\n`;

    let out = '';

    // --- секция 1: импеданс ---
    out += sectionHeader('Full_Impedance', '[V/m]/[T]');
    out += sectionTail(stations.length);

    for (let k = 0; k < nFreq; k++) {
        const period = periods[k];
        for (const st of stations) {
            // Общая ошибка на станцию-период для всех 4 компонент Z
            // (как в эталоне: 5% от |Zxy| после конвертации)
            const zxy = st.Zxy[k];
            const zxyConv = simpegToAp3dmtZ(zxy.re, zxy.im);
            const zxyMag = Math.hypot(zxyConv.re, zxyConv.im);
            const err = Math.max(zxyMag * 0.05, 1e-30);

            for (const name of comps) {
                const v = st[name][k];
                const conv = simpegToAp3dmtZ(v.re, v.im);
                out += formatProfilesRow(
                    period, st.code, 0, 0, st.x, st.y, st.z,
                    name.toUpperCase(), conv.re, conv.im, err,
                ) + '\n';
            }
        }
    }

    // --- секция 2: вертикальные компоненты (типпер) ---
    // Типпер безразмерен — БЕЗ деления на mu0; конвертация conj(T).
    if (stations.some((s) => s.Tx && s.Ty)) {
        out += sectionHeader('Full_Vertical_Components', '[]');
        out += sectionTail(stations.length);

        for (let k = 0; k < nFreq; k++) {
            const period = periods[k];
            for (const st of stations) {
                if (!st.Tx || !st.Ty) continue;
                const tx = simpegToAp3dmtT(st.Tx[k].re, st.Tx[k].im);
                const ty = simpegToAp3dmtT(st.Ty[k].re, st.Ty[k].im);
                out += formatProfilesRow(
                    period, st.code, 0, 0, st.x, st.y, st.z,
                    'TX', tx.re, tx.im, 0.03,
                ) + '\n';
                out += formatProfilesRow(
                    period, st.code, 0, 0, st.x, st.y, st.z,
                    'TY', ty.re, ty.im, 0.03,
                ) + '\n';
            }
        }
    }

    return out;
}

/** Сводка для интерфейса: кажущееся сопротивление и фаза по станции. */
export function computeSimpegQc(npz, stations, stationIndex = 0) {
    const mu0 = 4e-7 * Math.PI;
    const st = stations[stationIndex];
    const rows = [];
    for (let k = 0; k < npz.nFreq; k++) {
        const z = st.Zxy[k];
        const rho = (z.re * z.re + z.im * z.im) / (mu0 * 2 * Math.PI * npz.frequencies[k]);
        rows.push({
            period: npz.periods[k],
            rho,
            phase: Math.atan2(z.im, z.re) * 180 / Math.PI,
        });
    }
    return rows;
}

/** Высокоуровневая функция: сырые .npy байты -> текст Profiles.dat. */
export function convertSimpegToProfiles(raw) {
    const npz = parseSimpegNpz(raw);
    const stations = buildSimpegStations(npz);
    const profiles = buildProfilesDat(stations, npz.periods);
    const qc = computeSimpegQc(npz, stations);
    return { npz, stations, profiles, qc };
}

// ---------------------------------------------------------------------------
// Объёмная модель для ResultViewer (тот же стиль, что у готовых решений)
// ---------------------------------------------------------------------------

/**
 * Модель проводимости SimPEG в формате ResultViewer:
 *   { nX, nY, nZ, xCells, yCells, zCells, rhoValues }
 * zCells идут сверху вниз (k=0 — поверхность), как ждёт ResultViewer;
 * дискретизация discretize хранит ячейки снизу вверх, поэтому z-ось
 * и z-срезы sigma разворачиваются. rho = 1/sigma; ячейки воздуха
 * (rho > 1e6) помечаются NaN и не рисуются — цветовая шкала охватывает
 * только подповерхностную модель.
 */
export function buildSimpegModelData(npz) {
    if (!npz.model) return null;
    const { sigma, hx, hy, hz } = npz.model;
    const nX = hx.length;
    const nY = hy.length;
    const nZ = hz.length;

    // top -> bottom для зрителя (k=0 — поверхность)
    const zCells = [];
    for (let k = nZ - 1; k >= 0; k--) zCells.push(hz[k]);

    // sigma в .npz хранится в порядке Fortran (x быстрее всего):
    // idx = i + j*nX + k*nX*nY, k=0 — НИЖНИЙ слой; зрителю нужен idx
    // k*nX*nY + j*nX + i с k сверху вниз, т.е. k_viewer -> k = nZ-1-k_viewer
    const AIR_RHO_CUT = 1e6;
    let rhoValues = new Array(nX * nY * nZ);
    for (let kv = 0; kv < nZ; kv++) {
        const k = nZ - 1 - kv;
        for (let j = 0; j < nY; j++) {
            for (let i = 0; i < nX; i++) {
                const s = sigma[i + j * nX + k * nX * nY];
                const rho = s > 0 ? 1 / s : NaN;
                rhoValues[kv * nX * nY + j * nX + i] =
                    (isFinite(rho) && rho < AIR_RHO_CUT) ? rho : NaN;
            }
        }
    }

    // Отрезаем верхние слои, состоящие целиком из воздуха: воздух в объёме
    // не рисуется, а его ячейки лишь раздувают границы кадра. Оставляем
    // первый слой, где есть хоть одна неподземная ячейка (поверхность).
    let firstSolid = 0;
    outer:
    for (let kv = 0; kv < nZ; kv++) {
        for (let idx = kv * nX * nY; idx < (kv + 1) * nX * nY; idx++) {
            if (isFinite(rhoValues[idx])) { firstSolid = kv; break outer; }
        }
    }
    let viewZ = zCells.slice(firstSolid);
    let viewRho = rhoValues.slice(firstSolid * nX * nY);

    return { nX, nY, nZ: nZ - firstSolid, xCells: [...hx], yCells: [...hy], zCells: viewZ, rhoValues: viewRho };
}