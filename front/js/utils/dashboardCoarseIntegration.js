// Dashboard Coarse Generator Integration
import { CoarseGenerator } from './utils/coarseGenerator.js';

export function initCoarseGenerator() {
    const generator = new CoarseGenerator();

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
    const fileInputC = document.getElementById('file-input-c');

    if (!profilesUploadArea) return; // Not on dashboard page

    let profilesData = null;
    let profilesStats = null;

    // Toggle generator visibility
    toggleGeneratorBtn?.addEventListener('click', () => {
        generatorContent.classList.toggle('hidden');
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
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                profilesData = e.target.result;
                profilesStats = generator.parseProfilesData(profilesData);

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
                            <div class="stat-label">X диапазон (м)</div>
                            <div class="stat-value">${(profilesStats.xRange / 1000).toFixed(1)} км</div>
                        </div>
                        <div>
                            <div class="stat-label">Y диапазон (м)</div>
                            <div class="stat-value">${(profilesStats.yRange / 1000).toFixed(1)} км</div>
                        </div>
                    </div>
                `;

                generatorControls.classList.remove('hidden');
                generateBtn.disabled = false;

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
                generator.init3DVisualization(gridCanvasContainer, coarseData);

                // Update stats
                const totalCells = config.nX * config.nY * config.nZ;
                const xExtent = coarseData.xCells.reduce((a, b) => a + b, 0);
                const yExtent = coarseData.yCells.reduce((a, b) => a + b, 0);
                const zExtent = coarseData.zCells.reduce((a, b) => a + b, 0);

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
                        <div class="stat-label">X протяженность</div>
                        <div class="stat-value">${(xExtent / 1000).toFixed(1)} км</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">Y протяженность</div>
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

            // Trigger change event
            const event = new Event('change', { bubbles: true });
            fileInputC.dispatchEvent(event);

            // Visual feedback
            useGeneratedBtn.textContent = '✓ Сетка добавлена';
            useGeneratedBtn.style.background = 'linear-gradient(135deg, var(--color-success), var(--color-success-hover))';

            setTimeout(() => {
                useGeneratedBtn.textContent = '✓ Использовать эту сетку';
                useGeneratedBtn.style.background = '';
            }, 2000);

            // Scroll to upload form
            document.getElementById('file-upload-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        } catch (error) {
            console.error('Error using generated coarse:', error);
            alert('Ошибка: ' + error.message);
        }
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        generator.dispose();
    });
}
