package config

import (
	"3dmtzinversionservice/pkg/logging"
	"os"
	"sync"

	"github.com/ilyakaznacheev/cleanenv"
)

type Config struct {
	IsDebug *bool `yaml:"is_debug"`
	Listen  struct {
		Type   string `yaml:"type"`
		BindIP string `yaml:"bind_ip"`
		Port   string `yaml:"port"`
	} `yaml:"listen"`
}

var instance *Config

var once sync.Once

func GetConfig_app() *Config {
	once.Do(func() {
		logger := logging.GetLogger()
		logger.Info("read configuration")
		instance = &Config{}

		// Путь к конфигу: из env или дефолт
		configPath := os.Getenv("CONFIG_PATH")
		if configPath == "" {
			configPath = "/app/config.yml"
		}

		if err := cleanenv.ReadConfig(configPath, instance); err != nil {
			help, _ := cleanenv.GetDescription(instance, nil)
			logger.Info("Reading error")
			logger.Info(help)
			logger.Fatal(err)
		}
	})
	return instance
}
