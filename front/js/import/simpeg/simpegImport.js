// Import UI: SimPEG .npz → Profiles.dat / Coarse.dat
import { convertSimpegToProfiles, buildSimpegModelData, buildCoarseFromSimpeg } from './simpegProfilesConverter.js';
import { showVolumeModal } from '../../utils/resultViewer.js';
import { showHint } from '../../utils/onboardingHints.js';

/**
 * Инициализация обработчиков импорта SimPEG.
 * @param {{ attachConvertedFiles: Function, fallbackToProfilesGeneration: Function }} profilesApi
 * @returns {{ resetUI: Function }|null}
 */
export function initSimpegImport(profilesApi) {
    const simpegUploadArea = document.getElementById('simpeg-upload-area');
    const simpegFileInput = document.getElementById('simpeg-file-input');
    const simpegControls = document.getElementById('simpeg-controls');
    const convertSimpegBtn = document.getElementById('convert-simpeg-btn');
    const simpegResult = document.getElementById('simpeg-result');
    const simpegStats = document.getElementById('simpeg-stats');
    const downloadProfilesBtn = document.getElementById('download-profiles-btn');
    const useConvertedProfilesBtn = document.getElementById('use-converted-profiles-btn');
    const simpegVolumeBtn = document.getElementById('simpeg-volume-btn');
    let simpegProfilesData = null;
    let simpegProfilesFile = null;
    let simpegModelData = null;   // объёмная модель проводимости из .npz (ResultViewer format)
    let simpegNpz = null;         // разобранный .npz целиком (для Coarse.dat из сетки)
    // ===== SimPEG Import Logic =====
    if (simpegUploadArea && simpegFileInput) {
        // Click to upload
        simpegUploadArea.addEventListener('click', () => simpegFileInput.click());

        // Drag and drop
        simpegUploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            simpegUploadArea.classList.add('dragover');
        });

        simpegUploadArea.addEventListener('dragleave', () => {
            simpegUploadArea.classList.remove('dragover');
        });

        simpegUploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            simpegUploadArea.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                handleSimpegFile(files[0]);
            }
        });

        simpegFileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleSimpegFile(e.target.files[0]);
            }
        });
    }

    // Handle SimPEG .npz file upload and convert to Profiles.dat
    async function handleSimpegFile(file) {
        if (!file.name.endsWith('.npz')) {
            alert('Пожалуйста, выберите файл с расширением .npz');
            return;
        }

        simpegUploadArea.innerHTML = `
            <div style="font-size: 2em; margin-bottom: 10px;">⏳</div>
            <p><strong>Чтение файла...</strong></p>
            <p style="font-size: 0.85em; color: var(--color-text-tertiary); margin-top: 8px;">
                ${file.name}
            </p>
        `;

        try {
            const arrayBuffer = await file.arrayBuffer();
            const zip = await JSZip.loadAsync(arrayBuffer);

            // Preload every .npy entry as raw bytes (JSZip is async)
            const raw = {};
            const entries = Object.keys(zip.files).filter(n => n.endsWith('.npy'));
            await Promise.all(entries.map(async (name) => {
                raw[name] = new Uint8Array(await zip.file(name).async('arraybuffer'));
            }));

            // Единый вызов конвертера (чистые функции живут в simpegProfilesConverter.js)
            const { npz, stations, profiles: profilesContent, qc } = convertSimpegToProfiles(raw);
            const nFreq = npz.nFreq;
            const nStations = npz.nStations;
            const periods = npz.periods;

            simpegProfilesData = profilesContent;
            simpegProfilesFile = new File([profilesContent], 'Profiles.dat', { type: 'text/plain' });
            // Объёмная модель (sigma -> rho) для ResultViewer, если в .npz есть сетка
            simpegModelData = buildSimpegModelData(npz);
            // Весь разобранный .npz — чтобы Coarse.dat строился ИЗ СЕТКИ модели
            simpegNpz = npz;

            // Onboarding-подсказка: показать пользователю следующий шаг
            if (useConvertedProfilesBtn) {
                setTimeout(() => {
                    showHint(
                        'use-converted-profiles',
                        useConvertedProfilesBtn,
                        '👆 Нажмите сюда, чтобы использовать сконвертированные данные для расчёта',
                        { position: 'top', autoHideMs: 8000 }
                    );
                }, 500);
            }

            const rhoVals = qc.map(q => q.rho).filter(v => isFinite(v) && v > 0);
            const rhoMin = rhoVals.length ? Math.min(...rhoVals) : NaN;
            const rhoMax = rhoVals.length ? Math.max(...rhoVals) : NaN;

            simpegUploadArea.innerHTML = `
                <div style="font-size: 2em; margin-bottom: 10px;"></div>
                <p><strong>${file.name}</strong></p>
                <p style="font-size: 0.85em; color: var(--color-text-tertiary); margin-top: 8px;">
                    Прочитано: ${nFreq} периодов, ${nStations} станций
                </p>
            `;

            simpegStats.innerHTML = `
                <div class="stat-item">
                    <div class="stat-label">Периодов</div>
                    <div class="stat-value">${nFreq}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Станций</div>
                    <div class="stat-value">${nStations}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Диапазон периодов</div>
                    <div class="stat-value">${periods[0].toExponential(2)} — ${periods[nFreq - 1].toExponential(2)} с</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">ρa (Zxy, ст.1)</div>
                    <div class="stat-value">${rhoMin.toFixed(1)} — ${rhoMax.toFixed(1)} Ом·м</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Фаза Zxy (ст.1)</div>
                    <div class="stat-value">${qc[0].phase.toFixed(1)}° … ${qc[nFreq - 1].phase.toFixed(1)}°</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Компоненты</div>
                    <div class="stat-value">ZXX, ZXY, ZYX, ZYY${npz.hasTipper ? ' + TX, TY' : ''}</div>
                </div>
            `;

            simpegControls.classList.remove('hidden');
            convertSimpegBtn.disabled = false;

        } catch (error) {
            console.error('Error parsing SimPEG .npz:', error);
            simpegUploadArea.innerHTML = `
                <div style="font-size: 2em; margin-bottom: 10px;">❌</div>
                <p><strong>Ошибка чтения .npz</strong></p>
                <p style="font-size: 0.85em; color: var(--color-danger); margin-top: 8px;">
                    ${error.message}
                </p>
            `;
        }
    }

    // Convert SimPEG button
    convertSimpegBtn?.addEventListener('click', () => {
        if (!simpegProfilesData || !simpegProfilesFile) {
            alert('Сначала загрузите .npz файл');
            return;
        }

        // Show result
        simpegResult.classList.remove('hidden');
        simpegResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Download converted Profiles.dat
    downloadProfilesBtn?.addEventListener('click', () => {
        if (!simpegProfilesData) {
            alert('Нет данных для скачивания');
            return;
        }
        const blob = new Blob([simpegProfilesData], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Profiles.dat';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // Объёмная модель SimPEG (.npz) — тот же стиль, что у готовых решений
    simpegVolumeBtn?.addEventListener('click', async () => {
        if (!simpegModelData) {
            alert('В загруженном .npz нет данных модели (sigma_model / mesh_*). Объёмный просмотр недоступен.');
            return;
        }
        await showVolumeModal(simpegModelData, 'Модель проводимости SimPEG (объём)');
    });

    // Use converted Profiles.dat for coarse generation
    useConvertedProfilesBtn?.addEventListener('click', () => {
        if (!simpegProfilesFile) {
            alert('Сначала конвертируйте файл');
            return;
        }

        // Если в .npz есть сетка — строим Coarse.dat ИЗ НЕЁ (та же модель,
        // что решалась в SimPEG), а не из эвристики скин-слоя.
        // Ошибки геометрии показываем сразу: падение в MATLAB будет только
        // через несколько часов расчёта.
        let coarseFromMesh = null;
        if (simpegNpz) {
            try {
                coarseFromMesh = buildCoarseFromSimpeg(simpegNpz);
            } catch (err) {
                console.error('[SIMPEG→COARSE]', err);
                alert(`Не удалось построить Coarse.dat из сетки .npz:\n${err.message}`);
                return;
            }
        }
        if (coarseFromMesh) {
            profilesApi.attachConvertedFiles(simpegProfilesFile, coarseFromMesh);
            return;
        }
        alert("Нет сети в .npz");

        // Fallback: нет данных сетки — прежний путь через генератор по станциям
        profilesApi.fallbackToProfilesGeneration(simpegProfilesFile);
    });

    /** Сброс SimPEG UI при переключении решений */
    function resetUI() {
    // Reset SimPEG UI
    if (simpegUploadArea) {
        simpegUploadArea.innerHTML = `
            <div style="font-size: 3em; margin-bottom: 10px;">📊</div>
            <p><strong>Загрузите .npz файл</strong></p>
            <p style="font-size: 0.9em; color: var(--color-text-tertiary); margin-top: 8px;">
                Содержит частоты, импедансы Zxy/Zyx и модель проводимости
            </p>
        `;
    }
    if (simpegControls) {
        simpegControls.classList.add('hidden');
    }
    if (simpegResult) {
        simpegResult.classList.add('hidden');
    }
    if (simpegStats) {
        simpegStats.innerHTML = '';
    }
    if (simpegFileInput) {
        simpegFileInput.value = '';
    }
    }

    return { resetUI };
}
