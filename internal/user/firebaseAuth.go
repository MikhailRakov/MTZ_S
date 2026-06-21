package user

import (
	"encoding/json"
	"net/http"
	"time"

	"cloud.google.com/go/firestore"
	"github.com/julienschmidt/httprouter"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (h *handler) GetOrCreateUser(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	// 1. Получаем ID токен из тела запроса
	var req struct {
		IDToken string `json:"idToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.logger.Errorf("Failed to decode request body: %v", err)
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	if req.IDToken == "" {
		http.Error(w, "ID Token is required", http.StatusBadRequest)
		return
	}

	// 2. Проверяем токен с помощью Firebase Admin SDK Auth
	token, err := h.authClient.VerifyIDToken(r.Context(), req.IDToken)
	if err != nil {
		h.logger.Errorf("Failed to verify ID token: %v", err)
		http.Error(w, "Invalid ID token", http.StatusUnauthorized)
		return
	}
	uid := token.UID

	// Безопасно извлекаем Claims
	var email, displayName, photoURL string
	if e, ok := token.Claims["email"].(string); ok {
		email = e
	}
	if dn, ok := token.Claims["name"].(string); ok {
		displayName = dn
	}
	if pu, ok := token.Claims["picture"].(string); ok {
		photoURL = pu
	}

	h.logger.Infof("Verified user token for UID: %s", uid)

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

	// 4. Ссылка на документ пользователя
	userDoc := client.Collection("users").Doc(uid)

	// 5. Попытка получить документ
	doc, err := userDoc.Get(r.Context())
	if err != nil && status.Code(err) != codes.NotFound {
		// Произошла ошибка, отличная от "не найдено"
		h.logger.Errorf("Failed to get user doc from Firestore: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	var userData User

	if doc != nil && doc.Exists() {
		// Документ существует
		h.logger.Infof("User %s found in Firestore", uid)

		// Обновляем lastLoginAt и потенциально другие поля из Auth
		updates := []firestore.Update{
			{Path: "lastLoginAt", Value: firestore.ServerTimestamp},
		}
		// Обновляем только если значения изменились/присутствуют
		if displayName != "" {
			updates = append(updates, firestore.Update{Path: "displayName", Value: displayName})
		}
		if photoURL != "" {
			updates = append(updates, firestore.Update{Path: "photoURL", Value: photoURL})
		}

		_, err = userDoc.Update(r.Context(), updates)
		if err != nil {
			h.logger.Errorf("Failed to update user doc in Firestore: %v", err)
			// Не прерываем выполнение, просто логируем
		}

		// Получаем обновленные данные для возврата
		updatedDoc, getErr := userDoc.Get(r.Context())
		if getErr != nil {
			h.logger.Errorf("Failed to get updated user doc: %v", getErr)
			// Используем старые данные из doc, если не удалось получить новые
			doc.DataTo(&userData)
		} else {
			updatedDoc.DataTo(&userData)
		}

	} else {
		// Документ не существует, создаем его
		h.logger.Infof("User %s not found in Firestore, creating...", uid)

		// Вычисляем вчерашнюю дату
		yesterday := time.Now().AddDate(0, 0, -1)

		// Используем Batch Write для атомарного создания пользователя и стандартного решения
		batch := client.Batch()

		// 1. Создаем документ пользователя
		userDocRef := client.Collection("users").Doc(uid)
		userDataToSave := map[string]interface{}{
			"uid":         uid,
			"email":       email,
			"displayName": displayName,
			"photoURL":    photoURL,
			"createdAt":   firestore.ServerTimestamp,
			"lastLoginAt": firestore.ServerTimestamp,
			"subscription": map[string]interface{}{
				"lastResetDate": yesterday,
			},
		}
		batch.Set(userDocRef, userDataToSave)

		// 2. Создаем стандартный документ в подколлекции 'solutions'
		solutionDocRef := userDocRef.Collection("solutions").Doc("new_solution_default")
		newSolutionData := map[string]interface{}{
			"name":        "Новое решение", // Используем кириллицу, как в запросе
			"create_date": firestore.ServerTimestamp,
			// Добавьте другие поля по умолчанию, если нужно
		}
		batch.Set(solutionDocRef, newSolutionData)

		// Выполняем batch операцию
		_, err = batch.Commit(r.Context())
		if err != nil {
			h.logger.Errorf("Failed to create user doc and default solution in Firestore: %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		// Заполняем локальную структуру для возврата (данные пользователя)
		userData.UID = uid
		userData.Email = &email
		userData.DisplayName = &displayName
		userData.PhotoURL = &photoURL
		// Для ServerTimestamp используем текущее время как приближение
		userData.CreatedAt = time.Now()
		userData.LastLoginAt = time.Now()
		userData.Subscription.LastResetDate = yesterday

		h.logger.Infof("User %s and default solution created in Firestore", uid)
	}

	// 6. Возвращаем данные пользователя в формате JSON
	w.Header().Set("Content-Type", "application/json")
	// Устанавливаем статус 200 OK (по умолчанию для http.ResponseWriter)
	// или можно явно: w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(userData); err != nil {
		h.logger.Errorf("Failed to encode user data to JSON: %v", err)
		// Тело ответа уже могло быть частично отправлено,
		// но можно попробовать отправить ошибку
		// http.Error(w, "Internal server error", http.StatusInternalServerError)
		// Однако это может не сработать, если заголовки уже отправлены
	}
}
