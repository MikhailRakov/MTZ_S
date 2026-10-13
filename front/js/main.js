//main.js
import { loadAndDisplaySolutions } from './utils/load_and_display_solutions.js';
import { updateProfileUI } from './utils/update_profile_ui.js';
import { openCreateSolutionModal, closeCreateSolutionModal, showCreateSolutionError, hideCreateSolutionError } from './utils/solution_modal_handler.js'
import { handleFileUpload } from './utils/upload_file_form.js'
import { initCoarseGenerator } from './utils/dashboardCoarseIntegration.js';
export { currentIDToken}


let auth;
let currentUser = null;
let currentIDToken = null; // Храним токен для использования в API запросах

// Элементы DOM
const elements = {
    userAvatarSmall: document.getElementById('user-avatar-small'),
    profileDropdown: document.getElementById('profile-dropdown'),
    userAvatarLarge: document.getElementById('user-avatar-large'),
    profileName: document.getElementById('profile-name'),
    profileEmail: document.getElementById('profile-email'),
    logoutBtn: document.getElementById('logout-btn'),
    blockLeft: document.querySelector('.block-left'),
    blockRight: document.querySelector('.block-right'),
    solutionsListPlaceholder: document.getElementById('solutions-list-placeholder'),
    solutionsListContainer: document.getElementById('solutions-list-container'),
    solutionDetailsPlaceholder: document.getElementById('solution-details-placeholder'),
    solutionDetailsContainer: document.getElementById('solution-details-container'),
    fileUploadSection: document.getElementById('file-upload-section'),
    createSolutionBtn: document.getElementById('create-solution-btn'),
    createSolutionModal: document.getElementById('create-solution-modal'),
    closeModalBtn: document.querySelector('.close'),
    cancelCreateBtn: document.getElementById('cancel-create-btn'),
    createSolutionForm: document.getElementById('create-solution-form'),
    solutionNameInput: document.getElementById('solution-name'),
    createSolutionError: document.getElementById('create-solution-error'),

    sendToQueueWidget: document.getElementById('send-to-queue-widget'),
    sendToQueueBtn: document.getElementById('send-to-queue-btn'),
    sendToQueueStatus: document.getElementById('send-to-queue-status'),

};

//console.log(elements.solutionsListContainer);
try {
    if (typeof firebaseConfig !== 'undefined') {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        } else {
            firebase.app();
        }
        auth = firebase.auth();
    } else {
        console.error("Конфигурация firebaseConfig не найдена!");
        // Показать ошибку в UI, если нужно
    }
} catch (e) {
    console.error("Ошибка инициализации Firebase:", e);
    // Показать ошибку в UI, если нужно
}

if (auth) {
    auth.onAuthStateChanged((user) => {
        if (user) {
            currentUser = user;
            console.log("[AUTH] Пользователь аутентифицирован:", user.uid);

            user.getIdToken(true)
                .then((idToken) => {
                    console.log("[TOKEN] Получен ID токен");
                    currentIDToken = idToken;

                    return fetch('/api/users/self', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ idToken: idToken })
                    })
                        .then(response => {
                            console.log("[API] Raw response status:", response.status);
                            console.log("[API] Raw response headers:", [...response.headers.entries()]);

                            if (!response.ok) {
                                return response.text().then(text => {
                                    console.error("[API] Error response body (text):", text); // Логируем тело ошибки
                                    throw new Error(`HTTP ${response.status}: ${text}`);
                                });
                            }

                            // Проверим, есть ли тело у ответа перед попыткой парсить JSON
                            const contentType = response.headers.get("content-type");
                            if (contentType && contentType.indexOf("application/json") !== -1) {
                                return response.json(); // Парсим JSON, если Content-Type правильный
                            } else {
                                // Если Content-Type не JSON, попробуем получить текст для отладки
                                return response.text().then(text => {
                                    console.error("[API] Expected JSON, but got:", text);
                                    throw new Error(`Expected JSON, but got ${contentType || 'no content-type'}: ${text.substring(0, 100)}...`);
                                });
                            }
                        })
                        .then(userData => {
                            console.log("[API] Данные пользователя получены");
                            currentUser = updateProfileUI(user, elements.userAvatarSmall, elements.userAvatarLarge, elements.profileName, elements.profileEmail, elements.profileDropdown);
                            return loadAndDisplaySolutions(idToken, elements.solutionsListContainer, elements.solutionsListPlaceholder, elements.solutionDetailsContainer, elements.solutionDetailsPlaceholder, elements.fileUploadSection);
                        });
                })
                .catch((error) => {
                    console.error("[ERROR] Ошибка при работе с API:", error);
                    // Можно показать ошибку в UI
                });
        } else {
            currentUser = null;
            console.log("[AUTH] Пользователь не аутентифицирован");
            // Сбросить UI, показать сообщение о необходимости входа
            if (elements.solutionsListPlaceholder) {
                elements.solutionsListPlaceholder.textContent = 'Вы не вошли в систему.';
                elements.solutionsListPlaceholder.classList.remove('hidden');
            }
            if (elements.solutionsListContainer) {
                elements.solutionsListContainer.innerHTML = '';
            }
            if (elements.solutionDetailsPlaceholder) {
                elements.solutionDetailsPlaceholder.textContent = 'Войдите, чтобы просмотреть или создать решения.';
                elements.solutionDetailsPlaceholder.classList.remove('hidden');
            }
            if (elements.solutionDetailsContainer) {
                elements.solutionDetailsContainer.classList.add('hidden');
            }
            if (elements.fileUploadSection) {
                fileUploadForm.classList.add('hidden');
            }
        }
    });
}

// Открытие модального окна
if (elements.createSolutionBtn) {
    elements.createSolutionBtn.addEventListener('click', function () {
        openCreateSolutionModal(elements.createSolutionModal, elements.createSolutionError, elements.solutionNameInput, document);
    })
}

// Закрытие модального окна по клику на "X"
if (elements.closeModalBtn) {
    elements.closeModalBtn.addEventListener('click', function () { closeCreateSolutionModal(elements.createSolutionModal); })
}

// Закрытие модального окна по клику на кнопку "Отмена"
if (elements.cancelCreateBtn) {
    elements.cancelCreateBtn.addEventListener('click', function () { closeCreateSolutionModal(elements.createSolutionModal); })
}

// Закрытие модального окна по клику вне его содержимого
window.addEventListener('click', (event) => {
    if (elements.createSolutionModal && event.target === elements.createSolutionModal) {
        closeCreateSolutionModal(elements.createSolutionModal);
    }
});

// Добавляем обработчик события для формы загрузки файла
const fileUploadForm = document.getElementById('file-upload-form');
//console.log("Форма найдена:", fileUploadForm);
if (fileUploadForm) {
    //console.log("Вешаем обработчик..."); 
    fileUploadForm.addEventListener('submit', handleFileUpload);
}


// Обработка отправки формы создания решения
if (elements.createSolutionForm) {
    elements.createSolutionForm.addEventListener('submit', async (e) => {
        e.preventDefault(); // Предотвращаем стандартную отправку формы

        const solutionName = elements.solutionNameInput.value.trim();
        console.log(solutionName)
        if (!solutionName) {
            showCreateSolutionError('Пожалуйста, введите название решения.', elements.createSolutionError);
            return;
        }

        if (!currentIDToken) {
            showCreateSolutionError('Ошибка аутентификации. Пожалуйста, перезагрузите страницу.',elements.createSolutionError);
            return;
        }

        // Блокируем кнопку отправки и показываем индикатор загрузки
        const submitBtn = elements.createSolutionForm.querySelector('button[type="submit"]');
               
        submitBtn.disabled = true;
        hideCreateSolutionError(); // Скрываем предыдущие ошибки

        try {
            console.log(`[CREATE SOLUTION] Отправка запроса на создание решения: ${solutionName}`);
            const response = await fetch('/api/users/self/solutions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${currentIDToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: solutionName }) // Отправляем JSON с названием
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[CREATE SOLUTION] Ошибка от API:`, response.status, errorText);
                throw new Error(`Ошибка сервера: ${response.status}`);
            }

            const newSolution = await response.json();
            console.log(`[CREATE SOLUTION] Решение создано:`, newSolution);

            // Закрываем модальное окно
            closeCreateSolutionModal(elements.createSolutionModal)

            // Перезагружаем список решений
            await loadAndDisplaySolutions(currentIDToken, elements.solutionsListContainer, elements.solutionsListPlaceholder, elements.solutionDetailsContainer, elements.solutionDetailsPlaceholder);


        } catch (error) {
            console.error(`[CREATE SOLUTION] Ошибка при создании решения:`, error);
            showCreateSolutionError(`Ошибка создания решения: ${error.message}`, elements.createSolutionError);
        } finally {
            // Разблокируем кнопку
            
            submitBtn.disabled = false;
        }
    });
}

if (elements.userAvatarSmall) {
    elements.userAvatarSmall.addEventListener('click', (event) => {
        event.stopPropagation();
        if (elements.profileDropdown) {
            elements.profileDropdown.classList.toggle('show');
        }
    });
}

if (elements.logoutBtn) {
    elements.logoutBtn.addEventListener('click', (event) => {
        event.preventDefault();
        if (auth) {
            auth.signOut()
                .then(() => {
                    window.location.href = '/login.html';
                })
                .catch((error) => {
                    console.error("Ошибка выхода:", error);

                });
        }
    });
}


document.addEventListener('click', (event) => {
    if (elements.profileDropdown && elements.userAvatarSmall &&
        !elements.profileDropdown.contains(event.target) && !elements.userAvatarSmall.contains(event.target)) {
        if (elements.profileDropdown.classList.contains('show')) {
            elements.profileDropdown.classList.remove('show');
        }
    }
});
window.requestDownload = async function(s3Key) {
  console.log(`[DOWNLOAD] Запрос скачивания: ${s3Key}`);
  
  try {
    // 1. Запрашиваем presigned URL у бэкенда
    const res = await fetch(`/api/users/self/downloads/url?key=${encodeURIComponent(s3Key)}`, {
      headers: { 'Authorization': `Bearer ${currentIDToken}` }
    });
    
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Сервер вернул ${res.status}: ${errText}`);
    }
    
    const { download_url } = await res.json();
    console.log(`[DOWNLOAD] Получена ссылка`);
    
    // 2. Скачиваем файл по presigned URL
    const fileRes = await fetch(download_url);
    if (!fileRes.ok) throw new Error('Не удалось скачать файл');
    
    const blob = await fileRes.blob();
    const fileName = s3Key.split('/').pop() || 'downloaded_file';
    
    // 3. Сохраняем на диск (FileSaver.js уже подключён в dashboard.html)
    if (typeof saveAs !== 'undefined') {
      saveAs(blob, fileName);
    } else {
      // Фоллбэк без FileSaver
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    }
    
    console.log(`[DOWNLOAD] Файл ${fileName} сохранён`);
    
  } catch (error) {
    console.error(`[DOWNLOAD] Ошибка:`, error);
    alert(`Не удалось скачать: ${error.message}`);
  }
};

// Initialize Coarse Generator
initCoarseGenerator();