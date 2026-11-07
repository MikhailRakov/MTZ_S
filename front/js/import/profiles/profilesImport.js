// Import UI: Profiles.dat + Coarse-генератор
import { CoarseGenerator } from './coarseGenerator.js';
import { showVolumeModal } from '../../utils/resultViewer.js';

let generatorInstance = null;
let _initialized = false;

export function isProfilesInitialized() {
    return _initialized;
}

/**
 * Инициализация обработчиков импорта Profiles.dat и генератора Coarse.
 * @returns {{ attachConvertedFiles: Function, fallbackToProfilesGeneration: Function } | null}
 *   API для SimPEG-модуля или null, если страница без формы загрузки.
 */
export function initProfilesImport() {
    if (!generatorInstance) {
        generatorInstance = new CoarseGenerator();
    }

    const generator = generatorInstance;

    // Elements
    const profilesUploadArea = document.getElementById('profiles-upload-area');
    const profilesFileInput = document.getElementById('profiles-file-input');
    const generatorControls = document.getElementById('generator-controls');
    const generateBtn = document.getElementById('generate-coarse-btn');
    const gridVisualization = document.getElementById('grid-visualization');
    const gridCanvasContainer = document.getElementById('grid-canvas-container');
    const profilesInfo = document.getElementById('profiles-info');
    const downloadBtn = document.getElementById('download-coarse-btn');
    const useGeneratedBtn = document.getElementById('use-generated-coarse-btn');
    const toggleGeneratorBtn = document.getElementById('toggle-generator-btn');
    const generatorContent = document.getElementById('generator-content');
    const fileInputP = document.getElementById('file-input-p');
    const fileInputC = document.getElementById('file-input-c');
    const submitFilesSection = document.getElementById('submit-files-section');
    const submitFilesBtn = document.getElementById('submit-files-btn');
    const fileUploadForm = document.getElementById('file-upload-form');
    const uploadFileBtn = document.getElementById('upload-file-btn');
    const readyProfilesName = document.getElementById('ready-profiles-name');
    const readyCoarseName = document.getElementById('ready-coarse-name');

    const volumeCoarseBtn = document.getElementById('volume-coarse-btn');

    if (!profilesUploadArea) return null; // Not on dashboard page
    let profilesData = null;
    let profilesStats = null;
    let profilesFile = null;
    // Toggle generator visibility
    toggleGeneratorBtn?.addEventListener('click', () => {
        const isHidden = generatorContent.classList.toggle('hidden');
        toggleGeneratorBtn.classList.toggle('rotated');
    });
    // Click to upload
    profilesUploadArea.addEventListener('click', () => profilesFileInput.click());

    // Drag and drop
    profilesUploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        profilesUploadArea.classList.add('dragover');
    });

    profilesUploadArea.addEventListener('dragleave', () => {
        profilesUploadArea.classList.remove('dragover');
    });

    profilesUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        profilesUploadArea.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleProfilesFile(files[0]);
        }
    });

    profilesFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleProfilesFile(e.target.files[0]);
        }
    });

    // Handle Profiles.dat upload
    function handleProfilesFile(file) {
        profilesFile = file;
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                profilesData = e.target.result;
                // CRITICAL: Store profiles data in generator instance
                generator.profilesData = profilesData;
                profilesStats = generator.parseProfilesData(profilesData);

                // Auto-suggest grid configuration based on profiles data
                const suggestedConfig = generator.suggestGridConfig(profilesStats);

                // Auto-fill form fields with suggested values (user can still modify)
                document.getElementById('grid-nx').value = suggestedConfig.nX;
                document.getElementById('grid-ny').value = suggestedConfig.nY;
                document.getElementById('grid-nz').value = suggestedConfig.nZ;
                document.getElementById('grid-z-first').value = suggestedConfig.zFirstLayer;

                // Update UI
                profilesUploadArea.innerHTML = `
                    <div style="font-size: 2em; margin-bottom: 10px;"></div>
                    <p><strong>${file.name}</strong></p>
                    <p style="font-size: 0.85em; color: var(--color-text-tertiary); margin-top: 8px;">
                        Загружено успешно
                    </p>
                `;

                profilesInfo.innerHTML = `
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px;">
                        <div>
                            <div class="stat-label">Станции</div>
                            <div class="stat-value">${profilesStats.numStations}</div>
                        </div>
                        <div>
                            <div class="stat-label">Периоды</div>
                            <div class="stat-value">${profilesStats.numPeriods}</div>
                        </div>
                        <div>
                            <div class="stat-label">X (север) диапазон</div>
                            <div class="stat-value">${(profilesStats.xRange / 1000).toFixed(1)} км</div>
                        </div>
                        <div>
                            <div class="stat-label">Y (восток) диапазон</div>
                            <div class="stat-value">${(profilesStats.yRange / 1000).toFixed(1)} км</div>
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; padding: 12px; background: var(--color-primary-light); border-radius: var(--radius-md);">
                        <div>
                            <div class="stat-label">Рекомендуемые X ячейки</div>
                            <div class="stat-value" style="color: var(--color-primary);">${suggestedConfig.nX}</div>
                        </div>
                        <div>
                            <div class="stat-label">Рекомендуемые Y ячейки</div>
                            <div class="stat-value" style="color: var(--color-primary);">${suggestedConfig.nY}</div>
                        </div>
                        <div>
                            <div class="stat-label">Рекомендуемые Z слои</div>
                            <div class="stat-value" style="color: var(--color-primary);">${suggestedConfig.nZ}</div>
                        </div>
                        <div>
                            <div class="stat-label">Первый Z слой</div>
                            <div class="stat-value" style="color: var(--color-primary);">${suggestedConfig.zFirstLayer} м</div>
                        </div>
                    </div>
                    ${suggestedConfig.notes && suggestedConfig.notes.length > 0
                        ? '<div style="margin-top: 12px; padding: 10px; background: var(--color-warning-light); border-radius: var(--radius-md); font-size: 0.85em; color: var(--color-warning);"><strong>⚠ Примечания:</strong><ul style="margin: 8px 0 0 18px;">' +
                          suggestedConfig.notes.map(n => `<li>${n}</li>`).join('') + '</ul></div>'
                        : ''}
                `;

                generatorControls.classList.remove('hidden');
                generateBtn.disabled = false;

                // Set profiles file to hidden input
                const dataTransferP = new DataTransfer();
                dataTransferP.items.add(profilesFile);
                fileInputP.files = dataTransferP.files;
                readyProfilesName.textContent = `✓ ${file.name}`;

                checkFilesReady();

            } catch (error) {
                console.error('Error parsing Profiles.dat:', error);
                profilesUploadArea.innerHTML = `
                    <div style="font-size: 2em; margin-bottom: 10px;">❌</div>
                    <p><strong>Ошибка чтения файла</strong></p>
                    <p style="font-size: 0.85em; color: var(--color-danger); margin-top: 8px;">
                        ${error.message}
                    </p>
                `;
            }
        };

        reader.onerror = () => {
            console.error('File reading failed');
            profilesUploadArea.innerHTML = `
                <div style="font-size: 2em; margin-bottom: 10px;">❌</div>
                <p><strong>Не удалось прочитать файл</strong></p>
            `;
        };

        reader.readAsText(file);
    }

    // Generate Coarse.dat
    generateBtn?.addEventListener('click', () => {
        if (!profilesStats) return;

        try {
            // Get configuration
            const config = {
                nX: parseInt(document.getElementById('grid-nx').value),
                nY: parseInt(document.getElementById('grid-ny').value),
                nZ: parseInt(document.getElementById('grid-nz').value),
                zFirstLayer: parseFloat(document.getElementById('grid-z-first').value),
                padding: 1.2,
                growthFactor: 1.15,
                zGrowthFactor: 1.15,
                minCellSize: 30000,
                defaultRho: 100
            };

            // Generate coarse data
            const coarseData = generator.generateCoarse(profilesStats, config);

            // Show visualization
            gridVisualization.classList.remove('hidden');

            // Initialize 3D visualization (async: lazy-loads Three.js)
            setTimeout(async () => {
                try {
                    await generator.init3DVisualization(gridCanvasContainer, coarseData, profilesStats);

                    // Update stats
                    const totalCells = config.nX * config.nY * config.nZ;
                    const xExtent = coarseData.xCells.reduce((a, b) => a + b, 0);
                    const yExtent = coarseData.yCells.reduce((a, b) => a + b, 0);
                    const zExtent = coarseData.zCells.reduce((a, b) => a + b, 0);

                    // Actual padding cell counts reported by the generator
                    const nPaddingX = coarseData.layout.nPaddingX;
                    const nPaddingY = coarseData.layout.nPaddingY;

                    document.getElementById('grid-stats').innerHTML = `
                        <div class="stat-item">
                            <div class="stat-label">Размер сетки</div>
                            <div class="stat-value">${config.nX} × ${config.nY} × ${config.nZ}</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">Всего ячеек</div>
                            <div class="stat-value">${totalCells.toLocaleString()}</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">Станций наблюдения</div>
                            <div class="stat-value">${profilesStats.numStations}</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">X (север) расширение</div>
                            <div class="stat-value">${nPaddingX} ячеек</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">Y (восток) расширение</div>
                            <div class="stat-value">${nPaddingY} ячеек</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">X (север) протяженность</div>
                            <div class="stat-value">${Math.round(xExtent).toLocaleString('ru-RU')} м</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">Y (восток) протяженность</div>
                            <div class="stat-value">${Math.round(yExtent).toLocaleString('ru-RU')} м</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">Z глубина</div>
                            <div class="stat-value">${Math.round(zExtent).toLocaleString('ru-RU')} м</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">Первый Z слой</div>
                            <div class="stat-value">${config.zFirstLayer} м</div>
                        </div>
                    `;

                    // Scroll to visualization
                    gridVisualization.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } catch (vizError) {
                    console.error('Visualization error:', vizError);
                    alert('Ошибка визуализации: ' + vizError.message);
                }
            }, 100);

        } catch (error) {
            console.error('Error generating coarse:', error);
            alert('Ошибка генерации сетки: ' + error.message);
        }
    });

    // Download Coarse.dat
    downloadBtn?.addEventListener('click', () => {
        try {
            generator.downloadCoarse('Coarse.dat');
        } catch (error) {
            console.error('Error downloading coarse:', error);
            alert('Ошибка скачивания: ' + error.message);
        }
    });

    // Use generated Coarse.dat for upload
    useGeneratedBtn?.addEventListener('click', () => {
        try {
            const coarseFile = generator.getCoarseAsFile('Coarse.dat');

            // Create a new FileList-like object
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(coarseFile);

            // Set the file input
            fileInputC.files = dataTransfer.files;

            // Visual feedback
            useGeneratedBtn.textContent = '✓ Сетка добавлена';
            useGeneratedBtn.style.background = 'linear-gradient(135deg, var(--color-success), var(--color-success-hover))';

            readyCoarseName.textContent = '✓ Coarse.dat (сгенерирован)';
            // Если ячейки редактировались — подпись сразу покажет число правок
            updateEditedStatus();

            setTimeout(() => {
                useGeneratedBtn.textContent = '✓ Использовать эту сетку';
                useGeneratedBtn.style.background = '';
            }, 2000);

            checkFilesReady();

        } catch (error) {
            console.error('Error using generated coarse:', error);
            alert('Ошибка: ' + error.message);
        }
    });
    // Объёмный просмотр сгенерированной Coarse-сетки С РЕДАКТИРОВАНИЕМ:
    // пользователь может менять сопротивление отдельных ячеек (априорная информация).
    // Правки пишутся в общий массив coarse.rhoValues, а Coarse.dat пересобирается
    // лениво — при скачивании или «Использовать эту сетку».
    volumeCoarseBtn?.addEventListener('click', async () => {
        const coarse = generator.generatedCoarse;
        if (!coarse) {
            alert('Сначала сгенерируйте сетку');
            return;
        }
        const { config, xCells, yCells, zCells } = coarse;
        // Страховка: если generatedCoarse создан старой версией модуля
        // (например, из кэша браузера) — инициализируем массив ρ на месте
        if (!Array.isArray(coarse.rhoValues)) {
            console.warn('[COARSE EDIT] rhoValues отсутствует — инициализирую фоновым значением');
            coarse.rhoValues = new Array(config.nX * config.nY * config.nZ).fill(config.defaultRho || 100);
        }
        const rhoValues = coarse.rhoValues;
        await showVolumeModal(
            { nX: config.nX, nY: config.nY, nZ: config.nZ, xCells, yCells, zCells, rhoValues },
            `Coarse-сетка ${config.nX}×${config.nY}×${config.nZ} (фон ρ = ${config.defaultRho} Ω·м)`,
            {
                editing: {
                    defaultRho: config.defaultRho || 100,
                    onCellsEdited: (indices, rho) => {
                        try {
                            generator.setCellsRho(indices, rho);
                        } catch (err) {
                            console.error('[COARSE EDIT] setCellsRho failed:', err);
                        }
                        updateEditedStatus();
                    },
                    getModifiedCount: () => generator.getModifiedCount(),
                }
            }
        );
    });

    // Индикатор правок сетки на дашборде (под 3D-визуализацией)
    function updateEditedStatus() {
        const statusEl = document.getElementById('grid-edited-status');
        if (!statusEl) return;
        const coarse = generator.generatedCoarse;
        if (!coarse) {
            statusEl.classList.add('hidden');
            return;
        }
        const n = generator.getModifiedCount();
        if (n > 0) {
            statusEl.classList.remove('hidden');
            statusEl.innerHTML =
                `✏️ <strong>Изменено ячеек: ${n.toLocaleString('ru-RU')}</strong> — ` +
                `сопротивления отличаются от фона (${coarse.config.defaultRho} Ω·м). ` +
                `Coarse.dat будет пересобран при скачивании или отправке на расчёт.`;
        } else {
            statusEl.classList.add('hidden');
        }
        // Обновить подпись у готового файла, если он уже добавлен
        const modified = n > 0 ? `, изменено ${n.toLocaleString('ru-RU')} ячеек` : '';
        const wasAttached = readyCoarseName && readyCoarseName.textContent.includes('сгенерирован');
        if (wasAttached) {
            readyCoarseName.textContent = `✓ Coarse.dat (сгенерирован${modified})`;
            // Если файл уже был приложен к форме — перевкладываем актуальную версию,
            // иначе на расчёт уйдёт снапшот с устаревшими сопротивлениями
            if (fileInputC && fileInputC.files.length > 0) {
                try {
                    const freshFile = generator.getCoarseAsFile('Coarse.dat');
                    const dt = new DataTransfer();
                    dt.items.add(freshFile);
                    fileInputC.files = dt.files;
                    console.log('[COARSE EDIT] Re-attached updated Coarse.dat to upload form');
                } catch (err) {
                    console.error('[COARSE EDIT] Failed to re-attach Coarse.dat:', err);
                }
            }
        }
    }
    // Check if both files are ready
    function checkFilesReady() {
        if (fileInputP.files.length > 0 && fileInputC.files.length > 0) {
            submitFilesSection.classList.remove('hidden');
            submitFilesSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    // Submit files button
    submitFilesBtn?.addEventListener('click', () => {
        // Trigger the hidden form submit
        uploadFileBtn.click();
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        generator.dispose();
    });

    /**
     * Прикрепить сконвертированные Profiles.dat (+ Coarse.dat из сетки .npz) к форме отправки.
     * Вызывается из SimPEG-модуля.
     * @param {File} profilesFile - конвертированный Profiles.dat
     * @param {{ content: string, nX: number, nY: number, nZ: number }|null} coarseFromMesh - Coarse из сетки или null
     */
    function attachConvertedFiles(profilesFile, coarseFromMesh) {
        if (!coarseFromMesh) return;
        const coarseFile = new File([coarseFromMesh.content], 'Coarse.dat', { type: 'text/plain' });
        const dtC = new DataTransfer();
        dtC.items.add(coarseFile);
        fileInputC.files = dtC.files;
        readyCoarseName.textContent = `✓ Coarse.dat (сетка .npz: ${coarseFromMesh.nX}×${coarseFromMesh.nY}×${coarseFromMesh.nZ})`;

        const dtP = new DataTransfer();
        dtP.items.add(profilesFile);
        fileInputP.files = dtP.files;
        readyProfilesName.textContent = `✓ ${profilesFile.name}`;

        checkFilesReady();
    }

    /**
     * Fallback без сетки: показать вкладку Profiles и отдать файл стандартному обработчику.
     * Вызывается из SimPEG-модуля.
     * @param {File} profilesFile
     */
    function fallbackToProfilesGeneration(profilesFile) {
        const profilesTab = document.querySelector('.import-tab[data-tab="profiles"]');
        if (profilesTab) {
            profilesTab.click();
        }

        // Set the converted file to profiles upload
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(profilesFile);
        profilesFileInput.files = dataTransfer.files;

        // Trigger the file handler
        handleProfilesFile(profilesFile);
    }

    _initialized = true;
    return { attachConvertedFiles, fallbackToProfilesGeneration };
}

/** Сброс состояния Profiles/Coarse-генератора при переключении решений */
export function resetProfiles() {
    if (!generatorInstance) return;

    // Dispose 3D resources
    generatorInstance.dispose();

    // Reset UI elements
    const profilesUploadArea = document.getElementById('profiles-upload-area');
    const generatorControls = document.getElementById('generator-controls');
    const gridVisualization = document.getElementById('grid-visualization');
    const profilesInfo = document.getElementById('profiles-info');
    const submitFilesSection = document.getElementById('submit-files-section');
    const fileInputP = document.getElementById('file-input-p');
    const fileInputC = document.getElementById('file-input-c');

    if (profilesUploadArea) {
        profilesUploadArea.innerHTML = `
            <div style="font-size: 3em; margin-bottom: 10px;"></div>
            <h3>Drop Profiles.dat here or click to browse</h3>
            <p style="color: #999; margin-top: 10px;">Supported format: Profiles.dat (MT data file)</p>
        `;
    }

    if (generatorControls) {
        generatorControls.classList.add('hidden');
    }

    if (gridVisualization) {
        gridVisualization.classList.add('hidden');
        const gridCanvasContainer = document.getElementById('grid-canvas-container');
        if (gridCanvasContainer) {
            gridCanvasContainer.innerHTML = '';
        }
    }

    if (profilesInfo) {
        profilesInfo.innerHTML = '';
    }

    if (submitFilesSection) {
        submitFilesSection.classList.add('hidden');
    }
    // Clear file inputs
    if (fileInputP) {
        fileInputP.value = '';
    }
    if (fileInputC) {
        fileInputC.value = '';
    }

    // Reset generator instance
    generatorInstance.profilesData = null;
    generatorInstance.generatedCoarse = null;

    // Скрыть индикатор правок сетки (правки живут в generatedCoarse.rhoValues)
    const gridEditedStatus = document.getElementById('grid-edited-status');
    if (gridEditedStatus) {
        gridEditedStatus.classList.add('hidden');
        gridEditedStatus.innerHTML = '';
    }
}
