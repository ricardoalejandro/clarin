package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/programtransfer"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

const (
	maxProgramTransferRequestBytes = 3 << 20
	programTransferPreviewTTL      = 10 * time.Minute
	programTransferPreviewPurpose  = "clarin-program-transfer-preview:v1\x00"
	programTransferFilePurpose     = "clarin-program-transfer-file:v1\x00"
	programTransferCompletedEvent  = "program_transfer_completed"
)

var errProgramTransferFileSignature = errors.New("invalid program transfer file signature")

type programTransferPreviewClaims struct {
	Request   string `json:"request"`
	Snapshot  string `json:"snapshot"`
	ExpiresAt int64  `json:"expires"`
}

func canTransferPrograms(claims *service.JWTClaims) bool {
	return claims != nil && (domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin) ||
		hasModulePermission(claims.Permissions, domain.PermPrograms) && hasModulePermission(claims.Permissions, domain.PermContacts))
}

func programTransferActor(c *fiber.Ctx) (*service.JWTClaims, error) {
	// Files and previews carry academic and contact information. Do not permit
	// browser, intermediary, or service-worker caches to retain the response.
	c.Set(fiber.HeaderCacheControl, "private, no-store")
	c.Set("X-Content-Type-Options", "nosniff")
	claims, _ := c.Locals("claims").(*service.JWTClaims)
	if claims == nil || claims.AccountID == uuid.Nil || claims.UserID == uuid.Nil {
		return nil, writeProgramTransferProblem(c, fiber.StatusUnauthorized, "program_transfer_auth_required", "Inicia sesión para continuar.")
	}
	if !canTransferPrograms(claims) {
		return nil, writeProgramTransferProblem(c, fiber.StatusForbidden, "program_transfer_forbidden", "Se requiere acceso a Programas y Contactos para transferir un programa.")
	}
	return claims, nil
}

func decodeProgramTransferRequest(c *fiber.Ctx, dst any) error {
	body := c.Body()
	if len(body) > maxProgramTransferRequestBytes {
		return programtransfer.ErrTooLarge
	}
	mediaType, _, err := mime.ParseMediaType(c.Get(fiber.HeaderContentType))
	if err != nil || mediaType != fiber.MIMEApplicationJSON {
		return fiber.ErrUnsupportedMediaType
	}
	if !utf8.Valid(body) {
		return programtransfer.ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return programtransfer.ErrInvalid
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return programtransfer.ErrInvalid
	}
	return nil
}

func (s *Server) handleExportProgramTransfer(c *fiber.Ctx) error {
	actor, err := programTransferActor(c)
	if actor == nil {
		return err
	}
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil || programID == uuid.Nil {
		return writeProgramTransferProblem(c, fiber.StatusBadRequest, "program_transfer_invalid_program", "El programa indicado no es válido.")
	}
	file, err := repository.ExportProgramTransfer(c.Context(), s.repos.DB(), actor.AccountID, programID)
	if err != nil {
		return writeProgramTransferError(c, "export", err)
	}
	file.Signature, err = createProgramTransferFileSignature(s.cfg.JWTSecret, file)
	if err != nil {
		return writeProgramTransferError(c, "export-sign", err)
	}
	body, err := json.Marshal(file)
	if err != nil {
		return writeProgramTransferError(c, "export-encode", err)
	}
	if len(body) > programtransfer.MaxFileBytes {
		return writeProgramTransferError(c, "export-size", programtransfer.ErrTooLarge)
	}
	c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	c.Set(fiber.HeaderContentDisposition, `attachment; filename="programa-`+programID.String()+`.clarin-program.json"`)
	return c.Send(body)
}

func (s *Server) handlePreviewProgramTransfer(c *fiber.Ctx) error {
	actor, err := programTransferActor(c)
	if actor == nil {
		return err
	}
	var input programtransfer.Request
	if err := decodeProgramTransferRequest(c, &input); err != nil {
		return writeProgramTransferError(c, "preview-request", err)
	}
	if err := verifyProgramTransferFileSignature(s.cfg.JWTSecret, input.File); err != nil {
		return writeProgramTransferError(c, "preview-signature", err)
	}
	preview, err := repository.PreviewProgramTransfer(c.Context(), s.repos.DB(), actor.AccountID, input)
	if err != nil {
		return writeProgramTransferError(c, "preview", err)
	}
	preview.Token, err = createProgramTransferPreviewToken(s.cfg.JWTSecret, actor, input, preview.Digest, time.Now())
	if err != nil {
		return writeProgramTransferError(c, "preview-sign", err)
	}
	return c.JSON(preview)
}

func (s *Server) handleConfirmProgramTransfer(c *fiber.Ctx) error {
	actor, err := programTransferActor(c)
	if actor == nil {
		return err
	}
	var input programtransfer.ConfirmRequest
	if err := decodeProgramTransferRequest(c, &input); err != nil {
		return writeProgramTransferError(c, "confirm-request", err)
	}
	digest, err := verifyProgramTransferPreviewToken(s.cfg.JWTSecret, actor, input.Request, input.Token, time.Now())
	if err != nil {
		return writeProgramTransferError(c, "confirm-token", err)
	}
	if err := verifyProgramTransferFileSignature(s.cfg.JWTSecret, input.File); err != nil {
		return writeProgramTransferError(c, "confirm-signature", err)
	}
	var quota repository.ProgramTransferContactQuota
	for _, record := range input.File.Records {
		if record.Kind != "contact" {
			continue
		}
		overview, _ := c.Locals("subscription").(*domain.SubscriptionOverview)
		quota.Maximum, quota.LookupErr = s.services.Subscription.ResolveContactLimit(c.Context(), actor.AccountID, overview)
		break
	}
	result, err := repository.ConfirmProgramTransfer(c.Context(), s.repos.DB(), actor.AccountID, actor.UserID, input, digest, quota)
	if err != nil {
		return writeProgramTransferError(c, "confirm", err)
	}
	// Only publish after the transaction commits. The notification contains
	// no contact identity or file data, and is delivered to the destination.
	s.invalidateProgramsCache(actor.AccountID)
	s.invalidateContactTreeCaches(actor.AccountID)
	if s.hub != nil {
		s.hub.BroadcastToAccountWithPermission(actor.AccountID, domain.PermPrograms, programTransferCompletedEvent, fiber.Map{"program_id": result.ProgramID})
	}
	return c.JSON(result)
}

func writeProgramTransferProblem(c *fiber.Ctx, status int, code, message string) error {
	return c.Status(status).JSON(fiber.Map{"code": code, "error": message})
}

func writeProgramTransferError(c *fiber.Ctx, operation string, err error) error {
	switch {
	case errors.Is(err, programtransfer.ErrInvalid):
		return writeProgramTransferProblem(c, fiber.StatusBadRequest, "program_transfer_invalid_file", "El archivo o los datos de importación no coinciden con el formato de Clarin.")
	case errors.Is(err, errProgramTransferFileSignature):
		return writeProgramTransferProblem(c, fiber.StatusBadRequest, "program_transfer_signature_invalid", "El archivo no se puede verificar. Usa un archivo exportado por esta instalación de Clarin y no lo edites.")
	case errors.Is(err, programtransfer.ErrTooLarge):
		return writeProgramTransferProblem(c, fiber.StatusRequestEntityTooLarge, "program_transfer_too_large", "El programa supera los límites de tamaño o cantidad de registros admitidos para la transferencia.")
	case errors.Is(err, fiber.ErrUnsupportedMediaType):
		return writeProgramTransferProblem(c, fiber.StatusUnsupportedMediaType, "program_transfer_unsupported_format", "Envía el archivo en el formato JSON de Clarin.")
	case errors.Is(err, programtransfer.ErrNotFound), errors.Is(err, pgx.ErrNoRows):
		return writeProgramTransferProblem(c, fiber.StatusNotFound, "program_transfer_not_found", "No se encontró el programa seleccionado en esta cuenta.")
	case errors.Is(err, programtransfer.ErrClosed):
		return writeProgramTransferProblem(c, fiber.StatusConflict, "program_transfer_destination_closed", "El programa de destino debe estar activo y ser un grupo de clases.")
	case errors.Is(err, programtransfer.ErrStale):
		return writeProgramTransferProblem(c, fiber.StatusConflict, "program_transfer_preview_stale", "La vista previa venció o cambió el destino. Genera una nueva antes de confirmar.")
	case errors.Is(err, programtransfer.ErrConflict):
		return writeProgramTransferProblem(c, fiber.StatusConflict, "program_transfer_unresolved_conflicts", "Revisa los conflictos de la vista previa antes de confirmar.")
	case errors.Is(err, programtransfer.ErrContactLimit):
		return writeProgramTransferProblem(c, fiber.StatusConflict, "program_transfer_contact_limit", "La cuenta no tiene cupo para los contactos nuevos de esta importación.")
	case errors.Is(err, programtransfer.ErrSourceContactCollision):
		return writeProgramTransferProblem(c, fiber.StatusUnprocessableEntity, "program_transfer_source_contact_collision", "El archivo contiene más de un contacto con el mismo teléfono. Revisa los contactos en la cuenta de origen y vuelve a exportar.")
	default:
		// Pg errors can echo an imported value in their message or detail.
		// Preserve operational diagnostics without logging any row contents.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			log.Printf("[program-transfer] %s failed (sqlstate=%s)", operation, pgErr.Code)
		} else {
			log.Printf("[program-transfer] %s failed (%T)", operation, err)
		}
		return writeProgramTransferProblem(c, fiber.StatusInternalServerError, "program_transfer_failed", "No se pudo completar la transferencia. Inténtalo nuevamente.")
	}
}

func createProgramTransferFileSignature(secret string, file programtransfer.File) (string, error) {
	if secret == "" {
		return "", errors.New("missing program transfer file signing material")
	}
	file.Signature = ""
	// Marshal sorts map keys, letting the client parse and re-submit the JSON
	// without having to preserve the export's byte encoding or whitespace.
	raw, err := json.Marshal(file)
	if err != nil {
		return "", err
	}
	if len(raw) > programtransfer.MaxFileBytes {
		return "", programtransfer.ErrTooLarge
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(programTransferFilePurpose))
	_, _ = mac.Write(raw)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func verifyProgramTransferFileSignature(secret string, file programtransfer.File) error {
	// The length of an unpadded, base64url-encoded SHA-256 MAC is fixed.
	if len(file.Signature) != base64.RawURLEncoding.EncodedLen(sha256.Size) {
		return errProgramTransferFileSignature
	}
	expected, err := createProgramTransferFileSignature(secret, file)
	if err != nil {
		return err
	}
	if !hmac.Equal([]byte(file.Signature), []byte(expected)) {
		return errProgramTransferFileSignature
	}
	return nil
}

func programTransferRequestDigest(request programtransfer.Request) (string, error) {
	raw, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func programTransferPreviewMAC(secret, body string, actor *service.JWTClaims) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(programTransferPreviewPurpose))
	// Bind fixed-width claim data to the MAC without exposing the session ID
	// (or a user/account identifier) in the client-side preview token.
	session := sha256.Sum256([]byte(actor.SessionID))
	_, _ = mac.Write(actor.AccountID[:])
	_, _ = mac.Write(actor.UserID[:])
	_, _ = mac.Write(session[:])
	_, _ = mac.Write([]byte(body))
	return mac.Sum(nil)
}

func createProgramTransferPreviewToken(secret string, actor *service.JWTClaims, request programtransfer.Request, snapshot string, now time.Time) (string, error) {
	if secret == "" || snapshot == "" {
		return "", errors.New("missing transfer preview signing material")
	}
	digest, err := programTransferRequestDigest(request)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(programTransferPreviewClaims{
		Request: digest, Snapshot: snapshot, ExpiresAt: now.Add(programTransferPreviewTTL).Unix(),
	})
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	return body + "." + base64.RawURLEncoding.EncodeToString(programTransferPreviewMAC(secret, body, actor)), nil
}

func verifyProgramTransferPreviewToken(secret string, actor *service.JWTClaims, request programtransfer.Request, token string, now time.Time) (string, error) {
	if secret == "" || len(token) > 2048 {
		return "", programtransfer.ErrStale
	}
	body, signature, ok := strings.Cut(token, ".")
	if !ok || body == "" || signature == "" {
		return "", programtransfer.ErrStale
	}
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || !hmac.Equal(sig, programTransferPreviewMAC(secret, body, actor)) {
		return "", programtransfer.ErrStale
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return "", programtransfer.ErrStale
	}
	var claims programTransferPreviewClaims
	if err := json.Unmarshal(raw, &claims); err != nil || claims.ExpiresAt <= now.Unix() || claims.Snapshot == "" {
		return "", programtransfer.ErrStale
	}
	digest, err := programTransferRequestDigest(request)
	if err != nil || !hmac.Equal([]byte(claims.Request), []byte(digest)) {
		return "", programtransfer.ErrStale
	}
	return claims.Snapshot, nil
}
