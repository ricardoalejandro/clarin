package api

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func automationTagActionIDs(a *domain.Automation) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0)
	seen := map[uuid.UUID]bool{}
	for index := range a.Config.Nodes {
		_, raw, ok := domain.AutomationTagAction(&a.Config.Nodes[index])
		if !ok {
			continue
		}
		raw = strings.TrimSpace(raw)
		if raw == "" {
			if a.IsActive {
				return nil, fiber.NewError(422, "Selecciona una etiqueta en cada acción antes de activar la automatización")
			}
			continue
		}
		id, err := uuid.Parse(raw)
		if err != nil || id == uuid.Nil {
			return nil, fiber.NewError(422, "Una acción contiene una etiqueta inválida")
		}
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	return ids, nil
}

func (s *Server) validateAutomationTagActions(c *fiber.Ctx, a *domain.Automation) error {
	ids, err := automationTagActionIDs(a)
	if err != nil {
		return err
	}
	if len(ids) > 0 {
		tags, err := s.repos.Tag.GetByIDsForAccount(c.Context(), a.AccountID, ids)
		if err != nil {
			return fiber.NewError(500, "No se pudieron validar las etiquetas")
		}
		if len(tags) != len(ids) {
			return fiber.NewError(422, "Una etiqueta ya no existe o no pertenece a la cuenta")
		}
	}
	domain.NormalizeAutomationTagActions(&a.Config)
	return nil
}
