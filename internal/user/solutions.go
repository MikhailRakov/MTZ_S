package user

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"cloud.google.com/go/firestore"
	"github.com/julienschmidt/httprouter"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (h *handler) GetSolutions(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	// 1. Получаем ID токен из заголовка Authorization или из тела запроса
	// Проще и стандартнее использовать заголовок Authorization: Bearer <token>
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, "Authorization header is required", http.StatusUnauthorized)
		return
	}

	// Ожидаем формат "Bearer <token>"
	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		http.Error(w, "Invalid Authorization header format", http.StatusUnauthorized)
		return
	}

	idToken := authHeader[len(bearerPrefix):]
	if idToken == "" {
		http.Error(w, "ID Token is required", http.StatusUnauthorized)
		return
	}

	// 2. Проверяем токен с помощью Firebase Admin SDK Auth
	token, err := h.authClient.VerifyIDToken(r.Context(), idToken)
	if err != nil {
		h.logger.Errorf("Failed to verify ID token: %v", err)
		http.Error(w, "Invalid ID token", http.StatusUnauthorized)
		return
	}

	uid := token.UID
	h.logger.Infof("Verified user token for UID (GetSolutions): %s", uid)

	// 3. Получаем клиента Firestore
	client, err := h.firebaseApp.Firestore(r.Context())
	if err != nil {
		h.logger.Errorf("Failed to get Firestore client: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	defer func() {
		if cerr := client.Close(); cerr != nil {
			h.logger.Errorf("Error closing Firestore client: %v", cerr)
		}
	}()

	// 4. Получаем ссылку на подколлекцию 'solutions'
	solutionsCollection := client.Collection("users").Doc(uid).Collection("solutions").
		OrderBy("create_date", firestore.Desc)

	// 5. Получаем все документы из подколлекции
	iter := solutionsCollection.Documents(r.Context())
	defer iter.Stop()

	var solutions []map[string]interface{}

	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			h.logger.Errorf("Failed to iterate solutions for user %s: %v", uid, err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		// Добавляем данные документа в слайс
		// Добавим ID документа в данные для удобства на фронтенде
		docData := doc.Data()
		docData["id"] = doc.Ref.ID // Добавляем ID документа
		solutions = append(solutions, docData)
	}

	h.logger.Infof("Retrieved %d solutions for user %s", len(solutions), uid)

	// 6. Возвращаем список решений в формате JSON
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(solutions); err != nil {
		h.logger.Errorf("Failed to encode solutions to JSON: %v", err)
		// Заголовки уже отправлены, ничего не поделаешь
	}
}

func (h *handler) GetSolutionByID(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	// 1. Получаем ID токен из заголовка Authorization
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, "Authorization header is required", http.StatusUnauthorized)
		return
	}

	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		http.Error(w, "Invalid Authorization header format", http.StatusUnauthorized)
		return
	}

	idToken := authHeader[len(bearerPrefix):]
	if idToken == "" {
		http.Error(w, "ID Token is required", http.StatusUnauthorized)
		return
	}

	// 2. Проверяем токен с помощью Firebase Admin SDK Auth
	token, err := h.authClient.VerifyIDToken(r.Context(), idToken)
	if err != nil {
		h.logger.Errorf("Failed to verify ID token: %v", err)
		http.Error(w, "Invalid ID token", http.StatusUnauthorized)
		return
	}

	uid := token.UID
	h.logger.Infof("Verified user token for UID (GetSolutionByID): %s", uid)

	// 3. Получаем ID решения из параметров URL
	solutionID := ps.ByName("solutionID")
	if solutionID == "" {
		http.Error(w, "Solution ID is required", http.StatusBadRequest)
		return
	}

	// 4. Получаем клиента Firestore
	client, err := h.firebaseApp.Firestore(r.Context())
	if err != nil {
		h.logger.Errorf("Failed to get Firestore client: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	defer func() {
		if cerr := client.Close(); cerr != nil {
			h.logger.Errorf("Error closing Firestore client: %v", cerr)
		}
	}()

	// 5. Получаем ссылку на конкретный документ решения
	solutionDocRef := client.Collection("users").Doc(uid).Collection("solutions").Doc(solutionID)

	// 6. Получаем документ
	doc, err := solutionDocRef.Get(r.Context())
	if err != nil {
		if status.Code(err) == codes.NotFound {
			http.Error(w, "Solution not found", http.StatusNotFound)
			return
		}
		h.logger.Errorf("Failed to get solution doc %s for user %s: %v", solutionID, uid, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// 7. Подготавливаем данные для возврата, включая ID
	docData := doc.Data()
	docData["id"] = doc.Ref.ID

	h.logger.Infof("Retrieved solution %s for user %s", solutionID, uid)

	// 8. Возвращаем данные решения в формате JSON
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(docData); err != nil {
		h.logger.Errorf("Failed to encode solution data to JSON: %v", err)

	}
}
func (h *handler) CreateSolution(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	// --- 1. Аутентификация и авторизация ---
	// Получаем ID токен из заголовка Authorization
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, "Authorization header is required", http.StatusUnauthorized)
		return
	}

	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		http.Error(w, "Invalid Authorization header format", http.StatusUnauthorized)
		return
	}

	idTokenStr := authHeader[len(bearerPrefix):]
	if idTokenStr == "" {
		http.Error(w, "ID Token is required", http.StatusUnauthorized)
		return
	}

	// Проверяем токен с помощью Firebase Admin SDK Auth
	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
	if err != nil {
		h.logger.Errorf("Failed to verify ID token: %v", err)
		http.Error(w, "Invalid ID token", http.StatusUnauthorized)
		return
	}

	uid := token.UID
	h.logger.Infof("Verified user token for UID (CreateSolution): %s", uid)

	// --- 2. Чтение и парсинг тела запроса ---
	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.logger.Errorf("Failed to read request body: %v", err)
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var req struct {
		Name string `json:"name"` // Ожидаем поле "name" в JSON
	}
	if err := json.Unmarshal(body, &req); err != nil {
		h.logger.Errorf("Failed to decode request JSON: %v", err)
		http.Error(w, "Bad request: invalid JSON", http.StatusBadRequest)
		return
	}

	if req.Name == "" {
		http.Error(w, "Solution name is required", http.StatusBadRequest)
		return
	}

	// --- 3. Взаимодействие с Firestore ---
	// Получаем клиента Firestore
	client, err := h.firebaseApp.Firestore(r.Context())
	if err != nil {
		h.logger.Errorf("Failed to get Firestore client: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	defer func() {
		if cerr := client.Close(); cerr != nil {
			h.logger.Errorf("Error closing Firestore client: %v", cerr)
		}
	}()

	// Ссылка на подколлекцию 'solutions' текущего пользователя
	solutionsCollection := client.Collection("users").Doc(uid).Collection("solutions")

	// Создаем ссылку на новый документ с автоматически сгенерированным ID
	newSolutionDocRef := solutionsCollection.NewDoc()

	// Подготавливаем данные для нового документа
	newSolutionData := map[string]interface{}{
		"name":        req.Name, // Используем кириллицу, как в запросе
		"create_date": firestore.ServerTimestamp,
		// Добавьте другие поля по умолчанию, если нужно
		// "статус": "черновик",
	}

	// Записываем данные в Firestore
	_, err = newSolutionDocRef.Set(r.Context(), newSolutionData)
	if err != nil {
		h.logger.Errorf("Failed to create solution doc for user %s: %v", uid, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// --- 4. Подготовка и отправка ответа ---
	// Формируем ответ с данными созданного документа
	response := map[string]interface{}{
		"id":   newSolutionDocRef.ID, // Возвращаем ID созданного документа
		"name": req.Name,
		// Можно добавить и другие поля из newSolutionData, если нужно
	}

	h.logger.Infof("Created new solution '%s' with ID '%s' for user %s", req.Name, newSolutionDocRef.ID, uid)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated) // 201 Created - стандартный код для создания ресурса
	if err := json.NewEncoder(w).Encode(response); err != nil {
		h.logger.Errorf("Failed to encode solution data to JSON: %v", err)
		// Заголовки и статус уже отправлены, ничего не поделаешь
	}
}
