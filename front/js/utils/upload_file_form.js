import { currentIDToken } from '../main.js';

let currentSolutionID = null;

export function setCurrentSolutionID(id) {
    currentSolutionID = id;
    console.log(`[MAIN] currentSolutionID обновлен на: ${id}`);
}

// Привязываем обработчик программно
const uploadForm = document.getElementById('file-upload-form');
if (uploadForm) {
    uploadForm.addEventListener('submit', handleFileUpload);
}

export async function handleFileUpload(event) {
    // 1. ПЕРВЫМ ДЕЛОМ предотвращаем перезагрузку
    event.preventDefault();

   

    const zip = new JSZip();

    const fileInput_p = document.getElementById('file-input-p');
    const fileInput_c = document.getElementById('file-input-c');
    const uploadBtn = document.getElementById('upload-file-btn');
    const uploadProgress = document.getElementById('upload-progress');
    const progressBar = document.getElementById('progress-bar');
    const progressPercent = document.getElementById('progress-percent');
    const uploadMessage = document.getElementById('upload-message');

    const file_p = fileInput_p.files[0];
    const file_c = fileInput_c.files[0];

    // Валидация
    if (!file_p || !file_c) {
        showMessage('Пожалуйста, выберите оба файла (P и C).', 'error', uploadMessage);
        return;
    }

    if (!file_p.name.toLowerCase().endsWith('.dat') || !file_c.name.toLowerCase().endsWith('.dat')) {
        showMessage('Файлы должны иметь расширение .dat', 'error', uploadMessage);
        return;
    }

    if (!currentIDToken || !currentSolutionID) {
        showMessage('Ошибка: решение не выбрано или вы не авторизованы.', 'error', uploadMessage);
        return;
    }

    // Блокировка интерфейса
    fileInput_p.disabled = true;
    fileInput_c.disabled = true;
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Упаковка...';
    
    uploadProgress.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';

    try {
        // 1. Создание архива
        zip.file("Profiles.dat", file_p);
        zip.file("Coarse.dat", file_c);

        const zipBlob = await zip.generateAsync({ type: "blob" });
        const zipFile = new File([zipBlob], "solution_data.zip", { type: "application/zip" });

        console.log(`[FILE UPLOAD] ZIP создан: ${zipFile.size} байт`);
        showMessage(`Загрузка архива...`, 'info', uploadMessage);
        uploadBtn.textContent = 'Загрузка...';

        // 2. Отправка
        const formData = new FormData();
        formData.append('file', zipFile);

        const response = await fetch(`/api/users/self/solutions/${currentSolutionID}/upload`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentIDToken}`,
            },
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Сервер вернул ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        console.log(`[FILE UPLOAD] Успех:`, result);

        showMessage(`Файлы успешно упакованы и загружены!`, 'success', uploadMessage);
        progressBar.style.width = '100%';
        progressPercent.textContent = '100%';

        document.getElementById('file-upload-form').reset();

    } catch (error) {
        console.error(`[FILE UPLOAD] Ошибка:`, error);
        showMessage(`Ошибка: ${error.message}`, 'error', uploadMessage);
    } finally {
        // Разблокировка (используем правильные переменные)
        fileInput_p.disabled = false;
        fileInput_c.disabled = false;
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Загрузить';
    }
}

function showMessage(message, type, element) {
    if (element) {
        element.textContent = message;
        element.className = 'upload-message ' + type;
        element.classList.remove('hidden');
    }
}
