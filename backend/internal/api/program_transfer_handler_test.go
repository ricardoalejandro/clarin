package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/programtransfer"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/config"
)

func transferActor(permissions ...string) *service.JWTClaims {
	return &service.JWTClaims{AccountID: uuid.New(), UserID: uuid.New(), SessionID: uuid.NewString(), Permissions: permissions}
}

func TestProgramTransferRequiresProgramsAndContacts(t *testing.T) {
	for _, tc := range []struct {
		name        string
		permissions []string
		role        string
		superAdmin  bool
		legacyAdmin bool
		allowed     bool
	}{
		{name: "programs only", permissions: []string{domain.PermPrograms}},
		{name: "contacts only", permissions: []string{domain.PermContacts}},
		{name: "both", permissions: []string{domain.PermPrograms, domain.PermContacts}, allowed: true},
		{name: "all", permissions: []string{domain.PermAll}, allowed: true},
		{name: "legacy admin bit does not grant foreign account authority", legacyAdmin: true},
		{name: "account admin", role: domain.RoleAdmin, allowed: true},
		{name: "super admin", superAdmin: true, allowed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			actor := transferActor(tc.permissions...)
			actor.Role, actor.IsSuperAdmin, actor.IsAdmin = tc.role, tc.superAdmin, tc.legacyAdmin
			if got := canTransferPrograms(actor); got != tc.allowed {
				t.Fatalf("permission = %v, want %v", got, tc.allowed)
			}
		})
	}
}

func TestProgramTransferPreviewTokenBindsAccountActorSessionAndInput(t *testing.T) {
	now := time.Date(2026, 11, 22, 14, 0, 0, 0, time.UTC)
	actor := transferActor(domain.PermPrograms, domain.PermContacts)
	programID, contactID, localContactID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	request := programtransfer.Request{
		File:            programtransfer.File{Version: 1, Records: []programtransfer.Record{{Kind: "program", ID: uuid.NewString(), Fields: map[string]any{"name": "Dato no incluido en la firma visible"}}}},
		TargetProgramID: programID,
		Mappings:        map[string]string{contactID: localContactID},
	}
	token, err := createProgramTransferPreviewToken("signing-key", actor, request, "expected-snapshot", now)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _, _ := strings.Cut(token, ".")
	claims, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || strings.Contains(string(claims), actor.SessionID) || strings.Contains(string(claims), actor.AccountID.String()) || strings.Contains(string(claims), "Dato no incluido") {
		t.Fatal("preview token exposed personal or session data")
	}
	if got, err := verifyProgramTransferPreviewToken("signing-key", actor, request, token, now.Add(time.Minute)); got != "expected-snapshot" || err != nil {
		t.Fatalf("valid token: digest=%q, err=%v", got, err)
	}
	otherAccount, otherActor, otherSession := *actor, *actor, *actor
	otherAccount.AccountID, otherActor.UserID, otherSession.SessionID = uuid.New(), uuid.New(), uuid.NewString()
	otherProgram, otherFile, otherMappings := request, request, request
	otherProgram.TargetProgramID = uuid.NewString()
	otherFile.File = programtransfer.File{Version: 1, Records: []programtransfer.Record{}}
	otherMappings.Mappings = map[string]string{contactID: "create"}
	for _, tc := range []struct {
		name    string
		actor   *service.JWTClaims
		request programtransfer.Request
		token   string
		now     time.Time
	}{
		{"account changed", &otherAccount, request, token, now},
		{"actor changed", &otherActor, request, token, now},
		{"session changed", &otherSession, request, token, now},
		{"destination changed", actor, otherProgram, token, now},
		{"file changed", actor, otherFile, token, now},
		{"mapping changed", actor, otherMappings, token, now},
		{"expiry boundary", actor, request, token, now.Add(programTransferPreviewTTL)},
		{"signature tampered", actor, request, token + "A", now},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := verifyProgramTransferPreviewToken("signing-key", tc.actor, tc.request, tc.token, tc.now); !errors.Is(err, programtransfer.ErrStale) {
				t.Fatalf("expected stale preview, got %v", err)
			}
		})
	}
}

func TestProgramTransferFileSignatureAllowsRoundTripButRejectsChanges(t *testing.T) {
	original := programtransfer.File{Version: 1, Records: []programtransfer.Record{
		{Kind: "program", ID: uuid.NewString(), Fields: map[string]any{"name": "Programa de prueba <&>", "description": "Primera línea\nsegunda línea"}},
	}}
	signature, err := createProgramTransferFileSignature("installation-key", original)
	if err != nil {
		t.Fatal(err)
	}
	original.Signature = signature
	pretty, err := json.MarshalIndent(original, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip programtransfer.File
	if err := json.Unmarshal(pretty, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if err := verifyProgramTransferFileSignature("installation-key", roundTrip); err != nil {
		t.Fatalf("format-only re-encoding changed the signature: %v", err)
	}
	if err := verifyProgramTransferFileSignature("foreign-key", roundTrip); !errors.Is(err, errProgramTransferFileSignature) {
		t.Fatalf("foreign installation did not reject the file: %v", err)
	}
	roundTrip.Records[0].Fields["name"] = "Cambiado después de exportar"
	if err := verifyProgramTransferFileSignature("installation-key", roundTrip); !errors.Is(err, errProgramTransferFileSignature) {
		t.Fatalf("modification did not invalidate the signature: %v", err)
	}
	if err := verifyProgramTransferFileSignature("installation-key", programtransfer.File{Version: 1}); !errors.Is(err, errProgramTransferFileSignature) {
		t.Fatalf("unsigned file did not fail integrity verification: %v", err)
	}
}

func TestProgramTransferHTTPRejectsUnapprovedInputBeforeRepository(t *testing.T) {
	server := &Server{cfg: &config.Config{JWTSecret: "signing-key"}}
	validActor := transferActor(domain.PermPrograms, domain.PermContacts)
	validRequest := `{"file":{"version":1,"records":[]}}`
	for _, tc := range []struct {
		name, path, body, contentType string
		actor                         *service.JWTClaims
		status                        int
		code                          string
	}{
		{"no auth", "/transfer/preview", validRequest, "application/json", nil, 401, "program_transfer_auth_required"},
		{"no contact permission", "/transfer/preview", validRequest, "application/json", transferActor(domain.PermPrograms), 403, "program_transfer_forbidden"},
		{"unsupported format", "/transfer/preview", validRequest, "text/plain", validActor, 415, "program_transfer_unsupported_format"},
		{"trailing data", "/transfer/preview", validRequest + ` {}`, "application/json", validActor, 400, "program_transfer_invalid_file"},
		{"embedded account override", "/transfer/preview", `{"file":{"version":1,"records":[]},"account_id":"foreign"}`, "application/json", validActor, 400, "program_transfer_invalid_file"},
		{"unsigned file", "/transfer/preview", validRequest, "application/json", validActor, 400, "program_transfer_signature_invalid"},
		{"request size", "/transfer/preview", strings.Repeat(" ", maxProgramTransferRequestBytes+1), "application/json", validActor, 413, "program_transfer_too_large"},
		{"confirm requires token", "/transfer/confirm", validRequest, "application/json", validActor, 409, "program_transfer_preview_stale"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := fiber.New(fiber.Config{BodyLimit: 4 << 20})
			app.Use(func(c *fiber.Ctx) error {
				if tc.actor != nil {
					c.Locals("claims", tc.actor)
				}
				return c.Next()
			})
			app.Post("/transfer/preview", server.handlePreviewProgramTransfer)
			app.Post("/transfer/confirm", server.handleConfirmProgramTransfer)
			req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			req.Header.Set(fiber.HeaderContentType, tc.contentType)
			resp, err := app.Test(req, -1)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			var payload struct{ Code string }
			if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode != tc.status || payload.Code != tc.code {
				t.Fatalf("got %d %s, want %d %s", resp.StatusCode, payload.Code, tc.status, tc.code)
			}
			if actual := resp.Header.Get(fiber.HeaderCacheControl); actual != "private, no-store" {
				t.Fatalf("sensitive response is cacheable: %q", actual)
			}
		})
	}
}
