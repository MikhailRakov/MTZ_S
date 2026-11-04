// Dashboard Coarse Generator Integration — оркестратор вкладок импорта.
// Реальная логика разнесена по папкам:
//   js/import/profiles/  — Profiles.dat + Coarse-генератор
//   js/import/simpeg/    — SimPEG .npz → Profiles.dat / Coarse.dat
//   js/import/phoenix/   — сырые данные Phoenix MT (.zip)
//   js/import/importTabs.js — переключение вкладок
import { initProfilesImport, isProfilesInitialized, resetProfiles } from '../import/profiles/profilesImport.js';
import { initSimpegImport } from '../import/simpeg/simpegImport.js';
import { initImportTabs } from '../import/importTabs.js';
import { resetPhoenixUI } from '../import/phoenix/phoenixImport.js';

// Совместимость: main.js и тесты могут продолжать импортировать Phoenix-экспорты отсюда
export { initPhoenixImport, disableCalCurvesEditor } from '../import/phoenix/phoenixImport.js';

let simpegApi = null;

/**
 * Инициализация всех вкладок импорта на dashboard.
 * Вызывается один раз при загрузке страницы из main.js.
 */
export function initCoarseGenerator() {
    const profilesApi = initProfilesImport();
    if (!profilesApi) return; // Не страница dashboard

    initImportTabs();
    simpegApi = initSimpegImport(profilesApi);
}

/**
 * Сброс состояния всех вкладок импорта при переключении решений.
 * Вызывается из load_and_display_solution_details.js.
 */
export function resetCoarseGenerator() {
    if (!isProfilesInitialized()) return;

    resetProfiles();

    if (simpegApi) {
        simpegApi.resetUI();
    }

    resetPhoenixUI();

    console.log('[COARSE GENERATOR] State reset for new solution');
}
