package api

import (
	"context"
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func tagSearchContextPermission(value string) (permission string, commercial, automation bool) {
	switch value {
	case "contact_create":
		return domain.PermContacts, false, false
	case "lead_create", "lead_import":
		return domain.PermLeads, true, false
	case "automation":
		return domain.PermAutomations, true, true
	default:
		return "", false, false
	}
}

func parseTagSearchIDs(raw string) ([]uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 25 {
		return nil, fiber.NewError(400, "El límite de identificadores es 25")
	}
	ids := make([]uuid.UUID, 0, len(parts))
	seen := map[uuid.UUID]bool{}
	for _, part := range parts {
		id, err := uuid.Parse(strings.TrimSpace(part))
		if err != nil || id == uuid.Nil {
			return nil, fiber.NewError(400, "Etiqueta inválida")
		}
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	return ids, nil
}

func (s *Server) handleSearchTags(c *fiber.Ctx) error {
	permission, commercial, automation := tagSearchContextPermission(strings.TrimSpace(c.Query("context_type")))
	if permission == "" {
		return fiber.NewError(400, "Contexto de etiquetas inválido")
	}
	if !s.contactAvatarCallerHasPermission(c, permission) {
		return fiber.NewError(403, "No tienes permiso para consultar etiquetas en este contexto")
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	if commercial {
		if err := s.repos.Account.RequireLeadsEnabled(c.Context(), accountID); err != nil {
			return writeLeadPolicyError(c, err)
		}
	}
	if automation {
		claims, _ := c.Locals("claims").(*service.JWTClaims)
		if claims == nil || !claims.IsSuperAdmin {
			allowed, err := s.services.Subscription.HasFeature(c.Context(), accountID, "automations")
			if err != nil {
				return fiber.NewError(500, "No se pudo validar el plan")
			}
			if !allowed {
				return c.Status(402).JSON(fiber.Map{"success": false, "error": "Tu plan actual no incluye Automatizaciones", "code": "plan_feature_required", "feature": "automations"})
			}
		}
	}
	search, limit, err := parseContactProfileTagSearch(c.Query("q"), c.Query("limit"))
	if err != nil {
		return err
	}
	ids, err := parseTagSearchIDs(c.Query("ids"))
	if err != nil {
		return err
	}
	tags := make([]*domain.Tag, 0)
	total := 0
	if len(ids) > 0 {
		tags, err = s.repos.Tag.GetByIDsForAccount(c.Context(), accountID, ids)
		total = len(tags)
	} else if search != "" {
		tags, total, err = s.services.Tag.ListPaginated(c.Context(), accountID, search, limit, 0)
	}
	if err != nil {
		return fiber.NewError(500, "No se pudieron buscar las etiquetas")
	}
	if tags == nil {
		tags = make([]*domain.Tag, 0)
	}
	return c.JSON(fiber.Map{"success": true, "tags": tags, "total": total, "can_create": s.contactAvatarCallerHasPermission(c, domain.PermTags)})
}

// resolveCSVImportTag handles only the explicit picker choice, never file metadata.
func (s *Server) resolveCSVImportTag(ctx context.Context, accountID uuid.UUID, name string) (*uuid.UUID, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, nil
	}
	var id uuid.UUID
	err := s.repos.DB().QueryRow(ctx, `SELECT id FROM tags WHERE account_id=$1 AND name=$2`, accountID, name).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fiber.NewError(422, "La etiqueta de importación seleccionada ya no existe en esta cuenta")
	}
	if err != nil {
		return nil, fiber.NewError(500, "No se pudo validar la etiqueta de importación")
	}
	return &id, nil
}
