// Блок "Готовое решение": скачивание .zip архива результатов из S3,
// его распаковка и просмотр .vtr файлов.
// Распакованные .vtr сохраняются в IndexedDB браузера (квота на порядки
// больше, чем у localStorage), чтобы повторный просмотр не требовал
// повторной загрузки с сервера.
import { showVtrViewer } from './vtrViewer.js';

const DB_NAME = 'mtz_solutions';
const DB_STORE = 'vtr_files';
const KEY_PREFIX = 'mtz_vtr:';

let initialized = false;
let currentSolutionId = null;
let currentIdToken = null;
let zipFileInfo = null;
let dbPromise = null;

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

async function cacheVtr(solutionId, name, text) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(text, KEY_PREFIX + solutionId + ':' + name);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function readCachedVtr(solutionId, name) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(DB_STORE, 'readonly')
            .objectStore(DB_STORE)
            .get(KEY_PREFIX + solutionId + ':' + name);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

async function getCachedVtrNames(solutionId) {
    const db = await openDb();
    const prefix = KEY_PREFIX + solutionId + ':';
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

// Отображает блок, если в результатах есть .zip архив или .vtr файлы
// (в S3 или в кэше браузера)
export async function displayReadySolution(files, solutionId, idToken) {
    const container = document.getElementById('ready-solution-container');
    if (!container) return;

    currentSolutionId = solutionId;
    currentIdToken = idToken;

    if (!initialized) {
        initialized = true;
        setupHandlers();
    }

    zipFileInfo = (files || []).find(f => f.name.toLowerCase().endsWith('.zip')) || null;
    const s3VtrFiles = (files || []).filter(f => f.name.toLowerCase().endsWith('.vtr'));

    let cachedNames = [];
    try {
        cachedNames = await getCachedVtrNames(solutionId);
    } catch (err) {
        console.warn('[READY SOLUTION] IndexedDB недоступен, кэш не используется:', err);
    }

    // Показываем блок только если есть что показать
    if (!zipFileInfo && s3VtrFiles.length === 0 && cachedNames.length === 0) {
        container.classList.add('hidden');
        return;
    }

    // Кнопки работы с архивом видны только если архив есть в S3
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

    renderVtrList(s3VtrFiles, cachedNames);
    setStatus('');
    container.classList.remove('hidden');
}

function setupHandlers() {
    document.getElementById('download-results-zip-btn')?.addEventListener('click', downloadZip);
    document.getElementById('extract-zip-btn')?.addEventListener('click', extractZip);
}

// Список .vtr файлов: из S3 + из кэша браузера (без дублей по имени)
async function renderVtrList(s3VtrFiles, cachedNamesArg) {
    const list = document.getElementById('vtr-files-list');
    if (!list) return;

    let cachedNames = cachedNamesArg;
    if (!cachedNames) {
        try {
            cachedNames = await getCachedVtrNames(currentSolutionId);
        } catch (err) {
            cachedNames = [];
        }
    }

    const items = [];
    for (const f of s3VtrFiles) {
        items.push({ name: f.name, key: f.key, size: f.size, cached: cachedNames.includes(f.name) });
    }
    for (const name of cachedNames) {
        if (!items.some(it => it.name === name)) {
            items.push({ name, key: null, size: null, cached: true });
        }
    }

    if (items.length === 0) {
        list.innerHTML = '<p class="text-muted">Файлы .vtr появятся здесь после распаковки архива результатов</p>';
        return;
    }

    list.innerHTML = '';
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
        list.appendChild(el);
    });

    list.querySelectorAll('.btn-view').forEach(btn => {
        btn.addEventListener('click', () => viewVtr(btn.dataset.vtrName, btn.dataset.vtrKey || null));
    });
}

// Просмотр .vtr: сначала пробуем взять из кэша браузера, иначе — из S3
async function viewVtr(name, key) {
    try {
        let text = null;
        try {
            text = await readCachedVtr(currentSolutionId, name);
        } catch (err) {
            console.warn('[READY SOLUTION] Не удалось прочитать кэш:', err);
        }

        if (!text && key) {
            setStatus(`Загрузка ${name}...`);
            const response = await fetch(`/api/users/self/solutions/${currentSolutionId}/files/${encodeURIComponent(key)}`, {
                headers: { 'Authorization': `Bearer ${currentIdToken}` }
            });
            if (!response.ok) throw new Error('Не удалось загрузить файл');
            text = await response.text();
            try {
                await cacheVtr(currentSolutionId, name, text);
                renderVtrList([]);
            } catch (err) {
                console.warn(`[READY SOLUTION] Не удалось сохранить ${name} в кэш:`, err);
            }
            setStatus('');
        }

        if (!text) {
            throw new Error('Файл не найден ни в кэше браузера, ни в S3');
        }

        showVtrViewer(text, name);
    } catch (error) {
        console.error('[READY SOLUTION] Ошибка просмотра .vtr:', error);
        setStatus(`Ошибка: ${error.message}`, true);
    }
}

// Скачивание .zip архива из S3
async function downloadZip() {
    if (!zipFileInfo) return;
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
        a.href = url;
        a.download = zipFileInfo.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        setStatus(`✓ Архив ${zipFileInfo.name} скачан`);
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

// Распаковка .zip архива: все .vtr извлекаются и сохраняются в кэш браузера
async function extractZip() {
    if (!zipFileInfo) return;
    const btn = document.getElementById('extract-zip-btn');
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
                await cacheVtr(currentSolutionId, name, text);
                saved++;
            } catch (err) {
                failed++;
                console.warn(`[READY SOLUTION] Не удалось сохранить ${name} в кэш:`, err);
            }
        }

        if (failed > 0 && saved === 0) {
            setStatus('Кэш браузера недоступен — файлы будут загружаться с сервера по запросу', true);
        } else {
            setStatus(`✓ Распаковано файлов: ${entries.length}${failed > 0 ? ` (в кэш сохранено ${saved})` : ''}. Они сохранены в хранилище браузера.`);
        }
        renderVtrList([]);
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