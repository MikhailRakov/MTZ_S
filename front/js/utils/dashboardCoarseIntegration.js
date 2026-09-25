// Dashboard Coarse Generator Integration
import { CoarseGenerator } from './coarseGenerator.js';
import { convertSimpegToProfiles } from './simpegProfilesConverter.js';

let generatorInstance = null;

export function initCoarseGenerator() {
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

    // Import Tabs Elements
    const importTabs = document.querySelectorAll('.import-tab');
    const tabProfiles = document.getElementById('tab-profiles');
    const tabSimpeg = document.getElementById('tab-simpeg');
    const simpegUploadArea = document.getElementById('simpeg-upload-area');
    const simpegFileInput = document.getElementById('simpeg-file-input');
    const simpegControls = document.getElementById('simpeg-controls');
    const convertSimpegBtn = document.getElementById('convert-simpeg-btn');
    const simpegResult = document.getElementById('simpeg-result');
    const simpegStats = document.getElementById('simpeg-stats');
    const downloadProfilesBtn = document.getElementById('download-profiles-btn');
    const useConvertedProfilesBtn = document.getElementById('use-converted-profiles-btn');

    if (!profilesUploadArea) return; // Not on dashboard page

    let profilesData = null;
    let profilesStats = null;
    let profilesFile = null;
    let simpegProfilesData = null;
    let simpegProfilesFile = null;

    // ===== Import Tabs Logic =====
    importTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            
            // Update tab buttons
            importTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            // Update tab content
            if (tabProfiles && tabSimpeg) {
                tabProfiles.classList.toggle('active', targetTab === 'profiles');
                tabSimpeg.classList.toggle('active', targetTab === 'simpeg');
            }
        });
    });

    // Toggle generator visibility
    toggleGeneratorBtn?.addEventListener('click', () => {
        const isHidden = generatorContent.classList.toggle('hidden');
        toggleGeneratorBtn.classList.toggle('rotated');
    });

    // ... rest of existing code

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
                    <div style="font-size: 2em; margin-bottom: 10px;">✅</div>
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

            // Initialize 3D visualization
            setTimeout(() => {
                try {
                    generator.init3DVisualization(gridCanvasContainer, coarseData, profilesStats);

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
                            <div class="stat-value">${(xExtent / 1000).toFixed(1)} км</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">Y (восток) протяженность</div>
                            <div class="stat-value">${(yExtent / 1000).toFixed(1)} км</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-label">Z глубина</div>
                            <div class="stat-value">${(zExtent / 1000).toFixed(1)} км</div>
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

            const rhoVals = qc.map(q => q.rho).filter(v => isFinite(v) && v > 0);
            const rhoMin = rhoVals.length ? Math.min(...rhoVals) : NaN;
            const rhoMax = rhoVals.length ? Math.max(...rhoVals) : NaN;

            simpegUploadArea.innerHTML = `
                <div style="font-size: 2em; margin-bottom: 10px;">✅</div>
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

    // Use converted Profiles.dat for coarse generation
    useConvertedProfilesBtn?.addEventListener('click', () => {
        if (!simpegProfilesFile) {
            alert('Сначала конвертируйте файл');
            return;
        }

        // Switch to Profiles.dat tab
        const profilesTab = document.querySelector('.import-tab[data-tab="profiles"]');
        if (profilesTab) {
            profilesTab.click();
        }

        // Set the converted file to profiles upload
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(simpegProfilesFile);
        profilesFileInput.files = dataTransfer.files;
        
        // Trigger the file handler
        handleProfilesFile(simpegProfilesFile);
    });

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
}

// Reset generator state when switching solutions
export function resetCoarseGenerator() {
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

    // SimPEG elements
    const simpegUploadArea = document.getElementById('simpeg-upload-area');
    const simpegFileInput = document.getElementById('simpeg-file-input');
    const simpegControls = document.getElementById('simpeg-controls');
    const simpegResult = document.getElementById('simpeg-result');
    const simpegStats = document.getElementById('simpeg-stats');

    if (profilesUploadArea) {
        profilesUploadArea.innerHTML = `
            <div style="font-size: 3em; margin-bottom: 10px;">📁</div>
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

    console.log('[COARSE GENERATOR] State reset for new solution');
}
