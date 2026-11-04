/**
 * Парсер файлов Phoenix Geophysics (V5-2000 / MTU-5A): сырые полевые данные МТЗ.
 *
 * Поддерживаемые форматы (реверс-инжиниринг по реальным файлам съёмки
 * «Присаянская» 2013 г., сверен с структурой mt_metadata.timeseries.phoenix):
 *
 * 1. .TBL (конфигурация станции/записи) — последовательность 25-байтовых
 *    записей:
 *      [0..3]   TAG — 4 ASCII-символа (3-символьные теги дополняются \0:
 *               "VER\0", "EGN\0")
 *      [4..10]  заголовок: [4]=источник, [5..6]=класс (00/02/ff),
 *               [7]=группа, [8]=под-индекс, [9..10]=00
 *      [11]     тип значения:
 *               0x00 → uint32 LE  [12..16]
 *               0x01 → float64 LE [12..20]
 *               0x02 → 4-символьная строка (или int32, если не ASCII)
 *               0x04 → строка до 13 байт, оканчивающаяся \0
 *               0x05 → дата/время, 8 байт:
 *                      [0]=флаг, [1]=сек, [2]=мин, [3]=час,
 *                      [4]=месяц, [5]=год (2 цифры), [6]=день, [7]=век (0x14=20)
 *      [12..24] значение (13 байт)
 *    Файл заканчивается записью-маркером 0x03 00 00 00 ... (не тег).
 *
 * 2. Файлы калибровки Cal/*: .CLC (катушки), .CLB (электрические каналы),
 *    .CLE (электроды/доп. датчики):
 *      [0..131]  заголовок 132 байта:
 *                +20  модель ("MTU52"/"MTU5A", 12 байт)
 *                +32  прошивка ("3100E6"/"3112G2", 12 байт)
 *                +64  серийный номер датчика (13 байт, может быть пустым)
 *      [132..]   строки фиксированного размера 32 или 128 байт:
 *                +0  тип секции (0x05/0x04/0x03)
 *                +1..2  00 00
 *                +3  флаг (0x00/0x80)
 *                +4  uint32 LE — ПЕРИОД в микросекундах (f = 1e6 / period)
 *                +8  6 × float32 LE (строка 32 Б) или
 *                    30 × float32 LE = 5 групп по 6 значений (строка 128 Б)
 *    В группе 6 float32: [0],[1] — отклик (Re/Im либо амплитуда/фаза),
 *    [2] — малая величина (погрешность?), [3] — константа файла
 *    (усиление/нормировка), [4],[5] — амплитуда и фаза (для катушек:
 *    спад ~1.24→0.02 от ВЧ к НЧ — отклик индукционной катушки ∝ f).
 *
 * Модуль не зависит от DOM: чистые функции для переиспользания в конвертере.
 */

// ---------------------------------------------------------------------------
// .TBL — конфигурация записи
// ---------------------------------------------------------------------------

/** Типы значений в записи TBL (байт [11]). */
const TBL_TYPE_U32 = 0x00;
const TBL_TYPE_F64 = 0x01;
const TBL_TYPE_STR4 = 0x02;
const TBL_TYPE_STR13 = 0x04;
const TBL_TYPE_DATETIME = 0x05;

const RECORD_SIZE = 25;
// Теги: 2–4 ASCII-символа (Phoenix использует и 2-буквенные теги: HW, SR, …)
const TAG_RE = /^[A-Z0-9]{2,4}$/;

/**
 * Разбор 8-байтового значения даты/времени Phoenix.
 * Раскладка: [0]=флаг, [1]=сек, [2]=мин, [3]=час, [4]=месяц, [5]=год,
 * [6]=день, [7]=век (0x14 = 20xx).
 * @param {DataView} dv
 * @param {number} off
 * @returns {{iso:string|null, parts:number[], century:number}}
 */
function decodePhoenixDatetime(dv, off) {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(dv.getUint8(off + i));
    const [, sec, min, hour, month, year, day, century] = parts;
    // Полностью нулевая или заведомо невалидная дата → null
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) {
        return { iso: null, parts, century };
    }
    const fullYear = (century === 0x14 ? 2000 : century * 100) + year;
    const pad = (n) => String(n).padStart(2, '0');
    const iso = `${fullYear}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(min)}:${pad(sec)}`;
    return { iso, parts, century };
}

/**
 * Значение типа 0x02: ASCII-строка до \0 (в пределах 13 байт), если среди
 * байтов есть латинские буквы и нет непечатных; иначе int32 LE.
 * Строки короче/длиннее 4 символов допустимы: VER="3100E6", FILE="1369712A",
 * HXSN="CHX"; целые: EGNC=1, STDE=0xFFFFFFFF.
 * @param {Uint8Array} bytes
 * @param {DataView} dv
 * @param {number} off
 * @param {TextDecoder} decoder
 * @returns {string|number}
 */
function decodeStrOrI32(bytes, dv, off, decoder) {
    let hasAlpha = false;
    let strLen = 0;
    for (let i = 0; i < 13; i++) {
        const b = bytes[off + i];
        if (b === 0) break;
        strLen = i + 1;
        if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) hasAlpha = true;
        else if (b < 0x20 || b > 0x7e) return dv.getInt32(off, true); // бинарное → int32
    }
    if (!hasAlpha || strLen === 0) return dv.getInt32(off, true);
    return decoder.decode(bytes.subarray(off, off + strLen));
}

/**
 * Разбор .TBL-файла Phoenix.
 * @param {ArrayBuffer|Uint8Array} buffer содержимое файла
 * @returns {{records: Array<{tag:string, type:number, value:*, header:Uint8Array}>,
 *            tags: Object<string, *>}}
 *          tags — карта тег→значение; при повторяющихся тегах (EGN/HGN и т.п.)
 *          сохраняется последнее значение, все записи — в records.
 */
export function parseTbl(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('ascii');

    const records = [];
    const tags = {};
    for (let off = 0; off + RECORD_SIZE <= bytes.byteLength; off += RECORD_SIZE) {
        const tagRaw = bytes.subarray(off, off + 4);
        const tag = decoder.decode(tagRaw).replace(/\0+$/, '');
        if (!TAG_RE.test(tag)) break; // маркер конца файла (0x03 00 00 00 ...)

        const type = bytes[off + 11];
        const vOff = off + 12;
        let value;
        switch (type) {
            case TBL_TYPE_F64:
                value = dv.getFloat64(vOff, true);
                break;
            case TBL_TYPE_STR4:
                value = decodeStrOrI32(bytes, dv, vOff, decoder);
                break;
            case TBL_TYPE_STR13: {
                const slice = bytes.subarray(vOff, vOff + 13);
                const zero = slice.indexOf(0);
                value = decoder.decode(zero >= 0 ? slice.subarray(0, zero) : slice);
                break;
            }
            case TBL_TYPE_DATETIME:
                value = decodePhoenixDatetime(dv, vOff);
                break;
            case TBL_TYPE_U32:
            default:
                value = dv.getUint32(vOff, true);
                break;
        }
        const rec = { tag, type, value, header: bytes.subarray(off + 4, off + 12) };
        records.push(rec);
        tags[tag] = value;
    }
    return { records, tags };
}

// ---------------------------------------------------------------------------
// Семантический слой TBL: параметры станции
// ---------------------------------------------------------------------------

/**
 * «5617.176,N» / «09916.954,E» → десятичные градусы.
 * Формат [d]ddmm.mmm,H: все цифры до точки = градусы+минуты слитно,
 * последние 2 цифры перед точкой — целая часть минут.
 * @param {string} s
 * @returns {number|null}
 */
export function parseDmsCoordinate(s) {
    if (typeof s !== 'string') return null;
    const m = s.trim().match(/^(\d{3,})(\.\d+)?,?\s*([NSEW])$/i);
    if (!m) return null;
    const intPart = m[1];
    if (intPart.length < 3) return null;
    const deg = parseInt(intPart.slice(0, -2), 10);
    const minutes = parseFloat(intPart.slice(-2) + (m[2] || ''));
    if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 60) return null;
    let dec = deg + minutes / 60;
    const hemi = m[3].toUpperCase();
    if (hemi === 'S' || hemi === 'W') dec = -dec;
    return Number.isFinite(dec) ? dec : null;
}

/** Значение тега как число (для смешанных string/u32 тегов). */
function num(tags, key, fallback = 0) {
    const v = tags[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const f = parseFloat(v);
        if (Number.isFinite(f)) return f;
    }
    return fallback;
}

function str(tags, key) {
    const v = tags[key];
    return typeof v === 'string' ? v : '';
}

/** ISO-строка тега-даты или null. */
function dt(tags, key) {
    const v = tags[key];
    return v && typeof v === 'object' && v.iso ? v.iso : null;
}

/**
 * Извлечение параметров станции/записи из разобранного TBL.
 * @param {{tags: Object}} tbl результат parseTbl
 * @returns {Object} stationInfo — поля для формы редактирования в UI
 */
export function extractStationInfo(tbl) {
    const t = tbl.tags;
    return {
        // Идентификация
        fileName: str(t, 'FILE'),
        survey: str(t, 'SRVY'),
        company: str(t, 'CMPY'),
        site: str(t, 'SITE'),
        instrument: str(t, 'HW') || str(t, 'VER'),
        firmware: str(t, 'VER'),
        // Координаты и рельеф
        latRaw: str(t, 'LATG'),
        lonRaw: str(t, 'LNGG'),
        lat: parseDmsCoordinate(str(t, 'LATG')),
        lon: parseDmsCoordinate(str(t, 'LNGG')),
        elevationRaw: num(t, 'ELEV'),
        // Раскладка электродов/датчиков
        exLine: num(t, 'EXLN'),        // длина диполя Ex, м
        eyLine: num(t, 'EYLN'),        // длина диполя Ey, м
        eAzimuth: num(t, 'EAZM'),      // азимут электрической раскладки, °
        hAzimuth: num(t, 'HAZM'),      // азимут магнитной раскладки, °
        declination: num(t, 'DECL'),   // магнитное склонение, °
        hxSensor: str(t, 'HXSN'),
        hySensor: str(t, 'HYSN'),
        hzSensor: str(t, 'HZSN'),
        nRef: num(t, 'NREF'),          // число каналов (3 или 5 — remote reference)
        // Усиление/масштаб
        fscv: num(t, 'FSCV'),          // full-scale voltage, В
        tstv: num(t, 'TSTV'),
        hAtt: num(t, 'HATT'),
        hNom: num(t, 'HNOM'),
        ccMin: num(t, 'CCMN'),
        ccMax: num(t, 'CCMX'),
        lineFreq: num(t, 'LFRQ'),      // частота сети (50 Гц — Россия)
        // Время
        startTime: dt(t, 'STIM'),
        endTime: dt(t, 'ETIM'),
        gpsSync: dt(t, 'TSYN'),
        fileTime: dt(t, 'FTIM'),
        ntpFix: dt(t, 'NUTC'),
        // Состояние
        battery1: num(t, 'BAT1'),      // мВ
        battery2: num(t, 'BAT2'),
        battery3: num(t, 'BAT3'),
        temperature: num(t, 'TEMP'),
        nSatellites: num(t, 'NSAT'),
        mode: num(t, 'MODE'),
        // Исходные теги (для отладки)
        rawTags: t,
    };
}

// ---------------------------------------------------------------------------
// Список станций и параметры вида карты
// ---------------------------------------------------------------------------

/**
 * Нормализация списка станций из результатов extractStationInfo.
 * stationId берётся из fileName (тег FILE), при пустом — из fallbackNames[i] (имя TBL-файла).
 * Записи без id и без координат отбрасываются; дубликаты по stationId — первая побеждает.
 * @param {Object[]} infos — массив результатов extractStationInfo
 * @param {string[]} [fallbackNames] — имена файлов по индексу (без пути и расширения)
 * @returns {{stationId: string, latitude: number|null, longitude: number|null,
 *            elevation: number|null, declination: number|null, instrument: string|null}[]}
 */
export function buildStationList(infos, fallbackNames) {
    if (!Array.isArray(infos)) return [];
    const out = [];
    const seen = new Set();
    infos.forEach((info, i) => {
        if (!info) return;
        let id = String(info.fileName || info.stationId || '').trim();
        if (!id && Array.isArray(fallbackNames)) {
            id = String(fallbackNames[i] || '').replace(/\.[^.]+$/, '').trim();
        }
        const latitude = Number.isFinite(info.lat) ? info.lat : null;
        const longitude = Number.isFinite(info.lon) ? info.lon : null;
        if (!id && latitude == null && longitude == null) return; // не о чём показывать
        if (id && seen.has(id)) return; // дубль станции
        if (id) seen.add(id);
        out.push({
            stationId: id || `№${out.length + 1}`,
            latitude,
            longitude,
            elevation: Number.isFinite(info.elevationRaw) ? info.elevationRaw : null,
            declination: Number.isFinite(info.declination) ? info.declination : null,
            instrument: info.instrument || null,
        });
    });
    return out;
}

/**
 * Параметры вида Leaflet-карты для набора станций.
 * 1 станция → центр на ней, zoom 8. Несколько → центр bbox, zoom по максимальному разбросу:
 * ≥5°→4, ≥2°→5, ≥0.5°→6, ≥0.1°→7, иначе 8. Станции без координат игнорируются.
 * @returns {{center: [number, number], zoom: number}|null} null — если валидных станций нет
 * @deprecated Географическая карта заменена физической схемой (front/js/import/phoenix/stationPlot.js).
 *   Оставлено для обратной совместимости и возможных внешних потребителей.
 */
export function mapViewForStations(stations) {
    if (!Array.isArray(stations)) return null;
    const pts = stations.filter(s => s
        && Number.isFinite(s.latitude) && Number.isFinite(s.longitude)
        && Math.abs(s.latitude) <= 90 && Math.abs(s.longitude) <= 180);
    if (pts.length === 0) return null;
    if (pts.length === 1) return { center: [pts[0].latitude, pts[0].longitude], zoom: 8 };

    const lats = pts.map(p => p.latitude);
    const lons = pts.map(p => p.longitude);
    const latSpread = Math.max(...lats) - Math.min(...lats);
    const lonSpread = Math.max(...lons) - Math.min(...lons);
    const spread = Math.max(latSpread, lonSpread);
    const zoom = spread >= 5 ? 4 : spread >= 2 ? 5 : spread >= 0.5 ? 6 : spread >= 0.1 ? 7 : 8;
    return {
        center: [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2],
        zoom,
    };
}

// ---------------------------------------------------------------------------
// Калибровочные файлы .CLC / .CLB / .CLE
// ---------------------------------------------------------------------------

const CAL_HEADER_SIZE = 132;

/**
 * Определение размера строки таблицы калибровки (32 или 128 байт).
 * Признак: первый байт каждой строки ∈ {2,3,4,5}, байты [1..2] = 0.
 * Тип 2 — вспомогательные данные (доп. таблица после основной), тоже валиден.
 * Выбор: предпочитаем stride с наибольшим числом подряд валидных строк от начала.
 * @param {Uint8Array} bytes
 * @returns {32|128|null}
 */
function detectCalRowSize(bytes) {
    const VALID_TYPES = new Set([2, 3, 4, 5]);
    let bestSize = null;
    let bestConsec = 0;

    for (const rowSize of [32, 128]) {
        const body = bytes.byteLength - CAL_HEADER_SIZE;
        if (body <= 0 || body % rowSize !== 0) continue;
        const nrows = body / rowSize;
        // Считаем подряд валидные строки от начала
        let consec = 0;
        for (let i = 0; i < nrows; i++) {
            const off = CAL_HEADER_SIZE + i * rowSize;
            const t = bytes[off];
            if (VALID_TYPES.has(t) && bytes[off + 1] === 0 && bytes[off + 2] === 0) {
                consec++;
            } else {
                break;
            }
        }
        // Требуем хотя бы 4 валидные строки подряд и ≥50% от общего числа
        if (consec >= 4 && consec >= nrows * 0.5 && consec > bestConsec) {
            bestConsec = consec;
            bestSize = rowSize;
        }
    }
    return bestSize;
}

/**
 * Разбор файла калибровки Phoenix (.CLC/.CLB/.CLE).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{model:string, firmware:string, serial:string, rowSize:number,
 *            rows: Array<{type:number, flag:number, periodUs:number,
 *                         freqHz:number, values:number[]}>}}
 */
export function parseCalFile(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength < CAL_HEADER_SIZE + 8) {
        throw new Error('Файл калибровки слишком короткий');
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('ascii');

    const readStr = (off, len) => {
        const slice = bytes.subarray(off, off + len);
        const zero = slice.indexOf(0);
        return decoder.decode(zero >= 0 ? slice.subarray(0, zero) : slice).trim();
    };

    const model = readStr(20, 12);
    const firmware = readStr(32, 12);
    const serial = readStr(64, 13);

    const rowSize = detectCalRowSize(bytes);
    if (!rowSize) {
        throw new Error('Не удалось определить структуру таблицы калибровки');
    }
    const floatsPerRow = (rowSize - 8) / 4;

    const rows = [];
    for (let off = CAL_HEADER_SIZE; off + rowSize <= bytes.byteLength; off += rowSize) {
        const type = bytes[off];
        const flag = bytes[off + 3];
        const periodUs = dv.getUint32(off + 4, true);
        const values = [];
        for (let i = 0; i < floatsPerRow; i++) {
            values.push(dv.getFloat32(off + 8 + i * 4, true));
        }
        rows.push({
            type,
            flag,
            periodUs,
            freqHz: periodUs > 0 ? 1e6 / periodUs : 0,
            values,
        });
    }
    return { model, firmware, serial, rowSize, rows };
}

/**
 * Кривые отклика датчика для визуализации: частота + амплитуда/фаза.
 * Для строк из 6 float32: [4]=амплитуда, [5]=фаза (рад), [0..1] — Re/Im.
 * Для строк из 30 float32 (5 групп) берётся первая группа; остальные
 * возвращаются в groups для детального просмотра.
 * @param {{rows:Array}} cal результат parseCalFile
 * @returns {Array<{freqHz:number, amp:number, phase:number, re:number, im:number,
 *                  groups:number[][]}>}
 */
export function calResponseCurves(cal) {
    return cal.rows.map((r) => {
        const groups = [];
        for (let g = 0; g + 6 <= r.values.length; g += 6) {
            groups.push(r.values.slice(g, g + 6));
        }
        const first = groups[0] || r.values;
        return {
            freqHz: r.freqHz,
            periodUs: r.periodUs,
            amp: first[4],
            phase: first[5],
            re: first[0],
            im: first[1],
            groups,
        };
    });
}

// ---------------------------------------------------------------------------
// Вспомогательное: сопоставление датчиков станции и калибровочных файлов
// ---------------------------------------------------------------------------

/**
 * По серийным номерам датчиков из TBL (HXSN/HYSN/HZSN) сопоставляет файлы
 * из Cal/: имя файла = серийный номер (COIL2430.CLC) либо содержимое
 * заголовка cal.serial (CHZ.CLE → serial "CHZ").
 * @param {string[]} calFileNames имена файлов в папке Cal/
 * @param {Object} stationInfo результат extractStationInfo
 * @param {Function} parseCalFn функция разбора (для теста с подменой)
 * @returns {Object<string,string[]>} карта канал→имена файлов-кандидатов
 */
export function matchCalFiles(calFileNames, stationInfo) {
    const rawTags = (stationInfo && stationInfo.rawTags) || {};
    const wanted = {
        Hx: str(rawTags, 'HXSN'),
        Hy: str(rawTags, 'HYSN'),
        Hz: str(rawTags, 'HZSN'),
    };
    const result = { Hx: [], Hy: [], Hz: [], unmatched: [] };
    const used = new Set();
    for (const [ch, serial] of Object.entries(wanted)) {
        if (!serial || serial.length < 2) continue;
        for (const name of calFileNames) {
            const base = name.replace(/\.(CLC|CLB|CLE)$/i, '').toUpperCase();
            if (base === serial.toUpperCase() || serial.toUpperCase().startsWith(base)) {
                result[ch].push(name);
                used.add(name);
            }
        }
    }
    result.unmatched = calFileNames.filter((n) => !used.has(n));
    return result;
}
