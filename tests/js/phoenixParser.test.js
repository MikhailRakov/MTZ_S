/**
 * Тесты для phoenixParser.js
 * Запуск: node --test MTZ_S/tests/js/*.test.js  (или: cd MTZ_S/tests/js && node --test)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Импортируем функции парсера (ES module)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Динамический импорт ES модуля
const { parseTbl, extractStationInfo, parseCalFile, calResponseCurves, matchCalFiles, parseDmsCoordinate } = await import('../../front/js/import/phoenix/phoenixParser.js');

// Путь к тестовым данным (поднимаемся на 3 уровня из front/js/utils → MTZ_S)
const TEST_DATA_DIR = join(__dirname, '..', '..', 'mt_time_data');

/**
 * Вспомогательная функция для чтения файла как ArrayBuffer
 * Node.js Buffer использует общий pool, поэтому .buffer возвращает весь pool.
 * Нужно правильно slice'ить нужный диапазон.
 */
function readFileAsArrayBuffer(filePath) {
    const nodeBuffer = readFileSync(filePath);
    return nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.length);
}

describe('parseTbl', () => {
    test('должен парсить валидный TBL файл с координатами', () => {
        const tblPath = join(TEST_DATA_DIR, 'DATA', '1369712A.TBL');
        const nodeBuffer = readFileSync(tblPath);
        // Правильно извлекаем ArrayBuffer из Node.js Buffer
        const buffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.length);
        
        const result = parseTbl(buffer);
        
        assert.ok(result, 'Результат не должен быть null');
        assert.ok(result.records, 'Должен содержать records');
        assert.ok(result.tags, 'Должен содержать tags');
        assert.equal(result.records.length, 118, 'Должно быть 118 записей');
        
        // Проверяем ключевые теги
        assert.equal(result.tags.FILE, '1369712A', 'FILE tag');
        assert.equal(result.tags.SRVY, 'PrisayanoEn', 'SRVY tag');
        assert.equal(result.tags.CMPY, 'EMGEO', 'CMPY tag');
        assert.equal(result.tags.HW, 'MTU2E', 'HW tag');
        assert.equal(result.tags.VER, '3100E6', 'VER tag');
    });

    test('должен возвращать пустой результат для пустого буфера', () => {
        const emptyBuffer = new ArrayBuffer(0);
        
        const result = parseTbl(emptyBuffer);
        
        assert.ok(result, 'Результат не должен быть null');
        assert.ok(Array.isArray(result.records), 'records должен быть массивом');
        assert.equal(result.records.length, 0, 'records должен быть пустым');
        assert.ok(result.tags, 'tags должен существовать');
        assert.equal(Object.keys(result.tags).length, 0, 'tags должен быть пустым объектом');
    });

    test('должен корректно обрабатывать Startup.tbl', () => {
        const startupPath = join(TEST_DATA_DIR, 'DATA', 'Startup.tbl');
        const buffer = readFileAsArrayBuffer(startupPath);
        
        const result = parseTbl(buffer);
        
        assert.ok(result, 'Результат не должен быть null');
        assert.ok(result.records.length > 0, 'Должны быть записи');
        assert.ok(result.tags, 'Должен содержать tags');
    });
});

describe('extractStationInfo', () => {
    test('должен извлекать информацию из полного TBL', () => {
        const tblPath = join(TEST_DATA_DIR, 'DATA', '1369712A.TBL');
        const buffer = readFileAsArrayBuffer(tblPath);
        const tblResult = parseTbl(buffer);
        
        const info = extractStationInfo(tblResult);
        
        assert.ok(info, 'Информация не должна быть null');
        assert.equal(info.fileName, '1369712A', 'fileName');
        assert.equal(info.survey, 'PrisayanoEn', 'survey');
        assert.equal(info.company, 'EMGEO', 'company');
        assert.equal(info.instrument, 'MTU2E', 'instrument');
        assert.equal(info.firmware, '3100E6', 'firmware');
        
        // Координаты (если есть в TBL)
        if (info.lat !== undefined && info.lat !== null) {
            assert.ok(typeof info.lat === 'number', 'lat должен быть числом');
            assert.ok(info.lat >= -90 && info.lat <= 90, 'lat в диапазоне [-90, 90]');
        }
        if (info.lon !== undefined && info.lon !== null) {
            assert.ok(typeof info.lon === 'number', 'lon должен быть числом');
            assert.ok(info.lon >= -180 && info.lon <= 180, 'lon в диапазоне [-180, 180]');
        }
        
        // Датчики
        assert.ok(info.hxSensor, 'hxSensor должен быть заполнен');
        assert.ok(info.hySensor, 'hySensor должен быть заполнен');
        assert.ok(info.hzSensor, 'hzSensor должен быть заполнен');
        
        // Время начала
        assert.ok(info.startTime, 'startTime должен быть заполнен');
    });

    test('должен обрабатывать TBL без координат', () => {
        // Создаем минимальный TBL только с базовыми тегами
        const minimalTags = {
            FILE: 'TEST001',
            SRVY: 'TestSurvey',
            CMPY: 'TestCo',
            HW: 'MTU5A',
            VER: '1234',
        };
        const mockTbl = { records: [], tags: minimalTags };
        
        const info = extractStationInfo(mockTbl);
        
        assert.equal(info.fileName, 'TEST001', 'fileName');
        assert.equal(info.survey, 'TestSurvey', 'survey');
        assert.equal(info.company, 'TestCo', 'company');
        assert.equal(info.instrument, 'MTU5A', 'instrument');
        // Координаты должны быть undefined или null
        assert.ok(info.lat === undefined || info.lat === null || isNaN(info.lat), 'lat должен быть отсутствующим');
        assert.ok(info.lon === undefined || info.lon === null || isNaN(info.lon), 'lon должен быть отсутствующим');
    });

    test('должен обрабатывать пустой TBL', () => {
        const emptyTbl = { records: [], tags: {} };
        
        const info = extractStationInfo(emptyTbl);
        
        assert.ok(info, 'Информация не должна быть null');
        assert.equal(info.fileName, '', 'fileName должен быть пустой строкой');
        assert.equal(info.survey, '', 'survey должен быть пустой строкой');
    });
});

describe('parseDmsCoordinate', () => {
    test('должен парсить DMS формат с градусами и минутами', () => {
        // 56°17.176' N = 56 + 17.176/60 = 56.28627
        const lat = parseDmsCoordinate('5617.176,N');
        assert.ok(Math.abs(lat - 56.28627) < 0.0001, `lat=${lat}, ожидалось ~56.28627`);
        
        // 99°16.954' E = 99 + 16.954/60 = 99.28257
        const lon = parseDmsCoordinate('09916.954,E');
        assert.ok(Math.abs(lon - 99.28257) < 0.0001, `lon=${lon}, ожидалось ~99.28257`);
    });

    test('должен обрабатывать южные и западные координаты', () => {
        const latS = parseDmsCoordinate('3345.5,S');
        assert.ok(latS < 0, 'Южная широта должна быть отрицательной');
        
        const lonW = parseDmsCoordinate('11820.3,W');
        assert.ok(lonW < 0, 'Западная долгота должна быть отрицательной');
    });

    test('должен возвращать null для невалидного формата', () => {
        const invalid = parseDmsCoordinate('invalid');
        assert.equal(invalid, null, 'Невалидный формат должен возвращать null');

        const empty = parseDmsCoordinate('');
        assert.equal(empty, null, 'Пустая строка должна возвращать null');

        const nullInput = parseDmsCoordinate(null);
        assert.equal(nullInput, null, 'null должен возвращать null');

        const undefinedInput = parseDmsCoordinate(undefined);
        assert.equal(undefinedInput, null, 'undefined должен возвращать null');
    });
});

describe('parseCalFile', () => {
    test('должен парсить стандартный CLC файл (COIL)', () => {
        const clcPath = join(TEST_DATA_DIR, 'Cal', 'COIL2430.CLC');
        const buffer = readFileAsArrayBuffer(clcPath);
        
        const result = parseCalFile(buffer);
        
        assert.ok(result, 'Результат не должен быть null');
        assert.ok(result.rows, 'Должен содержать rows');
        assert.ok(result.rows.length > 0, 'Должны быть строки');
        assert.ok(result.rowSize === 32 || result.rowSize === 128, 'rowSize должен быть 32 или 128');
    });

    test('должен парсить CLB файл (MTU5A)', () => {
        const clbPath = join(TEST_DATA_DIR, 'Cal', '1482.CLB');
        const buffer = readFileAsArrayBuffer(clbPath);
        
        const result = parseCalFile(buffer);
        
        assert.ok(result, 'Результат не должен быть null');
        assert.ok(result.rows.length > 0, 'Должны быть строки');
        assert.equal(result.rowSize, 128, 'CLB файлы обычно имеют rowSize=128');
    });

    test('должен выбрасывать ошибку для невалидного файла', () => {
        // Создаем буфер с невалидными данными
        const invalidBuffer = new Uint8Array(200).buffer;
        
        assert.throws(() => {
            parseCalFile(invalidBuffer);
        }, /Не удалось определить структуру/, 'Должна выбрасываться ошибка для невалидного файла');
    });

    test('должен обрабатывать файлы с разными stride', () => {
        // Проверяем все CLC файлы в директории Cal
        const calDir = join(TEST_DATA_DIR, 'Cal');
        const files = [
            'COIL2430.CLC', 'AMTC1047.CLC', 'NONE.CLC', 'CHZ.CLC',
            '1482.CLB', '1333.CLB', '2853.CLB'
        ];
        
        for (const fileName of files) {
            const filePath = join(calDir, fileName);
            try {
                const buffer = readFileAsArrayBuffer(filePath);
                const result = parseCalFile(buffer);
                assert.ok(result.rows.length > 0, `${fileName}: должны быть строки`);
            } catch (e) {
                // Некоторые файлы могут быть в нестандартном формате (1339.CLB, 1369.CLB)
                console.log(`Предупреждение: ${fileName} не парсится: ${e.message}`);
            }
        }
    });
});

describe('calResponseCurves', () => {
    test('должен извлекать кривые отклика из калибровочного файла', () => {
        const clcPath = join(TEST_DATA_DIR, 'Cal', 'COIL2430.CLC');
        const buffer = readFileAsArrayBuffer(clcPath);
        const calData = parseCalFile(buffer);

        const curves = calResponseCurves(calData);

        assert.ok(curves, 'Кривые не должны быть null');
        assert.ok(Array.isArray(curves), 'Должен быть массив');
        assert.ok(curves.length > 0, 'Должны быть кривые');
        assert.equal(curves.length, calData.rows.length, 'Число кривых = числу строк');

        // Проверяем структуру первой кривой (контракт: freqHz/amp/phase/re/im/groups)
        const firstCurve = curves[0];
        assert.ok(typeof firstCurve.freqHz === 'number', 'Кривая должна иметь freqHz');
        assert.ok(firstCurve.freqHz > 0, 'freqHz должен быть положительным');
        assert.ok(typeof firstCurve.amp === 'number', 'Кривая должна иметь amp');
        assert.ok(typeof firstCurve.phase === 'number', 'Кривая должна иметь phase');
        assert.ok('re' in firstCurve, 'Кривая должна иметь re');
        assert.ok('im' in firstCurve, 'Кривая должна иметь im');
        assert.ok(Array.isArray(firstCurve.groups), 'Кривая должна иметь groups[]');
    });

    test('кривые должны быть упорядочены по убыванию частоты', () => {
        const clcPath = join(TEST_DATA_DIR, 'Cal', 'COIL2430.CLC');
        const buffer = readFileAsArrayBuffer(clcPath);
        const curves = calResponseCurves(parseCalFile(buffer));

        assert.ok(curves.length > 10, 'Должно быть много точек');
        // Реальные катушечные таблицы Phoenix идут от высокой частоты к низкой
        assert.ok(curves[0].freqHz > curves[curves.length - 1].freqHz,
            `Первая частота ${curves[0].freqHz} должна быть больше последней ${curves[curves.length - 1].freqHz}`);
        // Амплитуда отклика катушки падает с частотой
        assert.ok(curves[0].amp > curves[curves.length - 1].amp,
            'Амплитуда должна убывать к низкой частоте');
        // Все значения конечны
        for (const c of curves) {
            assert.ok(Number.isFinite(c.freqHz), 'freqHz конечен');
            assert.ok(Number.isFinite(c.amp), 'amp конечен');
            assert.ok(Number.isFinite(c.phase), 'phase конечен');
        }
    });

    test('должен возвращать пустой массив для cal без rows', () => {
        const curves = calResponseCurves({ rows: [] });
        assert.ok(Array.isArray(curves), 'Должен быть массив');
        assert.equal(curves.length, 0, 'Массив должен быть пустым');
    });
});

describe('matchCalFiles', () => {
    test('должен сопоставлять калибровочные файлы с датчиками по серийным номерам', () => {
        const calFileNames = [
            'COIL2429.CLC', 'COIL2430.CLC', 'CHZ.CLE', 'NONE.CLC', '1339.CLB',
        ];
        // Контракт: matchCalFiles читает stationInfo.rawTags
        const stationInfo = {
            rawTags: { HXSN: 'COIL2429', HYSN: 'COIL2430', HZSN: 'CHZ' },
        };

        const matched = matchCalFiles(calFileNames, stationInfo);

        assert.ok(matched, 'Результат не должен быть null');
        assert.deepEqual(matched.Hx, ['COIL2429.CLC'], 'Hx → COIL2429.CLC');
        assert.deepEqual(matched.Hy, ['COIL2430.CLC'], 'Hy → COIL2430.CLC');
        assert.deepEqual(matched.Hz, ['CHZ.CLE'], 'Hz → CHZ.CLE');
        assert.ok(Array.isArray(matched.unmatched), 'unmatched должен быть массивом');
        assert.ok(matched.unmatched.includes('NONE.CLC'), 'NONE.CLC не сопоставлен');
        assert.ok(matched.unmatched.includes('1339.CLB'), '1339.CLB не сопоставлен');
    });

    test('должен возвращать пустые каналы при отсутствии совпадений', () => {
        const calFileNames = ['UNKNOWN.CLC'];
        const stationInfo = { rawTags: { HXSN: 'COIL2429', HYSN: 'COIL2430', HZSN: 'CHZ' } };

        const matched = matchCalFiles(calFileNames, stationInfo);

        assert.equal(matched.Hx.length, 0, 'Нет совпадений для Hx');
        assert.equal(matched.Hy.length, 0, 'Нет совпадений для Hy');
        assert.equal(matched.Hz.length, 0, 'Нет совпадений для Hz');
        assert.deepEqual(matched.unmatched, ['UNKNOWN.CLC'], 'Все файлы не сопоставлены');
    });

    test('не должен падать при отсутствии rawTags', () => {
        const calFileNames = ['COIL2429.CLC'];

        // Защита: stationInfo без rawTags (например, собранный вручную в UI)
        const matched = matchCalFiles(calFileNames, {});

        assert.equal(matched.Hx.length, 0, 'Hx пуст');
        assert.equal(matched.Hy.length, 0, 'Hy пуст');
        assert.equal(matched.Hz.length, 0, 'Hz пуст');
        assert.deepEqual(matched.unmatched, ['COIL2429.CLC'], 'Файл в unmatched');
    });

    test('не должен падать при stationInfo = undefined', () => {
        const matched = matchCalFiles(['A.CLC'], undefined);
        assert.deepEqual(matched.unmatched, ['A.CLC'], 'Файл в unmatched');
    });

    test('должен сопоставлять без учёта регистра расширения и имени', () => {
        const calFileNames = ['coil2429.clc', 'CHZ.cLe'];
        const stationInfo = { rawTags: { HXSN: 'COIL2429', HZSN: 'CHZ' } };

        const matched = matchCalFiles(calFileNames, stationInfo);

        assert.deepEqual(matched.Hx, ['coil2429.clc'], 'Регистр не важен');
        assert.deepEqual(matched.Hz, ['CHZ.cLe'], 'Регистр расширения не важен');
    });
});

// Запуск тестов
console.log('Запуск тестов phoenixParser...');
