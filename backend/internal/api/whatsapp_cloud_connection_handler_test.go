package api

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/pkg/config"
)

func TestCloudReadinessFailsClosedAndExposesNoSecrets(t *testing.T) {
	server := &Server{cfg: &config.Config{
		WhatsAppCloudAppID:              "123456",
		WhatsAppCloudAppSecret:          "private-app-secret",
		WhatsAppCloudConfigID:           "654321",
		WhatsAppCloudGraphVersion:       "v23.0",
		WhatsAppCloudGraphBaseURL:       "https://graph.facebook.com",
		WhatsAppCloudVerifyToken:        "private-verify-token-with-32-chars",
		WhatsAppCloudTokenEncryptionKey: base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		PublicURL:                       "https://clarin.example",
	}}
	readiness := server.cloudReadiness()
	if !readiness.Ready || !readiness.EmbeddedSignupReady {
		t.Fatalf("expected complete configuration to be ready: %#v", readiness)
	}
	if readiness.AppID != "123456" || readiness.ConfigurationID != "654321" {
		t.Fatalf("public Embedded Signup identifiers are missing: %#v", readiness)
	}
	raw := []byte(readiness.WebhookURL + readiness.AppID + readiness.ConfigurationID)
	for _, secret := range [][]byte{[]byte("private-app-secret"), []byte("private-verify-token-with-32-chars"), []byte("0123456789abcdef0123456789abcdef")} {
		if bytes.Contains(raw, secret) {
			t.Fatalf("readiness exposed secret %q", secret)
		}
	}

	server.cfg.WhatsAppCloudTokenEncryptionKey = ""
	readiness = server.cloudReadiness()
	if readiness.Ready || readiness.TokenEncryptionConfigured {
		t.Fatalf("missing token encryption must fail closed: %#v", readiness)
	}
}

func TestCloudReadinessRequiresOfficialMetaAndHTTPSWebhook(t *testing.T) {
	encodedKey := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	server := &Server{cfg: &config.Config{
		WhatsAppCloudAppID:              "123456",
		WhatsAppCloudAppSecret:          "private-app-secret",
		WhatsAppCloudConfigID:           "654321",
		WhatsAppCloudGraphVersion:       "v23.0",
		WhatsAppCloudGraphBaseURL:       "https://not-meta.example",
		WhatsAppCloudVerifyToken:        "private-verify-token-with-32-chars",
		WhatsAppCloudTokenEncryptionKey: encodedKey,
		PublicURL:                       "http://clarin.example",
	}}
	readiness := server.cloudReadiness()
	if readiness.Ready || readiness.EmbeddedSignupReady || readiness.WebhookURL != "" {
		t.Fatalf("non-Meta endpoint or insecure webhook URL must fail closed: %#v", readiness)
	}
	if _, err := server.cloudClient(); err == nil {
		t.Fatal("Cloud client accepted a non-Meta Graph endpoint")
	}

	server.cfg.WhatsAppCloudGraphBaseURL = "https://graph.facebook.com"
	server.cfg.PublicURL = "https://clarin.example"
	server.cfg.WhatsAppCloudGraphVersion = "v23.0/oauth/access_token"
	if server.cloudReadiness().Ready {
		t.Fatal("invalid Graph version must fail closed")
	}
	if _, err := server.cloudClient(); err == nil {
		t.Fatal("Cloud client accepted an invalid Graph version")
	}
}

func TestCloudCredentialAADIsTenantAndDeviceBound(t *testing.T) {
	accountID := uuid.New()
	deviceID := uuid.New()
	base := cloudCredentialAAD(accountID, deviceID)
	if bytes.Equal(base, cloudCredentialAAD(uuid.New(), deviceID)) {
		t.Fatal("AAD is not account-bound")
	}
	if bytes.Equal(base, cloudCredentialAAD(accountID, uuid.New())) {
		t.Fatal("AAD is not device-bound")
	}
}

func TestValidMetaObjectID(t *testing.T) {
	for _, valid := range []string{"12345", "12345678901234567890"} {
		if !validMetaObjectID(valid) {
			t.Fatalf("expected valid Meta object ID: %s", valid)
		}
	}
	for _, invalid := range []string{"", "1234", "123-45", "abcde"} {
		if validMetaObjectID(invalid) {
			t.Fatalf("expected invalid Meta object ID: %s", invalid)
		}
	}
}
