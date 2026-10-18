package api

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/contactavatar"
	"github.com/naperu/clarin/internal/repository"
)

func parseProgramAvatarRevision(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, errors.New("expected_revision es obligatorio")
	}
	revision, err := strconv.ParseInt(value, 10, 64)
	if err != nil || revision < 0 {
		return 0, errors.New("expected_revision debe ser un entero no negativo")
	}
	return revision, nil
}

func (s *Server) programAvatarError(c *fiber.Ctx, accountID, programID uuid.UUID, err error) error {
	switch {
	case errors.Is(err, repository.ErrProgramAvatarConflict):
		program, loadErr := s.repos.Program.GetByID(c.Context(), accountID, programID)
		if loadErr != nil {
			return c.Status(500).JSON(fiber.Map{"error": "No se pudo recargar la foto actual"})
		}
		return c.Status(409).JSON(fiber.Map{"code": "PROGRAM_AVATAR_CONFLICT", "error": "La foto cambió. Revisa la imagen actual antes de volver a guardar.", "program": program})
	case errors.Is(err, repository.ErrAvatarStorageLimit):
		return c.Status(413).JSON(fiber.Map{"code": "STORAGE_LIMIT_EXCEEDED", "error": "La cuenta alcanzó su límite de almacenamiento"})
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, repository.ErrProgramNotFound):
		return c.Status(404).JSON(fiber.Map{"error": "Programa no encontrado"})
	case errors.Is(err, repository.ErrMediaAssetDeletionInProgress):
		return c.Status(409).JSON(fiber.Map{"code": "MEDIA_BUSY", "error": "La imagen se está actualizando. Vuelve a intentarlo."})
	default:
		return c.Status(500).JSON(fiber.Map{"error": "No se pudo guardar la foto del programa"})
	}
}

func (s *Server) handleUploadProgramAvatar(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(400, "Programa inválido")
	}
	revision, err := parseProgramAvatarRevision(c.FormValue("expected_revision"))
	if err != nil {
		return fiber.NewError(400, err.Error())
	}
	file, err := c.FormFile("file")
	if err != nil {
		return fiber.NewError(400, "Selecciona una imagen JPEG o PNG")
	}
	if file.Size > contactavatar.MaxInputBytes {
		return fiber.NewError(413, "La imagen supera el tamaño permitido")
	}
	reader, err := file.Open()
	if err != nil {
		return fiber.NewError(400, "No se pudo leer la imagen")
	}
	defer reader.Close()
	raw, err := io.ReadAll(io.LimitReader(reader, contactavatar.MaxInputBytes+1))
	if err != nil {
		return fiber.NewError(400, "No se pudo leer la imagen")
	}
	data, err := contactavatar.Normalize(raw)
	if err != nil {
		return fiber.NewError(400, "Usa una imagen JPEG o PNG de hasta 40 megapíxeles")
	}
	program, err := s.repos.Program.SaveAvatar(c.Context(), s.storage, accountID, programID, revision, data)
	if err != nil {
		return s.programAvatarError(c, accountID, programID, err)
	}
	s.invalidateProgramsCache(accountID)
	return c.JSON(program)
}

func (s *Server) handleDeleteProgramAvatar(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(400, "Programa inválido")
	}
	var body struct {
		ExpectedRevision *int64 `json:"expected_revision"`
	}
	if c.BodyParser(&body) != nil || body.ExpectedRevision == nil || *body.ExpectedRevision < 0 {
		return fiber.NewError(400, "expected_revision es obligatorio")
	}
	program, err := s.repos.Program.SaveAvatar(c.Context(), s.storage, accountID, programID, *body.ExpectedRevision, nil)
	if err != nil {
		return s.programAvatarError(c, accountID, programID, err)
	}
	s.invalidateProgramsCache(accountID)
	return c.JSON(program)
}

func (s *Server) handleGetProgramAvatarContent(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return fiber.NewError(400, "Programa inválido")
	}
	key, revision, err := s.repos.Program.AvatarContent(c.Context(), accountID, programID)
	if err != nil || s.storage == nil {
		return c.SendStatus(404)
	}
	data, err := s.storage.GetFile(c.Context(), key)
	if err != nil {
		return c.SendStatus(404)
	}
	c.Set(fiber.HeaderContentType, "image/jpeg")
	c.Set("X-Content-Type-Options", "nosniff")
	// Authenticated images must never persist across account switches. Revision
	// identifies the content; the API client owns a short-lived object URL.
	c.Set(fiber.HeaderCacheControl, "private, no-store")
	c.Set(fiber.HeaderETag, fmt.Sprintf(`"program-%s-%d"`, programID, revision))
	return c.Send(data)
}

func programInactiveAPIError(c *fiber.Ctx) error {
	return c.Status(409).JSON(fiber.Map{"code": "PROGRAM_NOT_ACTIVE", "error": "El programa está concluido o archivado. Reábrelo desde escritorio para agregar participantes o sesiones."})
}
