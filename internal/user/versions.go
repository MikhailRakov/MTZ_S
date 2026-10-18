// versions.go — история версий результатов решения и перезапуск расчёта.
//
// Каждый запуск потребителя складывает архив в отдельный каталог
// users/{uid}/solutions/{sid}/results/{version}/all_models.zip, поэтому
// все прошлые решения сохраняются. GetSolutionVersions отдаёт список
// архивов (новые первыми), RerunSolution повторно отправляет исходные
// данные решения в очередь расчёта.
package user

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/julienschmidt/httprouter"
)

// authenticateRequest — общая проверка Firebase-токена: возвращает UID.
func (h *handler) authenticateRequest(r *http.Request) (string, error) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return "", fmt.Errorf("authorization header is required")
	}
	const bearerPrefix = "Bearer "
	if !strings.HasPrefix(authHeader, bearerPrefix) {
		return "", fmt.Errorf("invalid authorization header format")
	}
	idTokenStr := authHeader[len(bearerPrefix):]
	if idTokenStr == "" {
		return "", fmt.Errorf("id token is required")
	}
	token, err := h.authClient.VerifyIDToken(r.Context(), idTokenStr)
	if err != nil {
		return "", fmt.Errorf("invalid id token")
	}
	return token.UID, nil
}

// ResultVersion — архив результатов одного завершённого запуска
type ResultVersion struct {
	Version      string    `json:"version"`
	Name         string    `json:"name"`
	Key          string    `json:"key"`
	Size         int64     `json:"size"`
	LastModified time.Time `json:"last_modified"`
	// Legacy — архив старого формата results/all_models.zip (без каталога версии)
	Legacy bool `json:"legacy"`
}

// GetSolutionVersions возвращает историю результатов решения: все .zip
// архивы внутри results/ (включая старый формат), новые первыми.
// GET /api/users/self/solutions/:solutionID/versions
func (h *handler) GetSolutionVersions(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	uid, err := h.authenticateRequest(r)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusUnauthorized)
		return
	}
	solutionID := ps.ByName("solutionID")
	if solutionID == "" {
		http.Error(w, `{"error":"solution_id is required"}`, http.StatusBadRequest)
		return
	}

	bucketName := os.Getenv("AWS_S3_BUCKET_NAME")
	prefix := fmt.Sprintf("users/%s/solutions/%s/results/", uid, solutionID)

	var versions []ResultVersion
	var contToken *string
	// Защита от бесконечного цикла при очень большом числе объектов
	for page := 0; page < 20; page++ {
		out, err := h.s3Client.ListObjectsV2(r.Context(), &s3.ListObjectsV2Input{
			Bucket:            aws.String(bucketName),
			Prefix:            aws.String(prefix),
			ContinuationToken: contToken,
		})
		if err != nil {
			h.logger.Errorf("Failed to list result versions for %s: %v", prefix, err)
			http.Error(w, `{"error":"failed to list versions"}`, http.StatusInternalServerError)
			return
		}
		for _, obj := range out.Contents {
			if obj.Key == nil {
				continue
			}
			key := *obj.Key
			rel := strings.TrimPrefix(key, prefix)
			if !strings.HasSuffix(strings.ToLower(rel), ".zip") {
				continue
			}
			// results/<version>/all_models.zip → version;
			// results/all_models.zip → старый формат без версионирования
			version := "legacy"
			legacy := true
			if idx := strings.Index(rel, "/"); idx > 0 {
				version = rel[:idx]
				legacy = false
			}
			var size int64
			if obj.Size != nil {
				size = *obj.Size
			}
			var modified time.Time
			if obj.LastModified != nil {
				modified = *obj.LastModified
			}
			versions = append(versions, ResultVersion{
				Version:      version,
				Name:         filepath.Base(key),
				Key:          key,
				Size:         size,
				LastModified: modified,
				Legacy:       legacy,
			})
		}
		if out.IsTruncated != nil && *out.IsTruncated && out.NextContinuationToken != nil {
			contToken = out.NextContinuationToken
			continue
		}
		break
	}

	// Новые версии первыми
	sort.Slice(versions, func(i, j int) bool {
		return versions[i].LastModified.After(versions[j].LastModified)
	})
	if versions == nil {
		versions = []ResultVersion{}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"solution_id": solutionID,
		"versions":    versions,
		"count":       len(versions),
	}); err != nil {
		h.logger.Errorf("Failed to encode versions response: %v", err)
	}
}

// RerunSolution повторно отправляет исходные данные решения на расчёт:
// берёт оригинальный входной .zip, создаёт новую задачу и публикует её
// в очередь. Прежние версии результатов остаются в истории.
// POST /api/users/self/solutions/:solutionID/rerun
func (h *handler) RerunSolution(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	uid, err := h.authenticateRequest(r)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusUnauthorized)
		return
	}
	solutionID := ps.ByName("solutionID")
	if solutionID == "" {
		http.Error(w, `{"error":"solution_id is required"}`, http.StatusBadRequest)
		return
	}

	inputKey, inputName, err := h.findSolutionInput(r.Context(), uid, solutionID)
	if err != nil {
		h.logger.Errorf("Rerun: input archive not found for solution %s: %v", solutionID, err)
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	timestamp := time.Now().Unix()
	taskID, err := h.CreateTask(r.Context(), uid, solutionID, inputKey, timestamp)
	if err != nil {
		h.logger.Errorf("Rerun: failed to create task for solution %s: %v", solutionID, err)
		http.Error(w, "Internal server error: failed to create task", http.StatusInternalServerError)
		return
	}

	// Статус «в очереди» записываем ДО публикации: интерфейс сразу показывает
	// актуальное состояние вместо старого completed. Потребитель перезапишет
	// status.json, когда подберёт задачу.
	if serr := h.writeQueuedStatus(r.Context(), uid, solutionID, taskID); serr != nil {
		h.logger.Errorf("Rerun: failed to write queued status for %s: %v", solutionID, serr)
		// Не фатально: потребитель опубликует свой статус сам
	}

	message := map[string]interface{}{
		"user_id":           uid,
		"solution_id":       solutionID,
		"s3_file_key":       inputKey,
		"original_filename": inputName,
		"task_id":           taskID,
		"timestamp":         timestamp,
	}
	body, err := json.Marshal(message)
	if err != nil {
		h.logger.Errorf("Rerun: failed to marshal queue message: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	if err := h.publishTask(r.Context(), body); err != nil {
		h.logger.Errorf("Rerun: failed to publish task for solution %s: %v", solutionID, err)
		// Отмечаем статус упавшим, чтобы интерфейс не завис на «в очереди»
		if werr := h.writeFailedStatus(r.Context(), uid, solutionID, taskID, err.Error()); werr != nil {
			h.logger.Errorf("Rerun: failed to write failed status: %v", werr)
		}
		http.Error(w, "Failed to send task to queue", http.StatusInternalServerError)
		return
	}

	h.logger.Infof("Solution %s re-queued for user %s (task %s, input %s)", solutionID, uid, taskID, inputKey)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":        true,
		"task_id":   taskID,
		"status":    "queued",
		"timestamp": timestamp,
	})
}

// findSolutionInput ищет входной .zip решения: сначала в последней задаче
// Firestore (там записан s3_file_key), при неудаче — самый свежий .zip
// в корневом каталоге решения в S3 (файлы вне results/).
func (h *handler) findSolutionInput(ctx context.Context, uid, solutionID string) (key, name string, err error) {
	if task, terr := h.GetLatestTask(ctx, uid, solutionID); terr == nil && task.S3FileKey != "" {
		if h.objectExists(ctx, task.S3FileKey) {
			return task.S3FileKey, filepath.Base(task.S3FileKey), nil
		}
		h.logger.Warnf("Rerun: task input %s missing in S3, falling back to listing", task.S3FileKey)
	}

	bucketName := os.Getenv("AWS_S3_BUCKET_NAME")
	prefix := fmt.Sprintf("users/%s/solutions/%s/", uid, solutionID)
	out, lerr := h.s3Client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String(bucketName),
		Prefix: aws.String(prefix),
	})
	if lerr != nil {
		return "", "", fmt.Errorf("failed to list solution files: %w", lerr)
	}

	var bestKey string
	var bestTime time.Time
	for _, obj := range out.Contents {
		if obj.Key == nil {
			continue
		}
		k := *obj.Key
		rel := strings.TrimPrefix(k, prefix)
		// Входные файлы лежат прямо в каталоге решения; всё, что в подкаталогах
		// (results/...), — результаты, их перезапускать нельзя
		if strings.Contains(rel, "/") {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(k), ".zip") {
			continue
		}
		if obj.LastModified != nil && obj.LastModified.After(bestTime) {
			bestTime = *obj.LastModified
			bestKey = k
		}
	}
	if bestKey == "" {
		return "", "", fmt.Errorf("input archive for solution not found")
	}
	return bestKey, filepath.Base(bestKey), nil
}

// objectExists проверяет наличие объекта в бакете решения
func (h *handler) objectExists(ctx context.Context, key string) bool {
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	_, err := h.s3Client.HeadObject(c, &s3.HeadObjectInput{
		Bucket: aws.String(os.Getenv("AWS_S3_BUCKET_NAME")),
		Key:    aws.String(key),
	})
	return err == nil
}

// writeQueuedStatus записывает status.json со статусом «в очереди» перед
// отправкой задачи. Набор полей совпадает со statusPayload потребителя,
// поэтому интерфейс разбирает оба формата одинаково.
func (h *handler) writeQueuedStatus(ctx context.Context, uid, solutionID, taskID string) error {
	return h.putStatusJSON(ctx, uid, solutionID, map[string]interface{}{
		"user_id":     uid,
		"solution_id": solutionID,
		"task_id":     taskID,
		"stage":       "queued",
		"stage_index": 0,
		"stage_total": 5,
		"status":      "queued",
		"message":     "Задача отправлена на расчёт",
		"will_retry":  false,
	})
}

// writeFailedStatus записывает status.json со статусом «ошибка»
// (используется, когда публикация в очередь не удалась)
func (h *handler) writeFailedStatus(ctx context.Context, uid, solutionID, taskID, errMsg string) error {
	return h.putStatusJSON(ctx, uid, solutionID, map[string]interface{}{
		"user_id":     uid,
		"solution_id": solutionID,
		"task_id":     taskID,
		"stage":       "queued",
		"stage_index": 0,
		"stage_total": 5,
		"status":      "failed",
		"message":     "Не удалось отправить задачу в очередь",
		"error":       errMsg,
		"will_retry":  false,
	})
}

// putStatusJSON добавляет временные метки и публикует status.json решения
func (h *handler) putStatusJSON(ctx context.Context, uid, solutionID string, payload map[string]interface{}) error {
	now := time.Now().UTC().Format(time.RFC3339)
	payload["updated_at"] = now
	if _, ok := payload["started_at"]; !ok {
		payload["started_at"] = now
	}

	body, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}

	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	_, err = h.s3Client.PutObject(c, &s3.PutObjectInput{
		Bucket:       aws.String(os.Getenv("AWS_S3_BUCKET_NAME")),
		Key:          aws.String(fmt.Sprintf("users/%s/solutions/%s/status.json", uid, solutionID)),
		Body:         bytes.NewReader(body),
		ContentType:  aws.String("application/json"),
		CacheControl: aws.String("no-cache"),
	})
	return err
}
