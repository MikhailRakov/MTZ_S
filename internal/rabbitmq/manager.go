// Package rabbitmq поддерживает соединение с брокером и автоматически
// переподключается после обрыва.
//
// Прежняя схема (amqp.Dial один раз при старте) приводила к тому, что после
// сетевого сбоя или перезапуска брокера основной сервер навсегда оставался
// с мёртвым каналом: /api/system/stats падал в 500 (виджет очереди на дашборде
// показывал прочерк), а публикация новых задач — в 500, и помогал только
// перезапуск процесса. Manager переподключается лениво (при первом обращении
// к мёртвому каналу), поэтому сервер переживает любой простой брокера.
package rabbitmq

import (
	"fmt"
	"sync"
	"time"

	"3dmtzinversionservice/pkg/logging"

	amqp "github.com/rabbitmq/amqp091-go"
)

// reconnectPauses — ограниченный набор попыток переподключения внутри одного
// вызова Channel(): HTTP-обработчики не должны висеть долго. Полноценный
// повтор происходит при следующем обращении.
var reconnectPauses = []time.Duration{0, time.Second, 2 * time.Second}

// Manager — потокобезопасный провайдер соединения с RabbitMQ.
// Channel() всегда возвращает живой канал: если прежнее соединение закрыто,
// оно пересоздаётся (вместе с декларированием очереди).
type Manager struct {
	url       string
	queueName string
	logger    *logging.Logger

	mu   sync.Mutex
	conn *amqp.Connection
	ch   *amqp.Channel
}

// NewManager создаёт менеджер. Соединение устанавливается лениво —
// при первом вызове Channel(), поэтому старт сервера не зависит от брокера.
func NewManager(url, queueName string, logger *logging.Logger) *Manager {
	return &Manager{url: url, queueName: queueName, logger: logger}
}

// Channel возвращает живой канал RabbitMQ, переподключаясь при необходимости.
// Возвращённый канал может умереть в любой момент — вызывающий код должен
// повторить операцию один раз при ошибке (тогда Channel() переподключится).
func (m *Manager) Channel() (*amqp.Channel, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.ch != nil && !m.ch.IsClosed() && m.conn != nil && !m.conn.IsClosed() {
		return m.ch, nil
	}
	return m.reconnectLocked()
}

// reconnectLocked рвёт старое соединение и устанавливает новое (под mu).
func (m *Manager) reconnectLocked() (*amqp.Channel, error) {
	m.teardownLocked()

	if m.url == "" {
		return nil, fmt.Errorf("rabbitmq: RABBITMQ_URL is empty")
	}

	var lastErr error
	for i, pause := range reconnectPauses {
		if pause > 0 {
			time.Sleep(pause)
		}
		conn, err := amqp.Dial(m.url)
		if err != nil {
			lastErr = err
			m.logger.Errorf("[RABBIT] Dial attempt %d/%d failed: %v", i+1, len(reconnectPauses), err)
			continue
		}
		ch, err := conn.Channel()
		if err != nil {
			_ = conn.Close()
			lastErr = err
			continue
		}
		// Очередь декларируется идемпотентно: это переживает и перезапуск
		// брокера (durable), и смену соединения
		if _, err := ch.QueueDeclare(m.queueName, true, false, false, false, nil); err != nil {
			_ = ch.Close()
			_ = conn.Close()
			lastErr = err
			continue
		}
		m.conn, m.ch = conn, ch
		m.logger.Infof("[RABBIT] Connected (attempt %d/%d), queue %q declared", i+1, len(reconnectPauses), m.queueName)
		go m.watchClose(conn)
		return ch, nil
	}
	return nil, fmt.Errorf("rabbitmq: reconnect failed after %d attempts: %w", len(reconnectPauses), lastErr)
}

// teardownLocked закрывает текущие канал и соединение (под mu).
func (m *Manager) teardownLocked() {
	if m.ch != nil {
		_ = m.ch.Close()
		m.ch = nil
	}
	if m.conn != nil {
		_ = m.conn.Close()
		m.conn = nil
	}
}

// watchClose дожидается закрытия соединения: инвалидирует кэш, чтобы
// следующий вызов Channel() переподключился, и логирует внезапные обрывы.
func (m *Manager) watchClose(conn *amqp.Connection) {
	notify := conn.NotifyClose(make(chan *amqp.Error, 1))
	amqpErr, ok := <-notify
	if !ok {
		return
	}

	m.mu.Lock()
	mine := m.conn == conn
	if mine {
		m.ch = nil
		m.conn = nil
	}
	m.mu.Unlock()

	// amqp.ErrClosed — намеренное закрытие (teardownLocked), не сбой
	if mine && amqpErr != amqp.ErrClosed {
		m.logger.Errorf("[RABBIT] Connection lost: %v — reconnecting on next use", amqpErr)
	}
}

// Close закрывает соединение при завершении работы приложения.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.teardownLocked()
}
