// internal/user/handler.go
package user

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"3dmtzinversionservice/internal/handlers" // Убедитесь, что путь правильный
	"3dmtzinversionservice/pkg/logging"       // Убедитесь, что путь правильный

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/julienschmidt/httprouter"
	amqp "github.com/rabbitmq/amqp091-go"
	///aws
)

// Убедитесь, что handler реализует интерфейс handlers.Handler
var _ handlers.Handler = &handler{}

// Константы для URL
const (
	getOrCreateUserURL = "/api/users/self"
)

// User представляет структуру документа пользователя в Firestore.
type User struct {
	UID         string  `firestore:"uid"`
	Email       *string `firestore:"email,omitempty"`
	DisplayName *string `firestore:"displayName,omitempty"`
	PhotoURL    *string `firestore:"photoURL,omitempty"`
	// Используем json:"-" для полей, которые устанавливаются сервером
	CreatedAt    time.Time `firestore:"createdAt" json:"-"`
	LastLoginAt  time.Time `firestore:"lastLoginAt" json:"-"`
	Subscription struct {
		LastResetDate time.Time `firestore:"lastResetDate"`
	} `firestore:"subscription"`
	// Inversions будет подколлекцией
}

// handler реализует логику обработки запросов для пользователей.
type handler struct {
	logger      *logging.Logger
	firebaseApp *firebase.App // Добавляем зависимость от Firebase App
	authClient  *auth.Client  // Добавляем зависимость от Auth Client
	rabbitCh    *amqp.Channel
	s3Client    *s3.Client
}

// NewHandler создает новый экземпляр handler.
// Мы передаем зависимости через конструктор.
func NewHandler(logger *logging.Logger, firebaseApp *firebase.App, authClient *auth.Client, rabbitCh *amqp.Channel, s3Client *s3.Client) handlers.Handler {
	return &handler{
		logger:      logger,
		firebaseApp: firebaseApp, // Сохраняем зависимости
		authClient:  authClient,  //
		rabbitCh:    rabbitCh,
		s3Client:    s3Client,
	}
}

// func (h *handler) SendToQueue(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
// 	// 1. Получаем ID токена из заголовка Authorization
// 	authHeader := r.Header.Get("Authorization")
// 	if authHeader == "" {
// 		http.Error(w, "Authorization header is required", http.StatusUnauthorized)
// 		return
// 	}

// 	const bearerPrefix = "Bearer "
// 	if !strings.HasPrefix(authHeader, bearerPrefix) {
// 		http.Error(w, "Invalid Authorization header format", http.StatusUnauthorized)
// 		return
// 	}

// 	idTokenStr := authHeader[len(bearerPrefix):]
// 	if idTokenStr == "" {
// 		http.Error(w, "ID Token is required", http.StatusUnauthorized)
// 		return
// 	}

// 	// 2. Проверяем токен с помощью Firebase Admin SDK Auth
// 	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
// 	if err != nil {
// 		h.logger.Errorf("Failed to verify ID token: %v", err)
// 		http.Error(w, "Invalid ID token", http.StatusUnauthorized)
// 		return
// 	}

// 	uid := token.UID
// 	solutionID := ps.ByName("solutionID")
// 	h.logger.Infof("Verified user token for UID (SendToQueue): %s, SolutionID: %s", uid, solutionID)

// 	if solutionID == "" {
// 		http.Error(w, "Solution ID is required", http.StatusBadRequest)
// 		return
// 	}

// 	// 3. (Опционально) Проверяем, существует ли решение у пользователя
// 	// Это зависит от вашей логики. Можно пропустить, если очередь сама проверит.

// 	// 4. Читаем тело запроса (может содержать дополнительные параметры)
// 	var reqBody map[string]interface{}
// 	if r.ContentLength > 0 {
// 		body, err := io.ReadAll(r.Body)
// 		if err != nil {
// 			h.logger.Errorf("Failed to read request body: %v", err)
// 			http.Error(w, "Bad request", http.StatusBadRequest)
// 			return
// 		}
// 		defer r.Body.Close()

// 		if err := json.Unmarshal(body, &reqBody); err != nil {
// 			h.logger.Errorf("Failed to decode request JSON: %v", err)
// 			http.Error(w, "Bad request: invalid JSON", http.StatusBadRequest)
// 			return
// 		}
// 	}

// 	// 5. Подготавливаем сообщение для отправки в RabbitMQ
// 	message := map[string]interface{}{
// 		"user_id":     uid,
// 		"solution_id": solutionID,
// 		"timestamp":   time.Now().Unix(), // Добавляем временную метку
// 		// Можно добавить другие поля из reqBody, если нужно
// 		"parameters": reqBody, // Передаем тело запроса как параметры
// 	}

// 	messageBody, err := json.Marshal(message)
// 	if err != nil {
// 		h.logger.Errorf("Failed to marshal message to JSON: %v", err)
// 		http.Error(w, "Internal server error", http.StatusInternalServerError)
// 		return
// 	}

// 	// 6. Отправляем сообщение в очередь RabbitMQ
// 	if h.rabbitCh == nil {
// 		h.logger.Error("RabbitMQ channel is not initialized")
// 		http.Error(w, "Internal server error: Messaging system unavailable", http.StatusInternalServerError)
// 		return
// 	}

// 	err = h.rabbitCh.PublishWithContext(
// 		r.Context(),
// 		"",                  // exchange (по умолчанию)
// 		"calculation_tasks", // routing key (имя очереди)
// 		false,               // mandatory
// 		false,               // immediate
// 		amqp.Publishing{
// 			ContentType: "application/json",
// 			Body:        messageBody,
// 		})
// 	if err != nil {
// 		h.logger.Errorf("Failed to publish message to RabbitMQ: %v", err)
// 		http.Error(w, "Failed to send task to queue", http.StatusInternalServerError)
// 		return
// 	}

// 	h.logger.Infof("Message sent to queue for user %s, solution %s", uid, solutionID)

// 	// 7. Возвращаем успешный ответ
// 	w.Header().Set("Content-Type", "application/json")
// 	w.WriteHeader(http.StatusOK) // 200 OK
// 	response := map[string]interface{}{
// 		"status":      "success",
// 		"message":     "Task sent to queue",
// 		"user_id":     uid,
// 		"solution_id": solutionID,
// 	}
// 	json.NewEncoder(w).Encode(response)
// }

func (h *handler) UploadSolutionFile1(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {

	// 1. Получаем ID токена из заголовка Authorization
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

	// 2. Проверяем токен с помощью Firebase Admin SDK Auth
	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
	if err != nil {
		h.logger.Errorf("Failed to verify ID token: %v", err)
		http.Error(w, "Invalid ID token", http.StatusUnauthorized)
		return
	}

	uid := token.UID
	solutionID := ps.ByName("solutionID")
	h.logger.Infof("Verified user token for UID (UploadFile): %s, SolutionID: %s", uid, solutionID)

	if solutionID == "" {
		http.Error(w, "Solution ID is required", http.StatusBadRequest)
		return
	}

	// 3. Ограничиваем размер тела запроса (например, 32 МБ)
	const maxUploadSize int64 = 32 << 20 // 32 MB
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		h.logger.Errorf("Failed to parse multipart form (too large?): %v", err)
		http.Error(w, "File too large or invalid form", http.StatusBadRequest)
		return
	}

	// 4. Получаем файл из формы
	file, fileHeader, err := r.FormFile("file") // Ключ "file" из FormData
	if err != nil {
		h.logger.Errorf("Failed to get file from form: %v", err)
		http.Error(w, "Failed to get file from request", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 5. Проверяем имя файла и расширение
	filename := fileHeader.Filename
	if filename == "" {
		http.Error(w, "Filename is missing", http.StatusBadRequest)
		return
	}
	ext := strings.ToLower(filepath.Ext(filename))
	if ext != ".zip" {
		http.Error(w, "Only .zip files are allowed", http.StatusBadRequest)
		return
	}
	filename = uid + solutionID
	h.logger.Infof("File %s uploaded successfully for user %s, solution %s ", filename, uid, solutionID)

	// 10. Возвращаем успешный ответ
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated) // 201 Created
	response := map[string]interface{}{
		"message":  "File uploaded successfully",
		"filename": filename, // Или относительный путь, если нужно
	}
	if err := json.NewEncoder(w).Encode(response); err != nil {
		h.logger.Errorf("Failed to encode response JSON: %v", err)
		// Заголовки уже отправлены, ничего не поделаешь
	}
}
func (h *handler) UploadSolutionFile(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	// 1. Получаем ID токена из заголовка Authorization
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

	// 2. Проверяем токен с помощью Firebase Admin SDK Auth
	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
	if err != nil {
		h.logger.Errorf("Failed to verify ID token: %v", err)
		http.Error(w, "Invalid ID token", http.StatusUnauthorized)
		return
	}

	uid := token.UID
	solutionID := ps.ByName("solutionID")
	h.logger.Infof("Verified user token for UID (UploadFile): %s, SolutionID: %s", uid, solutionID)

	if solutionID == "" {
		http.Error(w, "Solution ID is required", http.StatusBadRequest)
		return
	}

	// 3. Removed concurrent task limit - users can now run multiple tasks simultaneously
	// Note: Previously limited to 1 active task per user
	// h.logger.Infof("User %s can submit new task (concurrent limit removed)", uid)

	// 4. Ограничиваем размер тела запроса (например, 32 МБ)
	const maxUploadSize int64 = 32 << 20 // 32 MB
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		h.logger.Errorf("Failed to parse multipart form (too large?): %v", err)
		http.Error(w, "File too large or invalid form", http.StatusBadRequest)
		return
	}

	// 4. Получаем файл из формы
	file, fileHeader, err := r.FormFile("file") // Ключ "file" из FormData
	if err != nil {
		h.logger.Errorf("Failed to get file from form: %v", err)
		http.Error(w, "Failed to get file from request", http.StatusBadRequest)
		return
	}
	defer file.Close() // ВАЖНО: Закрываем файл после использования

	// 5. Проверяем имя файла и расширение
	filename := fileHeader.Filename
	if filename == "" {
		http.Error(w, "Filename is missing", http.StatusBadRequest)
		return
	}
	ext := strings.ToLower(filepath.Ext(filename))
	if ext != ".zip" {
		http.Error(w, "Only .zip files are allowed", http.StatusBadRequest)
		return
	}
	if h.s3Client == nil {
		h.logger.Error("S3 client is not initialized in UploadSolutionFile")
		http.Error(w, "Internal server error: S3 client not available", http.StatusInternalServerError)
		return
	}

	if h.rabbitCh == nil {
		h.logger.Error("RabbitMQ channel is not initialized in UploadSolutionFile")
		http.Error(w, "Internal server error: RabbitMQ channel not available", http.StatusInternalServerError)
		return
	}

	s3Key := fmt.Sprintf("users/%s/solutions/%s/%s", uid, solutionID, filename)

	// Читаем содержимое файла в память (для PutObject)
	// ВНИМАНИЕ: Для больших файлов лучше использовать UploadManager или stream
	fileBytes, err := io.ReadAll(file) // file уже открыт из FormFile
	if err != nil {
		h.logger.Errorf("Failed to read file contents: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	h.logger.Infof("S3 Bucket: %s", os.Getenv("AWS_S3_BUCKET_NAME"))
	// Подготовим параметры для PutObject
	putObjectInput := &s3.PutObjectInput{
		Bucket: aws.String(os.Getenv("AWS_S3_BUCKET_NAME")), // Используем переменную из .env
		Key:    aws.String(s3Key),
		Body:   bytes.NewReader(fileBytes), // Передаем содержимое файла
		// ACL:  types.ObjectCannedACL("private"), // Установите ACL по необходимости
	}

	// Выполним PutObject
	_, err = h.s3Client.PutObject(r.Context(), putObjectInput)
	if err != nil {
		h.logger.Errorf("Failed to upload file to S3: %v", err)
		http.Error(w, "Failed to upload file to S3", http.StatusInternalServerError)
		return
	}

	h.logger.Infof("File %s uploaded to S3 successfully for user %s, solution %s (key: %s)", filename, uid, solutionID, s3Key)

	// 5. Создаём запись задачи в Firestore ПЕРЕД отправкой в очередь
	timestamp := time.Now().Unix()
	taskID, err := h.CreateTask(r.Context(), uid, solutionID, s3Key, timestamp)
	if err != nil {
		h.logger.Errorf("Failed to create task record for user %s: %v", uid, err)
		http.Error(w, "Internal server error: failed to create task", http.StatusInternalServerError)
		return
	}
	h.logger.Infof("Created task record with ID %s for user %s, solution %s", taskID, uid, solutionID)

	// 6. Отправка ключа в очередь RabbitMQ
	// Подготавливаем сообщение
	message := map[string]interface{}{
		"user_id":     uid,
		"solution_id": solutionID,
		"s3_file_key": s3Key,
		"task_id":     taskID, // Добавляем ID задачи для отслеживания
		"timestamp":   timestamp,
	}

	messageBody, err := json.Marshal(message)
	if err != nil {
		h.logger.Errorf("Failed to marshal message to JSON: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Отправляем сообщение в очередь
	if h.rabbitCh == nil {
		h.logger.Error("RabbitMQ channel is not initialized")
		http.Error(w, "Internal server error: Messaging system unavailable", http.StatusInternalServerError)
		return
	}

	err = h.rabbitCh.PublishWithContext(
		r.Context(),
		"",
		"calculation_tasks", // routing key (имя вашей очереди)
		false,               // mandatory
		false,               // immediate
		amqp.Publishing{
			ContentType: "application/json",
			Body:        messageBody,
		})
	if err != nil {
		h.logger.Errorf("Failed to publish message to RabbitMQ: %v", err)
		http.Error(w, "Failed to send task to queue", http.StatusInternalServerError)
		return
	}

	h.logger.Infof("S3 file key message sent to queue for user %s, solution %s, key: %s, task_id: %s", uid, solutionID, s3Key, taskID)
	// --- КОНЕЦ НОВОГО ---

	// 10. Возвращаем успешный ответ клиенту
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated) // 201 Created
	response := map[string]interface{}{
		"message":  "File uploaded to S3 and task sent to queue successfully", // Изменено сообщение
		"filename": filename,
		"s3_key":   s3Key, // Полезно вернуть ключ, если клиенту он нужен
		// "size":     written, // Убрано, так как файл не сохраняется на диск
		// "path":     fullPath, // Убрано
	}
	if err := json.NewEncoder(w).Encode(response); err != nil {
		h.logger.Errorf("Failed to encode response JSON: %v", err)
		// Заголовки уже отправлены
	}
}

// GetDownloadURL генерирует presigned URL для скачивания файла из S3
func (h *handler) GetDownloadURL(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	// 1. Аутентификация
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, `{"error":"authorization header is required"}`, http.StatusUnauthorized)
		return
	}
	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		http.Error(w, `{"error":"invalid authorization header format"}`, http.StatusUnauthorized)
		return
	}
	idTokenStr := authHeader[len(bearerPrefix):]
	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
	if err != nil {
		http.Error(w, `{"error":"invalid id token"}`, http.StatusUnauthorized)
		return
	}
	uid := token.UID

	// 2. Получаем ключ файла из query-параметра
	s3Key := r.URL.Query().Get("key")
	if s3Key == "" {
		http.Error(w, `{"error":"key parameter is required"}`, http.StatusBadRequest)
		return
	}

	// 3. Проверяем, что файл принадлежит пользователю
	expectedPrefix := fmt.Sprintf("users/%s/", uid)
	if !strings.HasPrefix(s3Key, expectedPrefix) {
		h.logger.Warnf("User %s attempted to access unauthorized key: %s", uid, s3Key)
		http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
		return
	}

	// 4. Генерируем presigned URL (действует 15 минут)
	presignClient := s3.NewPresignClient(h.s3Client)
	presignedReq, err := presignClient.PresignGetObject(r.Context(), &s3.GetObjectInput{
		Bucket: aws.String(os.Getenv("AWS_S3_BUCKET_NAME")),
		Key:    aws.String(s3Key),
	}, func(o *s3.PresignOptions) {
		o.Expires = 15 * time.Minute
	})
	if err != nil {
		h.logger.Errorf("Failed to generate presigned URL for %s: %v", s3Key, err)
		http.Error(w, `{"error":"failed to generate download link"}`, http.StatusInternalServerError)
		return
	}

	// 5. Возвращаем ссылку
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"download_url": presignedReq.URL,
		"expires_in":   "900",
	})
}

func (h *handler) GetSolutionFiles(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	solutionID := ps.ByName("solutionID")
	if solutionID == "" {
		http.Error(w, `{"error":"solution_id is required"}`, http.StatusBadRequest)
		return
	}
	h.logger.Info("1")

	// 🔐 1. ИЗВЛЕЧЕНИЕ ТОКЕНА (этого не хватало!)
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, `{"error":"authorization header is required"}`, http.StatusUnauthorized)
		return
	}

	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		http.Error(w, `{"error":"invalid authorization header format"}`, http.StatusUnauthorized)
		return
	}

	idTokenStr := authHeader[len(bearerPrefix):]
	if idTokenStr == "" {
		http.Error(w, `{"error":"id token is required"}`, http.StatusUnauthorized)
		return
	}
	h.logger.Info("2")
	// 2. Проверка токена
	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
	if err != nil {
		h.logger.Errorf("Failed to verify ID token in GetSolutionFiles: %v", err)
		http.Error(w, `{"error":"invalid id token"}`, http.StatusUnauthorized)
		return
	}
	uid := token.UID
	h.logger.Info("3")
	// 3. Формируем префикс для поиска результатов
	prefix := fmt.Sprintf("users/%s/solutions/%s/results/", uid, solutionID)
	bucketName := os.Getenv("AWS_S3_BUCKET_NAME")

	// 4. Запрашиваем список объектов из S3
	listInput := &s3.ListObjectsV2Input{
		Bucket: aws.String(bucketName),
		Prefix: aws.String(prefix),
	}

	result, err := h.s3Client.ListObjectsV2(r.Context(), listInput)
	if err != nil {
		h.logger.Errorf("Failed to list S3 objects for %s: %v", prefix, err)
		http.Error(w, `{"error":"failed to list files"}`, http.StatusInternalServerError)
		return
	}

	// 5. Преобразуем в удобный JSON
	type FileInfo struct {
		Name         string    `json:"name"`
		Key          string    `json:"key"`
		Size         int64     `json:"size"`
		LastModified time.Time `json:"last_modified"`
	}

	var files []FileInfo
	for _, obj := range result.Contents {
		fileName := filepath.Base(*obj.Key)
		files = append(files, FileInfo{
			Name:         fileName,
			Key:          *obj.Key,
			Size:         *obj.Size,
			LastModified: *obj.LastModified,
		})
	}

	// 6. Отправляем ответ
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"solution_id": solutionID,
		"files":       files,
	})
}

// GetSolutionFile returns a specific file from solution results
func (h *handler) GetSolutionFile(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	solutionID := ps.ByName("solutionID")
	fileKey := ps.ByName("fileKey")

	if solutionID == "" || fileKey == "" {
		http.Error(w, `{"error":"solution_id and file_key are required"}`, http.StatusBadRequest)
		return
	}

	// httprouter возвращает параметр *fileKey с ведущим слэшем — убираем его,
	// иначе проверка принадлежности файла пользователю ниже всегда падает
	fileKey = strings.TrimPrefix(fileKey, "/")

	// Decode URL-encoded fileKey
	decodedKey, err := url.QueryUnescape(fileKey)
	if err != nil {
		h.logger.Errorf("Failed to decode file key: %v", err)
		http.Error(w, `{"error":"invalid file key"}`, http.StatusBadRequest)
		return
	}

	// Extract and verify token
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, `{"error":"authorization header is required"}`, http.StatusUnauthorized)
		return
	}

	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		http.Error(w, `{"error":"invalid authorization header format"}`, http.StatusUnauthorized)
		return
	}

	idTokenStr := authHeader[len(bearerPrefix):]
	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
	if err != nil {
		h.logger.Errorf("Failed to verify ID token: %v", err)
		http.Error(w, `{"error":"invalid id token"}`, http.StatusUnauthorized)
		return
	}
	uid := token.UID

	// Verify that the file belongs to this user and solution
	expectedPrefix := fmt.Sprintf("users/%s/solutions/%s/", uid, solutionID)
	if !strings.HasPrefix(decodedKey, expectedPrefix) {
		h.logger.Warnf("User %s attempted to access unauthorized file: %s", uid, decodedKey)
		http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
		return
	}

	// Get file from S3
	bucketName := os.Getenv("AWS_S3_BUCKET_NAME")
	getInput := &s3.GetObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(decodedKey),
	}

	result, err := h.s3Client.GetObject(r.Context(), getInput)
	if err != nil {
		h.logger.Errorf("Failed to get S3 object %s: %v", decodedKey, err)
		http.Error(w, `{"error":"file not found"}`, http.StatusNotFound)
		return
	}
	defer result.Body.Close()

	// Get file metadata
	fileName := filepath.Base(decodedKey)

	// Set headers
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=\"%s\"", fileName))

	// Try to detect content type
	if result.ContentType != nil {
		w.Header().Set("Content-Type", *result.ContentType)
	} else {
		// Fallback based on extension
		ext := strings.ToLower(filepath.Ext(fileName))
		switch ext {
		case ".txt", ".log", ".dat":
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		case ".json":
			w.Header().Set("Content-Type", "application/json")
		case ".png":
			w.Header().Set("Content-Type", "image/png")
		case ".jpg", ".jpeg":
			w.Header().Set("Content-Type", "image/jpeg")
		case ".pdf":
			w.Header().Set("Content-Type", "application/pdf")
		default:
			w.Header().Set("Content-Type", "application/octet-stream")
		}
	}

	if result.ContentLength != nil {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", *result.ContentLength))
	}

	// Stream file to response
	_, err = io.Copy(w, result.Body)
	if err != nil {
		h.logger.Errorf("Failed to stream file %s: %v", decodedKey, err)
	}
}

func (h *handler) GetPresignedURL(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	// 1. Аутентификация
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, `{"error":"authorization header is required"}`, http.StatusUnauthorized)
		return
	}
	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		http.Error(w, `{"error":"invalid authorization header format"}`, http.StatusUnauthorized)
		return
	}
	idTokenStr := authHeader[len(bearerPrefix):]
	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
	if err != nil {
		http.Error(w, `{"error":"invalid id token"}`, http.StatusUnauthorized)
		return
	}
	uid := token.UID

	// 2. Получаем S3-ключ из query-параметра (не из path!)
	s3Key := r.URL.Query().Get("key")
	if s3Key == "" {
		http.Error(w, `{"error":"key parameter is required"}`, http.StatusBadRequest)
		return
	}

	// 3. Проверяем, что файл принадлежит пользователю
	// Ключ должен начинаться с users/{uid}/
	expectedPrefix := fmt.Sprintf("users/%s/", uid)
	if !strings.HasPrefix(s3Key, expectedPrefix) {
		h.logger.Warnf("User %s attempted to access unauthorized key: %s", uid, s3Key)
		http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
		return
	}

	// 4. Генерируем presigned URL (15 минут)
	presignClient := s3.NewPresignClient(h.s3Client)
	presignedReq, err := presignClient.PresignGetObject(r.Context(), &s3.GetObjectInput{
		Bucket: aws.String(os.Getenv("AWS_S3_BUCKET_NAME")),
		Key:    aws.String(s3Key),
	}, func(o *s3.PresignOptions) {
		o.Expires = 15 * time.Minute
	})
	if err != nil {
		h.logger.Errorf("Failed to generate presigned URL for %s: %v", s3Key, err)
		http.Error(w, `{"error":"failed to generate download link"}`, http.StatusInternalServerError)
		return
	}

	// 5. Возвращаем ссылку
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"download_url": presignedReq.URL,
		"expires_in":   "900",
	})
}

// GetSolutionStatus fetches the status.json file from S3 for a solution
func (h *handler) GetSolutionStatus(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	// 1. Аутентификация
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, `{"error":"authorization header is required"}`, http.StatusUnauthorized)
		return
	}
	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		http.Error(w, `{"error":"invalid authorization header format"}`, http.StatusUnauthorized)
		return
	}
	idTokenStr := authHeader[len(bearerPrefix):]
	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
	if err != nil {
		http.Error(w, `{"error":"invalid id token"}`, http.StatusUnauthorized)
		return
	}
	uid := token.UID

	// 2. Получаем solutionID из параметров URL
	solutionID := ps.ByName("solutionID")
	if solutionID == "" {
		http.Error(w, `{"error":"solution_id is required"}`, http.StatusBadRequest)
		return
	}

	// 3. Формируем S3 ключ для status.json
	s3Key := fmt.Sprintf("users/%s/solutions/%s/status.json", uid, solutionID)
	bucketName := os.Getenv("AWS_S3_BUCKET_NAME")

	// 4. Получаем файл из S3 с таймаутом
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	getInput := &s3.GetObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(s3Key),
	}

	result, err := h.s3Client.GetObject(ctx, getInput)
	if err != nil {
		// Check if it's a "not found" error - AWS SDK v2 uses different error types
		errStr := err.Error()
		h.logger.Infof("S3 GetObject error for %s: %v", s3Key, err)
		if strings.Contains(errStr, "NotFound") ||
			strings.Contains(errStr, "NoSuchKey") ||
			strings.Contains(errStr, "404") ||
			strings.Contains(errStr, "Not Found") ||
			strings.Contains(errStr, "timeout") ||
			strings.Contains(errStr, "context deadline exceeded") {
			// Return a default status if file doesn't exist or timeout
			h.logger.Infof("Status file not found or timeout for %s, returning default", s3Key)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"status":      "unknown",
				"message":     "Status file not found",
				"solution_id": solutionID,
			})
			return
		}
		h.logger.Errorf("Failed to get S3 object %s: %v", s3Key, err)
		http.Error(w, `{"error":"failed to fetch status"}`, http.StatusInternalServerError)
		return
	}
	defer result.Body.Close()

	// 5. Читаем и парсим JSON с таймаутом
	readCtx, readCancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer readCancel()

	body, err := io.ReadAll(io.LimitReader(result.Body, 1024*1024)) // Limit to 1MB
	if err != nil {
		h.logger.Errorf("Failed to read status file %s: %v", s3Key, err)
		http.Error(w, `{"error":"failed to read status"}`, http.StatusInternalServerError)
		return
	}

	// Check if context was cancelled during read
	select {
	case <-readCtx.Done():
		h.logger.Warnf("Read timeout for status file %s", s3Key)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":      "unknown",
			"message":     "Status read timeout",
			"solution_id": solutionID,
		})
		return
	default:
	}

	// 6. Возвращаем статус как есть (предполагаем, что это валидный JSON)
	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// Register регистрирует маршруты для обработчиков.
func (h *handler) Register(router *httprouter.Router) {
	// === МАРШРУТЫ С :solutionID (должны быть вместе) ===
	router.POST("/api/users/self/solutions/:solutionID/upload", h.UploadSolutionFile)
	router.GET("/api/users/self/solutions/:solutionID/files", h.GetSolutionFiles)
	router.GET("/api/users/self/solutions/:solutionID/files/*fileKey", h.GetSolutionFile)
	router.GET("/api/users/self/solutions/:solutionID", h.GetSolutionByID)
	router.GET("/api/users/self/solutions/:solutionID/status", h.GetSolutionStatus)

	// === ОБЩИЕ МАРШРУТЫ ===
	router.GET("/api/users/self/solutions", h.GetSolutions)
	router.POST("/api/users/self/solutions", h.CreateSolution)
	router.POST(getOrCreateUserURL, h.GetOrCreateUser)

	// === НОВЫЙ ПУТЬ ДЛЯ СКАЧИВАНИЯ (вне иерархии /solutions/:id) ===
	// ❗ ВАЖНО: Этот маршрут НЕ должен содержать :solutionID,
	// чтобы не конфликтовать с остальными
	router.GET("/api/users/self/downloads/url", h.GetPresignedURL)
}
