//load_and_display_solution_details.js
import { apiCall, apiCallWithTimeout } from './api.js';
import { setCurrentSolutionID } from './upload_file_form.js';
import { resetCoarseGenerator } from './dashboardCoarseIntegration.js';
import { ResultViewer } from './resultViewer.js';

let currentIdToken = null;
let resultViewerInstance = null;

export async function loadSolutionFiles(solutionId, idToken){
  currentIdToken = idToken; // Store token for later use
  const container = document.getElementById('files-list');
  const filesSection = document.getElementById('solution-files-container');

  try {
    const res = await fetch(`/api/users/self/solutions/${solutionId}/files`, {
            headers: { 'Authorization': `Bearer ${idToken}` }
        });

    if (!res.ok) throw new Error('Не удалось получить список файлов');

    const data = await res.json();

    if (data.files && data.files.length > 0) {
      filesSection.classList.remove('hidden');
      renderFiles(data.files, container, solutionId, idToken);
    } else {
      filesSection.classList.add('hidden');
    }
  } catch (err) {
    container.innerHTML = `<p class="text-danger">Файлы ещё не готовы или произошла ошибка: ${err.message}</p>`;
    filesSection.classList.remove('hidden');
  }
}

function renderFiles(files, container, solutionId, idToken) {
  if (!files || files.length === 0) {
    container.innerHTML = '<p class="text-muted">Файлы результатов отсутствуют.</p>';
    return;
  }

  container.innerHTML = '';
  files.forEach(file => {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    const date = new Date(file.last_modified).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });

    // Determine if file is viewable
    const isViewable = isFileViewable(file.name);

    const el = document.createElement('div');
    el.className = 'file-card';
    el.innerHTML = `
      <div class="file-info">
        <strong>${file.name}</strong><br>
        <small>${sizeMB} MB • ${date}</small>
      </div>
      <div class="file-actions">
        ${isViewable ? `<button class="btn-view" data-file-key="${file.key}" data-file-name="${file.name}">👁 Просмотр</button>` : ''}
        <button class="btn-download" data-file-key="${file.key}">💾 Скачать</button>
      </div>
    `;
    container.appendChild(el);
  });

  // Add event listeners for view buttons
  container.querySelectorAll('.btn-view').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const fileKey = e.target.getAttribute('data-file-key');
      const fileName = e.target.getAttribute('data-file-name');
      await viewFile(solutionId, fileKey, fileName, idToken);
    });
  });

  // Add event listeners for download buttons
  container.querySelectorAll('.btn-download').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const fileKey = e.target.getAttribute('data-file-key');
      await downloadFile(solutionId, fileKey, idToken);
    });
  });
}

function isFileViewable(filename) {
  const viewableExtensions = ['.txt', '.log', '.dat', '.json', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf'];
  return viewableExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

function isResultFile(filename) {
  // Check if this is an inversion result file (Coarse_inv.dat, model_*.dat, etc.)
  const resultPatterns = ['coarse_inv', 'model', 'inv_', 'result'];
  const lower = filename.toLowerCase();
  return lower.endsWith('.dat') && resultPatterns.some(pattern => lower.includes(pattern));
}

async function viewFile(solutionId, fileKey, fileName, idToken) {
  try {
    const response = await fetch(`/api/users/self/solutions/${solutionId}/files/${encodeURIComponent(fileKey)}`, {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });

    if (!response.ok) throw new Error('Не удалось загрузить файл');

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    // Determine file type
    const ext = fileName.toLowerCase().split('.').pop();

    if (isResultFile(fileName)) {
      // Open 3D result viewer for inversion results
      const text = await blob.text();
      show3DResultViewer(text, fileName);
    } else if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext)) {
      // Open image in modal
      showImageModal(url, fileName);
    } else if (ext === 'pdf') {
      // Open PDF in new tab
      window.open(url, '_blank');
    } else {
      // Open text files in modal
      const text = await blob.text();
      showTextModal(text, fileName);
    }
  } catch (error) {
    console.error('Error viewing file:', error);
    alert('Ошибка при просмотре файла: ' + error.message);
  }
}

async function downloadFile(solutionId, fileKey, idToken) {
  try {
    const response = await fetch(`/api/users/self/solutions/${solutionId}/files/${encodeURIComponent(fileKey)}`, {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });

    if (!response.ok) throw new Error('Не удалось загрузить файл');

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileKey.split('/').pop(); // Get filename from key
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Error downloading file:', error);
    alert('Ошибка при скачивании файла: ' + error.message);
  }
}

function showImageModal(imageUrl, fileName) {
  const modal = document.createElement('div');
  modal.className = 'file-viewer-modal';
  modal.innerHTML = `
    <div class="file-viewer-content">
      <div class="file-viewer-header">
        <h3>${fileName}</h3>
        <button class="file-viewer-close">&times;</button>
      </div>
      <div class="file-viewer-body">
        <img src="${imageUrl}" alt="${fileName}" style="max-width: 100%; max-height: 80vh;">
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('.file-viewer-close').addEventListener('click', () => {
    document.body.removeChild(modal);
    URL.revokeObjectURL(imageUrl);
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
      URL.revokeObjectURL(imageUrl);
    }
  });
}

function showTextModal(text, fileName) {
  const modal = document.createElement('div');
  modal.className = 'file-viewer-modal';
  modal.innerHTML = `
    <div class="file-viewer-content">
      <div class="file-viewer-header">
        <h3>${fileName}</h3>
        <button class="file-viewer-close">&times;</button>
      </div>
      <div class="file-viewer-body">
        <pre style="white-space: pre-wrap; word-wrap: break-word; max-height: 70vh; overflow-y: auto; padding: 16px; background: var(--color-bg-secondary); border-radius: var(--radius-md);">${escapeHtml(text)}</pre>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('.file-viewer-close').addEventListener('click', () => {
    document.body.removeChild(modal);
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      document.body.removeChild(modal);
    }
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function show3DResultViewer(fileContent, fileName) {
  const modal = document.createElement('div');
  modal.className = 'file-viewer-modal result-viewer-modal-large';
  modal.innerHTML = `
    <div class="file-viewer-content result-viewer-content-large">
      <div class="file-viewer-header">
        <h3>📊 3D Визуализация: ${fileName}</h3>
        <button class="file-viewer-close">&times;</button>
      </div>
      <div class="file-viewer-body">
        <div id="result-3d-container" style="width: 100%; height: 70vh; position: relative;"></div>
        <div id="result-stats" style="margin-top: 16px; padding: 12px; background: var(--color-bg-secondary); border-radius: var(--radius-md);"></div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const container = modal.querySelector('#result-3d-container');
  const statsDiv = modal.querySelector('#result-stats');

  // Parse and visualize result
  try {
    if (resultViewerInstance) {
      resultViewerInstance.dispose();
    }

    resultViewerInstance = new ResultViewer();
    const modelData = resultViewerInstance.parseResultFile(fileContent);

    // Display stats
    const totalCells = modelData.nX * modelData.nY * modelData.nZ;
    const xExtent = modelData.xCells.reduce((a, b) => a + b, 0);
    const yExtent = modelData.yCells.reduce((a, b) => a + b, 0);
    const zExtent = modelData.zCells.reduce((a, b) => a + b, 0);

    const validRho = modelData.rhoValues.filter(v => v > 0);
    const minRho = Math.min(...validRho);
    const maxRho = Math.max(...validRho);
    const avgRho = validRho.reduce((a, b) => a + b, 0) / validRho.length;

    statsDiv.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; font-size: 0.9em;">
        <div>
          <div style="color: var(--color-text-tertiary);">Размер модели</div>
          <div style="color: var(--color-primary); font-weight: 600;">${modelData.nX} × ${modelData.nY} × ${modelData.nZ}</div>
        </div>
        <div>
          <div style="color: var(--color-text-tertiary);">Всего ячеек</div>
          <div style="color: var(--color-primary); font-weight: 600;">${totalCells.toLocaleString()}</div>
        </div>
        <div>
          <div style="color: var(--color-text-tertiary);">Область (X × Y)</div>
          <div style="color: var(--color-primary); font-weight: 600;">${(xExtent/1000).toFixed(1)} × ${(yExtent/1000).toFixed(1)} км</div>
        </div>
        <div>
          <div style="color: var(--color-text-tertiary);">Глубина</div>
          <div style="color: var(--color-primary); font-weight: 600;">${(zExtent/1000).toFixed(1)} км</div>
        </div>
        <div>
          <div style="color: var(--color-text-tertiary);">Мин. сопротивление</div>
          <div style="color: var(--color-primary); font-weight: 600;">${minRho.toFixed(2)} Ω·м</div>
        </div>
        <div>
          <div style="color: var(--color-text-tertiary);">Макс. сопротивление</div>
          <div style="color: var(--color-primary); font-weight: 600;">${maxRho.toFixed(2)} Ω·м</div>
        </div>
        <div>
          <div style="color: var(--color-text-tertiary);">Среднее</div>
          <div style="color: var(--color-primary); font-weight: 600;">${avgRho.toFixed(2)} Ω·м</div>
        </div>
      </div>
      <div style="margin-top: 12px; color: var(--color-text-tertiary); font-size: 0.85em;">
        💡 Используйте мышь для вращения, масштабирования и панорамирования модели
      </div>
    `;

    // Initialize 3D visualization
    resultViewerInstance.init3DVisualization(container, modelData);

  } catch (error) {
    console.error('Error parsing result file:', error);
    statsDiv.innerHTML = `<p style="color: var(--color-danger);">Ошибка при парсинге файла: ${error.message}</p>`;
  }

  modal.querySelector('.file-viewer-close').addEventListener('click', () => {
    if (resultViewerInstance) {
      resultViewerInstance.dispose();
      resultViewerInstance = null;
    }
    document.body.removeChild(modal);
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      if (resultViewerInstance) {
        resultViewerInstance.dispose();
        resultViewerInstance = null;
      }
      document.body.removeChild(modal);
    }
  });
}
export async function loadAndDisplaySolutionDetails(solutionID, idToken, solutionDetailsPlaceholder, solutionDetailsContainer, fileUploadSection) {

    // Reset coarse generator state when switching solutions
    resetCoarseGenerator();

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
        const solutionData = await apiCallWithTimeout(`/api/users/self/solutions/${solutionID}`, 'GET', null, {}, idToken, 5000);

        // Fetch solution status with timeout
        let statusData = { status: 'unknown', message: 'Failed to load status' };
        try {
            statusData = await apiCallWithTimeout(`/api/users/self/solutions/${solutionID}/status`, 'GET', null, {}, idToken, 3000);
        } catch (statusError) {
            console.warn(`[SOLUTION DETAILS] Failed to fetch status for ${solutionID}:`, statusError);
        }

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

        const status = statusData.status || 'unknown';
        const statusMessage = statusData.message || '';
        const statusClass = getStatusClass(status);
        const statusIcon = getStatusIcon(status);
        const formattedStatus = formatStatus(status);

        let solutionInfoHTML = `
            <h3>Информация о решении</h3>
            <div class="solution-header">
                <div class="solution-title">
                    <h4>${solutionName}</h4>
                    <span class="solution-status ${statusClass}" title="${statusMessage}">
                        ${statusIcon} ${formattedStatus}
                    </span>
                </div>
            </div>
            <div class="solution-meta">
                <p><strong>ID:</strong> ${solutionData.id}</p>
                <p><strong>Дата создания:</strong> ${createdAtString}</p>
            </div>
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

// Helper functions for status display (shared with load_and_display_solutions.js)
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