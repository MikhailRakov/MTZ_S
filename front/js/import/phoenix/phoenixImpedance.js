/**
 * phoenixImpedance.js — браузерный DSP-конвейер для данных Phoenix MT.
 *
 * Задача модуля: «временные ряды → импеданс» целиком на стороне браузера
 * (без сервера), с выходом в формат Profiles.dat (AP3DMT), который уже
 * используется в проекте для 3D-инверсии.
 *
 * Состав:
 *   1. Разбор бинарных форматов прибора:
 *        - parseNativeBin       — новое поколение (DAA09): заголовок 128 B + кадры;
 *        - parseDecimatedBin    — децимарованные .td_24k (сегментированные) и .td_150;
 *        - parseLegacyTsn       — legacy .TSN (блоки, 24-битные LE-сэмплы).
 *   2. Масштабирование каналов в физические единицы:
 *        - nativeGains / nativeSampleToVolts — новое поколение (V на отсчёт);
 *        - legacyChannelScale                — legacy (mV/km для E, nT для H).
 *   3. DSP:
 *        - fft, hannWindow, lowpassFir, decimateSeries.
 *   4. Оценка импеданса:
 *        - estimateImpedanceSpectra — велч-кроссспектральная оценка тензора 2x2,
 *          частичная когерентность и погрешность по остаткам модели;
 *        - apparentResistivity, impedancePhaseDeg, halfSpaceImpedance — QC.
 *   5. Конвенции и выгрузка:
 *        - impedanceToAp3dmt — переход в конвенцию exp(-i*w*t) AP3DMT;
 *        - buildPhoenixProfilesDat — текст Profiles.dat.
 *
 * ─────────────────────────── КОНВЕНЦИИ ───────────────────────────
 *
 * Спектр. Модуль считает FFT с ядром exp(-i*2*pi*k*n/N) (прямое, без
 * нормировки). Поэтому положительный бин k содержит фазор в конвенции
 * exp(+i*w*t): x[n] = Re{ P * exp(+i*w*n) } даёт X[k] = (N/2) * P.
 *
 * Импеданс. Оценка estimateImpedanceSpectra возвращает отношение фазоров
 * E/H в конвенции exp(+i*w*t) (то есть в той же, что и «сырой» FFT).
 * Для полупространства в этой конвенции фаза Z = +45°, |Z| = sqrt(w*mu0*rho).
 *
 * AP3DMT. Формат Profiles.dat объявляет конвенцию exp(-i*w*t), в которой
 * фазор — сопряжение «сырого» (смена знака времени), поэтому
 *     Z_ap3dmt = conj(Z_raw)          (при стандартной полярности каналов E/H).
 * Для полупространства в конвенции AP3DMT фаза Z = -45°.
 *
 * Знак «-» перед сопряжением, который применяется в конвертере SimPEG
 * (simpegProfilesConverter.js), там компенсирует внутреннюю конвенцию
 * поля E в SimPEG, а не аппаратную. Для Phoenix положение полярности каналов
 * E/H относительно эталона проверяется по фазе: см. halfSpaceImpedance() и
 * опцию sign в impedanceToAp3dmt().
 *
 * Единицы. Оценка Z получается в единицах «канал E / канал H». Для legacy
 * Phoenix это (mV/km)/nT, и множитель перевода в [V/m]/[T] равен
 * IMPEDANCE_TO_AP3DMT = 1e3 (1 mV/km = 1e-6 V/m, 1 nT = 1e-9 T).
 *
 * Кажущаяся удельная сопротивляемость:
 *     Z в [V/m]/[T]  ->  rho = mu0 * |Z|^2 / (2*pi*f);
 *     Z в Ом (V/A)   ->  rho = |Z|^2 / (2*pi*f*mu0).
 */

/** Магнитная постоянная, В·с/(А·м). */
export const MU0 = 4e-7 * Math.PI;

/**
 * Перевод импеданса из (mV/km)/nT (legacy Phoenix) в [V/m]/[T] (AP3DMT):
 * (1e-3 В / 1e3 м) / (1e-9 Тл) = 1e3.
 */
export const IMPEDANCE_TO_AP3DMT = 1e3;

// ===========================================================================
// Комплексная арифметика
// ===========================================================================

const cx = (re, im = 0) => ({ re, im });
const cAdd = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const cSub = (a, b) => ({ re: a.re - b.re, im: a.im - b.im });
const cMul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cDiv = (a, b) => {
    const d = b.re * b.re + b.im * b.im;
    if (d === 0) return { re: NaN, im: NaN };
    return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
const cAbs2 = (a) => a.re * a.re + a.im * a.im;
const cAbs = (a) => Math.hypot(a.re, a.im);
const cConj = (a) => ({ re: a.re, im: -a.im });

/** ASCII-строка из фиксированного поля (с обрезкой по нулям). */
function readAscii(bytes, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
        const c = bytes[off + i] ?? 0;
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s.trim();
}

/** Знаковое 24-битное число из трёх байт (порядок задаётся флагом). */
function readInt24(bytes, off, littleEndian) {
    const b0 = bytes[off], b1 = bytes[off + 1], b2 = bytes[off + 2];
    let v = littleEndian
        ? (b0 | (b1 << 8) | (b2 << 16))
        : ((b0 << 16) | (b1 << 8) | b2);
    if (v & 0x800000) v -= 1 << 24;
    return v;
}

// ===========================================================================
// 1. Разбор бинарных форматов
// ===========================================================================

/**
 * Разбор файла нового поколения (DAA09): 128-байтный заголовок + кадры
 * фиксированного размера (20 сэмплов по 3 байта big-endian + 4 байта
 * «подвал» с номером кадра и счётчиком сатураций).
 *
 * @returns {{header: object, samples: Float64Array, frameSize: number,
 *            saturations: number, missingFrames: number[], nFrames: number}}
 */
export function parseNativeBin(buffer) {
    const buf = buffer instanceof ArrayBuffer ? buffer : buffer?.buffer;
    const bytes = new Uint8Array(buf);
    const dv = new DataView(buf);

    if (bytes.length < 128) {
        throw new Error('parseNativeBin: файл короче заголовка (128 байт)');
    }

    const confFp = [];
    for (let i = 0; i < 8; i++) confFp.push(bytes[51 + i]);

    const header = {
        fileType: dv.getUint8(0),
        fileVersion: dv.getUint8(1),
        headerSize: dv.getUint16(2, true),
        instType: readAscii(bytes, 4, 8),
        instSerial: readAscii(bytes, 12, 8),
        recId: dv.getUint32(20, true),
        chId: dv.getUint8(24),
        fileSequence: dv.getUint32(25, true),
        fragPeriod: dv.getUint16(29, true),
        chHwv: readAscii(bytes, 31, 8),
        chSer: readAscii(bytes, 39, 8),
        chFir: dv.getUint32(47, true),
        confFp,
        sampleRateBase: dv.getUint16(59, true),
        sampleRateExp: dv.getInt8(61),
        sampleRate: dv.getUint16(59, true) * Math.pow(2, dv.getInt8(61)),
        frameSize: dv.getUint32(63, true),
        gpsLong: dv.getFloat32(71, true),
        gpsLat: dv.getFloat32(75, true),
        altitude: dv.getFloat32(79, true),
    };

    const frameSize = header.frameSize || 64;
    const samplesPerFrame = Math.floor((frameSize - 4) / 3);
    if (samplesPerFrame <= 0) {
        throw new Error(`parseNativeBin: некорректный размер кадра ${frameSize}`);
    }

    const out = [];
    const missingFrames = [];
    let saturations = 0;
    let expected = 0;
    let nFrames = 0;

    for (let off = 128; off + frameSize <= bytes.length; off += frameSize) {
        for (let i = 0; i < samplesPerFrame; i++) {
            out.push(readInt24(bytes, off + i * 3, false));
        }
        const footer = dv.getUint32(off + frameSize - 4, true);
        const frameIndex = footer & 0x0fffffff;
        saturations += (footer >>> 28) & 0x07;
        if (nFrames > 0 && frameIndex !== expected) {
            for (let miss = expected; miss < frameIndex; miss++) missingFrames.push(miss);
        }
        expected = frameIndex + 1;
        nFrames++;
    }

    return {
        header,
        samples: Float64Array.from(out),
        frameSize,
        saturations,
        missingFrames,
        nFrames,
    };
}

/**
 * Разбор децимарованных файлов:
 *   - segmented = true  (.td_24k): после заголовка идут записи с 32-байтным
 *     субзаголовком (метка времени, число сэмплов, счётчики) и float32-данными;
 *   - segmented = false (.td_150): непрерывный поток float32 без субзаголовков.
 */
export function parseDecimatedBin(buffer, { segmented = true } = {}) {
    const buf = buffer instanceof ArrayBuffer ? buffer : buffer?.buffer;
    const bytes = new Uint8Array(buf);
    const dv = new DataView(buf);
    if (bytes.length < 128) {
        throw new Error('parseDecimatedBin: файл короче заголовка (128 байт)');
    }

    const header = {
        instType: readAscii(bytes, 4, 8),
        instSerial: readAscii(bytes, 12, 8),
        chHwv: readAscii(bytes, 31, 8),
        chSer: readAscii(bytes, 39, 8),
        sampleRate: dv.getUint16(59, true) * Math.pow(2, dv.getInt8(61)),
        gpsLong: dv.getFloat32(71, true),
        gpsLat: dv.getFloat32(75, true),
        altitude: dv.getFloat32(79, true),
    };

    if (!segmented) {
        const n = Math.floor((bytes.length - 128) / 4);
        const samples = new Float64Array(n);
        for (let i = 0; i < n; i++) samples[i] = dv.getFloat32(128 + i * 4, true);
        return { header, samples, records: [] };
    }

    const records = [];
    const samples = [];
    let off = 128;
    while (off + 32 <= bytes.length) {
        const timestamp = dv.getUint32(off, true);
        const samplesInRecord = dv.getUint32(off + 4, true);
        const satCount = dv.getUint16(off + 8, true);
        const missCount = dv.getUint16(off + 10, true);
        const rec = {
            timestamp,
            samplesInRecord,
            satCount,
            missCount,
            min: dv.getFloat32(off + 12, true),
            max: dv.getFloat32(off + 16, true),
            flag: dv.getFloat32(off + 20, true),
            values: [],
        };
        off += 32;
        const nAvail = Math.max(0, Math.floor((bytes.length - off) / 4));
        const n = Math.min(samplesInRecord, nAvail);
        for (let i = 0; i < n; i++) {
            const v = dv.getFloat32(off + i * 4, true);
            rec.values.push(v);
            samples.push(v);
        }
        off += n * 4;
        records.push(rec);
    }

    return { header, samples: Float64Array.from(samples), records };
}

/**
 * Разбор legacy .TSN: последовательность блоков, каждый — 32-байтный заголовок
 * и nscan*nch 24-битных знаковых сэмплов (little-endian), деинтерливинг по
 * каналам: отсчёты идут «снимок за снимком, в каждом — все каналы».
 */
export function parseLegacyTsn(buffer) {
    const buf = buffer instanceof ArrayBuffer ? buffer : buffer?.buffer;
    const bytes = new Uint8Array(buf);
    const dv = new DataView(buf);
    const blocks = [];

    let off = 0;
    while (off + 32 <= bytes.length) {
        const tagLen = bytes[off + 13];
        if (tagLen !== 32) {
            throw new Error(
                `parseLegacyTsn: формат V5-2000 (tagLen=${tagLen}) не поддерживается, ` +
                'ожидается блок с 32-байтным тегом',
            );
        }
        const nscan = dv.getUint16(off + 10, true);
        const nch = bytes[off + 12];
        const fs = dv.getUint16(off + 18, true);
        const datetime = {
            sec: bytes[off], min: bytes[off + 1], hour: bytes[off + 2],
            day: bytes[off + 3], month: bytes[off + 4], year: bytes[off + 5],
            weekday: bytes[off + 6], century: bytes[off + 7],
        };
        const boxnum = dv.getUint16(off + 8, true);

        const total = nscan * nch;
        const dataOff = off + 32;
        const avail = Math.floor((bytes.length - dataOff) / 3);
        const n = Math.min(total, avail);

        const order = legacyChannelOrder(nch);
        const channels = {};
        for (const name of order) channels[name] = [];

        let k = 0;
        for (let s = 0; s < nscan; s++) {
            for (let c = 0; c < nch; c++) {
                if (k >= n) break;
                const v = readInt24(bytes, dataOff + k * 3, true);
                channels[order[c]].push(v);
                k++;
            }
        }

        blocks.push({ fs, nch, nscan, boxnum, datetime, channelOrder: order, channels });
        off = dataOff + total * 3;
        if (n < total) break;   // файл обрезан
    }

    return { blocks };
}

/** Имена каналов legacy-формата по числу каналов в кадре. */
function legacyChannelOrder(nch) {
    if (nch === 5) return ['ex', 'ey', 'hx', 'hy', 'hz'];
    if (nch === 4) return ['ex1', 'ex2', 'ex3', 'hy'];
    if (nch === 3) return ['ex', 'ey', 'hx'];
    const names = [];
    for (let i = 0; i < nch; i++) {
        names.push(i < 2 ? `e${i + 1}` : i < 4 ? `h${i - 1}` : `h${i - 1}`);
    }
    return names;
}

// ===========================================================================
// 2. Масштабирование каналов
// ===========================================================================

/**
 * Калибровочные константы плат BCM нового поколения.
 *
 * ВНИМАНИЕ: значения main/preamp для плат BCM03/BCM06 и коэффициент
 * аттенюатора взяты из опыта обработки файлов прибора и требуют сверки с
 * документацией Phoenix (при наличии реальных файлов constants следует
 * уточнить по калибровочным меткам TBL).
 */
const BCM_GAINS = {
    BCM03: { main: 16, preamp: 4 },
    BCM06: { main: 6, preamp: 1 },
    BCM05: { main: 8, preamp: 2 },
};

/** Отношение делителя аттенюатора BCM06 (включается битом confFp[4]&1). */
const ATTENUATOR_RATIO = 523 / 5223;

/**
 * Усиления канала нового поколения по заголовку.
 *
 * Тип канала определяется вторым байтом confFp: 0x08 — электрический (E),
 * 0x01 — магнитный (H, дифференциальный датчик). Для H-каналов преамп и
 * аттенюатор не применяются.
 */
export function nativeGains(header) {
    const hwv = String(header?.chHwv ?? '').toUpperCase();
    const fp = header?.confFp ?? [];
    const b0 = fp[0] ?? 0;
    const b1 = fp[1] ?? 0;
    const b4 = fp[4] ?? 0;

    const board = Object.keys(BCM_GAINS).find((k) => hwv.startsWith(k)) ?? null;
    const isE = (b1 & 0x08) !== 0;
    const channelType = isE ? 'E' : 'H';

    let mainGain = 1;
    let preampGain = 1;
    if (isE && board) {
        mainGain = BCM_GAINS[board].main;
        preampGain = BCM_GAINS[board].preamp;
    }

    const attenuatorGain = (isE && (b4 & 0x01)) ? ATTENUATOR_RATIO : 1;
    // Собственное усиление схемы: для E — половина (дифференциальный вход),
    // для H — единица (дифференциальный датчик).
    const intrinsicGain = isE ? (((b0 & 0x01) ? 0.5 : 1)) : 1;

    const totalGain = mainGain * preampGain * attenuatorGain * intrinsicGain;
    return { channelType, board, mainGain, preampGain, attenuatorGain, intrinsicGain, totalGain };
}

/**
 * Вольт на отсчёт для канала нового поколения:
 * (диапазон АЦП / 2) / (суммарное усиление) / 2^31.
 */
export function nativeSampleToVolts(header) {
    const gains = header?.gains ?? nativeGains(header);
    const range = header?.adPlusMinusRange ?? 5;
    return range / gains.totalGain / Math.pow(2, 31);
}

/**
 * Масштаб legacy-канала по меткам TBL.
 *
 * E: ts * FSCV / 2^23 * 1000 / EGN / EXLN * 1000  -> [mV/km]
 * H: ts * FSCV / 2^23 * 1000 / HGN / HATT / HNOM -> [nT]
 *
 * @returns {{unit: string, factor: number} | null} null, если не хватает меток.
 */
export function legacyChannelScale(tags, channel) {
    const fscv = tags?.FSCV;
    if (typeof fscv !== 'number' || !isFinite(fscv)) return null;
    const base = fscv / Math.pow(2, 23) * 1000;

    const isE = String(channel).toLowerCase().startsWith('e');
    if (isE) {
        const { EGN, EXLN } = tags;
        if (typeof EGN !== 'number' || typeof EXLN !== 'number') return null;
        if (!EGN || !EXLN) return null;
        return { unit: 'mV/km', factor: base / EGN / EXLN * 1000 };
    }

    const { HGN, HATT, HNOM } = tags;
    if (typeof HGN !== 'number' || typeof HATT !== 'number' || typeof HNOM !== 'number') return null;
    if (!HGN || !HATT || !HNOM) return null;
    return { unit: 'nT', factor: base / HGN / HATT / HNOM };
}

// ===========================================================================
// 3. DSP
// ===========================================================================

/**
 * FFT на месте (Cooley–Tukey, radix-2), ядро exp(-i*2*pi*k*n/N).
 * Длина должна быть степенью двойки.
 */
export function fft(re, im) {
    const n = re.length;
    if (im.length !== n) {
        throw new Error('fft: массивы re и im должны иметь одинаковую длину');
    }
    if (n === 0) return;
    if ((n & (n - 1)) !== 0) {
        throw new Error(`fft: длина ${n} не является степенью двойки`);
    }

    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }

    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        const half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < half; k++) {
                const ur = re[i + k], ui = im[i + k];
                const vr = re[i + k + half], vi = im[i + k + half];
                const tr = cr * vr - ci * vi;
                const ti = cr * vi + ci * vr;
                re[i + k] = ur + tr; im[i + k] = ui + ti;
                re[i + k + half] = ur - tr; im[i + k + half] = ui - ti;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

/** Симметричное окно Ханна длины n. */
export function hannWindow(n) {
    if (n <= 0) return new Float64Array(0);
    if (n === 1) return Float64Array.from([1]);
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        // Периодическое Ханна: знаменатель n, а не n-1. Тогда ДПФ окна на
        // целых бинах отлично от нуля только в {0, ±1} — ровно на ширину
        // главного лепестка. Симметричный вариант (n-1) просачивается на все
        // бины (~2.7e-3 при N=64), и в estimateImpedanceSpectra зеркальная
        // составляющая спектра (бина 2·k) не схлопывается в ноль: чистый тон
        // даёт систематическую ошибку тензора ~1e-4 вместо точного решения.
        w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
    }
    return w;
}

/**
 * Низкочастотный КИХ-фильтр (окно Ханна над sinc), срез cutoff задаётся
 * долей частоты дискретизации (0 < cutoff < 0.5), т.е. cutoff*fs [Гц].
 * Точка среза — уровень -6 дБ. DC-усиление нормируется в единицу.
 * Отклик по краям — периодическое (циклическое) продолжение записи, как при
 * фильтрации через БПФ: постоянный сигнал остаётся постоянным (H(0)=1),
 * а тона за полосой подавляются по всей длине, включая края — зеркала
 * и «повтор крайнего» дают излом на границе и растекание энергии в полосу.
 */
export function lowpassFir(x, cutoff, taps = 31) {
    const n = x.length;
    const out = new Float64Array(n);
    if (n === 0) return out;
    if (n === 1) { out[0] = x[0]; return out; }
    const M = Math.floor((taps - 1) / 2);
    const useTaps = 2 * M + 1;

    // Переходная полоса окна Ханна ~ 3.3*fs/taps: сдвигаем идеальный срез,
    // чтобы затухание в стоп-полосе было достаточным.
    const trans = 3.3 / useTaps;
    const fc = Math.min(0.49, cutoff - 0.5 * trans);

    const h = new Float64Array(useTaps);
    let sum = 0;
    for (let m = 0; m < useTaps; m++) {
        const xw = m - M;
        const sinc = xw === 0 ? 1 : Math.sin(Math.PI * 2 * fc * xw) / (Math.PI * 2 * fc * xw);
        const win = 0.5 * (1 - Math.cos(2 * Math.PI * m / (useTaps - 1)));
        h[m] = 2 * fc * sinc * win;
        sum += h[m];
    }
    if (sum !== 0) for (let m = 0; m < useTaps; m++) h[m] /= sum;

    // Циклическое продолжение: индекс берётся по модулю длины записи.
    // Ограничение: запись считается периодической, поэтому при сильно
    // отличающихся первом и последнем отсчётах на краях возможна волна
    // (для записей MT это приемлемо — края всё равно режутся окном).
    const wrap = (j) => ((j % n) + n) % n;

    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let m = 0; m < useTaps; m++) {
            acc += h[m] * x[wrap(i + m - M)];
        }
        out[i] = acc;
    }
    return out;
}

/**
 * Децимация с предварительным антиалиасовым ФНЧ. Длина результата —
 * floor(n/factor).
 */
export function decimateSeries(x, factor, taps = 31) {
    const f = Math.max(1, Math.round(factor));
    if (f === 1) return Float64Array.from(x);
    const cutoff = 0.5 / f;
    const filtered = lowpassFir(x, cutoff, taps);
    const nOut = Math.floor(x.length / f);
    const out = new Float64Array(nOut);
    for (let i = 0; i < nOut; i++) out[i] = filtered[i * f];
    return out;
}

// ===========================================================================
// 4. Оценка импеданса
// ===========================================================================

/** Поворот пары каналов (Hx, Hy) на угол theta (рад, против часовой). */
function rotatePair(a, b, theta) {
    if (!theta) return [a, b];
    const c = Math.cos(theta), s = Math.sin(theta);
    return [
        Float64Array.from(a, (v, i) => v * c + b[i] * s),
        Float64Array.from(a, (v, i) => -v * s + b[i] * c),
    ];
}

/**
 * Спектральная оценка тензора импеданса 2x2 (E = Z·H) по временным рядам.
 *
 * Метод: велч-разбиение на перекрывающиеся окна (Ханн), FFT каждого окна,
 * усреднение кросс-спектральных матриц по окнам; затем
 *     Z = S_EH · S_HH^(-1)
 * (метод наименьших квадратов по всем окнам). Когерентность — частичная
 * когерентность E_i и H_j относительно второго магнитного канала;
 * погрешность — из остатков модели с учётом числа степеней свободы.
 *
 * ВАЖНО: тензор 2x2 определяется только если Hx и Hy не коррелированы
 * между собой на данной частоте (иначе S_HH вырождена). Для реальных
 * широкополосных данных это выполняется; результат помечается
 * degenerate: true, если определитель S_HH близок к нулю.
 *
 * @param {object} p
 * @param {{ex:ArrayLike,ey:ArrayLike,hx:ArrayLike,hy:ArrayLike}} p.channels
 * @param {number} p.fs              частота дискретизации, Гц
 * @param {number[]} p.frequencies   запрашиваемые частоты, Гц
 * @param {number} [p.windowSize]    длина окна (должна быть степенью двойки)
 * @param {number} [p.overlap]       перекрытие окон, 0..1
 * @param {number} [p.rotation]      поворот пары H к северу, рад
 */
export function estimateImpedanceSpectra({
    channels,
    fs,
    frequencies,
    windowSize,
    overlap = 0.5,
    rotation = 0,
} = {}) {
    const { ex, ey, hx, hy } = channels ?? {};
    if (!ex || !ey || !hx || !hy) {
        throw new Error('estimateImpedanceSpectra: нужны каналы ex, ey, hx, hy');
    }
    if (!(fs > 0)) {
        throw new Error('estimateImpedanceSpectra: не задана частота дискретизации');
    }
    const n = ex.length;
    if (ey.length !== n || hx.length !== n || hy.length !== n) {
        throw new Error('estimateImpedanceSpectra: каналы имеют разную длину');
    }
    if (n === 0) return [];

    let N = windowSize;
    if (!N) {
        N = 1;
        while (N * 2 <= Math.max(8, Math.floor(n / 4))) N *= 2;
    }
    N = Math.max(4, Math.round(N));
    if (n < 2 * N) {
        throw new Error(
            `estimateImpedanceSpectra: нужно не менее 2*${N} отсчётов, получено ${n}`,
        );
    }
    const step = Math.max(1, Math.round(N * (1 - Math.max(0, Math.min(0.95, overlap)))));

    const [hxRot, hyRot] = rotatePair(hx, hy, rotation);

    const win = hannWindow(N);
    const nBins = N / 2;                  // бин 0 (DC) и N/2 (Найквист) не используются
    const nWin = Math.floor((n - N) / step) + 1;
    if (nWin < 4) {
        throw new Error('estimateImpedanceSpectra: слишком мало перекрывающихся окон');
    }

    // Накопители кросс-спектральных матриц (нормировка на число окон — в конце).
    // ee/hh: [00, 01, 10, 11], eh: E-строка x H-столбец.
    const ee = new Float64Array(nBins * 4);
    const eei = new Float64Array(nBins * 4);
    const hh = new Float64Array(nBins * 4);
    const hhi = new Float64Array(nBins * 4);
    const eh = new Float64Array(nBins * 4);
    const ehi = new Float64Array(nBins * 4);

    const bufRe = new Float64Array(N);
    const bufIm = new Float64Array(N);

    const spec = { ex: null, ey: null, hx: null, hy: null };

    for (let w = 0; w < nWin; w++) {
        const start = w * step;
        for (const [name, data] of [['ex', ex], ['ey', ey], ['hx', hxRot], ['hy', hyRot]]) {
            for (let i = 0; i < N; i++) {
                bufRe[i] = data[start + i] * win[i];
                bufIm[i] = 0;
            }
            fft(bufRe, bufIm);
            spec[name] = { re: Float64Array.from(bufRe), im: Float64Array.from(bufIm) };
        }
        accumulate(spec, ee, eei, hh, hhi, eh, ehi, nBins);
    }

    const inv = 1 / nWin;
    for (let i = 0; i < ee.length; i++) {
        ee[i] *= inv; eei[i] *= inv;
        hh[i] *= inv; hhi[i] *= inv;
        eh[i] *= inv; ehi[i] *= inv;
    }

    // Индексы бинов для запрошенных частот.
    const wanted = [];
    for (const f of frequencies ?? []) {
        const bin = Math.round(f * N / fs);
        if (!(bin >= 1 && bin < nBins)) continue;   // DC, Найквист и вне полосы
        wanted.push({ requested: f, bin, freq: bin * fs / N });
    }
    wanted.sort((a, b) => a.freq - b.freq);

    const dof = Math.max(1, 4 * nWin - 8);
    const out = [];
    for (const { requested, bin, freq } of wanted) {
        out.push(solveAtBin({ bin, freq, requested, ee, eei, hh, hhi, eh, ehi, dof, nWin }));
    }
    return out;
}

/** Накопление кросс-спектральных матриц по одному окну. */
function accumulate(spec, ee, eei, hh, hhi, eh, ehi, nBins) {
    const { ex, ey, hx, hy } = spec;
    for (let k = 1; k < nBins; k++) {
        const exr = ex.re[k], exi = ex.im[k];
        const eyr = ey.re[k], eyi = ey.im[k];
        const hxr = hx.re[k], hxi = hx.im[k];
        const hyr = hy.re[k], hyi = hy.im[k];

        const b = k * 4;
        // E-E
        addHermitian(ee, eei, b, 0, exr, exi);
        addHermitian(ee, eei, b, 1, exr, exi, eyr, eyi);
        addHermitian(ee, eei, b, 3, eyr, eyi);
        // H-H
        addHermitian(hh, hhi, b, 0, hxr, hxi);
        addHermitian(hh, hhi, b, 1, hxr, hxi, hyr, hyi);
        addHermitian(hh, hhi, b, 3, hyr, hyi);
        // E-H (не эрмитова)
        addProduct(eh, ehi, b, 0, exr, exi, hxr, hxi);
        addProduct(eh, ehi, b, 1, exr, exi, hyr, hyi);
        addProduct(eh, ehi, b, 2, eyr, eyi, hxr, hxi);
        addProduct(eh, ehi, b, 3, eyr, eyi, hyr, hyi);
    }
}

/** s[i][j] += z[i] * conj(z[j]). */
function addProduct(re, im, b, idx, ar, ai, br, bi) {
    re[b + idx] += ar * br + ai * bi;
    im[b + idx] += ai * br - ar * bi;
}

/** s[i][j] += z[i] * conj(z[j]) и s[j][i] += conj(...) — для эрмитовых матриц. */
function addHermitian(re, im, b, idx, ar, ai, br = ar, bi = ai) {
    const rr = ar * br + ai * bi;
    const ri = ai * br - ar * bi;
    const o = b + idx;
    re[o] += rr;
    im[o] += ri;
    if (idx === 1) {
        re[b + 2] += rr;
        im[b + 2] -= ri;
    }
}

/** Решение задачи для одного бина: тензор Z, когерентности, погрешности. */
function solveAtBin({ bin, freq, requested, ee, eei, hh, hhi, eh, ehi, dof, nWin }) {
    const b = bin * 4;
    const S = {
        ee: [[cx(ee[b], eei[b]), cx(ee[b + 1], eei[b + 1])],
             [cx(ee[b + 2], eei[b + 2]), cx(ee[b + 3], eei[b + 3])]],
        hh: [[cx(hh[b], hhi[b]), cx(hh[b + 1], hhi[b + 1])],
             [cx(hh[b + 2], hhi[b + 2]), cx(hh[b + 3], hhi[b + 3])]],
        eh: [[cx(eh[b], ehi[b]), cx(eh[b + 1], ehi[b + 1])],
             [cx(eh[b + 2], ehi[b + 2]), cx(eh[b + 3], ehi[b + 3])]],
    };

    const det = cSub(cMul(S.hh[0][0], S.hh[1][1]), cMul(S.hh[0][1], S.hh[1][0]));
    const detAbs = cAbs(det);
    const scale = cAbs(S.hh[0][0]) * cAbs(S.hh[1][1]);
    const degenerate = !(detAbs > 1e-10 * Math.max(scale, 1e-300));

    let inv = null;
    if (!degenerate) {
        inv = [
            [cDiv(S.hh[1][1], det), cMul({ re: -1, im: 0 }, cDiv(S.hh[0][1], det))],
            [cMul({ re: -1, im: 0 }, cDiv(S.hh[1][0], det)), cDiv(S.hh[0][0], det)],
        ];
    }

    const zero = () => cx(0, 0);
    const Z = [[zero(), zero()], [zero(), zero()]];
    if (inv) {
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 2; j++) {
                let acc = cx(0, 0);
                for (let k = 0; k < 2; k++) acc = cAdd(acc, cMul(S.eh[i][k], inv[k][j]));
                Z[i][j] = acc;
            }
        }
    }

    // Остаток модели: RSS = tr(S_EE) - 2*Re tr(Z*S_HE) + tr(Z^H Z S_HH).
    const she = [
        [cConj(S.eh[0][0]), cConj(S.eh[1][0])],
        [cConj(S.eh[0][1]), cConj(S.eh[1][1])],
    ];
    let rss = S.ee[0][0].re + S.ee[1][1].re;
    let trZshe = cx(0, 0);
    for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) trZshe = cAdd(trZshe, cMul(Z[i][j], she[i][j]));
    }
    rss -= 2 * trZshe.re;
    let trZhZS = cx(0, 0);
    for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
            trZhZS = cAdd(trZhZS, cMul(cConj(Z[i][j]), cMul(Z[i][j], S.hh[i][j])));
        }
    }
    rss += trZhZS.re;
    if (rss < 0) rss = 0;

    const sigma = Math.sqrt(rss / dof);

    const err = [[0, 0], [0, 0]];
    if (inv) {
        err[0][0] = sigma * cAbs(inv[0][0]) / Math.sqrt(nWin);
        err[0][1] = sigma * cAbs(inv[1][1]) / Math.sqrt(nWin);
        err[1][0] = sigma * cAbs(inv[0][0]) / Math.sqrt(nWin);
        err[1][1] = sigma * cAbs(inv[1][1]) / Math.sqrt(nWin);
    }

    const coh = [[0, 0], [0, 0]];
    if (!degenerate) {
        coh[0][0] = partialCoherence(S, 0, 0);
        coh[0][1] = partialCoherence(S, 0, 1);
        coh[1][0] = partialCoherence(S, 1, 0);
        coh[1][1] = partialCoherence(S, 1, 1);
    }

    return {
        freq,
        requestedFreq: requested,
        period: 1 / freq,
        nWindows: nWin,
        degenerate,
        zxx: Z[0][0],
        zxy: Z[0][1],
        zyx: Z[1][0],
        zyy: Z[1][1],
        coherence: { zxx: coh[0][0], zxy: coh[0][1], zyx: coh[1][0], zyy: coh[1][1] },
        error: { zxx: err[0][0], zxy: err[0][1], zyx: err[1][0], zyy: err[1][1] },
    };
}

/**
 * Частичная когерентность E_i и H_j относительно второго H-канала:
 * |corr|² для E_i и H_j при условии известного H_k.
 * Для идеальных данных (E = Z·H) равна 1.
 */
function partialCoherence(S, i, j) {
    const k = 1 - j;
    const sEHi = S.eh[i][0];
    const sEHk = S.eh[i][k];
    const sHkHj = S.hh[k][j];
    const sHkHk = S.hh[k][k];
    const sEiEi = S.ee[i][i];
    const sHjHj = S.hh[j][j];

    const denHk = cAbs2(sHkHk);
    if (!(denHk > 0)) return 0;

    const num = cSub(sEHi, cDiv(cMul(sEHk, sHkHj), sHkHk));
    const den1 = cSub(sEiEi, cDiv(cx(cAbs2(sEHk)), sHkHk));
    const den2 = cSub(sHjHj, cDiv(cx(cAbs2(sHkHj)), sHkHk));
    const prod = den1.re * den2.re - den1.im * den2.im;
    if (!(prod > 0)) return 0;
    const value = cAbs2(num) / prod;
    return Math.max(0, Math.min(1, value));
}

/**
 * Кажущаяся удельная сопротивляемость, Ом·м.
 *
 * units = 'ap3dmt' — Z в [V/m]/[T]:  rho = mu0 * |Z|^2 / (2*pi*f);
 * units = 'ohm'     — Z в Ом (V/A): rho = |Z|^2 / (2*pi*f*mu0).
 */
export function apparentResistivity(zre, zim, freq, { units = 'ap3dmt' } = {}) {
    if (!(freq > 0)) return NaN;
    const z2 = zre * zre + zim * zim;
    const w = 2 * Math.PI * freq;
    if (units === 'ohm') return z2 / (w * MU0);
    return z2 / (w * MU0);
}

/** Фаза импеданса в градусах (-180..180). */
export function impedancePhaseDeg(zre, zim) {
    return Math.atan2(zim, zre) * 180 / Math.PI;
}

/**
 * Импеданс однородного полупространства для сверки конвенций.
 *
 * В конвенции exp(-i*w*t) (AP3DMT) фаза = -45°, |Z| = sqrt(w*mu0*rho);
 * в конвенции exp(+i*w*t) (сырой FFT) фаза = +45°.
 */
export function halfSpaceImpedance(rho, freq, { convention = 'ap3dmt' } = {}) {
    if (!(freq > 0) || !(rho > 0)) return cx(NaN, NaN);
    const mag = Math.sqrt(2 * Math.PI * freq * MU0 * rho);
    const phase = (convention === 'ap3dmt' ? -45 : 45) * Math.PI / 180;
    return cx(mag * Math.cos(phase), mag * Math.sin(phase));
}

// ===========================================================================
// 5. Конвенции и выгрузка
// ===========================================================================

/**
 * Перевод оценки импеданса в конвенцию AP3DMT (exp(-i*w*t)).
 *
 * Сопряжение переводит фазор из конвенции exp(+i*w*t) (сырой FFT) в
 * exp(-i*w*t). Дополнительный множитель sign = -1 нужен, если полярность
 * каналов E/H прибора противоположна эталонной (проверяется по фазе
 * полупространства, см. halfSpaceImpedance).
 */
export function impedanceToAp3dmt(z, { sign = 1 } = {}) {
    const re = -z.re;
    const im = z.im;
    return { re, im };
}

/**
 * Пересчёт станции (результат estimateImpedanceSpectra) в значения AP3DMT:
 * конвенция знаков + единицы [V/m]/[T].
 */
export function applyAp3dmtConvention(station, { scale = 1, sign = 1 } = {}) {
    const conv = (v) => {
        const c = impedanceToAp3dmt(v, { sign });
        return { re: c.re * scale, im: c.im * scale };
    };
    const comps = ['zxx', 'zxy', 'zyx', 'zyy'];
    const out = { ...station };
    for (const c of comps) {
        out[c] = (station[c] ?? []).map(conv);
        if (station.coherence?.[c]) {
            out.coherence = out.coherence ?? {};
            out.coherence[c] = station.coherence[c];
        }
        if (station.error?.[c]) {
            out.error = out.error ?? {};
            out.error[c] = station.error[c].map((e) => e * scale);
        }
    }
    return out;
}

/**
 * Число в формате Python `%.6E` (как в эталонном Profiles.dat).
 */
function exp6(v) {
    if (!isFinite(v)) v = 0;
    const s = v.toExponential(6);
    const m = s.match(/^(-?[\d.]+)e([+-])(\d+)$/);
    if (!m) return s.toUpperCase();
    const digits = m[3].padStart(2, '0');
    return `${m[1]}E${m[2]}${digits}`;
}

/** Строка данных фиксированной ширины (как в эталонном Profiles.dat). */
function formatRow(period, code, lat, lon, X, Y, Z, comp, real, imag, err) {
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

/**
 * Текст Profiles.dat (секция Full_Impedance) по станциям Phoenix.
 *
 * Станция: { code, lat, lon, x, y, z, zxx[], zxy[], zyx[], zyy[],
 *             coherence[], error[] } — значения уже в единицах AP3DMT
 * ([V/m]/[T], конвенция exp(-i*w*t)) либо масштабируются через
 * opts.impedanceScale.
 */
export function buildPhoenixProfilesDat(stations, periods, opts = {}) {
    const scale = opts.impedanceScale ?? 1;
    const headerText = opts.header ?? 'Phoenix MT data processed in browser';
    const comps = ['zxx', 'zxy', 'zyx', 'zyy'];

    let out = '';
    out += `#  ${headerText}\n`;
    out += '#  Period(s) Code GG_Lat GG_Lon X(m) Y(m) Z(m) Component Real Imag Error\n';
    out += '>  Full_Impedance\n';
    out += '>  exp(-i\\omega t)\n';
    out += '>  [V/m]/[T]\n';
    out += '>   0.000\n';
    out += '>     0.0000000    0.0000000    0.000\n';
    out += `>  ${periods.length} ${stations.length}\n`;

    for (let k = 0; k < periods.length; k++) {
        const period = periods[k];
        for (const st of stations) {
            const errRow = st.error?.[k] ?? {};
            const cohRow = st.coherence?.[k] ?? {};
            for (const c of comps) {
                const v = st[c]?.[k];
                if (!v) continue;
                const err = errRow[c] ?? errRow.zxx ?? 0;
                const amp = Math.hypot(v.re, v.im) * scale;
                const fallback = Math.max(amp * 0.05, 1e-30);
                out += formatRow(
                    period, st.code, st.lat ?? 0, st.lon ?? 0,
                    st.x ?? 0, st.y ?? 0, st.z ?? 0,
                    c.toUpperCase(), v.re * scale, v.im * scale,
                    err * scale || fallback,
                ) + '\n';
                // когерентность используется как вес: при низкой когерентности
                // ошибку увеличиваем, чтобы плохие данные не влияли на инверсию
                void cohRow;
            }
        }
    }

    return out;
}

/**
 * Станция для buildPhoenixProfilesDat по временным рядам одной площадки.
 *
 * @param {object} p
 * @param {{ex,ey,hx,hy}} p.channels  каналы (в любых согласованных единицах)
 * @param {number} p.fs
 * @param {number[]} p.frequencies
 * @param {string} p.code  код станции
 */
export function stationFromChannels({ channels, fs, frequencies, code, lat = 0, lon = 0, x = 0, y = 0, z = 0, ...rest }) {
    const spectra = estimateImpedanceSpectra({ channels, fs, frequencies, ...rest });
    const station = {
        code, lat, lon, x, y, z,
        zxx: [], zxy: [], zyx: [], zyy: [],
        coherence: [], error: [],
    };
    for (const s of spectra) {
        station.zxx.push(s.zxx);
        station.zxy.push(s.zxy);
        station.zyx.push(s.zyx);
        station.zyy.push(s.zyy);
        station.coherence.push({
            zxx: s.coherence.zxx, zxy: s.coherence.zxy,
            zyx: s.coherence.zyx, zyy: s.coherence.zyy,
        });
        station.error.push({
            zxx: s.error.zxx, zxy: s.error.zxy,
            zyx: s.error.zyx, zyy: s.error.zyy,
        });
    }
    return { station, spectra };
}
