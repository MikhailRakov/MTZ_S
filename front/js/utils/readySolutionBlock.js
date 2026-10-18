// Блок "Готовые решения": история версий результатов (все .zip архивы
// запусков), выбор конкретной версии, её скачивание/распаковка и просмотр
// .vtr файлов в браузере.
//
// Результаты каждого запуска хранятся в S3 отдельно:
//   users/{uid}/solutions/{sid}/results/{version}/all_models.zip
// Список версий запрашивается с GET /solutions/{sid}/versions; при
// недоступности эндпоинта версии выводятся из плоского списка файлов.
//
// Распакованные .vtr сохраняются в IndexedDB с ключом, включающим ВЕРСИЮ —
// одноимённые файлы разных запусков не перетирают друг друга.
import { showVtrViewer } from './vtrViewer.js';

const DB_NAME = 'mtz_solutions';
const DB_STORE = 'vtr_files';
const KEY_PREFIX = 'mtz_vtr:';

let initialized = false;
let currentSolutionId = null;
let currentIdToken = null;
// Список версий (новые первыми): {version, name, key, size, last_modified, legacy}
let versions = [];
// Выбранная версия и её архив
let currentVersion = null;
let zipFileInfo = null;
// Свободно лежащие .vtr старого формата (вне архивов) — показываются для legacy
let lastS3VtrFiles = [];
let dbPromise = null;
// Последний отрисованный список — чтобы не перестраивать DOM без изменений
let lastRenderedSignature = null;

// === Обёртка над IndexedDB ===

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(DB_STORE)) {
                    db.createObjectStore(DB_STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        // Не кэшируем отклонённый промис — тогда повторная попытка сработает заново
        dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
}

// Ключ кэша включает версию: mtz_vtr:{sid}:{version}:{name}
function cacheKey(solutionId, version, name) {
    return `${KEY_PREFIX}${solutionId}:${version}:${name}`;
}

async function cacheVtr(solutionId, version, name, text) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(text, cacheKey(solutionId, version, name));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function readCachedVtr(solutionId, version, name) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(DB_STORE, 'readonly')
            .objectStore(DB_STORE)
            .get(cacheKey(solutionId, version, name));
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

async function getCachedVtrNames(solutionId, version) {
    const db = await openDb();
    const prefix = cacheKey(solutionId, version, '');
    return new Promise((resolve, reject) => {
        const req = db.transaction(DB_STORE, 'readonly')
            .objectStore(DB_STORE)
            .getAllKeys();
        req.onsuccess = () => {
            resolve((req.result || [])
                .filter(k => typeof k === 'string' && k.startsWith(prefix))
                .map(k => k.slice(prefix.length)));
        };
        req.onerror = () => reject(req.error);
    });
}

// Удаляет записи кэша старого формата (mtz_vtr:{sid}:{name} — без версии):
// они больше не читаются и только занимают место в IndexedDB.
async function cleanupLegacyCache(solutionId) {
    try {
        const db = await openDb();
        const prefix = `${KEY_PREFIX}${solutionId}:`;
        const keys = await new Promise((resolve, reject) => {
            const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        const stale = keys.filter(k =>
            typeof k === 'string' && k.startsWith(prefix) && !k.slice(prefix.length).includes(':'));
        if (stale.length === 0) return;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            stale.forEach(k => store.delete(k));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        console.log(`[READY SOLUTION] Удалено устаревших записей кэша: ${stale.length}`);
    } catch (err) {
        console.warn('[READY SOLUTION] Очистка устаревшего кэша не удалась:', err);
    }
}

// === Загрузка списка версий ===

async function fetchVersions(solutionId, idToken, files) {
    try {
        const res = await fetch(`/api/users/self/solutions/${solutionId}/versions`, {
            headers: { 'Authorization': `Bearer ${idToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.versions)) return data.versions;
        }
    } catch (err) {
        console.warn('[READY SOLUTION] Эндпоинт версий недоступен, использую список файлов:', err);
    }
    // Запасной путь: собрать версии из плоского списка файлов results/
    return (files || [])
        .filter(f => f.name && f.name.toLowerCase().endsWith('.zip'))
        .map(f => {
            const parts = (f.key || '').split('/');
            // .../results/<version>/all_models.zip → version; .../results/all_models.zip → legacy
            const isVersioned = parts.length >= 2 && parts[parts.length - 2] !== 'results';
            return {
                version: isVersioned ? parts[parts.length - 2] : 'legacy',
                name: f.name,
                key: f.key,
                size: f.size,
                last_modified: f.last_modified,
                legacy: !isVersioned,
            };
        })
        .sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
}

function formatVersionDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'дата неизвестна';
    return d.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function formatSize(bytes) {
    if (bytes == null) return '';
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Отображает блок истории версий результата
export async function displayReadySolution(files, solutionId, idToken) {
    const container = document.getElementById('ready-solution-container');
    if (!container) return;

    currentSolutionId = solutionId;
    currentIdToken = idToken;
    lastRenderedSignature = null;

    if (!initialized) {
        initialized = true;
        setupHandlers();
    }

    // Свободно лежащие .vtr (старый формат загрузки) — дополняют legacy-версию
    lastS3VtrFiles = (files || []).filter(f => f.name && f.name.toLowerCase().endsWith('.vtr'));

    versions = await fetchVersions(solutionId, idToken, files);
    cleanupLegacyCache(solutionId); // не блокируем отрисовку

    const countBadge = document.getElementById('ready-versions-count');
    if (countBadge) {
        countBadge.textContent = versions.length > 0 ? `${versions.length} верс.` : '';
    }

    if (versions.length === 0 && lastS3VtrFiles.length === 0) {
        container.classList.add('hidden');
        return;
    }

    renderVersionSelect();
    // Автоматически выбираем самую свежую версию (список отсортирован)
    selectVersion(versions[0] || null);

    setStatus('');
    container.classList.remove('hidden');
}

function setupHandlers() {
    document.getElementById('download-results-zip-btn')?.addEventListener('click', downloadZip);
    document.getElementById('extract-zip-btn')?.addEventListener('click', extractZip);
    document.getElementById('result-version-select')?.addEventListener('change', (e) => {
        const idx = parseInt(e.target.value, 10);
        selectVersion(versions[idx] || null);
    });
    // Делегирование кликов по кнопкам просмотра: обработчик живёт на контейнере
    // и переживает идемпотентные перерисовки списка.
    document.getElementById('vtr-files-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-view');
        if (!btn) return;
        viewVtr(btn.dataset.vtrName, btn.dataset.vtrKey || null);
    });
}

function renderVersionSelect() {
    const select = document.getElementById('result-version-select');
    if (!select) return;

    select.innerHTML = '';
    versions.forEach((v, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        const label = v.legacy
            ? `Старый архив (без версии) — ${formatVersionDate(v.last_modified)}`
            : `Расчёт от ${formatVersionDate(v.last_modified)}`;
        opt.textContent = idx === 0 ? `${label} · последняя` : label;
        select.appendChild(opt);
    });
    select.disabled = versions.length === 0;
}

// Выбор версии: включает кнопки архива и показывает его распакованное
// содержимое (если оно уже есть в кэше браузера)
async function selectVersion(version) {
    currentVersion = version;
    zipFileInfo = version
        ? { name: version.name, key: version.key, size: version.size }
        : null;

    const info = document.getElementById('result-version-info');
    if (info) {
        info.textContent = version
            ? [formatSize(version.size), formatVersionDate(version.last_modified)].filter(Boolean).join(' • ')
            : '';
    }

    const zipBtn = document.getElementById('download-results-zip-btn');
    const extractBtn = document.getElementById('extract-zip-btn');
    if (zipBtn) {
        if (zipFileInfo) {
            zipBtn.classList.remove('hidden');
            zipBtn.disabled = false;
            zipBtn.textContent = `💾 Скачать архив (${zipFileInfo.name})`;
        } else {
            zipBtn.classList.add('hidden');
        }
    }
    if (extractBtn) {
        if (zipFileInfo) {
            extractBtn.classList.remove('hidden');
            extractBtn.disabled = false;
            extractBtn.textContent = '📂 Распаковать архив';
        } else {
            extractBtn.classList.add('hidden');
        }
    }

    await renderVtrList();
}

// Список .vtr файлов ВЫБРАННОЙ версии: из кэша браузера + свободно лежащие
// в S3 (для legacy). Идемпотентно: при том же составе DOM не перестраивается.
async function renderVtrList() {
    const list = document.getElementById('vtr-files-list');
    if (!list) return;

    if (!currentVersion) {
        // Версий нет, но есть свободные .vtr старого формата
        const looseItems = lastS3VtrFiles.map(f => ({ name: f.name, key: f.key, size: f.size, cached: false }));
        const looseSig = 'loose:' + looseItems.map(it => `${it.name}|${it.key || ''}`).join('\n');
        if (looseSig !== lastRenderedSignature) {
            lastRenderedSignature = looseSig;
            renderVtrItems(list, looseItems);
        }
        return;
    }

    let cachedNames = [];
    try {
        cachedNames = await getCachedVtrNames(currentSolutionId, currentVersion.version);
    } catch (err) {
        console.warn('[READY SOLUTION] IndexedDB недоступен, кэш не используется:', err);
    }

    const items = cachedNames.map(name => ({ name, key: null, size: null, cached: true }));
    // Для legacy-версии добавляем свободно лежащие .vtr из S3 (без дублей)
    if (currentVersion.legacy) {
        for (const f of lastS3VtrFiles) {
            if (!items.some(it => it.name === f.name)) {
                items.push({ name: f.name, key: f.key, size: f.size, cached: false });
            }
        }
    }

    const signature = `${currentVersion.version}:` + items.map(it => `${it.name}|${it.key || ''}|${it.cached}`).join('\n');
    if (signature === lastRenderedSignature) return;
    lastRenderedSignature = signature;

    renderVtrItems(list, items);
}

function renderVtrItems(list, items) {
    if (items.length === 0) {
        list.innerHTML = currentVersion
            ? '<p class="text-muted">Архив выбран, но ещё не распакован. Нажмите «📂 Распаковать архив», чтобы посмотреть 3D-модели этой версии в браузере.</p>'
            : '<p class="text-muted">Файлы .vtr появятся здесь после распаковки архива результатов</p>';
        return;
    }

    const frag = document.createDocumentFragment();
    items.forEach(item => {
        const sizeStr = item.size != null ? `${(item.size / (1024 * 1024)).toFixed(2)} MB • ` : '';
        const cachedStr = item.cached ? ' • сохранён в браузере' : '';
        const el = document.createElement('div');
        el.className = 'file-card';
        el.innerHTML = `
            <div class="file-info">
                <strong>${item.name}</strong><br>
                <small>${sizeStr}3D модель${cachedStr}</small>
            </div>
            <div class="file-actions">
                <button class="btn-view" data-vtr-name="${item.name}" data-vtr-key="${item.key || ''}">👁 Просмотр 3D</button>
            </div>
        `;
        frag.appendChild(el);
    });

    list.innerHTML = '';
    list.appendChild(frag);
}

// Просмотр .vtr выбранной версии: сначала кэш браузера, иначе — из S3
async function viewVtr(name, key) {
    if (!currentVersion && !key) {
        setStatus('Сначала выберите архив с решением', true);
        return;
    }
    try {
        let text = null;
        if (currentVersion) {
            try {
                text = await readCachedVtr(currentSolutionId, currentVersion.version, name);
            } catch (err) {
                console.warn('[READY SOLUTION] Не удалось прочитать кэш:', err);
            }
        }

        if (!text && key) {
            setStatus(`Загрузка ${name}...`);
            const response = await fetch(`/api/users/self/solutions/${currentSolutionId}/files/${encodeURIComponent(key)}`, {
                headers: { 'Authorization': `Bearer ${currentIdToken}` }
            });
            if (!response.ok) throw new Error('Не удалось загрузить файл');
            text = await response.text();
            if (currentVersion) {
                try {
                    await cacheVtr(currentSolutionId, currentVersion.version, name, text);
                    renderVtrList();
                } catch (err) {
                    console.warn(`[READY SOLUTION] Не удалось сохранить ${name} в кэш:`, err);
                }
            }
            setStatus('');
        }

        if (!text) {
            throw new Error('Файл не найден в кэше браузера — распакуйте архив выбранной версии');
        }

        showVtrViewer(text, name);
    } catch (error) {
        console.error('[READY SOLUTION] Ошибка просмотра .vtr:', error);
        setStatus(`Ошибка: ${error.message}`, true);
    }
}

// Скачивание .zip архива выбранной версии из S3
async function downloadZip() {
    if (!zipFileInfo || !currentVersion) return;
    const btn = document.getElementById('download-results-zip-btn');
    try {
        btn.disabled = true;
        btn.textContent = '⏳ Скачивание...';

        const response = await fetch(`/api/users/self/solutions/${currentSolutionId}/files/${encodeURIComponent(zipFileInfo.key)}`, {
            headers: { 'Authorization': `Bearer ${currentIdToken}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        // Имя файла дополняем версией, чтобы архивы разных запусков не
        // перетирали друг друга в загрузках браузера
        const baseName = zipFileInfo.name.replace(/\.zip$/i, '');
        const versionSuffix = currentVersion.legacy ? '' : `_${currentVersion.version}`;
        a.href = url;
        a.download = `${baseName}${versionSuffix}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        setStatus(`✓ Архив ${a.download} скачан`);
    } catch (error) {
        console.error('[READY SOLUTION] Ошибка скачивания архива:', error);
        setStatus(`Не удалось скачать архив: ${error.message}`, true);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = `💾 Скачать архив (${zipFileInfo.name})`;
        }
    }
}

// Распаковка архива выбранной версии: .vtr извлекаются и кэшируются
// с привязкой к версии
async function extractZip() {
    if (!zipFileInfo || !currentVersion) {
        setStatus('Сначала выберите архив с решением', true);
        return;
    }
    const btn = document.getElementById('extract-zip-btn');
    const version = currentVersion.version;
    try {
        btn.disabled = true;
        btn.textContent = '⏳ Загрузка архива...';

        const response = await fetch(`/api/users/self/solutions/${currentSolutionId}/files/${encodeURIComponent(zipFileInfo.key)}`, {
            headers: { 'Authorization': `Bearer ${currentIdToken}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();

        btn.textContent = '⏳ Распаковка...';
        setStatus('Распаковка архива...');
        const zip = await JSZip.loadAsync(blob);

        const entries = Object.values(zip.files).filter(f => !f.dir && f.name.toLowerCase().endsWith('.vtr'));
        if (entries.length === 0) {
            throw new Error('В архиве нет файлов .vtr');
        }

        let saved = 0;
        let failed = 0;
        for (const entry of entries) {
            const text = await entry.async('string');
            const name = entry.name.split('/').pop();
            try {
                await cacheVtr(currentSolutionId, version, name, text);
                saved++;
            } catch (err) {
                failed++;
                console.warn(`[READY SOLUTION] Не удалось сохранить ${name} в кэш:`, err);
            }
        }

        if (failed > 0 && saved === 0) {
            setStatus('Кэш браузера недоступен — файлы будут загружаться с сервера по запросу', true);
        } else {
            setStatus(`✓ Версия распакована: файлов ${entries.length}${failed > 0 ? ` (в кэш сохранено ${saved})` : ''}. Они сохранены в хранилище браузера.`);
        }
        renderVtrList();
    } catch (error) {
        console.error('[READY SOLUTION] Ошибка распаковки архива:', error);
        setStatus(`Ошибка распаковки: ${error.message}`, true);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📂 Распаковать архив';
        }
    }
}

function setStatus(message, isError = false) {
    const el = document.getElementById('vtr-loading-status');
    if (!el) return;
    if (!message) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.textContent = message;
    el.style.color = isError ? 'var(--color-danger)' : 'var(--color-info)';
    el.classList.remove('hidden');
}
