package config

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"
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
	KommoSubdomain     string
	KommoClientID      string
	KommoClientSecret  string
	KommoAccessToken   string
	KommoRedirectURI   string
	KommoWebhookSecret string
	KommoProxyURL      string
	// Kommo Outbox (batched push worker)
	// When enabled, pushes to Kommo are coalesced and flushed in bulk PATCHes
	// (up to batch size) every flush interval. Required for multi-account scale.
	KommoOutboxEnabled       bool
	KommoOutboxBatchSize     int
	KommoOutboxFlushInterval time.Duration
	// PublicURL is the public URL of the Clarin backend (e.g., https://clarin.naperu.cloud)
	// Used for webhook auto-registration with Kommo.
	PublicURL string
	// AI Assistant
	GeminiAPIKey string
	GroqAPIKey   string
	// Eros Codex Bridge
	ErosEnabled          bool
	ErosProvider         string
	ErosCodexBridgeURL   string
	ErosCodexBridgeToken string
	ErosCodexAuthMode    string
	ErosCodexModel       string
	ErosCodexReasoning   string
	ErosMCPBaseURL       string
	ErosMCPAccessToken   string
	ErosBridgeTimeout    time.Duration
	// Shared Browser
	SharedBrowserGatewayURL string
	SharedBrowserTimeout    time.Duration
	// Google Contacts OAuth
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURI  string
	// WhatsApp Cloud API webhook authentication
	WhatsAppCloudAppSecret string
	// Login abuse protection
	TurnstileSiteKey   string
	TurnstileSecretKey string
}

func Load() *Config {
	corsOrigins := getEnv("CORS_ORIGINS", "http://localhost:3000")
	origins := strings.Split(corsOrigins, ",")
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}

	return &Config{
		DatabaseURL:              getEnv("DATABASE_URL", "postgres://clarin:clarin_secret_2026@localhost:5432/clarin?sslmode=disable"),
		RedisURL:                 getEnv("REDIS_URL", "redis://localhost:6379"),
		JWTSecret:                getEnv("JWT_SECRET", "clarin_jwt_secret_change_in_production_2026"),
		Port:                     getEnv("PORT", "8080"),
		Env:                      getEnv("ENV", "development"),
		AdminUser:                getEnv("ADMIN_USER", "admin"),
		AdminPassword:            getEnv("ADMIN_PASSWORD", "clarin123"),
		AdminEmail:               getEnv("ADMIN_EMAIL", "admin@clarin.local"),
		CORSOrigins:              origins,
		MinioEndpoint:            getEnv("MINIO_ENDPOINT", "localhost:9000"),
		MinioAccessKey:           getEnv("MINIO_ACCESS_KEY", "clarinadmin"),
		MinioSecretKey:           getEnv("MINIO_SECRET_KEY", "clarinadmin"),
		MinioBucket:              getEnv("MINIO_BUCKET", "clarin-media"),
		MinioUseSSL:              getEnv("MINIO_USE_SSL", "false") == "true",
		MinioPublicURL:           getEnv("MINIO_PUBLIC_URL", "http://localhost:9000"),
		KommoSubdomain:           getEnv("KOMMO_SUBDOMAIN", ""),
		KommoClientID:            getEnv("KOMMO_CLIENT_ID", ""),
		KommoClientSecret:        getEnv("KOMMO_CLIENT_SECRET", ""),
		KommoAccessToken:         getEnv("KOMMO_ACCESS_TOKEN", ""),
		KommoRedirectURI:         getEnv("KOMMO_REDIRECT_URI", ""),
		KommoWebhookSecret:       getEnv("KOMMO_WEBHOOK_SECRET", ""),
		KommoProxyURL:            getEnv("KOMMO_PROXY_URL", getEnv("MEDIA_SOCKS5_PROXY", "")),
		KommoOutboxEnabled:       getEnvBool("KOMMO_OUTBOX_ENABLED", true),
		KommoOutboxBatchSize:     getEnvInt("KOMMO_OUTBOX_BATCH_SIZE", 250),
		KommoOutboxFlushInterval: getEnvDuration("KOMMO_OUTBOX_FLUSH_INTERVAL", 2*time.Second),
		PublicURL:                getEnv("PUBLIC_URL", ""),
		GeminiAPIKey:             getEnv("GEMINI_API_KEY", ""),
		GroqAPIKey:               getEnv("GROQ_API_KEY", ""),
		ErosEnabled:              getEnvBool("EROS_ENABLED", true),
		ErosProvider:             getEnv("EROS_PROVIDER", "codex_bridge"),
		ErosCodexBridgeURL:       strings.TrimRight(getEnv("EROS_CODEX_BRIDGE_URL", ""), "/"),
		ErosCodexBridgeToken:     getEnv("EROS_CODEX_BRIDGE_TOKEN", ""),
		ErosCodexAuthMode:        getEnv("EROS_CODEX_AUTH_MODE", "chatgpt_subscription"),
		ErosCodexModel:           getEnv("EROS_CODEX_MODEL", "gpt-5.4-mini"),
		ErosCodexReasoning:       getEnv("EROS_CODEX_REASONING_EFFORT", "medium"),
		ErosMCPBaseURL:           strings.TrimRight(getEnv("EROS_MCP_BASE_URL", ""), "/"),
		ErosMCPAccessToken:       getEnv("EROS_MCP_ACCESS_TOKEN", ""),
		ErosBridgeTimeout:        getEnvDuration("EROS_CODEX_BRIDGE_TIMEOUT", 195*time.Second),
		SharedBrowserGatewayURL:  strings.TrimRight(getEnv("SHARED_BROWSER_GATEWAY_URL", "http://clarin-shared-browser:8791"), "/"),
		SharedBrowserTimeout:     getEnvDuration("SHARED_BROWSER_TIMEOUT", 30*time.Second),
		GoogleClientID:           getEnv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret:       getEnv("GOOGLE_CLIENT_SECRET", ""),
		GoogleRedirectURI:        getEnv("GOOGLE_REDIRECT_URI", ""),
		WhatsAppCloudAppSecret:   getEnv("WHATSAPP_CLOUD_APP_SECRET", ""),
		TurnstileSiteKey:         getEnv("TURNSTILE_SITE_KEY", getEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "")),
		TurnstileSecretKey:       getEnv("TURNSTILE_SECRET_KEY", ""),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if v == "" {
		return defaultValue
	}
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func getEnvInt(key string, defaultValue int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return defaultValue
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return defaultValue
	}
	return n
}

func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return defaultValue
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return defaultValue
	}
	return d
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
