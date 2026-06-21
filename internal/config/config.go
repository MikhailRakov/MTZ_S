package config

import (
	"3dmtzinversionservice/pkg/logging"
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

		if err := cleanenv.ReadConfig("config.yml", instance); err != nil {
			help, _ := cleanenv.GetDescription(instance, nil)
			logger.Info("Reading error")
			logger.Info(help)
			logger.Fatal(err)
		}
	})
	return instance
}
