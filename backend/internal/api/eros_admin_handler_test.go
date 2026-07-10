package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/config"
)

func TestCallErosBridgeAuthStartsProtectedDeviceLogin(t *testing.T) {
	var receivedLoginID string
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/auth/device/cancel" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer bridge-secret" {
			t.Fatalf("unexpected authorization header: %q", got)
		}
		var body struct {
			LoginID string `json:"login_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		receivedLoginID = body.LoginID
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"login":{"status":"cancelled","login_id":"login-1"}}`))
	}))
	defer bridge.Close()

	server := &Server{cfg: &config.Config{ErosCodexBridgeToken: "bridge-secret"}}
	settings := &domain.ErosSettings{BridgeURL: bridge.URL}
	response, err := server.callErosBridgeAuth(t.Context(), settings, http.MethodPost, "/auth/device/cancel", map[string]string{"login_id": "login-1"})
	if err != nil {
		t.Fatalf("callErosBridgeAuth returned error: %v", err)
	}
	if receivedLoginID != "login-1" {
		t.Fatalf("unexpected login id: %q", receivedLoginID)
	}
	if response.Login == nil || response.Login.Status != "cancelled" {
		t.Fatalf("unexpected bridge response: %#v", response.Login)
	}
}

func TestCallErosBridgeAuthRejectsFailedBridgeResponse(t *testing.T) {
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"success":false,"error":"openai_connection_failed","detail":"internal detail"}`))
	}))
	defer bridge.Close()

	server := &Server{cfg: &config.Config{}}
	settings := &domain.ErosSettings{BridgeURL: bridge.URL}
	_, err := server.callErosBridgeAuth(t.Context(), settings, http.MethodGet, "/auth/status", nil)
	if err == nil {
		t.Fatal("expected bridge failure")
	}
	if !strings.Contains(err.Error(), "openai_connection_failed") {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(err.Error(), "internal detail") {
		t.Fatalf("bridge detail should not escape helper: %v", err)
	}
}
