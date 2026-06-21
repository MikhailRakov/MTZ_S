package main

import (
	"3dmtzinversionservice/pkg/logging"
	"os"

	amqp "github.com/rabbitmq/amqp091-go"
)

func initRabbitMQ() {
	logger := logging.GetLogger()
	// TODO: Получить адрес из конфига
	uri := os.Getenv("RABBITMQ_URL")

	var err error
	rabbitConn, err = amqp.Dial(uri)
	if err != nil {
		// Вместо паники, можно залогировать ошибку и, возможно, продолжить работу
		// если RabbitMQ не критичен для основных функций
		logger.Fatalf("Failed to connect to RabbitMQ: %v", err)

		// или logger.Errorf(...) и return, если не критично
	}
	logger.Info("RabbitMQ connected successfully")

	rabbitCh, err = rabbitConn.Channel()
	if err != nil {
		logger.Fatalf("Failed to open a RabbitMQ channel: %v", err)
	}
	logger.Info("RabbitMQ channel opened")

	// Объявить очередь (можно сделать один раз при запуске)
	_, err = rabbitCh.QueueDeclare(
		"calculation_tasks", // Имя очереди для задач расчета
		true,                // durable - очередь переживет перезапуск сервера
		false,               // delete when unused
		false,               // exclusive
		false,               // no-wait
		nil,                 // arguments
	)
	if err != nil {
		logger.Fatalf("Failed to declare RabbitMQ queue: %v", err)
	}
	logger.Info("RabbitMQ queue 'calculation_tasks' declared")

}
