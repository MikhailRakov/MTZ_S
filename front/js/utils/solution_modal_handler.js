export function openCreateSolutionModal(createSolutionModal,createSolutionError,solutionNameInput,document) {
    
    if (createSolutionModal) {
        console.log("openCreateSolutionModal")
        // Предотвращаем прокрутку основного контента
        document.body.style.overflow = 'hidden';
        // Показываем модальное окно
        createSolutionModal.classList.remove('hidden');
        // Очищаем и фокусируем поле ввода
        solutionNameInput.value = '';
        hideCreateSolutionError(createSolutionError);
        solutionNameInput.focus();
    }
    else{
        console.log("NOT openCreateSolutionModal")
    }
}

export function closeCreateSolutionModal(createSolutionModal) {
    if (createSolutionModal) {
        // Восстанавливаем прокрутку
        document.body.style.overflow = 'auto';
        // Скрываем модальное окно
        createSolutionModal.classList.add('hidden');
    }
}

export function showCreateSolutionError(message,createSolutionError) {
    if (createSolutionError) {
        createSolutionError.textContent = message;
        createSolutionError.classList.remove('hidden');
    }
}

export function hideCreateSolutionError(createSolutionError) {
    if (createSolutionError) {
        createSolutionError.textContent = '';
        createSolutionError.classList.add('hidden');
    }
}
