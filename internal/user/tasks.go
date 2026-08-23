package user

import (
	"context"
	"fmt"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
)

// TaskStatus представляет статус задачи
type TaskStatus string

const (
	TaskStatusPending    TaskStatus = "pending"
	TaskStatusProcessing TaskStatus = "processing"
	TaskStatusCompleted  TaskStatus = "completed"
	TaskStatusFailed     TaskStatus = "failed"
)

// Task представляет задачу в Firestore
type Task struct {
	UserID     string     `firestore:"user_id"`
	SolutionID string     `firestore:"solution_id"`
	S3FileKey  string     `firestore:"s3_file_key"`
	Status     TaskStatus `firestore:"status"`
	CreatedAt  int64      `firestore:"created_at"`
	UpdatedAt  int64      `firestore:"updated_at"`
}

// GetActiveTasksCount возвращает количество активных задач пользователя
func (h *handler) GetActiveTasksCount(ctx context.Context, userID string) (int, error) {
	client, err := h.firebaseApp.Firestore(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to get Firestore client: %w", err)
	}
	defer client.Close()

	// Считаем задачи со статусом pending или processing
	query := client.Collection("tasks").
		Where("user_id", "==", userID).
		Where("status", "in", []TaskStatus{TaskStatusPending, TaskStatusProcessing})

	iter := query.Documents(ctx)
	defer iter.Stop()

	count := 0
	for {
		_, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return 0, fmt.Errorf("failed to iterate tasks: %w", err)
		}
		count++
	}

	return count, nil
}

// CreateTask создает новую задачу в Firestore
func (h *handler) CreateTask(ctx context.Context, userID, solutionID, s3FileKey string, timestamp int64) (string, error) {
	client, err := h.firebaseApp.Firestore(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get Firestore client: %w", err)
	}
	defer client.Close()

	tasksCollection := client.Collection("tasks")
	newTaskRef := tasksCollection.NewDoc()

	taskData := map[string]interface{}{
		"user_id":     userID,
		"solution_id": solutionID,
		"s3_file_key": s3FileKey,
		"status":      TaskStatusPending,
		"created_at":  timestamp,
		"updated_at":  timestamp,
	}

	_, err = newTaskRef.Set(ctx, taskData)
	if err != nil {
		return "", fmt.Errorf("failed to create task: %w", err)
	}

	return newTaskRef.ID, nil
}

// UpdateTaskStatus обновляет статус задачи
func (h *handler) UpdateTaskStatus(ctx context.Context, taskID string, status TaskStatus) error {
	client, err := h.firebaseApp.Firestore(ctx)
	if err != nil {
		return fmt.Errorf("failed to get Firestore client: %w", err)
	}
	defer client.Close()

	taskRef := client.Collection("tasks").Doc(taskID)
	_, err = taskRef.Update(ctx, []firestore.Update{
		{Path: "status", Value: status},
		{Path: "updated_at", Value: firestore.ServerTimestamp},
	})

	if err != nil {
		return fmt.Errorf("failed to update task status: %w", err)
	}

	return nil
}
