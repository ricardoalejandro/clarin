package config

import (
	"encoding/hex"
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
	// Google Contacts OAuth
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURI  string
	// WhatsApp Cloud API / Embedded Signup. Secrets are backend-only; the App
	// ID and configuration ID are intentionally returned by the protected
	// readiness endpoint so the browser can launch Meta's official flow.
	WhatsAppCloudAppID              string
	WhatsAppCloudAppSecret          string
	WhatsAppCloudConfigID           string
	WhatsAppCloudGraphVersion       string
	WhatsAppCloudGraphBaseURL       string
	WhatsAppCloudVerifyToken        string
	WhatsAppCloudTokenEncryptionKey string
	// Experimental WhatsApp Web ephemeral status publishing. Keep disabled in
	// production until a real-device smoke test has passed.
	WhatsAppStatusEnabled     bool
	WhatsAppStatusSyncEnabled bool
	// Work whiteboard views are an additive rollout. The backend keeps the
	// contextual authorization resolver active even while entry points are
	// hidden, so persisted bindings can never fall back to standalone ACLs.
	WorkWhiteboardViewsEnabled bool
	// Login abuse protection
	TurnstileSiteKey   string
	TurnstileSecretKey string
	// Offline Windows terminals. Production enablement requires the isolated
	// signer and its token supplied through a read-only shared volume.
	OfflineEnabled           bool // legacy master switch; every v2 flag is additionally fail-closed
	OfflineControlEnabled    bool
	OfflineEnrollmentEnabled bool
	OfflineSyncReadEnabled   bool
	OfflineWriteWhiteboards  bool
	OfflineWriteTasks        bool
	OfflineWriteContacts     bool
	OfflineWritePrograms     bool
	OfflineMinClientVersion  string
	OfflineSignerAddress     string
	OfflineSignerTokenFile   string
	OfflineInstallerPath     string
	OfflineInstallerSHA256   string
	// Offline web v3 is a separate, fail-closed rollout.  It deliberately does
	// not inherit any v2 switch: enabling a legacy terminal must never enable
	// the browser/grant data plane by accident.
	OfflineV3Enabled          bool
	OfflineV4Enabled          bool
	OfflineV4TaskWrites       bool
	OfflineV4ServerOrigin     string
	OfflineV5Enabled          bool
	OfflineV5PrepareEnabled   bool
	OfflineV5WritesEnabled    bool
	OfflineV5BlobSyncEnabled  bool
	OfflineV5ServerOrigin     string
	OfflineV3TaskWrites       bool
	OfflineV3ServerOrigin     string
	OfflineV3MinClientVersion string
}

func Load() *Config {
	corsOrigins := getEnv("CORS_ORIGINS", "http://localhost:3000")
	origins := strings.Split(corsOrigins, ",")
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}
	offlineInstallerPath := getEnv("OFFLINE_INSTALLER_PATH", "")

	return &Config{
		DatabaseURL:                     getEnv("DATABASE_URL", "postgres://clarin:clarin_secret_2026@localhost:5432/clarin?sslmode=disable"),
		RedisURL:                        getEnv("REDIS_URL", "redis://localhost:6379"),
		JWTSecret:                       getEnv("JWT_SECRET", "clarin_jwt_secret_change_in_production_2026"),
		Port:                            getEnv("PORT", "8080"),
		Env:                             getEnv("ENV", "development"),
		AdminUser:                       getEnv("ADMIN_USER", "admin"),
		AdminPassword:                   getEnv("ADMIN_PASSWORD", "clarin123"),
		AdminEmail:                      getEnv("ADMIN_EMAIL", "admin@clarin.local"),
		CORSOrigins:                     origins,
		MinioEndpoint:                   getEnv("MINIO_ENDPOINT", "localhost:9000"),
		MinioAccessKey:                  getEnv("MINIO_ACCESS_KEY", "clarinadmin"),
		MinioSecretKey:                  getEnv("MINIO_SECRET_KEY", "clarinadmin"),
		MinioBucket:                     getEnv("MINIO_BUCKET", "clarin-media"),
		MinioUseSSL:                     getEnv("MINIO_USE_SSL", "false") == "true",
		MinioPublicURL:                  getEnv("MINIO_PUBLIC_URL", "http://localhost:9000"),
		KommoSubdomain:                  getEnv("KOMMO_SUBDOMAIN", ""),
		KommoClientID:                   getEnv("KOMMO_CLIENT_ID", ""),
		KommoClientSecret:               getEnv("KOMMO_CLIENT_SECRET", ""),
		KommoAccessToken:                getEnv("KOMMO_ACCESS_TOKEN", ""),
		KommoRedirectURI:                getEnv("KOMMO_REDIRECT_URI", ""),
		KommoWebhookSecret:              getEnv("KOMMO_WEBHOOK_SECRET", ""),
		KommoProxyURL:                   getEnv("KOMMO_PROXY_URL", getEnv("MEDIA_SOCKS5_PROXY", "")),
		KommoOutboxEnabled:              getEnvBool("KOMMO_OUTBOX_ENABLED", true),
		KommoOutboxBatchSize:            getEnvInt("KOMMO_OUTBOX_BATCH_SIZE", 250),
		KommoOutboxFlushInterval:        getEnvDuration("KOMMO_OUTBOX_FLUSH_INTERVAL", 2*time.Second),
		PublicURL:                       getEnv("PUBLIC_URL", ""),
		GeminiAPIKey:                    getEnv("GEMINI_API_KEY", ""),
		GroqAPIKey:                      getEnv("GROQ_API_KEY", ""),
		ErosEnabled:                     getEnvBool("EROS_ENABLED", true),
		ErosProvider:                    getEnv("EROS_PROVIDER", "codex_bridge"),
		ErosCodexBridgeURL:              strings.TrimRight(getEnv("EROS_CODEX_BRIDGE_URL", ""), "/"),
		ErosCodexBridgeToken:            getEnv("EROS_CODEX_BRIDGE_TOKEN", ""),
		ErosCodexAuthMode:               getEnv("EROS_CODEX_AUTH_MODE", "chatgpt_subscription"),
		ErosCodexModel:                  getEnv("EROS_CODEX_MODEL", "gpt-5.4-mini"),
		ErosCodexReasoning:              getEnv("EROS_CODEX_REASONING_EFFORT", "medium"),
		ErosMCPBaseURL:                  strings.TrimRight(getEnv("EROS_MCP_BASE_URL", ""), "/"),
		ErosMCPAccessToken:              getEnv("EROS_MCP_ACCESS_TOKEN", ""),
		ErosBridgeTimeout:               getEnvDuration("EROS_CODEX_BRIDGE_TIMEOUT", 195*time.Second),
		GoogleClientID:                  getEnv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret:              getEnv("GOOGLE_CLIENT_SECRET", ""),
		GoogleRedirectURI:               getEnv("GOOGLE_REDIRECT_URI", ""),
		WhatsAppCloudAppID:              getEnv("WHATSAPP_CLOUD_APP_ID", ""),
		WhatsAppCloudAppSecret:          getEnv("WHATSAPP_CLOUD_APP_SECRET", ""),
		WhatsAppCloudConfigID:           getEnv("WHATSAPP_CLOUD_CONFIG_ID", ""),
		WhatsAppCloudGraphVersion:       getEnv("WHATSAPP_CLOUD_GRAPH_VERSION", "v23.0"),
		WhatsAppCloudGraphBaseURL:       strings.TrimRight(getEnv("WHATSAPP_CLOUD_GRAPH_BASE_URL", "https://graph.facebook.com"), "/"),
		WhatsAppCloudVerifyToken:        getEnv("WHATSAPP_CLOUD_VERIFY_TOKEN", ""),
		WhatsAppCloudTokenEncryptionKey: getEnv("WHATSAPP_CLOUD_TOKEN_ENCRYPTION_KEY", ""),
		WhatsAppStatusEnabled:           getEnvBool("WHATSAPP_STATUS_ENABLED", false),
		WhatsAppStatusSyncEnabled:       getEnvBool("WHATSAPP_STATUS_SYNC_ENABLED", false),
		WorkWhiteboardViewsEnabled:      getEnvBool("WORK_WHITEBOARD_VIEWS_ENABLED", false),
		TurnstileSiteKey:                getEnv("TURNSTILE_SITE_KEY", getEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "")),
		TurnstileSecretKey:              getEnv("TURNSTILE_SECRET_KEY", ""),
		OfflineEnabled:                  getEnvBool("OFFLINE_TERMINALS_ENABLED", false),
		OfflineControlEnabled:           getEnvBool("OFFLINE_CONTROL_ENABLED", false),
		OfflineEnrollmentEnabled:        getEnvBool("OFFLINE_ENROLLMENT_ENABLED", false),
		OfflineSyncReadEnabled:          getEnvBool("OFFLINE_SYNC_READ_ENABLED", false),
		OfflineWriteWhiteboards:         getEnvBool("OFFLINE_WRITE_WHITEBOARDS_ENABLED", false),
		OfflineWriteTasks:               getEnvBool("OFFLINE_WRITE_TASKS_ENABLED", false),
		OfflineWriteContacts:            getEnvBool("OFFLINE_WRITE_CONTACTS_ENABLED", false),
		OfflineWritePrograms:            getEnvBool("OFFLINE_WRITE_PROGRAMS_ENABLED", false),
		OfflineMinClientVersion:         strings.TrimSpace(getEnv("OFFLINE_MIN_CLIENT_VERSION", "0.1.0")),
		OfflineSignerAddress:            strings.TrimRight(getEnv("OFFLINE_SIGNER_ADDRESS", ""), "/"),
		OfflineSignerTokenFile:          getEnv("OFFLINE_SIGNER_TOKEN_FILE", ""),
		OfflineInstallerPath:            offlineInstallerPath,
		OfflineInstallerSHA256:          artifactSHA256("OFFLINE_INSTALLER_SHA256", offlineInstallerPath),
		OfflineV3Enabled:                getEnvBool("OFFLINE_V3_ENABLED", false),
		OfflineV4Enabled:                getEnvBool("OFFLINE_V4_ENABLED", false),
		OfflineV4TaskWrites:             getEnvBool("OFFLINE_V4_TASK_WRITES_ENABLED", false),
		OfflineV4ServerOrigin:           strings.TrimRight(getEnv("OFFLINE_V4_SERVER_ORIGIN", "https://clarin.naperu.cloud"), "/"),
		OfflineV5Enabled:                getEnvBool("OFFLINE_V5_ENABLED", false),
		OfflineV5PrepareEnabled:         getEnvBool("OFFLINE_V5_PREPARE_ENABLED", false),
		OfflineV5WritesEnabled:          getEnvBool("OFFLINE_V5_WRITES_ENABLED", false),
		// Reserved for a future end-to-end blob transport. Keep this false even
		// if a stale deployment environment still contains the former flag: the
		// v5 contract must never advertise a capability it cannot enforce.
		OfflineV5BlobSyncEnabled:  false,
		OfflineV5ServerOrigin:     strings.TrimRight(getEnv("OFFLINE_V5_SERVER_ORIGIN", getEnv("OFFLINE_V4_SERVER_ORIGIN", "https://clarin.naperu.cloud")), "/"),
		OfflineV3TaskWrites:       getEnvBool("OFFLINE_V3_TASK_WRITES_ENABLED", false),
		OfflineV3ServerOrigin:     strings.TrimRight(getEnv("OFFLINE_V3_SERVER_ORIGIN", "https://clarin.naperu.cloud"), "/"),
		OfflineV3MinClientVersion: strings.TrimSpace(getEnv("OFFLINE_V3_MIN_CLIENT_VERSION", "3.0.0")),
	}
}

func artifactSHA256(envName, artifactPath string) string {
	if configured := strings.ToLower(strings.TrimSpace(os.Getenv(envName))); configured != "" {
		return configured
	}
	if artifactPath == "" {
		return ""
	}
	raw, err := os.ReadFile(artifactPath + ".sha256")
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return ""
	}
	return strings.ToLower(fields[0])
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
	offlineDataPlane := c.OfflineEnrollmentEnabled || c.OfflineSyncReadEnabled || c.OfflineWriteWhiteboards || c.OfflineWriteTasks || c.OfflineWriteContacts || c.OfflineWritePrograms
	if c.OfflineEnabled && offlineDataPlane && (c.OfflineSignerAddress == "" || c.OfflineSignerTokenFile == "") {
		log.Fatal("[CONFIG] FATAL: offline terminals require the isolated signer address and token file")
	}
	if c.OfflineEnabled && c.OfflineEnrollmentEnabled && (c.OfflineInstallerPath == "" || len(c.OfflineInstallerSHA256) != 64) {
		log.Fatal("[CONFIG] FATAL: offline terminals require a published installer with a SHA-256 value")
	}
	if c.OfflineEnabled && c.OfflineEnrollmentEnabled {
		if _, err := hex.DecodeString(c.OfflineInstallerSHA256); err != nil {
			log.Fatal("[CONFIG] FATAL: OFFLINE_INSTALLER_SHA256 must be hexadecimal")
		}
	}
	if (c.OfflineWriteWhiteboards || c.OfflineWriteTasks || c.OfflineWriteContacts || c.OfflineWritePrograms) && !c.OfflineSyncReadEnabled {
		log.Fatal("[CONFIG] FATAL: offline module writes require OFFLINE_SYNC_READ_ENABLED")
	}
	if c.OfflineV3TaskWrites && !c.OfflineV3Enabled {
		log.Fatal("[CONFIG] FATAL: OFFLINE_V3_TASK_WRITES_ENABLED requires OFFLINE_V3_ENABLED")
	}
	if c.OfflineV4TaskWrites && !c.OfflineV4Enabled {
		log.Fatal("[CONFIG] FATAL: OFFLINE_V4_TASK_WRITES_ENABLED requires OFFLINE_V4_ENABLED")
	}
	if (c.OfflineV5PrepareEnabled || c.OfflineV5WritesEnabled || c.OfflineV5BlobSyncEnabled) && !c.OfflineV5Enabled {
		log.Fatal("[CONFIG] FATAL: offline v5 feature flags require OFFLINE_V5_ENABLED")
	}
	if (c.OfflineV5WritesEnabled && !c.OfflineV5PrepareEnabled) || (c.OfflineV5BlobSyncEnabled && !c.OfflineV5WritesEnabled) {
		log.Fatal("[CONFIG] FATAL: offline v5 writes require preparation and blob sync additionally requires writes")
	}
	if c.OfflineV5Enabled && (c.OfflineSignerAddress == "" || c.OfflineSignerTokenFile == "" || c.OfflineV5ServerOrigin != c.OfflineV4ServerOrigin) {
		log.Fatal("[CONFIG] FATAL: offline web v5 requires the v4-compatible isolated signer and the exact same trusted origin")
	}
	if c.OfflineV4Enabled && (c.OfflineSignerAddress == "" || c.OfflineSignerTokenFile == "") {
		log.Fatal("[CONFIG] FATAL: offline web v4 requires the isolated signer address and token file")
	}
	if c.OfflineV3Enabled && (c.OfflineSignerAddress == "" || c.OfflineSignerTokenFile == "") {
		log.Fatal("[CONFIG] FATAL: offline web v3 requires the isolated signer address and token file")
	}
}
