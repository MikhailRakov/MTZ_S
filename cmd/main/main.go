// cmd/main/app.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"

	//"strings"
	"time"

	"3dmtzinversionservice/internal/config"
	"3dmtzinversionservice/internal/middleware"
	"3dmtzinversionservice/internal/rabbitmq"
	"3dmtzinversionservice/internal/user"
	"3dmtzinversionservice/pkg/logging"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/auth"

	"github.com/joho/godotenv"
	"github.com/julienschmidt/httprouter"

	/////aws
	"github.com/aws/aws-sdk-go-v2/aws"
	aws_conf "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

var (
	ctx         = context.Background()
	firebaseApp *firebase.App
	authClient  *auth.Client
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

	// Middleware для установки правильных MIME типов и кэширования статики.
	// JS/CSS кешируются на 1 день с ETag (браузер проверяет свежесть при reload);
	// HTML всегда no-cache (чтобы не смешивать старую разметку с новыми модулями).
	setContentType := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Определяем MIME тип по расширению файла
			ext := filepath.Ext(r.URL.Path)
			switch ext {
			case ".js":
				w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			case ".css":
				w.Header().Set("Content-Type", "text/css; charset=utf-8")
			case ".json":
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
			case ".html":
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
			}
			// Стратегия кэширования:
			// - HTML: no-cache (всегда проверять, чтобы не смешивать версии после деплоя)
			// - JS/CSS: кешировать 1 день + ETag (304 при неизменном содержимом)
			//   Это ускоряет повторные визиты и снижает нагрузку на сервер.
			//   При деплое новые файлы получают новый ETag автоматически.
			switch ext {
			case ".html":
				w.Header().Set("Cache-Control", "no-cache, must-revalidate")
			case ".js", ".css":
				w.Header().Set("Cache-Control", "public, max-age=86400")
			}
			next.ServeHTTP(w, r)
		})
	}

	// Статические файлы с правильными MIME типами
	jsHandler := setContentType(http.FileServer(http.Dir("front/js/")))
	cssHandler := setContentType(http.FileServer(http.Dir("front/css/")))

	router.Handler(http.MethodGet, "/js/*filepath", http.StripPrefix("/js/", jsHandler))
	router.Handler(http.MethodGet, "/css/*filepath", http.StripPrefix("/css/", cssHandler))

	//router.GET("//js/config/firebase-config.js", serveFirebaseConfigJS)

	// Маршруты для HTML страниц.
	// no-cache обязателен: иначе браузер может смешать старую HTML-разметку
	// с новыми JS-модулями (или наоборот) после деплоя.
	serveHTMLNoCache := func(file string) func(http.ResponseWriter, *http.Request, httprouter.Params) {
		return func(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
			w.Header().Set("Cache-Control", "no-cache, must-revalidate")
			http.ServeFile(w, r, file)
		}
	}
	router.GET("/", serveHTMLNoCache("front/index.html"))
	router.GET("/login.html", serveHTMLNoCache("front/login.html"))
	router.GET("/dashboard.html", serveHTMLNoCache("front/dashboard.html"))

	///icon

	router.ServeFiles("/front/*filepath", http.Dir("front"))

	// Чтобы иконка в корне тоже работала (если href="a_ficon.gif")
	router.GET("/a_ficon.gif", func(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
		http.ServeFile(w, r, "front/a_ficon.gif")
	})

	// Маршрут для проверки токена Firebase
	router.POST("/auth/firebase/verify", handleFirebaseTokenVerification)
	cfg := config.GetConfig_app()

	// RabbitMQ с автопереподключением: сервер стартует даже при недоступном
	// брокере и восстанавливает связь при первом же обращении (виджет
	// очереди и публикация задач больше не умирают навсегда после обрыва).
	rabbitMgr := rabbitmq.NewManager(os.Getenv("RABBITMQ_URL"), "calculation_tasks", logger)
	if _, err := rabbitMgr.Channel(); err != nil {
		logger.Errorf("RabbitMQ is not available at startup: %v — will reconnect on demand", err)
	}

	// Создаем rate limiter
	// 20 запросов в минуту на пользователя
	rateLimiter := middleware.NewRateLimiter(20, time.Minute)
	defer rateLimiter.Stop()
	logger.Info("Rate limiter initialized: 20 requests per minute per user")

	logger.Info("register user handler")
	handler := user.NewHandler(logger, firebaseApp, authClient, rabbitMgr, s3Client)
	handler.Register(router)

	defer rabbitMgr.Close() // Закрываем соединение при завершении
	logger.Info("Starting server...")
	start(router, cfg)

}
