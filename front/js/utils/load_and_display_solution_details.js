//load_and_display_solution_details.js
import { apiCall } from './api.js';
import { setCurrentSolutionID } from './upload_file_form.js';
export async function loadSolutionFiles(solutionId, idToken){
  const container = document.getElementById('files-list');
  try {
    const res = await fetch(`/api/users/self/solutions/${solutionId}/files`, {
            headers: { 'Authorization': `Bearer ${idToken}` } // <--- используем параметр
        });
    
    if (!res.ok) throw new Error('Не удалось получить список файлов');
    
    const data = await res.json();
    renderFiles(data.files, container);
  } catch (err) {
    container.innerHTML = `<p class="text-danger">Файлы ещё не готовы или произошла ошибка: ${err.message}</p>`;
  }
}

function renderFiles(files, container) {
  if (!files || files.length === 0) {
    container.innerHTML = '<p class="text-muted">Файлы результатов отсутствуют.</p>';
    return;
  }

  container.innerHTML = '';
  files.forEach(file => {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    const date = new Date(file.last_modified).toLocaleDateString();
    
    const el = document.createElement('div');
    el.className = 'file-card';
    el.innerHTML = `
      <div class="file-info">
        <strong>${file.name}</strong><br>
        <small>${sizeMB} MB • ${date}</small>
      </div>
      <button class="btn-download" onclick="requestDownload('${file.key}')">Скачать</button>
    `;
    container.appendChild(el);
  });
}
export async function loadAndDisplaySolutionDetails(solutionID, idToken, solutionDetailsPlaceholder, solutionDetailsContainer, fileUploadSection) {
    
    setCurrentSolutionID(solutionID);
    const elements = {
        //solutionDetailsView,
        //    solutionsContent,
        //    mainAreaTitle,
        //fileUploadSection = document.getElementById('file-upload-section');
        fileUploadForm: document.getElementById('file-upload-form'),
        fileInput_p: document.getElementById('file-input-p'),         //
        fileInput_c: document.getElementById('file-input-c'),  
        //uploadBtn: document.getElementById('upload-btn'),         // 
        uploadProgress: document.getElementById('upload-progress'),    // 
        uploadMessage: document.getElementById('upload-message'),   // 

    }
    if (!solutionDetailsContainer || !solutionDetailsPlaceholder) {
        console.error("[SOLUTION DETAILS] Элементы .block-right не найдены в DOM.");
        return;
    }
    
    elements.uploadMessage.classList.add('hidden');

    solutionDetailsPlaceholder.textContent = 'Загрузка информации о решении...';
    solutionDetailsPlaceholder.classList.remove('hidden');
    // Скрываем основной контейнер деи
    solutionDetailsContainer.classList.add('hidden');
   

    try {
        console.log(`[SOLUTION DETAILS] Отправка запроса на /api/users/self/solutions/${solutionID}`);
        const solutionData = await apiCall(`/api/users/self/solutions/${solutionID}`, 'GET', null, {}, idToken);

        console.log(`[SOLUTION DETAILS] Получены данные решения ${solutionID}:`, solutionData);
        
        const solutionName = solutionData.name || 'Без названия';
        //const createdAtString = "01.03.2026";
        const createdAtString =new Date(solutionData['create_date']).toLocaleString(undefined,{
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
        let solutionInfoHTML = `
            <h3>Информация о решении</h3>
            <p><strong>Название:</strong> ${solutionName}</p>
            <!-- <p><strong>ID:</strong> ${solutionData.id}</p> -->
            <p><strong>Дата создания:</strong> ${createdAtString}</p>
            <!-- Здесь можно добавить отображение загруженных файлов -->
        `;

        // --- КОНЕЦ ИЗМЕНЕНИЙ ---

        // --- НОВОЕ: Обновляем только информационную часть контейнера ---
        // Предполагаем, что в solutionDetailsContainer есть элемент для информации и форма загрузки
        // Например: <div id="solution-info"></div><div id="file-upload-section">...</div>
        // Или обновляем весь контейнер, но затем показываем форму

        // Вариант 1: Если у вас есть отдельный div для информации внутри solutionDetailsContainer
        // const solutionInfoDiv = solutionDetailsContainer.querySelector('#solution-info');
        // if (solutionInfoDiv) {
        //     solutionInfoDiv.innerHTML = solutionInfoHTML;
        // } else {
        //     solutionDetailsContainer.innerHTML = solutionInfoHTML; // fallback
        // }

        // Вариант 2: Обновляем весь контейнер, затем показываем форму (проще)
        solutionDetailsContainer.innerHTML = solutionInfoHTML;

        // Добавляем обработчик формы загрузки, если он не глобальный
        // setupFileUploadHandler(solutionID, idToken, elements); // Можно вызвать здесь

        // --- КОНЕЦ НОВОГО ---

        // Скрываем placeholder и показываем контейнер с деталями
        solutionDetailsPlaceholder.classList.add('hidden');
        solutionDetailsContainer.classList.remove('hidden');


        if (fileUploadSection) {
            fileUploadSection.classList.remove('hidden');
            if (elements.fileUploadForm) elements.fileUploadForm.reset();
            console.log(`[SOLUTION DETAILS] Форма загрузки показана для решения ${solutionID}`);
        } else {
            console.warn("[SOLUTION DETAILS] Элемент формы загрузки fileUploadSection не найден или не передан в elements");
        }

    loadSolutionFiles(solutionID, idToken);
    } catch (error) {
        console.error(`[SOLUTION DETAILS] Ошибка при загрузке деталей решения ${solutionID}:`, error);
        solutionDetailsPlaceholder.textContent = `Ошибка загрузки информации о решении: ${error.message}`;
        solutionDetailsPlaceholder.classList.remove('hidden');
        solutionDetailsContainer.classList.add('hidden');

        // --- НОВОЕ: Скрываем виджет в случае ошибки ---
        if (sendToQueueWidget) sendToQueueWidget.classList.add('hidden');
        // --- КОНЕЦ НОВОГО ---


    }

}