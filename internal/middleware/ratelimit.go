package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/julienschmidt/httprouter"
)

// RateLimiter хранит информацию о запросах пользователя
type RateLimiter struct {
	mu       sync.RWMutex
	requests map[string]*userLimit

	// Настройки лимитов
	maxRequests int           // Максимальное количество запросов
	window      time.Duration // Временное окно

	// Cleanup
	cleanupInterval time.Duration
	stopCleanup     chan struct{}
}

// userLimit хранит информацию о запросах конкретного пользователя
type userLimit struct {
	tokens    int       // Оставшиеся токены
	lastReset time.Time // Время последнего сброса
}

// NewRateLimiter создает новый rate limiter
// maxRequests - максимальное количество запросов в окне
// window - временное окно (например, 1 минута)
func NewRateLimiter(maxRequests int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		requests:        make(map[string]*userLimit),
		maxRequests:     maxRequests,
		window:          window,
		cleanupInterval: window * 2, // Очистка старых записей каждые 2 окна
		stopCleanup:     make(chan struct{}),
	}

	// Запускаем фоновую очистку
	go rl.cleanup()

	return rl
}

// Allow проверяет, разрешен ли запрос для данного пользователя
func (rl *RateLimiter) Allow(userID string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()

	// Получаем или создаем запись для пользователя
	limit, exists := rl.requests[userID]
	if !exists {
		rl.requests[userID] = &userLimit{
			tokens:    rl.maxRequests - 1,
			lastReset: now,
		}
		return true
	}

	// Проверяем, нужно ли сбросить счетчик
	if now.Sub(limit.lastReset) > rl.window {
		limit.tokens = rl.maxRequests - 1
		limit.lastReset = now
		return true
	}

	// Проверяем, есть ли доступные токены
	if limit.tokens > 0 {
		limit.tokens--
		return true
	}

	return false
}

// GetRemaining возвращает количество оставшихся запросов для пользователя
func (rl *RateLimiter) GetRemaining(userID string) int {
	rl.mu.RLock()
	defer rl.mu.RUnlock()

	limit, exists := rl.requests[userID]
	if !exists {
		return rl.maxRequests
	}

	// Если окно прошло, возвращаем полный лимит
	if time.Since(limit.lastReset) > rl.window {
		return rl.maxRequests
	}

	return limit.tokens
}

// cleanup периодически удаляет устаревшие записи
func (rl *RateLimiter) cleanup() {
	ticker := time.NewTicker(rl.cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.mu.Lock()
			now := time.Now()
			for userID, limit := range rl.requests {
				// Удаляем записи старше двух окон
				if now.Sub(limit.lastReset) > rl.window*2 {
					delete(rl.requests, userID)
				}
			}
			rl.mu.Unlock()
		case <-rl.stopCleanup:
			return
		}
	}
}

// Stop останавливает фоновую очистку
func (rl *RateLimiter) Stop() {
	close(rl.stopCleanup)
}

// Middleware для интеграции с httprouter
// Требует, чтобы userID был доступен через контекст или как параметр
func (rl *RateLimiter) Middleware(getUserID func(r *http.Request) string) func(httprouter.Handle) httprouter.Handle {
	return func(next httprouter.Handle) httprouter.Handle {
		return func(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
			userID := getUserID(r)

			if userID == "" {
				// Если userID не определен, пропускаем проверку
				// (аутентификация должна быть проверена раньше)
				next(w, r, ps)
				return
			}

			if !rl.Allow(userID) {
				remaining := rl.GetRemaining(userID)
				w.Header().Set("X-RateLimit-Limit", string(rune(rl.maxRequests)))
				w.Header().Set("X-RateLimit-Remaining", string(rune(remaining)))
				w.Header().Set("Retry-After", string(rune(int(rl.window.Seconds()))))
				http.Error(w, `{"error":"rate limit exceeded","message":"too many requests, please try again later"}`, http.StatusTooManyRequests)
				return
			}

			// Добавляем заголовки с информацией о лимитах
			remaining := rl.GetRemaining(userID)
			w.Header().Set("X-RateLimit-Limit", string(rune(rl.maxRequests)))
			w.Header().Set("X-RateLimit-Remaining", string(rune(remaining)))

			next(w, r, ps)
		}
	}
}
