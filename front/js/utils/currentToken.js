// currentToken.js — единый источник ID-токена текущей сессии.
// Модуль без зависимостей (как currentSolution.js): main.js пишет его при
// входе, любой слой читает без импорта main.js — импорт main.js тянет за
// собой весь UI (document.* на уровне модуля) и ломает headless-тесты.

let currentToken = null;

export function setCurrentToken(token) {
    currentToken = token || null;
}

export function getCurrentToken() {
    return currentToken;
}
