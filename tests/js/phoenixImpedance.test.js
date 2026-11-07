/**
 * Тесты браузерного DSP-модуля Phoenix: front/js/import/phoenix/phoenixImpedance.js
 *
 * Покрывают:
 *  - разбор нового поколения (native .bin, DAA09: заголовок 128B + кадры 64B);
 *  - разбор децимарованных .td_24k (сегментированный) и .td_150 (непрерывный);
 *  - разбор legacy .TSN (32B-заголовок блока, 24-битные LE-сэмплы, деинтерливинг);
 *  - пересчёт усилений/масштаба (native volts-per-count, legacy mV/km и nT);
 *  - FFT, ФИР-низкочастотный фильтр, децимацию, оценку импеданса OLS,
 *    когерентность и кажущуюся удельную сопротивляемость;
 *  - перевод импеданса в конвенцию AP3DMT и генерацию Profiles.dat.
 *
 * Тесты построены на СИНТЕТИЧЕСКИХ данных: реальных .bin/.TSN в репозитории нет.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseNativeBin,
    parseDecimatedBin,
    parseLegacyTsn,
    nativeGains,
    nativeSampleToVolts,
    legacyChannelScale,
    fft,
    hannWindow,
    lowpassFir,
    decimateSeries,
    estimateImpedanceSpectra,
    apparentResistivity,
    impedancePhaseDeg,
    impedanceToAp3dmt,
    buildPhoenixProfilesDat,
    IMPEDANCE_TO_AP3DMT,
} from '../../front/js/import/phoenix/phoenixImpedance.js';

// ---------------------------------------------------------------------------
// Вспомогательные конструкторы бинарных данных
// ---------------------------------------------------------------------------

/** Заголовок 128 байт нового поколения (DAA09). */
function makeNativeHeader(opts = {}) {
    const buf = new ArrayBuffer(128);
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    dv.setUint8(0, opts.fileType ?? 1);
    dv.setUint8(1, opts.fileVersion ?? 1);
    dv.setUint16(2, 128, true);
    const writeAscii = (off, str) => {
        for (let i = 0; i < 8; i++) bytes[off + i] = i < str.length ? str.charCodeAt(i) : 0;
    };
    writeAscii(4, opts.instType ?? 'MTU-2E');
    writeAscii(12, opts.instSerial ?? '1369712A');
    dv.setUint32(20, opts.recId ?? 7, true);
    dv.setUint8(24, opts.chId ?? 0);
    dv.setUint32(25, opts.fileSequence ?? 1, true);
    dv.setUint16(29, opts.fragPeriod ?? 0, true);
    writeAscii(31, opts.chHwv ?? 'BCM03-B');
    writeAscii(39, opts.chSer ?? '1234ABCD');
    dv.setUint32(47, opts.chFir ?? 0, true);
    const fp = opts.confFp ?? [0x93, 0x08, 0, 0, 0x00, 0, 0, 0];
    for (let i = 0; i < 8; i++) bytes[51 + i] = fp[i];
    dv.setUint16(59, opts.sampleRateBase ?? 4096, true);
    dv.setInt8(61, opts.sampleRateExp ?? 0);
    dv.setUint8(62, 3);
    dv.setUint32(63, 64, true); // frame_size: 64 байта
    dv.setUint16(67, 0, true);
    dv.setUint16(69, 0, true);
    dv.setFloat32(71, opts.gpsLong ?? 99.2825666, true);
    dv.setFloat32(75, opts.gpsLat ?? 56.2862666, true);
    dv.setFloat32(79, 263, true);
    dv.setUint32(83, 5, true);
    dv.setUint32(87, 8, true);
    dv.setUint8(91, 0); dv.setUint8(92, 0); dv.setUint16(93, 0, true);
    dv.setInt8(95, 0);
    dv.setInt32(97, 0, true);
    dv.setUint16(101, 0, true);
    dv.setUint16(103, 0, true);
    dv.setUint16(105, 3700, true);
    dv.setFloat32(107, -1, true);
    dv.setFloat32(111, 1, true);
    return buf;
}

/** Кадр native .bin: 20 сэмплов × 3 байта (big-endian) + footer u32 LE. */
function makeNativeFrame(values, frameIndex = 0, satCount = 0) {
    const buf = new ArrayBuffer(64);
    const dv = new DataView(buf);
    for (let i = 0; i < 20; i++) {
        let v = Math.round(values[i] ?? 0);
        if (v < 0) v += 1 << 24;
        dv.setUint8(i * 3, (v >> 16) & 0xff);
        dv.setUint8(i * 3 + 1, (v >> 8) & 0xff);
        dv.setUint8(i * 3 + 2, v & 0xff);
    }
    dv.setUint32(60, (frameIndex & 0x0fffffff) | ((satCount & 7) << 28), true);
    return buf;
}

function concatBuffers(parts) {
    const total = parts.reduce((s, p) => s + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(new Uint8Array(p), off);
        off += p.byteLength;
    }
    return out.buffer;
}

/** Блок legacy .TSN: 32-байтный заголовок + Nscan×Nch 24-битных LE-сэмплов. */
function makeLegacyBlock({ fs = 256, nch = 5, nscan = 3, scans = [], tagLen = 32 } = {}) {
    const head = new ArrayBuffer(32);
    const dv = new DataView(head);
    dv.setUint8(0, 0); dv.setUint8(1, 30); dv.setUint8(2, 12); // сек/мин/час
    dv.setUint8(3, 5); dv.setUint8(4, 6); dv.setUint8(5, 25);    // день/месяц/год
    dv.setUint8(6, 4); dv.setUint8(7, 0x14);                     // weekday/век
    dv.setUint16(8, 12, true);                                   // boxnum
    dv.setUint16(10, nscan, true);
    dv.setUint8(12, nch);
    dv.setUint8(13, tagLen);
    if (tagLen === 32) dv.setUint16(18, fs, true);
    const data = new ArrayBuffer(nscan * nch * 3);
    const ddv = new DataView(data);
    let k = 0;
    for (let s = 0; s < nscan; s++) {
        for (let c = 0; c < nch; c++) {
            let v = Math.round(scans[s]?.[c] ?? 0);
            if (v < 0) v += 1 << 24;
            ddv.setUint8(k * 3, v & 0xff);
            ddv.setUint8(k * 3 + 1, (v >> 8) & 0xff);
            ddv.setUint8(k * 3 + 2, (v >> 16) & 0xff);
            k++;
        }
    }
    return concatBuffers([head, data]);
}

/** Детерминированный ГПСЧ (для воспроизводимых шумов). */
function lcg(seed = 12345) {
    let s = seed >>> 0;
    return () => {
        s = (1664525 * s + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * Синтез вещественного сигнала из комплексных фазоров (конвенция exp(+iωt)):
 *   x[n] = Re{ Σ_k P_k · e^{iω_k n} }.
 * Соответствует DFT с ядром exp(-i2πkn/N): положительный бин даёт P_k.
 */
function synthFromPhasors(phasors, fs, n) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let v = 0;
        for (const p of phasors) {
            const w = 2 * Math.PI * p.freq * i / fs;
            v += p.re * Math.cos(w) - p.im * Math.sin(w);
        }
        out[i] = v;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Разбор native .bin
// ---------------------------------------------------------------------------

test('parseNativeBin: читает поля заголовка', () => {
    const buf = concatBuffers([makeNativeHeader(), makeNativeFrame([1], 0)]);
    const res = parseNativeBin(buf);
    assert.equal(res.header.instType, 'MTU-2E');
    assert.equal(res.header.instSerial, '1369712A');
    assert.equal(res.header.recId, 7);
    assert.equal(res.header.chId, 0);
    assert.equal(res.header.chHwv, 'BCM03-B');
    assert.equal(res.header.sampleRate, 4096);
    assert.ok(Math.abs(res.header.gpsLat - 56.2862666) < 1e-4);
    assert.ok(Math.abs(res.header.gpsLong - 99.2825666) < 1e-4);
    assert.equal(res.frameSize, 64);
});

test('parseNativeBin: читает 20 сэмплов на кадр, big-endian 24 бит', () => {
    const vals = Array.from({ length: 20 }, (_, i) => i * 1000);
    const buf = concatBuffers([makeNativeHeader(), makeNativeFrame(vals, 0)]);
    const res = parseNativeBin(buf);
    assert.equal(res.samples.length, 20);
    for (let i = 0; i < 20; i++) assert.equal(res.samples[i], i * 1000);
});

test('parseNativeBin: знаковые значения (24-битное дополнение до двух)', () => {
    const vals = [-1, -8388608, -2, 5];
    const buf = concatBuffers([makeNativeHeader(), makeNativeFrame(vals, 0)]);
    const res = parseNativeBin(buf);
    assert.equal(res.samples[0], -1);
    assert.equal(res.samples[1], -8388608);
    assert.equal(res.samples[2], -2);
    assert.equal(res.samples[3], 5);
});

test('parseNativeBin: несколько кадров, счётчик сатураций и пропуски кадров', () => {
    const f0 = makeNativeFrame([1, 2, 3], 0);
    const f1 = makeNativeFrame([4, 5, 6], 1);
    const f2 = makeNativeFrame([7, 8, 9], 3); // кадр 2 пропущен
    const buf = concatBuffers([makeNativeHeader(), f0, f1, f2]);
    const res = parseNativeBin(buf);
    assert.equal(res.samples.length, 60);
    assert.equal(res.saturations, 0);
    assert.deepEqual(res.missingFrames, [2]);
});

test('parseNativeBin: сатурации в footer учитываются', () => {
    const res = parseNativeBin(concatBuffers([makeNativeHeader(), makeNativeFrame([1], 0, 5)]));
    assert.equal(res.saturations, 5);
});

test('parseNativeBin: файл без кадров даёт 0 сэмплов', () => {
    const res = parseNativeBin(makeNativeHeader());
    assert.equal(res.samples.length, 0);
});

// ---------------------------------------------------------------------------
// Усиления и масштаб
// ---------------------------------------------------------------------------

test('nativeGains: E-канал BCM03 (main 16, preamp 4, intrinsic 0.5)', () => {
    const g = nativeGains({ chHwv: 'BCM03-B', confFp: [0x93, 0x08, 0, 0, 0x00, 0, 0, 0] });
    assert.equal(g.channelType, 'E');
    assert.equal(g.mainGain, 16);
    assert.equal(g.preampGain, 4);
    assert.equal(g.attenuatorGain, 1);
    assert.equal(g.intrinsicGain, 0.5);
    assert.equal(g.totalGain, 32);
});

test('nativeGains: H-канал с дифференциальным датчиком (intrinsic 1.0)', () => {
    const g = nativeGains({ chHwv: 'BCM03-B', confFp: [0x80, 0x01, 0, 0, 0x00, 0, 0, 0] });
    assert.equal(g.channelType, 'H');
    assert.equal(g.intrinsicGain, 1);
    assert.equal(g.preampGain, 1);
});

test('nativeGains: аттенюатор для E на новых платах = 523/5223', () => {
    const g = nativeGains({ chHwv: 'BCM06-B', confFp: [0x93, 0x08, 0, 0, 0x01, 0, 0, 0] });
    assert.ok(Math.abs(g.attenuatorGain - 523 / 5223) < 1e-12);
    assert.equal(g.mainGain, 6);
});

test('nativeGains: у H-канала преамп и аттенюатор не применяются', () => {
    const g = nativeGains({ chHwv: 'BCM06-B', confFp: [0x93, 0x01, 0, 0, 0x01, 0, 0, 0] });
    assert.equal(g.channelType, 'H');
    assert.equal(g.preampGain, 1);
    assert.equal(g.attenuatorGain, 1);
});

test('nativeSampleToVolts: volts-per-count = (5/totalGain)/2^31', () => {
    const header = {
        chHwv: 'BCM03-B',
        confFp: [0x93, 0x08, 0, 0, 0x00, 0, 0, 0],
        adPlusMinusRange: 5,
    };
    const k = nativeSampleToVolts(header);
    assert.ok(Math.abs(k - (5 / 32) / 2 ** 31) < 1e-24);
});

// ---------------------------------------------------------------------------
// Разбор децимарованных файлов
// ---------------------------------------------------------------------------

test('parseDecimatedBin: сегментированный .td_24k (субзаголовок + float32)', () => {
    const head = makeNativeHeader();
    const sub = new ArrayBuffer(32);
    const sdv = new DataView(sub);
    sdv.setUint32(0, 123456, true);      // timestamp
    sdv.setUint32(4, 3, true);           // samplesInRecord
    sdv.setUint16(8, 0, true);           // satCount
    sdv.setUint16(10, 0, true);          // missCount
    sdv.setFloat32(12, -2, true);
    sdv.setFloat32(16, 2, true);
    sdv.setFloat32(20, 0, true);
    const data = new ArrayBuffer(3 * 4);
    const ddv = new DataView(data);
    ddv.setFloat32(0, 1.5, true);
    ddv.setFloat32(4, -2.5, true);
    ddv.setFloat32(8, 3.5, true);
    const res = parseDecimatedBin(concatBuffers([head, sub, data]), { segmented: true });
    assert.equal(res.samples.length, 3);
    assert.ok(Math.abs(res.samples[1] + 2.5) < 1e-6);
    assert.equal(res.records.length, 1);
    assert.equal(res.records[0].timestamp, 123456);
});

test('parseDecimatedBin: непрерывный .td_150 (поток float32 без субзаголовка)', () => {
    const head = makeNativeHeader();
    const data = new ArrayBuffer(4 * 4);
    const ddv = new DataView(data);
    for (let i = 0; i < 4; i++) ddv.setFloat32(i * 4, i + 0.5, true);
    const res = parseDecimatedBin(concatBuffers([head, data]), { segmented: false });
    assert.equal(res.samples.length, 4);
    assert.ok(Math.abs(res.samples[3] - 3.5) < 1e-6);
});

// ---------------------------------------------------------------------------
// Разбор legacy .TSN
// ---------------------------------------------------------------------------

test('parseLegacyTsn: разбирает заголовок блока и деинтерливинг каналов', () => {
    const scans = [
        [1, 2, 3, 4, 5],
        [6, 7, 8, 9, 10],
        [11, 12, 13, 14, 15],
    ];
    const res = parseLegacyTsn(makeLegacyBlock({ fs: 256, nch: 5, nscan: 3, scans }));
    assert.equal(res.blocks.length, 1);
    const b = res.blocks[0];
    assert.equal(b.fs, 256);
    assert.equal(b.nch, 5);
    assert.equal(b.nscan, 3);
    assert.equal(b.channelOrder.join(','), 'ex,ey,hx,hy,hz');
    assert.deepEqual(Array.from(b.channels.ex), [1, 6, 11]);
    assert.deepEqual(Array.from(b.channels.hz), [5, 10, 15]);
});

test('parseLegacyTsn: поддерживает порядок из 4 каналов (ex1,ex2,ex3,hy)', () => {
    const scans = [[1, 2, 3, 4], [5, 6, 7, 8]];
    const res = parseLegacyTsn(makeLegacyBlock({ fs: 128, nch: 4, nscan: 2, scans }));
    assert.equal(res.blocks[0].channelOrder.join(','), 'ex1,ex2,ex3,hy');
});

test('parseLegacyTsn: несколько блоков разбираются подряд', () => {
    const b1 = makeLegacyBlock({ fs: 256, nch: 5, nscan: 1, scans: [[1, 2, 3, 4, 5]] });
    const b2 = makeLegacyBlock({ fs: 256, nch: 5, nscan: 1, scans: [[6, 7, 8, 9, 10]] });
    const res = parseLegacyTsn(concatBuffers([b1, b2]));
    assert.equal(res.blocks.length, 2);
    assert.deepEqual(Array.from(res.blocks[1].channels.ex), [6]);
});

test('parseLegacyTsn: формат V5-2000 (Taglen != 32) отклоняется с понятной ошибкой', () => {
    assert.throws(() => parseLegacyTsn(makeLegacyBlock({ tagLen: 64 })), /V5-2000/);
});

test('legacyChannelScale: E в mV/km и H в nT по тегам TBL', () => {
    const tags = { FSCV: 6.4, EGN: 40, EXLN: 50, HGN: 3, HATT: 0.233, HNOM: 1000 };
    const e = legacyChannelScale(tags, 'ex');
    const h = legacyChannelScale(tags, 'hx');
    assert.equal(e.unit, 'mV/km');
    assert.equal(h.unit, 'nT');
    // E: ts * FSCV / 2^23 * 1000 / EGN / EXLN * 1000  →  mV/km на единицу отсчёта
    assert.ok(Math.abs(e.factor - (6.4 / 2 ** 23 * 1000 / 40 / 50 * 1000)) < 1e-12);
    // H: ts * FSCV / 2^23 * 1000 / HGN / HATT / HNOM
    assert.ok(Math.abs(h.factor - (6.4 / 2 ** 23 * 1000 / 3 / 0.233 / 1000)) < 1e-12);
});

test('legacyChannelScale: без нужных тегов возвращает null', () => {
    assert.equal(legacyChannelScale({}, 'ex'), null);
    assert.equal(legacyChannelScale({ FSCV: 6.4 }, 'hx'), null);
});

// ---------------------------------------------------------------------------
// DSP: FFT, окно, фильтр, децимация
// ---------------------------------------------------------------------------

test('fft: чистый косинус даёт пик в нужном бине с амплитудой N/2', () => {
    const n = 64;
    const re = synthFromPhasors([{ freq: 8, re: 1, im: 0 }], n, n);
    const im = new Float64Array(n);
    fft(re, im);
    let peak = 0;
    for (let k = 1; k < n / 2; k++) if (Math.abs(re[k]) > Math.abs(re[peak])) peak = k;
    assert.equal(peak, 8);
    assert.ok(Math.abs(Math.abs(re[8]) - n / 2) < 1e-9);
    assert.ok(Math.abs(im[8]) < 1e-9);
});

test('fft: сохраняет энергию (Parseval)', () => {
    const n = 32;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i) + 0.3 * Math.cos(3 * i);
    const re0 = Float64Array.from(re);
    fft(re, im);
    let e0 = 0, e1 = 0;
    for (let i = 0; i < n; i++) e0 += re0[i] * re0[i];
    for (let k = 0; k < n; k++) e1 += re[k] * re[k] + im[k] * im[k];
    assert.ok(Math.abs(e1 / n - e0) < 1e-9);
});

test('fft: длина не степень двойки отвергается', () => {
    assert.throws(() => fft(new Float64Array(12), new Float64Array(12)), /степен/i);
});

test('hannWindow: N=0 → пустой, значения неотрицательны, периодичны', () => {
    assert.equal(hannWindow(0).length, 0);
    const w = hannWindow(8);
    assert.equal(w.length, 8);
    for (const v of w) assert.ok(v >= 0 && v <= 1);
    // Периодическое Ханна (знаменатель n): первый отсчёт ровно 0.
    assert.equal(w[0], 0);
    assert.ok(Math.abs(w[1] - w[7]) < 1e-12);
    // ДПФ такого окна обращается в ноль на всех целых бинах вне {0, ±1}:
    // именно это обнуляет зеркальную составляющую в estimateImpedanceSpectra.
    const N = 64, ww = hannWindow(N);
    for (const m of [2, 3, 8, 16, 32]) {
        let re = 0, im = 0;
        for (let j = 0; j < N; j++) {
            const a = (-2 * Math.PI * m * j) / N;
            re += ww[j] * Math.cos(a);
            im += ww[j] * Math.sin(a);
        }
        assert.ok(Math.hypot(re, im) / N < 1e-15, `W(${m}) не обнулилось`);
    }
});

test('lowpassFir: постоянный сигнал сохраняется (DC-gain = 1)', () => {
    const x = new Float64Array(64).fill(2.5);
    const y = lowpassFir(x, 0.25, 31);
    assert.equal(y.length, x.length);
    for (const v of y) assert.ok(Math.abs(v - 2.5) < 1e-9);
});

test('lowpassFir: подавляет компоненту выше частоты среза', () => {
    const n = 256;
    const x = synthFromPhasors([{ freq: 40, re: 1, im: 0 }], 128, n); // 40 Гц при fs=128
    const y = lowpassFir(x, 0.25, 31);                                // срез 32 Гц
    let amp = 0;
    for (const v of y) amp = Math.max(amp, Math.abs(v));
    assert.ok(amp < 0.05, `amp=${amp}`);
});

test('decimateSeries: длина / factor, постоянная сохраняется', () => {
    const x = new Float64Array(100).fill(3);
    const y = decimateSeries(x, 4);
    assert.equal(y.length, 25);
    for (const v of y) assert.ok(Math.abs(v - 3) < 1e-9);
});

// ---------------------------------------------------------------------------
// Оценка импеданса
// ---------------------------------------------------------------------------

/**
 * Синтетическая площадка с известной матрицей Z (конвенция exp(+iωt)).
 *
 * Магнитное поле «насыщено по поляризации»: каждый сегмент длины segment
 * несёт СВОЙ случайный комплексный вектор-огибающую [Hx, Hy] на частоте
 * freq. Сигнал — Re{A·e^{iωt}}, поэтому оконная ДПФ в бине freq даёт ровно
 * ½·A·Σw (огибажа внутри окна постоянна), а «зеркальный» член ½·A*·Σw·e^{-i2ωt}
 * обнуляется ТОЧНО: ДПФ окна Хана на целых бинах равна нулю вне {0, ±1},
 * а 2·bin — целый бин вне них. Значит E_окна = Z·H_окна в каждом окне, и
 * S_hh имеет ранг 2.
 *
 * Почему нельзя оставить одну тональную частоту: в бине freq вектор [Hx, Hy]
 * одинаков во всех окнах, S_hh = h·hᴴ имеет ранг 1, и тензор (4 неизвестных
 * при 2 уравнениях на окно) принципиально не разрешим — решение вырождается
 * в нуль, а не «считается неточно».
 *
 * Сегменты выровнены по окнам анализатора, поэтому вызывающие тесты обязаны
 * ставить overlap = 0 (иначе окно захватывает две разные огибающие).
 */
function synthSite(fs, n, freq, Z, noiseAmp = 0, seed = 7, segment = 64) {
    const rnd = lcg(seed);
    const ex = new Float64Array(n), ey = new Float64Array(n);
    const hx = new Float64Array(n), hy = new Float64Array(n);
    const w = (2 * Math.PI * freq) / fs;
    for (let s = 0; s * segment < n; s++) {
        const axr = rnd() - 0.5, axi = rnd() - 0.5;
        const ayr = rnd() - 0.5, ayi = rnd() - 0.5;
        // B = Z·A в комплексной форме: E = Z·H для каждой огибающей.
        const bxr = Z.zxx.re * axr - Z.zxx.im * axi + Z.zxy.re * ayr - Z.zxy.im * ayi;
        const bxi = Z.zxx.re * axi + Z.zxx.im * axr + Z.zxy.re * ayi + Z.zxy.im * ayr;
        const byr = Z.zyx.re * axr - Z.zyx.im * axi + Z.zyy.re * ayr - Z.zyy.im * ayi;
        const byi = Z.zyx.re * axi + Z.zyx.im * axr + Z.zyy.re * ayi + Z.zyy.im * ayr;
        const end = Math.min(n, (s + 1) * segment);
        for (let i = s * segment; i < end; i++) {
            const c = Math.cos(w * i), si = Math.sin(w * i);
            hx[i] = axr * c - axi * si;
            hy[i] = ayr * c - ayi * si;
            ex[i] = bxr * c - bxi * si;
            ey[i] = byr * c - byi * si;
        }
    }
    if (noiseAmp > 0) {
        const rn = lcg(seed + 991);
        for (let i = 0; i < n; i++) {
            ex[i] += noiseAmp * (rn() - 0.5);
            ey[i] += noiseAmp * (rn() - 0.5);
            hx[i] += noiseAmp * 0.3 * (rn() - 0.5);
            hy[i] += noiseAmp * 0.3 * (rn() - 0.5);
        }
    }
    return { channels: { ex, ey, hx, hy }, fs, n };
}

const Z_TRUE = {
    zxx: { re: 0.30, im: -0.40 },
    zxy: { re: -0.10, im: 0.05 },
    zyx: { re: 0.12, im: 0.07 },
    zyy: { re: -0.22, im: 0.31 },
};

test('estimateImpedanceSpectra: восстанавливает все четыре компоненты Z без шума', () => {
    // n = 4·windowSize: тогда estimateImpedanceSpectra не удваивает N и
    // окно совпадает с сегментом огибающей в synthSite.
    const fs = 64, n = 256;
    const site = synthSite(fs, n, 4, Z_TRUE, 0);
    const res = estimateImpedanceSpectra({
        channels: site.channels,
        fs,
        frequencies: [4],
        windowSize: 64,
        overlap: 0,
    });
    assert.equal(res.length, 1);
    const r = res[0];
    assert.ok(Math.abs(r.freq - 4) < 1e-9);
    for (const key of ['zxx', 'zxy', 'zyx', 'zyy']) {
        assert.ok(Math.abs(r[key].re - Z_TRUE[key].re) < 1e-6, `${key}.re=${r[key].re}`);
        assert.ok(Math.abs(r[key].im - Z_TRUE[key].im) < 1e-6, `${key}.im=${r[key].im}`);
    }
    assert.ok(r.coherence.zxx > 0.99, `coh=${r.coherence.zxx}`);
    // E = Z·H выполняется точно, остатков нет — error здесь уже не про точность,
    // а про численную обусловленность: sigma ~ 1e-8 из-за вычитания больших
    // близких величин в RSS, а inv[0][0] = S_hh[1][1]/det с det ~ 1e-2.
    // Проверяем, что оценка ошибки конечна и мала относительно |Zxx|.
    assert.ok(Number.isFinite(r.error.zxx), `err=${r.error.zxx}`);
    assert.ok(r.error.zxx < 0.05 * Math.hypot(r.zxx.re, r.zxx.im), `err=${r.error.zxx}`);
});

test('estimateImpedanceSpectra: когерентность падает и ошибка растёт с шумом', () => {
    const fs = 64, n = 256;
    const clean = estimateImpedanceSpectra({
        channels: synthSite(fs, n, 4, Z_TRUE, 0.1).channels, fs, frequencies: [4], windowSize: 64, overlap: 0,
    })[0];
    const noisy = estimateImpedanceSpectra({
        channels: synthSite(fs, n, 4, Z_TRUE, 0.6).channels, fs, frequencies: [4], windowSize: 64, overlap: 0,
    })[0];
    assert.ok(noisy.coherence.zxx < clean.coherence.zxx);
    assert.ok(noisy.error.zxx > clean.error.zxx);
});

test('estimateImpedanceSpectra: фаза Z соответствует фазе вектора (градусы)', () => {
    const fs = 64, n = 256;
    const Z = { zxx: { re: 0.0, im: -0.5 }, zxy: { re: 0, im: 0 }, zyx: { re: 0, im: 0 }, zyy: { re: 0, im: 0 } };
    const res = estimateImpedanceSpectra({
        channels: synthSite(fs, n, 4, Z, 0).channels, fs, frequencies: [4], windowSize: 64, overlap: 0,
    })[0];
    const phase = impedancePhaseDeg(res.zxx.re, res.zxx.im);
    assert.ok(Math.abs(phase - (-90)) < 1e-3, `phase=${phase}`);
});

test('estimateImpedanceSpectra: период = 1/f, частоты сортируются по возрастанию', () => {
    const fs = 64, n = 512;
    const res = estimateImpedanceSpectra({
        channels: synthSite(fs, n, 4, Z_TRUE, 0, 7, 128).channels, fs, frequencies: [8, 2], windowSize: 128, overlap: 0,
    });
    assert.equal(res.length, 2);
    assert.ok(Math.abs(res[0].freq - 2) < 1e-9);
    assert.ok(Math.abs(res[1].freq - 8) < 1e-9);
    assert.ok(Math.abs(res[0].period - 0.5) < 1e-9);
    assert.ok(Math.abs(res[1].period - 0.125) < 1e-9);
});

test('estimateImpedanceSpectra: отбрасывает частоты вне полосы Найквиста', () => {
    const fs = 64, n = 256;
    const res = estimateImpedanceSpectra({
        channels: synthSite(fs, n, 4, Z_TRUE, 0).channels, fs, frequencies: [4, 200], windowSize: 64, overlap: 0,
    });
    assert.equal(res.length, 1);
    assert.ok(Math.abs(res[0].freq - 4) < 1e-9);
});

test('apparentResistivity: ρa = |Z|²/(ωμ0) для Z в [V/m]/[T]', () => {
    const rho = apparentResistivity(1e-3, 0, 1);
    const expected = 1e-6 / (2 * Math.PI * 4e-7 * Math.PI);
    assert.ok(Math.abs(rho - expected) < 1e-12);
});

test('apparentResistivity: при нулевой частоте возвращает NaN', () => {
    assert.ok(Number.isNaN(apparentResistivity(1, 0, 0)));
});

test('impedanceToAp3dmt: -conj(Z) (конвенция exp(-iωt) AP3DMT)', () => {
    const z = impedanceToAp3dmt({ re: 3, im: -4 });
    assert.equal(z.re, -3);
    assert.equal(z.im, -4);
});

// ---------------------------------------------------------------------------
// Генерация Profiles.dat
// ---------------------------------------------------------------------------

const STATIONS_SAMPLE = [{
    code: '056-017',
    lat: 56.2862666,
    lon: 99.2825666,
    x: 0, y: 0, z: 263,
    zxx: [{ re: 1e-3, im: -1e-3 }],
    zxy: [{ re: 2e-3, im: 0 }],
    zyx: [{ re: 0, im: 1e-3 }],
    zyy: [{ re: -1e-3, im: -2e-3 }],
    coherence: [{ zxx: 0.9 }],
    error: [{ zxx: 1e-4 }],
}];

test('buildPhoenixProfilesDat: шапка AP3DMT и 4 компоненты на станцию-период', () => {
    const txt = buildPhoenixProfilesDat(STATIONS_SAMPLE, [10]);
    assert.ok(txt.includes('>  Full_Impedance'));
    assert.ok(txt.includes('>  exp(-i\\omega t)'));
    assert.ok(txt.includes('>  [V/m]/[T]'));
    const dataLines = txt.split('\n').filter(l => l && !l.startsWith('#') && !l.startsWith('>'));
    assert.equal(dataLines.length, 4);
    const parts = dataLines[0].trim().split(/\s+/);
    assert.equal(parts.length, 11);
    assert.equal(parts[0], '1.000000E+01');
    assert.equal(parts[1], '056-017');
    assert.equal(parts[7], 'ZXX');
    assert.ok(Math.abs(parseFloat(parts[8]) - 1e-3) < 1e-9);
    assert.ok(Math.abs(parseFloat(parts[9]) + 1e-3) < 1e-9);
    assert.ok(Math.abs(parseFloat(parts[2]) - 56.2862666) < 1e-6);
    assert.ok(Math.abs(parseFloat(parts[3]) - 99.2825666) < 1e-6);
    assert.ok(txt.includes('>  1 1'));
});

test('buildPhoenixProfilesDat: перевод (mV/km)/nT → [V/m]/[T] (коэффициент 1e3)', () => {
    assert.equal(IMPEDANCE_TO_AP3DMT, 1e3);
    const stations = [{
        code: '000-000', lat: 0, lon: 0, x: 0, y: 0, z: 0,
        zxx: [{ re: 1, im: 0 }],
        zxy: [{ re: 0, im: 0 }],
        zyx: [{ re: 0, im: 0 }],
        zyy: [{ re: 0, im: 0 }],
        coherence: [{ zxx: 1 }],
        error: [{ zxx: 0 }],
    }];
    const txt = buildPhoenixProfilesDat(stations, [1], { impedanceScale: IMPEDANCE_TO_AP3DMT });
    // Ищем строку по имени компоненты: периоды [1] печатаются как 1.000000E+00,
    // а не E+01 (на поиск E+01 строка не находилась, и тест ничего не проверял).
    const line = txt.split('\n').find(l => l.trim().split(/\s+/)[7] === 'ZXX');
    assert.ok(line, 'строка ZXX не найдена в ' + JSON.stringify(txt.split('\n').slice(-3)));
    const parts = line.trim().split(/\s+/);
    assert.ok(Math.abs(parseFloat(parts[8]) - 1e3) < 1e-3);
});
