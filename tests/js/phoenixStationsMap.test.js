/**
 * phoenixStationsMap.test.js — тесты для карты станций и выбора станций (TDD: написаны ДО кода).
 * Запуск: node --test MTZ_S/tests/js/*.test.js  (или: cd MTZ_S/tests/js && node --test)
 *
 * Проверяют РЕАЛЬНЫЕ функции:
 *  - buildStationList(infos)        — дедупликация/нормализация списка станций (phoenixParser.js)
 *  - mapViewForStations(stations)   — центр и zoom карты по набору станций (phoenixParser.js)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { parseTbl, extractStationInfo, buildStationList, mapViewForStations } =
    await import('../../front/js/import/phoenix/phoenixParser.js');

const TEST_DATA_DIR = join(__dirname, '..', '..', 'mt_time_data');

// readFileSync(...).buffer отдаёт общий пул 8KB — режем точный срез (известный lesson)
function readExactBuffer(path) {
    const nb = readFileSync(path);
    return nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.length);
}

function info(file) {
    return extractStationInfo(parseTbl(readExactBuffer(join(TEST_DATA_DIR, file))));
}

describe('buildStationList', () => {
    test('из реальных TBL: станция с координатами проходит, Startup без id/координат — пропускается', () => {
        const list = buildStationList([info('DATA/1369712A.TBL'), info('DATA/Startup.tbl')]);
        assert.equal(list.length, 1);
        assert.equal(list[0].stationId, '1369712A');
        assert.ok(Math.abs(list[0].latitude - 56.2863) < 0.001);
        assert.ok(Math.abs(list[0].longitude - 99.2826) < 0.001);
    });

    test('fallbackNames даёт id станциям без FILE-тега', () => {
        const list = buildStationList(
            [info('DATA/1369712A.TBL'), info('DATA/Startup.tbl')],
            ['1369712A', 'Startup'],
        );
        assert.equal(list.length, 2);
        assert.equal(list[1].stationId, 'Startup');
        assert.equal(list[1].latitude, null); // координат нет — остаётся null
    });

    test('дедуплицирует станции по stationId (первая побеждает)', () => {
        const a = info('DATA/1369712A.TBL');
        const list = buildStationList([a, { ...a }]);
        assert.equal(list.length, 1);
    });

    test('отбрасывает записи без stationId и без координат', () => {
        const list = buildStationList([{}, { stationId: 'OK1', latitude: null, longitude: null }, null, undefined]);
        assert.equal(list.length, 1);
        assert.equal(list[0].stationId, 'OK1');
    });

    test('пустой/не-массив вход → пустой массив', () => {
        assert.deepEqual(buildStationList([]), []);
        assert.deepEqual(buildStationList(null), []);
    });
});

describe('mapViewForStations', () => {
    test('пустой список → null', () => {
        assert.equal(mapViewForStations([]), null);
        assert.equal(mapViewForStations(null), null);
    });

    test('одна станция → центр на ней, zoom 8', () => {
        const v = mapViewForStations([{ stationId: 'A', latitude: 56.28, longitude: 99.28 }]);
        assert.ok(v);
        assert.deepEqual(v.center, [56.28, 99.28]);
        assert.equal(v.zoom, 8);
    });

    test('пропускает станции без валидных координат', () => {
        const v = mapViewForStations([
            { stationId: 'BAD', latitude: NaN, longitude: 10 },
            { stationId: 'OK', latitude: 50, longitude: 30 },
        ]);
        assert.deepEqual(v.center, [50, 30]);
        assert.equal(v.zoom, 8);
    });

    test('несколько станций — дальний разброс: центр по bbox, низкий zoom', () => {
        const v = mapViewForStations([
            { stationId: 'A', latitude: 50.0, longitude: 90.0 },
            { stationId: 'B', latitude: 60.0, longitude: 100.0 },
        ]);
        assert.deepEqual(v.center, [55, 95]);
        assert.equal(v.zoom, 4); // spread 10° ≥ 5°
    });

    test('несколько станций — близкий разброс: zoom 8', () => {
        const v = mapViewForStations([
            { stationId: 'A', latitude: 56.280, longitude: 99.280 },
            { stationId: 'B', latitude: 56.300, longitude: 99.310 },
        ]);
        assert.ok(Math.abs(v.center[0] - 56.29) < 1e-9);
        assert.ok(v.zoom >= 7 && v.zoom <= 8);
    });

    test('средний разброс (0.5°–2°) → zoom 6', () => {
        const v = mapViewForStations([
            { stationId: 'A', latitude: 56.0, longitude: 99.0 },
            { stationId: 'B', latitude: 56.8, longitude: 99.9 },
        ]);
        assert.equal(v.zoom, 6);
    });
});
