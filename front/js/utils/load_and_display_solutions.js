import { loadAndDisplaySolutionDetails } from "./load_and_display_solution_details.js";
export async function loadAndDisplaySolutions(idToken, solutionsListContainer,
    solutionsListPlaceholder, solutionDetailsContainer, solutionDetailsPlaceholder,fileUploadSection) {
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

        // Создаем HTML для списка решений в виде кнопок
        let solutionsScrollContainerHTML = `                
                <h3>Ваши решения:</h3>
                <div class="solutions-scroll-container">
                    <div class="solutions-list">
            `;
        solutions.forEach(solution => {
            const solutionName = solution.name; //|| `Решение (${solution.id})`;
            const solutionID = solution.id;
            solutionsScrollContainerHTML += `<button class="solution-btn" data-solution-id="${solutionID}">${solutionName}</button>`;
        });
        solutionsScrollContainerHTML += `
                    </div>
                </div>
            `;

        solutionsListContainer.innerHTML = solutionsScrollContainerHTML;

        solutionsListContainer.querySelectorAll('.solution-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                solutionsListContainer.querySelectorAll('.solution-btn').forEach(buttons => {
                    buttons.setAttribute("style", "background-color: #3367d6;");
                })
                button.setAttribute("style", "background-color: #4ba364a1;");

                let solutionID = e.target.getAttribute('data-solution-id');
                console.log(`[SOLUTIONS] Выбрано решение с ID: ${solutionID}`);
                loadAndDisplaySolutionDetails(solutionID, idToken, solutionDetailsPlaceholder,solutionDetailsContainer,fileUploadSection);
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
