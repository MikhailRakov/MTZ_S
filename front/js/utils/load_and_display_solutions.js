import { loadAndDisplaySolutionDetails } from "./load_and_display_solution_details.js";
import { apiCall, apiCallWithTimeout } from './api.js';

const PAGE_SIZE = 5; // Загружаем по 5 решений за раз

export async function loadAndDisplaySolutions(idToken, solutionsListContainer,
    solutionsListPlaceholder, solutionDetailsContainer, solutionDetailsPlaceholder, fileUploadSection) {
    if (!solutionsListContainer || !solutionsListPlaceholder) {
        console.error("[SOLUTIONS] Элементы .block-left не найдены в DOM.");
        return;
    }

    solutionsListPlaceholder.textContent = 'Загрузка решений...';
    solutionsListPlaceholder.classList.remove('hidden');
    solutionsListContainer.innerHTML = '';

    try {
        console.log("[SOLUTIONS] Отправка запроса на /api/users/self/solutions");
        const response = await fetch('/api/users/self/solutions', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${idToken}`,
                'Content-Type': 'application/json',
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("[SOLUTIONS] Ошибка от API:", response.status, errorText);
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const allSolutions = await response.json();
        console.log(`[SOLUTIONS] Получено ${allSolutions.length} решений`);

        solutionsListPlaceholder.classList.add('hidden');

        if (allSolutions.length === 0) {
            solutionsListContainer.innerHTML = '<p>У вас пока нет решений.</p>';
            solutionDetailsPlaceholder.textContent = 'Создайте первое решение!';
            solutionDetailsPlaceholder.classList.remove('hidden');
            solutionDetailsContainer.classList.add('hidden');
            return;
        }

        // Пагинация: показываем первые PAGE_SIZE решений, остальные по кнопке
        let visibleCount = Math.min(PAGE_SIZE, allSolutions.length);
        const hasMore = allSolutions.length > PAGE_SIZE;

        // Контейнер для списка
        solutionsListContainer.innerHTML = `
            <h3>Ваши решения:</h3>
            <div class="solutions-search-wrap">
                <input type="search" class="solutions-search-input" placeholder="🔍 Поиск по названию..." 
                       aria-label="Поиск решений" autocomplete="off">
            </div>
            <div class="solutions-scroll-container">
                <div class="solutions-list" id="solutions-list-inner"></div>
            </div>
            ${hasMore ? `<button type="button" class="btn btn-secondary solutions-load-more-btn" style="width:100%;margin-top:var(--spacing-sm);min-height:44px;">
                📋 Загрузить ещё (${allSolutions.length - PAGE_SIZE} из ${allSolutions.length})
            </button>` : ''}
        `;

        const listInner = solutionsListContainer.querySelector('#solutions-list-inner');
        const loadMoreBtn = solutionsListContainer.querySelector('.solutions-load-more-btn');
        const searchInput = solutionsListContainer.querySelector('.solutions-search-input');

        // Рендер порции решений с lazy-fetch статусов
        async function renderBatch(startIdx, count) {
            const batch = allSolutions.slice(startIdx, startIdx + count);

            // Параллельная загрузка статусов только для этой порции
            const fetchStatusWithTimeout = async (solution) => {
                try {
                    const statusData = await apiCallWithTimeout(
                        `/api/users/self/solutions/${solution.id}/status`,
                        'GET', null, {}, idToken, 5000
                    );
                    return { ...solution, status: statusData };
                } catch (error) {
                    console.warn(`[SOLUTIONS] Failed to fetch status for ${solution.id}:`, error.message || error);
                    return { ...solution, status: { status: 'unknown', message: 'Failed to load status' } };
                }
            };

            const solutionsWithStatus = await Promise.all(batch.map(fetchStatusWithTimeout));

            // Рендер карточек
            for (const solution of solutionsWithStatus) {
                const solutionName = solution.name;
                const solutionID = solution.id;
                const status = solution.status?.status || 'unknown';
                const statusMessage = solution.status?.message || '';
                const statusClass = getStatusClass(status);
                const statusIcon = getStatusIcon(status);

                const item = document.createElement('div');
                item.className = 'solution-item';
                item.dataset.solutionId = solutionID;
                item.innerHTML = `
                    <button class="solution-btn ${statusClass}" data-solution-id="${solutionID}">
                        <span class="solution-name">${solutionName}</span>
                        <span class="solution-status ${statusClass}" title="${statusMessage}">
                            ${statusIcon} ${formatStatus(status)}
                        </span>
                    </button>
                `;
                listInner.appendChild(item);
            }

            // Привязка кликов к новым кнопкам
            listInner.querySelectorAll('.solution-btn:not([data-bound])').forEach(button => {
                button.dataset.bound = '1';
                button.addEventListener('click', (e) => {
                    listInner.querySelectorAll('.solution-btn').forEach(b => {
                        b.classList.remove('selected');
                        b.removeAttribute("style");
                    });
                    button.classList.add('selected');

                    const solutionID = e.target.closest('.solution-btn').getAttribute('data-solution-id');
                    console.log(`[SOLUTIONS] Выбрано решение с ID: ${solutionID}`);
                    loadAndDisplaySolutionDetails(solutionID, idToken, solutionDetailsPlaceholder, solutionDetailsContainer, fileUploadSection);
                });
            });
        }

        // Первая порция
        await renderBatch(0, visibleCount);

        // Debounce-поиск по названию решений (300ms)
        let searchTimer = null;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                if (searchTimer) clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    const query = searchInput.value.trim().toLowerCase();
                    const items = listInner.querySelectorAll('.solution-item');
                    let visibleItems = 0;
                    items.forEach(item => {
                        const name = item.querySelector('.solution-name')?.textContent?.toLowerCase() || '';
                        const matches = !query || name.includes(query);
                        item.style.display = matches ? '' : 'none';
                        if (matches) visibleItems++;
                    });
                    // Скрываем кнопку «Загрузить ещё» при активном поиске
                    if (loadMoreBtn) {
                        loadMoreBtn.style.display = query ? 'none' : '';
                    }
                    // Показываем сообщение если ничего не найдено
                    let noResults = listInner.querySelector('.solutions-no-results');
                    if (visibleItems === 0 && query) {
                        if (!noResults) {
                            noResults = document.createElement('p');
                            noResults.className = 'solutions-no-results';
                            noResults.style.cssText = 'padding:var(--spacing-md);color:var(--color-text-tertiary);text-align:center;';
                            listInner.appendChild(noResults);
                        }
                        noResults.textContent = `Ничего не найдено по запросу «${searchInput.value.trim()}»`;
                        noResults.style.display = '';
                    } else if (noResults) {
                        noResults.style.display = 'none';
                    }
                }, 300);
            });
        }

        // Кнопка «Загрузить ещё»
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', async () => {
                const prevCount = visibleCount;
                visibleCount = Math.min(visibleCount + PAGE_SIZE, allSolutions.length);
                const remaining = allSolutions.length - visibleCount;

                loadMoreBtn.disabled = true;
                loadMoreBtn.textContent = '⏳ Загрузка...';

                await renderBatch(prevCount, visibleCount - prevCount);

                if (remaining > 0) {
                    loadMoreBtn.disabled = false;
                    loadMoreBtn.textContent = `📋 Загрузить ещё (${remaining} из ${allSolutions.length})`;
                } else {
                    loadMoreBtn.remove();
                }
            });
        }

        const newCreateBtn = solutionsListContainer.querySelector('#create-solution-btn');
        if (newCreateBtn) {
            newCreateBtn.addEventListener('click', openCreateSolutionModal);
        }

        // Если детали еще не отображены, показываем placeholder
        if (solutionDetailsContainer.classList.contains('hidden')) {
            solutionDetailsPlaceholder.textContent = 'Выберите решение из списка слева.';
            solutionDetailsPlaceholder.classList.remove('hidden');
        }

    } catch (error) {
        console.error("[SOLUTIONS] Ошибка при загрузке решений:", error);
        solutionsListPlaceholder.textContent = 'Ошибка загрузки решений.';
        solutionsListPlaceholder.classList.remove('hidden');
        solutionsListContainer.innerHTML = '';
        solutionDetailsPlaceholder.textContent = 'Не удалось загрузить список решений.';
        solutionDetailsPlaceholder.classList.remove('hidden');
        solutionDetailsContainer.classList.add('hidden');
    }
}

// Helper functions for status display
function getStatusClass(status) {
    switch (status) {
        case 'completed':
        case 'success':
        case 'finished':
            return 'status-success';
        case 'running':
        case 'processing':
        case 'in_progress':
            return 'status-running';
        case 'pending':
        case 'queued':
        case 'waiting':
            return 'status-pending';
        case 'failed':
        case 'error':
            return 'status-error';
        case 'cancelled':
        case 'canceled':
            return 'status-cancelled';
        default:
            return 'status-unknown';
    }
}

function getStatusIcon(status) {
    switch (status) {
        case 'completed':
        case 'success':
        case 'finished':
            return '✅';
        case 'running':
        case 'processing':
        case 'in_progress':
            return '⚙️';
        case 'pending':
        case 'queued':
        case 'waiting':
            return '⏳';
        case 'failed':
        case 'error':
            return '❌';
        case 'cancelled':
        case 'canceled':
            return '🚫';
        default:
            return '❓';
    }
}

function formatStatus(status) {
    const statusMap = {
        'completed': 'Завершено',
        'success': 'Успешно',
        'finished': 'Готово',
        'running': 'Выполняется',
        'processing': 'Обработка',
        'in_progress': 'В процессе',
        'pending': 'Ожидание',
        'queued': 'В очереди',
        'waiting': 'Ожидание',
        'failed': 'Ошибка',
        'error': 'Ошибка',
        'cancelled': 'Отменено',
        'canceled': 'Отменено',
        'unknown': 'Неизвестно'
    };
    return statusMap[status] || status;
}
