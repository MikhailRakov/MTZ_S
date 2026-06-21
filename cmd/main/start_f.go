package main

import (
	config_s "3dmtzinversionservice/internal/config"
	"3dmtzinversionservice/pkg/logging"
	"fmt"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"time"
)

func start(handler http.Handler, cfg *config_s.Config) {
	logger := logging.GetLogger()
	logger.Info("Start server")

	var listener net.Listener

	var ListenErr error

	if cfg.Listen.Type == "sock" {

		appDir, err := filepath.Abs(filepath.Dir(os.Args[0]))
		if err != nil {
			logger.Fatal(err)
		}
		logger.Info("create socket")
		socketPath := path.Join(appDir, "app.sock")
		// Удаляем старый сокет, если он существует
		if _, err := os.Stat(socketPath); err == nil {
			os.Remove(socketPath)
		}
		logger.Info("create listener unix socket")

		listener, ListenErr = net.Listen("unix", socketPath)

		logger.Infof("server is listening unix socket %s", socketPath)
	} else {
		logger.Info("create listener tcp")

		listener, ListenErr = net.Listen("tcp", fmt.Sprintf("%s:%s", cfg.Listen.BindIP, cfg.Listen.Port))
		logger.Infof("server is listening port %s:%s", cfg.Listen.BindIP, cfg.Listen.Port)
	}
	if ListenErr != nil {
		logger.Fatal(ListenErr)
	}

	server := &http.Server{
		Handler:      handler,
		WriteTimeout: 15 * time.Second,
		ReadTimeout:  15 * time.Second,
	}

	logger.Fatalln(server.Serve(listener))
}
