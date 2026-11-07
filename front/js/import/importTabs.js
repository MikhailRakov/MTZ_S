// ===== Переключение вкладок импорта (Profiles.dat / SimPEG / Phoenix) =====

/**
 * Инициализация переключения вкладок импорта.
 * Вызывается один раз при загрузке dashboard.
 */
export function initImportTabs() {
    const importTabs = document.querySelectorAll('.import-tab');
    const tabProfiles = document.getElementById('tab-profiles');
    const tabSimpeg = document.getElementById('tab-simpeg');
    const tabPhoenix = document.getElementById('tab-phoenix');

    importTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            
            // Update tab buttons
            importTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            // Update tab content
            if (tabProfiles) tabProfiles.classList.toggle('active', targetTab === 'profiles');
            if (tabSimpeg) tabSimpeg.classList.toggle('active', targetTab === 'simpeg');
            if (tabPhoenix) tabPhoenix.classList.toggle('active', targetTab === 'phoenix');
        });
    });
}
