// front/js/modules/api.js

/**
 * Универсальная функция для выполнения API-запросов с обработкой ошибок.
 * @param {string} url - URL эндпоинта API.
 * @param {string} method - HTTP метод (GET, POST, PUT, DELETE).
 * @param {Object|null} data - Данные для отправки в теле запроса (для POST/PUT).
 * @param {Object} headers - Дополнительные заголовки.
 * @param {string} idToken - ID токен Firebase для авторизации.
 * @param {Object} options - Дополнительные опции (timeout, signal).
 * @returns {Promise<any>} - Promise с данными ответа или ошибкой.
 */
export async function apiCall(url, method = 'GET', data = null, headers = {}, idToken = null, options = {}) {
    const defaultHeaders = {
        'Content-Type': 'application/json',
        ...(idToken && { 'Authorization': `Bearer ${idToken}` })
    };

    const config = {
        method: method,
        headers: { ...defaultHeaders, ...headers }
    };

    if (data) {
        // Для multipart/form-data не устанавливаем Content-Type вручную
        if (!(data instanceof FormData)) {
            config.body = JSON.stringify(data);
        } else {
             // Для FormData тело - сам FormData, Content-Type установит браузер
             config.body = data;
             // Удаляем Content-Type из заголовков, чтобы браузер мог установить boundary
             delete config.headers['Content-Type'];
        }
    }

    // Add signal for abort/timeout if provided
    if (options.signal) {
        config.signal = options.signal;
    }

    console.log(`[API CALL] ${method} ${url}`, config);
    const response = await fetch(url, config);

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[API ERROR] ${method} ${url} failed:`, response.status, errorText);
        throw new Error(`API Error (${response.status}): ${errorText}`);
    }

    // Проверяем Content-Type ответа
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        return await response.json();
    } else if (contentType && contentType.includes('text/')) {
        return await response.text();
    } else {
        // Для других типов (например, пустой ответ 204) просто возвращаем response
        return response;
    }
}

/**
 * Wrapper for apiCall with timeout
 * @param {string} url - URL эндпоинта API.
 * @param {string} method - HTTP метод.
 * @param {Object|null} data - Данные для отправки.
 * @param {Object} headers - Дополнительные заголовки.
 * @param {string} idToken - ID токен Firebase.
 * @param {number} timeoutMs - Таймаут в миллисекундах.
 * @returns {Promise<any>}
 */
export async function apiCallWithTimeout(url, method = 'GET', data = null, headers = {}, idToken = null, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await apiCall(url, method, data, headers, idToken, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

// Можно добавить специализированные функции, если нужно
// export async function getUserData(idToken) { ... }
// export async function createSolution(solutionData, idToken) { ... }