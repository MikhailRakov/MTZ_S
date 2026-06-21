// cmd/main/app.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"3dmtzinversionservice/internal/config"
	"3dmtzinversionservice/internal/user"
	"3dmtzinversionservice/pkg/logging"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"

	"github.com/joho/godotenv"
	"github.com/julienschmidt/httprouter"
	amqp "github.com/rabbitmq/amqp091-go"

	/////aws
	"github.com/aws/aws-sdk-go-v2/aws"
	aws_conf "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const (
	serviceAccountKeyFile = "serviceAccountKey.json"
)

var (
	ctx         = context.Background()
	firebaseApp *firebase.App
	authClient  *auth.Client
	rabbitConn  *amqp.Connection
	rabbitCh    *amqp.Channel
)

// NewS3Client создает клиент S3 с указанными ключами
func initS3Client() *s3.Client {
	logger := logging.GetLogger()

	// Загрузка конфигурации из переменных окружения или файла
	endpoint := os.Getenv("AWS_S3_ENDPOINT")      // e.g., https://s3.selectel.ru
	region := os.Getenv("AWS_S3_REGION")          // e.g., ru-1
	bucketName := os.Getenv("AWS_S3_BUCKET_NAME") // Не используется в initS3Client, но может быть нужна позже
	accessKeyID := os.Getenv("AWS_ACCESS_KEY_ID")
	secretAccessKey := os.Getenv("AWS_SECRET_ACCESS_KEY")

	if endpoint == "" || region == "" || bucketName == "" || accessKeyID == "" || secretAccessKey == "" {
		logger.Fatal("S3 configuration environment variables are not set")
	}

	// --- НОВЫЙ СПОСОБ: Загрузка базовой конфигурации БЕЗ endpoint ---
	// НЕ ИСПОЛЬЗУЕМ config.WithEndpointResolverWithOptions
	awsCfg, err := aws_conf.LoadDefaultConfig(context.TODO(),
		aws_conf.WithRegion(region),
		aws_conf.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, "")),
		// УБРАЛИ: config.WithEndpointResolverWithOptions и т.д.
	)
	if err != nil {
		logger.Fatalf("unable to load SDK config, %v", err)
	}

	// --- НОВЕЙШИЙ СПОСОБ: Создание S3 клиента с кастомным endpoint через опцию BaseEndpoint ---
	// Используем опцию BaseEndpoint напрямую в s3.Options
	s3Client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.Region = region // Убедимся, что регион установлен
		// УСТАНАВЛИВАЕМ БАЗОВЫЙ ЭНДПОИНТ НАПРЯМУЮ
		o.BaseEndpoint = aws.String(endpoint) // <-- Это НОВЫЙ РЕКОМЕНДОВАННЫЙ СПОСОБ
		// o.UsePathStyle = true // Например, если S3-совместимое хранилище требует path-style
	})
	// --- КОНЕЦ НОВЕЙШЕГО СПОСОБА ---

	logger.Info("S3 client initialized successfully")
	return s3Client
}

func main() {

	if err := godotenv.Load(); err != nil {
		// log.Println("INFO: No .env file found in current directory. Using system environment variables.")
		// Или log.Fatalf, если .env обязателен
		log.Println("INFO: No .env file found in current directory. Using system environment variables.")
		// os.Getenv будет искать в системной среде, что нормально, если переменные установлены.
	} else {
		log.Println("INFO: .env file loaded successfully.")
	}

	logger := logging.GetLogger()
	logger.Info("initFirebase")
	initFirebase()

	logger.Info("Init s3Client")

	s3Client := initS3Client()

	logger.Info("Create Router")
	router := httprouter.New()

	/////
	router.ServeFiles("/js/*filepath", http.Dir("front/js/"))
	router.ServeFiles("/css/*filepath", http.Dir("front/css/"))
	/////

	router.GET("/internal/middleware/firebase/firebase-config.js", serveFirebaseConfigJS)

	// Маршруты для HTML страниц
	router.GET("/", func(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
		http.ServeFile(w, r, "front/index.html")
	})
	router.GET("/login.html", func(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
		http.ServeFile(w, r, "front/login.html")
	})
	router.GET("/dashboard.html", func(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
		http.ServeFile(w, r, "front/dashboard.html")
	})

	///icon

	router.ServeFiles("/front/*filepath", http.Dir("front"))

	// Чтобы иконка в корне тоже работала (если href="a_ficon.gif")
	router.GET("/a_ficon.gif", func(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
		http.ServeFile(w, r, "front/a_ficon.gif")
	})

	// Маршрут для проверки токена Firebase
	router.POST("/auth/firebase/verify", handleFirebaseTokenVerification)
	cfg := config.GetConfig_app()

	initRabbitMQ()

	logger.Info("register user handler")
	handler := user.NewHandler(logger, firebaseApp, authClient, rabbitCh, s3Client)
	handler.Register(router)

	defer rabbitConn.Close() // Закрываем соединение при завершении
	defer rabbitCh.Close()
	logger.Info("Starting server...")
	start(router, cfg)

}
