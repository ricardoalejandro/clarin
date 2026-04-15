package config

import (
	"log"
	"os"
	"strings"
)

type Config struct {
	DatabaseURL   string
	RedisURL      string
	JWTSecret     string
	Port          string
	Env           string
	AdminUser     string
	AdminPassword string
	AdminEmail    string
	CORSOrigins   []string
	// MinIO Storage
	MinioEndpoint  string
	MinioAccessKey string
	MinioSecretKey string
	MinioBucket    string
	MinioUseSSL    bool
	MinioPublicURL string
	// Kommo CRM
	KommoSubdomain    string
	KommoClientID     string
	KommoClientSecret string
	KommoAccessToken  string
	KommoRedirectURI  string
	KommoWebhookSecret string
	// PublicURL is the public URL of the Clarin backend (e.g., https://clarin.naperu.cloud)
	// Used for webhook auto-registration with Kommo.
	PublicURL string
	// AI Assistant
	GeminiAPIKey string
	GroqAPIKey   string
	// Google Contacts OAuth
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURI  string
}

func Load() *Config {
	corsOrigins := getEnv("CORS_ORIGINS", "http://localhost:3000")
	origins := strings.Split(corsOrigins, ",")
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}

	return &Config{
		DatabaseURL:    getEnv("DATABASE_URL", "postgres://clarin:clarin_secret_2026@localhost:5432/clarin?sslmode=disable"),
		RedisURL:       getEnv("REDIS_URL", "redis://localhost:6379"),
		JWTSecret:      getEnv("JWT_SECRET", "clarin_jwt_secret_change_in_production_2026"),
		Port:           getEnv("PORT", "8080"),
		Env:            getEnv("ENV", "development"),
		AdminUser:      getEnv("ADMIN_USER", "admin"),
		AdminPassword:  getEnv("ADMIN_PASSWORD", "clarin123"),
		AdminEmail:     getEnv("ADMIN_EMAIL", "admin@clarin.local"),
		CORSOrigins:    origins,
		MinioEndpoint:  getEnv("MINIO_ENDPOINT", "localhost:9000"),
		MinioAccessKey: getEnv("MINIO_ACCESS_KEY", "clarinadmin"),
		MinioSecretKey: getEnv("MINIO_SECRET_KEY", "clarinadmin"),
		MinioBucket:    getEnv("MINIO_BUCKET", "clarin-media"),
		MinioUseSSL:    getEnv("MINIO_USE_SSL", "false") == "true",
		MinioPublicURL: getEnv("MINIO_PUBLIC_URL", "http://localhost:9000"),
		KommoSubdomain:    getEnv("KOMMO_SUBDOMAIN", ""),
		KommoClientID:     getEnv("KOMMO_CLIENT_ID", ""),
		KommoClientSecret: getEnv("KOMMO_CLIENT_SECRET", ""),
		KommoAccessToken:  getEnv("KOMMO_ACCESS_TOKEN", ""),
		KommoRedirectURI:  getEnv("KOMMO_REDIRECT_URI", ""),
		KommoWebhookSecret: getEnv("KOMMO_WEBHOOK_SECRET", ""),
		PublicURL:           getEnv("PUBLIC_URL", ""),
		GeminiAPIKey:      getEnv("GEMINI_API_KEY", ""),
		GroqAPIKey:        getEnv("GROQ_API_KEY", ""),
		GoogleClientID:     getEnv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret: getEnv("GOOGLE_CLIENT_SECRET", ""),
		GoogleRedirectURI:  getEnv("GOOGLE_REDIRECT_URI", ""),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func (c *Config) IsDevelopment() bool {
	return c.Env == "development"
}

func (c *Config) IsProduction() bool {
	return c.Env == "production"
}

// Validate checks that critical secrets are not using default values in production.
func (c *Config) Validate() {
	if !c.IsProduction() {
		return
	}
	if c.JWTSecret == "clarin_jwt_secret_change_in_production_2026" {
		log.Fatal("[CONFIG] FATAL: JWT_SECRET is using the default value in production. Set a secure JWT_SECRET environment variable.")
	}
	if c.AdminPassword == "clarin123" {
		log.Fatal("[CONFIG] FATAL: ADMIN_PASSWORD is using the default value in production. Set a secure ADMIN_PASSWORD environment variable.")
	}
}
