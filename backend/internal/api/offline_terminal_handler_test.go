package api

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/compress"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestValidateOfflinePublicKeyRequiresP256(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	normalized, err := validateOfflinePublicKey(publicKey)
	if err != nil {
		t.Fatalf("valid public key rejected: %v", err)
	}
	if normalized != publicKey {
		t.Fatal("public key was not normalized deterministically")
	}
	if _, err := validateOfflinePublicKey("not a public key"); err == nil {
		t.Fatal("malformed public key was accepted")
	}
}

func TestOfflineEnrollmentUsesAuthenticatedRequestAndPublicProofRoute(t *testing.T) {
	raw, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	if !strings.Contains(source, `offlineV2.Post("/enrollment-requests", s.handleRequestOfflineTerminal)`) {
		t.Fatal("authenticated user enrollment request route is missing")
	}
	if !strings.Contains(source, `api.Post("/offline/v2/activate", s.handleActivateOfflineTerminal)`) {
		t.Fatal("public activation proof route is missing")
	}
	if !strings.Contains(source, `adminOffline.Post("/:id/approve", s.handleAdminApproveOfflineTerminal)`) || !strings.Contains(source, `adminOffline.Post("/:id/reject", s.handleAdminRejectOfflineTerminal)`) {
		t.Fatal("superadmin approval decision routes are missing")
	}
	for _, retired := range []string{`api.Post("/offline/v2/enroll"`, `certificate/renew`, `enrollment-code`, `handleAdminCreateOfflineTerminal`, `handleAdminRegenerateOfflineEnrollment`} {
		if strings.Contains(source, retired) {
			t.Fatalf("retired certificate/manual enrollment path remains routable: %s", retired)
		}
	}
}

func TestOfflineActionsAreServerDefined(t *testing.T) {
	for module, actions := range offlineAllowedModules {
		if !json.Valid(actions) {
			t.Fatalf("invalid actions for %s", module)
		}
	}
	if len(offlineAllowedModules) != 4 {
		t.Fatalf("unexpected offline module count: %d", len(offlineAllowedModules))
	}
	if !bytes.Contains(offlineAllowedModules["tasks"], []byte(`"create":true`)) || !bytes.Contains(offlineAllowedModules["tasks"], []byte(`"complete":true`)) {
		t.Fatal("task pilot writes are not limited to create and complete")
	}
	for _, module := range []string{"whiteboards", "contacts", "programs"} {
		if bytes.Contains(offlineAllowedModules[module], []byte(":true")) {
			t.Fatalf("%s unexpectedly permits offline writes", module)
		}
	}
}

func TestOfflineApprovalRequiresExplicitRiskAcknowledgement(t *testing.T) {
	secure := domain.OfflineDevicePosture{BitLocker: domain.OfflineBitLockerEnabled, WindowsHello: domain.OfflineWindowsHelloConfigured}
	if err := validateOfflineRiskAcknowledgement(secure, false); err != nil {
		t.Fatalf("fully protected terminal required risk acknowledgement: %v", err)
	}
	for _, posture := range []domain.OfflineDevicePosture{
		{BitLocker: domain.OfflineBitLockerDisabled, WindowsHello: domain.OfflineWindowsHelloConfigured},
		{BitLocker: domain.OfflineBitLockerEnabled, WindowsHello: domain.OfflineWindowsHelloNotConfigured},
		{BitLocker: domain.OfflinePostureUnknown, WindowsHello: domain.OfflinePostureUnknown},
	} {
		if err := validateOfflineRiskAcknowledgement(posture, false); err == nil {
			t.Fatalf("risk acknowledgement was not required for %#v", posture)
		}
		if err := validateOfflineRiskAcknowledgement(posture, true); err != nil {
			t.Fatalf("explicit risk acknowledgement was rejected for %#v: %v", posture, err)
		}
	}
}

func TestOfflineActivationProofBindsTerminalAndInstallation(t *testing.T) {
	terminalID := uuid.New()
	installHash := strings.Repeat("a", 64)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	publicPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	digest := sha256.Sum256([]byte("CLARIN-OFFLINE-ACTIVATE\n" + terminalID.String() + "\n" + installHash))
	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(signature)
	if !verifyOfflineActivationProof(publicPEM, terminalID, installHash, encoded) {
		t.Fatal("valid activation proof rejected")
	}
	if verifyOfflineActivationProof(publicPEM, uuid.New(), installHash, encoded) || verifyOfflineActivationProof(publicPEM, terminalID, strings.Repeat("b", 64), encoded) {
		t.Fatal("activation proof was not bound to the exact terminal installation")
	}
}

func TestSendVerifiedOfflineArtifactKeepsStreamOpenThroughResponse(t *testing.T) {
	payload := bytes.Repeat([]byte("clarin-offline-installer\n"), 4096)
	path := filepath.Join(t.TempDir(), "Clarin-Offline-Setup.exe")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	expected := hex.EncodeToString(digest[:])

	app := fiber.New()
	app.Use(compress.New(compress.Config{Level: compress.LevelBestSpeed}))
	app.Get("/installer", func(c *fiber.Ctx) error {
		return sendVerifiedOfflineArtifact(c, path, expected, "exe")
	})
	request := httptest.NewRequest("GET", "/installer", nil)
	request.Header.Set("Accept-Encoding", "br, gzip")
	response, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(body, payload) {
		t.Fatalf("artifact stream changed or was truncated: got %d bytes, want %d", len(body), len(payload))
	}
	if got := response.Header.Get("X-Clarin-SHA256"); got != expected {
		t.Fatalf("checksum header=%q, want %q", got, expected)
	}
	if got := response.Header.Get("Content-Encoding"); got != "identity" {
		t.Fatalf("artifact must not be transformed in transit: content-encoding=%q", got)
	}
	for _, directive := range []string{"private", "no-store", "no-cache", "must-revalidate", "no-transform"} {
		if !strings.Contains(response.Header.Get("Cache-Control"), directive) {
			t.Fatalf("artifact cache policy is missing %q: %q", directive, response.Header.Get("Cache-Control"))
		}
	}
}
