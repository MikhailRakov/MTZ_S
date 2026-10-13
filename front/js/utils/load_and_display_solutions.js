import { loadAndDisplaySolutionDetails } from "./load_and_display_solution_details.js";
import { apiCall, apiCallWithTimeout } from './api.js';

export async function loadAndDisplaySolutions(idToken, solutionsListContainer,
    solutionsListPlaceholder, solutionDetailsContainer, solutionDetailsPlaceholder, fileUploadSection) {
    if (!solutionsListContainer || !solutionsListPlaceholder) {
        console.error("[SOLUTIONS] Элементы .block-left не найдены в DOM.");
        return;
    }

    solutionsListPlaceholder.textContent = 'Загрузка решений...';
    solutionsListPlaceholder.classList.remove('hidden');
    solutionsListContainer.innerHTML = ''; // Очищаем список

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

        const solutions = await response.json();

        console.log(`[SOLUTIONS] Получено ${solutions.length} решений`);

        solutionsListPlaceholder.classList.add('hidden'); // Скрываем placeholder
        //fileUploadSection.classList.add('hidden');
        if (solutions.length === 0) {
            solutionsListContainer.innerHTML = '<p>У вас пока нет решений.</p>';
            solutionDetailsPlaceholder.textContent = 'Создайте первое решение!';
            solutionDetailsPlaceholder.classList.remove('hidden');
            solutionDetailsContainer.classList.add('hidden');

            return;
        }

        // Fetch status for each solution with timeout
        console.log("[SOLUTIONS] Fetching status for all solutions...");

        const fetchStatusWithTimeout = async (solution) => {
            try {
                console.log(`[SOLUTIONS] Fetching status for ${solution.id}...`);
                const statusData = await apiCallWithTimeout(`/api/users/self/solutions/${solution.id}/status`, 'GET', null, {}, idToken, 5000);
                console.log(`[SOLUTIONS] Status for ${solution.id}:`, statusData);
                return { ...solution, status: statusData };
            } catch (error) {
                console.warn(`[SOLUTIONS] Failed to fetch status for ${solution.id}:`, error.message || error);
                return { ...solution, status: { status: 'unknown', message: 'Failed to load status' } };
            }
        };

        const solutionsWithStatus = await Promise.all(
            solutions.map(fetchStatusWithTimeout)
        );
        console.log("[SOLUTIONS] All statuses fetched:", solutionsWithStatus);

        // Создаем HTML для списка решений в виде кнопок
        let solutionsScrollContainerHTML = `
                <h3>Ваши решения:</h3>
                <div class="solutions-scroll-container">
                    <div class="solutions-list">
            `;
        solutionsWithStatus.forEach(solution => {
            const solutionName = solution.name; //|| `Решение (${solution.id})`;
            const solutionID = solution.id;
            const status = solution.status?.status || 'unknown';
            const statusMessage = solution.status?.message || '';
            const statusClass = getStatusClass(status);
            const statusIcon = getStatusIcon(status);

            solutionsScrollContainerHTML += `
                <div class="solution-item" data-solution-id="${solutionID}">
                    <button class="solution-btn ${statusClass}" data-solution-id="${solutionID}">
                        <span class="solution-name">${solutionName}</span>
                        <span class="solution-status ${statusClass}" title="${statusMessage}">
                            ${statusIcon} ${formatStatus(status)}
                        </span>
                    </button>
                </div>
            `;
        });
        solutionsScrollContainerHTML += `
                    </div>
                </div>
            `;

        solutionsListContainer.innerHTML = solutionsScrollContainerHTML;

        solutionsListContainer.querySelectorAll('.solution-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                solutionsListContainer.querySelectorAll('.solution-btn').forEach(buttons => {
                    buttons.classList.remove('selected');
                    buttons.removeAttribute("style");
                })
                button.classList.add('selected');

                let solutionID = e.target.closest('.solution-btn').getAttribute('data-solution-id');
                console.log(`[SOLUTIONS] Выбрано решение с ID: ${solutionID}`);
                loadAndDisplaySolutionDetails(solutionID, idToken, solutionDetailsPlaceholder, solutionDetailsContainer, fileUploadSection);
            });
        });
        const newCreateBtn = solutionsListContainer.querySelector('#create-solution-btn');
        if (newCreateBtn) {
            newCreateBtn.addEventListener('click', openCreateSolutionModal);
        }


        // Если детали еще не отображены, показываем placeholder
        if (solutionDetailsContainer.classList.contains('hidden') && solutionsListContainer.innerHTML !== '<p>У вас пока нет решений.</p>') {
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
