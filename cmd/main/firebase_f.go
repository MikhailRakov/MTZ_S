package main

import (
	"3dmtzinversionservice/pkg/logging"
	"encoding/json"
	"net/http"
	"os"

	firebase "firebase.google.com/go/v4"
	"github.com/julienschmidt/httprouter"
	"google.golang.org/api/option"
)

func initFirebase() {
	logger := logging.GetLogger()

	// Проверка существования файла (по желанию, но полезно)
	if _, err := os.Stat(serviceAccountKeyFile); os.IsNotExist(err) {
		logger.Fatalf("Firebase service account key file not found at: %s", serviceAccountKeyFile)
	}

	opt := option.WithCredentialsFile(serviceAccountKeyFile)
	var err error

	// Инициализация Firebase App
	firebaseApp, err = firebase.NewApp(ctx, nil, opt)
	if err != nil {
		logger.Fatalf("error initializing firebase app: %v", err)
	}

	// Получение клиента Auth
	authClient, err = firebaseApp.Auth(ctx)
	if err != nil {
		logger.Fatalf("error getting Auth client: %v", err)
	}

	logger.Info("Firebase initialized successfully")
}

func serveFirebaseConfigJS(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {

	http.ServeFile(w, r, "internal/middleware/firebase/firebase-config.js")
}

// handleFirebaseTokenVerification проверяет ID токен, полученный от клиента
func handleFirebaseTokenVerification(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	logger := logging.GetLogger()

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		IDToken string `json:"idToken"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		logger.Errorf("Failed to decode request body: %v", err)
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	if req.IDToken == "" {
		http.Error(w, "ID Token is required", http.StatusBadRequest)
		return
	}

	// Верификация токена через Firebase Admin SDK
	token, err := authClient.VerifyIDToken(ctx, req.IDToken)
	if err != nil {
		logger.Errorf("Failed to verify ID token: %v", err)
		http.Error(w, "Invalid ID token", http.StatusUnauthorized)
		return
	}

	logger.Infof("Verified user with UID: %s, Email: %v", token.UID, token.Claims["email"])

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "success",
		"uid":    token.UID,
		"claims": token.Claims,
	})
}
