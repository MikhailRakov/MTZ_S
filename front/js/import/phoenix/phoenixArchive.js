/**
 * phoenixArchive.js — локальный (браузерный) разбор архива «сырых» данных станции
 * Phoenix MTU-5A/V5-2000: контейнер → станции →Profiles.dat для вкладки «Profiles».
 *
 * Заменяет мёртвый серверный флоу (POST /raw-upload): здесь только распаковка и
 * распознавание файлов; DSP-часть (спектры импеданса, текст Profiles.dat) берёт
 * готовую сетку частот из opts.frequencies и считает через phoenixImpedance.js.
 *
 * Поддерживаемые входные items:
 *   - File/Blob zip-архива (.zip) → JSZip (window.JSZip, подключён в dashboard.html),
 *     если недоступен (Node/тесты) — собственный сканер локальных заголовков PK\x03\x04
 *     (методы 0 stored и 8 deflate; inflate через DecompressionStream('deflate-raw')
 *     или node:zlib), устойчивый к zip без читаемого EOCD (потоковая запись на карту).
 *   - File/Blob tar-архива (.tar) → 512-байтные блоки ustar (для d1.zip-подобных
 *     снапшотов карты, упакованных в tar).
 *   - File/Blob или {name, bytes|ArrayBuffer|Uint8Array} одиночного файла
 *     (.TBL/.TS2..TS5/.CLC/.CLB/.CLE) — уже распакованные записи.
 *
 * Распознавание станций: имя .TBL = базовый идентификатор (SNUM+буква, напр. 1332813A);
 * потоки привязываются по тому же базису имени независимо от раскладки каталогов
 * (DATA/, Data/, DAT/, Cal/...). Файлы без пары/неизвестных типов → unrecognized.
 *
 * ВАЖНО (проверено на MT_data_C_flash/d/d7/DATA): у каждой станции 1332812D/3A/3B/4A
 * три потока — .TS3 (Fs=2400), .TS4 (Fs=150), .TS5 (Fs=15) — НЕ одинаковые данные в
 * разных передискретизациях, а три независимых полосы записи (соотношение объёмов
 * файлов ≈ обратно пропорционально Fs, времена блоков перекрываются частично).
 * Для Profiles.dat каждый поток даёт свой вклад в частотную полосу [~0.002·Fs … 0.4·Fs];
 * в перекрытии приоритет у потока с бо́льшим Fs. Startup.tbl/DEFAULT.TBL (без 7-значного
 * SNUM) — конфигурация регистратора, не станция: помечается в unrecognized.
 *
 * Формат TS2..TS5 (подтверждено поблочно на d/d7/DATA/*.TS* и по MTU_utils/read_tsn.py):
 * повторяющиеся блоки tag(32) + Nscan·Nch·3 байт int24 LE, межстрочная интерляция
 * (запись-major), порядок каналов ex,ey,hx,hy,hz; Nscan == Fs (1-секундные блоки);
 *   tag[0..7]=сек,мин,час,день,мес,год2,день-нед,век-1; tag[8..9] box (u16LE);
 *   tag[10..11] Nscan (u16LE); tag[12] Nch(5); tag[13] Taglen(32); tag[14] status;
 *   tag[15] saturation; tag[18..19] Fs (u16LE); tag[20] units(0=В).
 * Блоки могут быть не непрерывны по времени — время каждого блока сохраняется.
 *
 * Калибровка counts→физ. единицы — только теги TBL (FSCV/EGN|HGN/HATT/HNOM/EXLN|EYLN)
 * через legacyChannelScale из phoenixImpedance.js; для ey добавлен учёт EYLN
 * (legacyChannelScale использует EXLN для обоих E-каналов — сохранено как есть,
 *  при EYLN≠EXLN расхождение ~EYLN/EXLN). CLC-амплитудная калибровка в этом пути
 * НЕ применяется (зафиксированное ограничение).
 */

import { parseTbl, extractStationInfo, parseCalFile } from './phoenixParser.js';
import {
    parseLegacyTsn, legacyChannelScale, estimateImpedanceSpectra,
    impedanceToAp3dmt, IMPEDANCE_TO_AP3DMT, buildPhoenixProfilesDat,
} from './phoenixImpedance.js';

// ===== Утилиты =====

const FS_BY_EXT = { '.ts2': 24000, '.ts3': 2400, '.ts4': 150, '.ts5': 15 };
const KNOWN_EXT_RE = /\.(tbl|ts[2345]|clc|clb|cle)$/i;

function cleanName(name) {
    return String(name ?? '').replace(/\\/g, '/');
}

function baseOf(name) {
    return name.split('/').pop() || name;
}

function extOf(name) {
    const m = baseOf(name).toLowerCase().match(/\.[a-z0-9_]+$/);
    return m ? m[0] : '';
}

function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x?.bytes) return toBytes(x.bytes);
    return null;
}

// ===== Распаковка контейнеров =====

async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const { inflateRawSync } = await import('node:zlib').catch(() => ({}));
    if (inflateRawSync) return new Uint8Array(inflateRawSync(Buffer.from(bytes)));
    throw new Error('Нет inflate (DecompressionStream/zlib) — распакуйте архив вручную');
}

/**
 * Нативный сканер ZIP: цепочка локальных заголовков PK\x03\x04 (устойчив к архивам
 * без читаемого EOCD). Методы 0 (stored) и 8 (deflate). При streaming-флаге 0x08
 * без центрального реестра размер до следующего заголовка — оценка.
 */
async function walkZipNative(buffer) {
    const u8 = toBytes(buffer) ?? new Uint8Array(await buffer.arrayBuffer());
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const dec = new TextDecoder('utf-8', { fatal: false });
    const out = [];
    const sigAt = (p) => p + 4 <= u8.length ? dv.getUint32(p, true) : 0;
    // если есть EOCD — идём по центральному реестру (точные размеры/смещения)
    let eocd = -1;
    const scanFrom = Math.max(0, u8.length - 66000);
    for (let p = u8.length - 22; p >= scanFrom; p--) {
        if (sigAt(p) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd >= 0) {
        const cnt = dv.getUint16(eocd + 10, true);
        let off = dv.getUint32(eocd + 16, true);
        for (let i = 0; i < cnt && off + 46 <= u8.length; i++) {
            if (sigAt(off) !== 0x02014b50) break;
            const method = dv.getUint16(off + 10, true);
            let compSize = dv.getUint32(off + 20, true);
            const nameLen = dv.getUint16(off + 28, true);
            const extraLen = dv.getUint16(off + 30, true);
            const commentLen = dv.getUint16(off + 32, true);
            const lho = dv.getUint32(off + 42, true);
            const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
            if (name && !name.endsWith('/') && compSize > 0 && sigAt(lho) === 0x04034b50) {
                const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true);
                const dataStart = lho + 30 + lnl + lel;
                const raw = u8.subarray(dataStart, dataStart + compSize);
                try {
                    out.push({ name, bytes: method === 0 ? raw.slice() : await inflateRaw(raw) });
                } catch (err) { console.warn(`[ARCHIVE] inflate failed for ${name}:`, err); }
            }
            off += 46 + nameLen + extraLen + commentLen;
        }
        if (out.length) return out;
    }
    // цепочка локальных заголовков
    let pos = 0;
    while (pos + 30 <= u8.length && sigAt(pos) === 0x04034b50) {
        const flags = dv.getUint16(pos + 6, true);
        const method = dv.getUint16(pos + 8, true);
        let compSize = dv.getUint32(pos + 18, true);
        const nameLen = dv.getUint16(pos + 26, true);
        const extraLen = dv.getUint16(pos + 28, true);
        const name = dec.decode(u8.subarray(pos + 30, pos + 30 + nameLen));
        const dataStart = pos + 30 + nameLen + extraLen;
        if (!(flags & 0x08) && compSize === 0) {
            let next = dataStart;
            while (next + 4 <= u8.length && sigAt(next) !== 0x04034b50 && sigAt(next) !== 0x02014b50 && sigAt(next) !== 0x06054b50) next++;
            compSize = next - dataStart;
        }
        const raw = u8.subarray(dataStart, dataStart + Math.min(compSize, u8.length - dataStart));
        try {
            if (method === 0) out.push({ name, bytes: raw.slice() });
            else if (method === 8) out.push({ name, bytes: await inflateRaw(raw) });
        } catch (err) { console.warn(`[ARCHIVE] inflate failed for ${name}:`, err); }
        pos = dataStart + compSize + ((flags & 0x08) ? 16 : 0);
    }
    return out;
}

async function walkZip(buffer) {
    if (typeof window !== 'undefined' && window.JSZip) {
        try {
            const zip = await window.JSZip.loadAsync(buffer instanceof Uint8Array ? buffer : buffer);
            const out = [];
            const promises = [];
            zip.forEach((path, entry) => {
                if (entry.dir) return;
                promises.push(entry.async('uint8array').then((bytes) => out.push({ name: path, bytes })));
            });
            await Promise.all(promises);
            return out;
        } catch (err) {
            console.warn('[ARCHIVE] JSZip failed, falling back to native scanner:', err);
        }
    }
    return walkZipNative(buffer);
}

/** TAR (ustar/7-digit-safe): 512-байтные заголовки, октальные поля, GNU longname 'L'. */
function walkTar(buffer) {
    const u8 = toBytes(buffer);
    const dec = new TextDecoder('utf-8', { fatal: false });
    const out = [];
    let off = 0;
    let pendingLongName = null;
    const cstr = (s, start, len) => { const seg = s.subarray(start, start + len); const z = seg.indexOf(0); return dec.decode(z < 0 ? seg : seg.subarray(0, z)).trim(); };
    const oct = (s, start, len) => parseInt(cstr(s, start, len), 8) || 0;
    while (off + 512 <= u8.length) {
        const h = u8.subarray(off, off + 512);
        if (h.every((x) => x === 0)) break;
        const name = cstr(h, 0, 100);
        const size = oct(h, 124, 12);
        const typeFlag = String.fromCharCode(h[156] || 0x30);
        const prefix = cstr(h, 345, 155);
        let dataStart = off + 512;
        let fullName = prefix ? `${prefix}/${name}` : name;
        if (typeFlag === 'L') { // GNU long name
            pendingLongName = dec.decode(u8.subarray(dataStart, dataStart + size)).replace(/\0+$/, '');
            off = dataStart + Math.ceil(size / 512) * 512;
            continue;
        }
        if (typeFlag === 'x' || typeFlag === 'g') { off = dataStart + Math.ceil(size / 512) * 512; continue; } // PAX — имена у нас ASCII
        if (pendingLongName) { fullName = pendingLongName; pendingLongName = null; }
        if ((typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') && size > 0 && fullName) {
            out.push({ name: fullName, bytes: u8.slice(dataStart, dataStart + size) });
        }
        off = dataStart + Math.ceil(size / 512) * 512;
    }
    return out;
}

/** item → плоский список {name, bytes}. */
async function expandItem(item) {
    if (!item) return [];
    if (Array.isArray(item)) {
        const all = [];
        for (const one of item) all.push(...await expandItem(one));
        return all;
    }
    const name = cleanName(item.name ?? item.fileName ?? '');
    const bytes = toBytes(item);
    if (/\.(zip|tar)$/i.test(name) || (!bytes && typeof item.arrayBuffer === 'function' && /\.(zip|tar)$/i.test(name))) {
        const buf = bytes ?? new Uint8Array(await item.arrayBuffer());
        return /\.zip$/i.test(name) ? await walkZip(buf) : walkTar(buf);
    }
    if (bytes) return [{ name, bytes }];
    if (typeof item.arrayBuffer === 'function') {
        const buf = new Uint8Array(await item.arrayBuffer());
        if (/\.zip$/i.test(name)) return await walkZip(buf);
        if (/\.tar$/i.test(name)) return walkTar(buf);
        return [{ name, bytes: buf }];
    }
    return [];
}

// ===== Сборка станций =====

const STATION_KEY_RE = /^0?(\d{7})([A-Z])(?=\.[A-Z0-9]+$)/i;

/** '1332813A.TS4' → {id:'1332813A', snum:'1332813'}; 'Startup.tbl' → null.
 *  Ведущий ноль в имени потока (01332813A) нормализуется — TBL обычно без него. */
function stationKeyFrom(base) {
    const m = baseOf(base).match(STATION_KEY_RE);
    if (!m) return null;
    const id = (m[1] + m[2]).toUpperCase();
    return { id, snum: m[1] };
}

/**
 * Основной вход. items — File/Blob/{name,bytes} (zip/tar-контейнер, одиночные файлы,
 * массив всего вместе). Возвращает recognition-слой: ничего не считает, только
 * распознаёт и разбирает заголовки.
 * @returns {Promise<{stations: Array, unrecognized: Array, warnings: string[]}>}
 */
export async function parsePhoenixArchive(items) {
    const entries = await expandItem(items);
    const warnings = [];
    const unrecognized = [];
    /** @type {Map<string, {id:string, snum:string, tbl:object|null, streams:object[], cals:object[]}>} */
    const byStation = new Map();
    const ensure = (key) => {
        if (!byStation.has(key.id)) byStation.set(key.id, { ...key, tbl: null, streams: [], cals: [] });
        return byStation.get(key.id);
    };

    for (const e of entries) {
        const base = baseOf(e.name);
        if (!base || !KNOWN_EXT_RE.test(base) || e.bytes.length === 0) {
            if (base) unrecognized.push({ name: e.name, reason: 'нераспознанный файл или пустая запись' });
            continue;
        }
        const key = stationKeyFrom(base);
        const ext = extOf(base);
        if (!key) { // Startup.tbl / DEFAULT.TBL / конфигурация — не станция
            unrecognized.push({ name: e.name, reason: ext === '.tbl' ? 'конфигурация регистратора, не станция' : 'имя без идентификатора станции' });
            continue;
        }
        const st = ensure(key);
        if (ext === '.tbl') {
            if (st.tbl) warnings.push(`повторный .TBL для ${key.id}: ${e.name}`);
            else st.tbl = { name: e.name, bytes: e.bytes };
        } else if (/^\.ts[2345]$/.test(ext)) {
            const rec = { name: e.name, bytes: e.bytes, ext, fsHint: FS_BY_EXT[ext], parsed: null, error: null };
            try {
                rec.parsed = parseLegacyTsn(e.bytes);
                // контракт parseLegacyTsn: { blocks:[{fs,nch,nscan,boxnum,datetime,channelOrder,channels}] }
                const fs0 = rec.parsed.blocks[0]?.fs;
                if (fs0 !== FS_BY_EXT[ext]) {
                    warnings.push(`${base}: Fs=${fs0} в заголовке не равен ожидаемому для ${ext} (${FS_BY_EXT[ext]})`);
                }
            } catch (err) {
                rec.error = String(err?.message || err);
                warnings.push(`${base}: разбор потока не удался (${rec.error})`);
            }
            st.streams.push(rec);
        } else { // .clc/.clb/.cle
            st.cals.push({ name: e.name, bytes: e.bytes, parsed: null });
        }
    }

    const stations = [...byStation.values()].map((st) => {
        let info = null, tags = {};
        if (st.tbl) {
            try {
                const parsedTbl = parseTbl(st.tbl.bytes);
                info = extractStationInfo(parsedTbl);
                tags = parsedTbl.tags ?? {};
            } catch (err) {
                warnings.push(`${st.id}: разбор TBL не удался (${err?.message || err})`);
            }
        } else {
            warnings.push(`${st.id}: нет .TBL — только потоки, калибровка counts недоступна`);
        }
        for (const c of st.cals) {
            try { c.parsed = parseCalFile(c.bytes); } catch { /* CLB/CLT могут быть не кривыми — молча пропускаем */ }
        }
        return {
            id: st.id,
            snum: st.snum,
            hasTbl: !!st.tbl,
            tblName: st.tbl?.name ?? null,
            info,
            tags,
            streams: st.streams.filter((s) => s.parsed),
            streamsFailed: st.streams.filter((s) => !s.parsed).map((s) => ({ name: s.name, error: s.error })),
            cals: st.cals.map((c) => ({ name: c.name, parsed: c.parsed })),
        };
    });
    stations.sort((a, b) => a.id.localeCompare(b.id));
    return { stations, unrecognized, warnings };
}

// ===== Единицы каналов =====

/**
 * Множитель counts→физ. единица канала с учётом EYLN для ey
 * (legacyChannelScale берёт EXLN для обоих E — при EYLN≠EXLN было бы расхождение).
 * @returns {{factor:number, unit:string}|null}
 */
export function legacyChannelScaleFor(tags, channel) {
    if (channel !== 'ey') return legacyChannelScale(tags, channel);
    const eg = legacyChannelScale(tags, 'ey');
    if (!eg) return null;
    const fscv = tags?.FSCV;
    const egain = tags?.EGN ?? 1e6;
    const eyln = typeof tags?.EYLN === 'number' ? tags.EYLN : null;
    if (!Number.isFinite(fscv) || !Number.isFinite(egain) || egain === 0 || !eyln) return eg;
    const base = fscv / Math.pow(2, 23) * 1000; // мВ на count
    return { unit: 'mV/km', factor: base / egain / eyln * 1000 };
}

/**
 * Поток (результат parseLegacyTsn: {blocks:[…]}) → {ex:{data,unit}, …} в физ. единицах.
 * Блоки склеиваются ПО РЯДКУ В ФАЙЛЕ (Phoenix пишет их хронологически; per-block усреднение
 * спектров делает estimateImpedanceSpectra своими окнами). Единицы каналов — из TBL-тегов
 * (FSCV/EGN/EXLN|EYLN/HGN/HATT/HNOM); без них остаётся counts с предупреждением на уровне вызова.
 */
export function streamToPhysicalUnits(parsed, tags) {
    const blocks = parsed?.blocks ?? [];
    if (!blocks.length) throw new Error('поток не разобран: нет блоков');
    const names = blocks[0].channelOrder ?? ['ex', 'ey', 'hx', 'hy', 'hz'];
    const lenOf = (b, n) => b.channels?.[n]?.length ?? 0;
    const out = {};
    for (const name of names) {
        const total = blocks.reduce((s, b) => s + lenOf(b, name), 0);
        const sc = legacyChannelScaleFor(tags, name);
        const data = new Float64Array(total);
        let pos = 0;
        for (const b of blocks) {
            const counts = b.channels?.[name];
            if (!counts || !counts.length) continue;
            if (sc) for (let k = 0; k < counts.length; k++) data[pos++] = counts[k] * sc.factor;
            else { data.set(counts, pos); pos += counts.length; }
        }
        out[name] = { data: pos === total ? data : data.subarray(0, pos), unit: sc?.unit ?? 'counts', scaled: !!sc };
    }
    return out;
}

// ===== Спектры станции =====

/** Стандартная MT-сетка периодов (с), ~5/дек., 2·10⁻⁴…2·10⁴ — строка "T1 T2 ..." как в imp.py. */
export const STANDARD_PERIODS = (() => {
    const out = [];
    for (let d = -4; d <= 4; d += 0.2) out.push(Number((10 ** d).toPrecision(6)));
    return out;
})();

function dedupFrac(f) {
    return f.toPrecision(8);
}

/**
 * Спектры Zxy (и полного тензора) станции: каждый пригодный поток даёт строки на
 * сетке opts.frequencies (по умолчанию STANDARD_PERIODS∩полоса потока), перекрытие
 * разрешается в пользу потока с бо́льшим Fs. Значения — в конвенции exp(+iωt) и
 * единицах E/H-каналов (mV/km / nT); конвенцию AP3DMT применяет вызывающий.
 * @returns {Promise<{rows: Array, notes: string[], perStream: Array}>}
 */
export async function buildStationSpectra(station, opts = {}) {
    const notes = [];
    const base = (opts.frequencies ?? STANDARD_PERIODS).map((f) => Number(f));
    const hiFsFirst = station.streams.slice().sort((a, b) => (b.parsed?.blocks?.[0]?.fs ?? 0) - (a.parsed?.blocks?.[0]?.fs ?? 0));
    const byFreq = new Map();
    const perStream = [];
    for (const s of hiFsFirst) {
        const phys = streamToPhysicalUnits(s.parsed, station.tags);
        const need = ['ex', 'ey', 'hx', 'hy'];
        if (!need.every((k) => phys[k])) { notes.push(`${baseOf(s.name)}: нет каналов ${need.filter((k) => !phys[k]).join(',')}`); continue; }
        if (!need.every((k) => phys[k].scaled) && station.hasTbl) notes.push(`${baseOf(s.name)}: часть E/H-масштабов не определена из TBL — значения в counts`);
        const fs = s.parsed.blocks[0]?.fs;
        if (!Number.isFinite(fs)) { notes.push(`${baseOf(s.name)}: нет Fs в блоках`); continue; }
        // полоса потока: f ∈ (0.002·Fs … 0.4·Fs), т.е. T ∈ (2.5/Fs … 500/Fs)
        const grid = base.filter((p) => Number.isFinite(p) && p > 0)
            .map((p) => 1 / p)
            .filter((f) => f >= 0.002 * fs && f <= 0.4 * fs);
        if (!grid.length) { notes.push(`${baseOf(s.name)}: сетка частот вне полосы (Fs=${fs})`); continue; }
        let spectra;
        try {
            spectra = estimateImpedanceSpectra({
                channels: { ex: phys.ex.data, ey: phys.ey.data, hx: phys.hx.data, hy: phys.hy.data },
                fs,
                frequencies: grid,
                windowSize: opts.windowSize,
                overlap: opts.overlap,
            });
        } catch (err) { notes.push(`${baseOf(s.name)}: DSP сбой (${err?.message || err})`); continue; }
        perStream.push({ name: s.name, fs, n: phys.ex.data.length, rows: spectra.length });
        const seenThisStream = new Map();
        for (const row of spectra) {
            if (row.degenerate) continue;
            const key = dedupFrac(row.freq);
            if (byFreq.has(key)) continue;            // более высокочастотный поток уже выиграл
            if (seenThisStream.has(key)) continue;    // бины сетки схлопнулись в один FFT-бин — первый ближе к запросу
            seenThisStream.set(key, row.requestedFreq ?? row.freq);
            byFreq.set(key, row);
        }
    }
    const rows = [...byFreq.values()].sort((a, b) => b.period - a.period);
    if (!rows.length) notes.push('спектры не получены ни из одного потока');
    return { rows, notes, perStream };
}

// ===== Profiles.dat =====

/** Простейшая плоская проекция lat/lon → локальные x/y (м), эquirectangular вокруг origin. */
function projectToLocal(lat, lon, origin) {
    const toRad = Math.PI / 180;
    const x = (lon - origin.lon) * 111320 * Math.cos(origin.lat * toRad);
    const y = (lat - origin.lat) * 110540;
    return { x, y };
}

function numOrNull(v) {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim());
    return Number.isFinite(n) ? n : null;
}

/**
 * Полный выход «распознанный архив → текст Profiles.dat».
 * @param {Awaited<ReturnType<parsePhoenixArchive>>> parsed — результат parsePhoenixArchive
 * @param {object} opts
 *   - stationFilter: (stationId)=>boolean — какие станции включить (вкладка Profiles);
 *   - coordinateOverrides: {stationId: {latitude, longitude, elevation}} — правки формы;
 *   - frequencies: базовая сетка периодов; windowSize/overlap — DSP;
 *   - origin: {lat, lon} — точка проекции (по умолчанию первая станция).
 * @returns {{text: string, used: string[], skipped: Array<{id, reason}>, notes: string[]}}
 */
export async function generatePhoenixProfilesDat(parsed, opts = {}) {
    const warnings = [];
    const usable = (parsed.stations ?? []).filter(
        (st) => (opts.stationFilter ? opts.stationFilter(st.id) : true)
    );
    const skipped = [];
    const built = [];
    const withCoord = [];
    for (const st of usable) {
        const co = opts.coordinateOverrides?.[st.id] ?? {};
        const lat = numOrNull(co.latitude ?? st.info?.latitude);
        const lon = numOrNull(co.longitude ?? st.info?.longitude);
        const elev = numOrNull(co.elevation ?? st.info?.elevation);
        const dec = numOrNull(co.declination ?? st.info?.declination);
        if (lat === null || lon === null) {
            skipped.push({ id: st.id, reason: 'нет координат (проверьте TBL или заполните форму)' });
            continue;
        }
        withCoord.push({ st, lat, lon, elev, dec });
    }
    if (!withCoord.length) {
        return { text: '', used: [], skipped, notes: warnings };
    }
    const origin = opts.origin ?? { lat: withCoord[0].lat, lon: withCoord[0].lon };
    for (const { st, lat, lon, elev, dec } of withCoord) {
        const { rows, notes } = await buildStationSpectra(st, opts);
        warnings.push(...notes.map((n) => `${st.id}: ${n}`));
        if (!rows.length) { skipped.push({ id: st.id, reason: 'нет спектров (см. warnings)' }); continue; }
        const { x, y } = projectToLocal(lat, lon, origin);
        // строки → тензорные массивы в конвенции AP3DMT
        const zc = (v) => impedanceToAp3dmt(v);
        built.push({
            station: {
                code: st.id,
                lat, lon, x, y, z: elev ?? 0,
                declination: dec ?? 0,
                periods: rows.map((r) => r.period),
                zxx: rows.map((r) => zc(r.zxx)),
                zxy: rows.map((r) => zc(r.zxy)),
                zyx: rows.map((r) => zc(r.zyx)),
                zyy: rows.map((r) => zc(r.zyy)),
                coherence: rows.map((r) => r.coherence.zxy),
                // AP3DMT-строка ошибки: writer читает st.error[k][comp] (zxy и т.д.)
                error: rows.map((r) => ({ ...r.error })),
            },
            rows,
        });
    }
    if (!built.length) {
        return { text: '', used: [], skipped, notes: warnings };
    }
    // Общая сетка периодов для buildPhoenixProfilesDat: берём периоды станции-«донора»
    // с максимумом строк, остальные пересобираем на неё линейной интерполяцией по 1/√f.
    built.sort((a, b) => b.station.periods.length - a.station.periods.length);
    const master = built[0].station.periods.slice(); // уже desc
    const aligned = built.map((b) => alignToPeriods(b.station, master));
    const text = buildPhoenixProfilesDat(aligned.map((a) => a.station), master, {
        impedanceScale: opts.impedanceScale ?? IMPEDANCE_TO_AP3DMT,
    });
    return {
        text,
        used: aligned.map((a) => a.station.code),
        skipped,
        notes: warnings,
    };
}

function interpComplex(rows, targetPeriod) {
    if (!rows.length) return { re: NaN, im: NaN };
    // rows: [{period, value}] — value либо {re,im}, либо скаляр (coherence/error)
    const lp = Math.log10(targetPeriod);
    let lo = null, hi = null;
    for (const r of rows) {
        if (r.period <= targetPeriod && (!lo || r.period > lo.period)) lo = r;
        if (r.period >= targetPeriod && (!hi || r.period < hi.period)) hi = r;
    }
    const pick = (r) => (r && (r.value === 0 || r.value) ? r.value : null);
    const a = pick(lo) ?? pick(hi), b = pick(hi) ?? pick(lo);
    if (a === null) return { re: NaN, im: NaN };
    const at = (v) => (typeof v === 'number' ? v : v.re);
    if (b === null || a === b) return { re: at(a), im: typeof a === 'number' ? 0 : a.im };
    const la = Math.log10(lo ? lo.period : hi.period), lb = Math.log10(hi ? hi.period : lo.period);
    const t = la === lb ? 0 : (lp - la) / (lb - la);
    const at2 = (v) => (typeof v === 'number' ? v : v.im);
    return { re: at(a) + (at(b) - at(a)) * t, im: at2(a) + (at2(b) - at2(a)) * t };
}

function interpScalar(rows, targetPeriod) {
    if (!rows.length) return NaN;
    const lp = Math.log10(targetPeriod);
    let lo = null, hi = null;
    for (const r of rows) {
        if (r.value === null || r.value === undefined || !Number.isFinite(r.value)) continue;
        if (r.period <= targetPeriod && (!lo || r.period > lo.period)) lo = r;
        if (r.period >= targetPeriod && (!hi || r.period < hi.period)) hi = r;
    }
    if (!lo && !hi) return NaN;
    if (!lo || !hi || lo === hi) return (lo ?? hi).value;
    const la = Math.log10(lo.period), lb = Math.log10(hi.period);
    const t = la === lb ? 0 : (lp - la) / (lb - la);
    return lo.value + (hi.value - lo.value) * t;
}

function alignToPeriods(station, masterPeriods) {
    // если периоды уже равны мастеру — без изменений
    if (station.periods.length === masterPeriods.length && station.periods.every((p, i) => p === masterPeriods[i])) {
        return { station, exact: true };
    }
    const mk = (key) => station.periods.map((p, i) => ({ period: p, value: station[key][i] }));
    const rows = { zxx: mk('zxx'), zxy: mk('zxy'), zyx: mk('zyx'), zyy: mk('zyy') };
    const cohRows = station.periods.map((p, i) => ({ period: p, value: station.coherence[i] }));
    const errRows = station.periods.map((p, i) => ({ period: p, value: station.error[i] }));
    const errComp = (c) => masterPeriods.map((p) => {
        const rr = errRows.map((r) => ({ period: r.period, value: r.value?.[c] ?? NaN }));
        return interpScalar(rr, p);
    });
    const eByComp = { zxx: errComp('zxx'), zxy: errComp('zxy'), zyx: errComp('zyx'), zyy: errComp('zyy') };
    return {
        station: {
            ...station,
            periods: masterPeriods,
            zxx: masterPeriods.map((p) => interpComplex(rows.zxx, p)),
            zxy: masterPeriods.map((p) => interpComplex(rows.zxy, p)),
            zyx: masterPeriods.map((p) => interpComplex(rows.zyx, p)),
            zyy: masterPeriods.map((p) => interpComplex(rows.zyy, p)),
            coherence: masterPeriods.map((p) => interpScalar(cohRows, p)),
            error: masterPeriods.map((_, i) => ({
                zxx: eByComp.zxx[i], zxy: eByComp.zxy[i],
                zyx: eByComp.zyx[i], zyy: eByComp.zyy[i],
            })),
        },
        exact: false,
    };
}
