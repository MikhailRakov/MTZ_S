// currentSolution.js — единый источник ID выбранной задачи.
// Модуль без зависимостей: его можно импортировать из любого слоя
// (формы загрузки, Phoenix-импорт, детали решения) без циклов инициализации.

let currentSolutionID = null;

export function setCurrentSolutionID(id) {
    currentSolutionID = id;
    console.log(`[MAIN] currentSolutionID обновлен на: ${id}`);
}

export function getCurrentSolutionID() {
    return currentSolutionID;
}
