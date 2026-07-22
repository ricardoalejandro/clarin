package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

type contactProfileCapabilities struct {
	CanView               bool `json:"can_view"`
	CanEdit               bool `json:"can_edit"`
	CanManageAvatar       bool `json:"can_manage_avatar"`
	CanManageObservations bool `json:"can_manage_observations"`
	CanCreateTags         bool `json:"can_create_tags"`
}

type contactProfileAvailableTag struct {
	ID    uuid.UUID `json:"id"`
	Name  string    `json:"name"`
	Color string    `json:"color"`
}

type contactProfileFieldDefinition struct {
	ID         uuid.UUID       `json:"id"`
	Name       string          `json:"name"`
	Slug       string          `json:"slug"`
	FieldType  string          `json:"field_type"`
	Options    json.RawMessage `json:"options"`
	Config     json.RawMessage `json:"config"`
	IsRequired bool            `json:"is_required"`
	Position   int             `json:"position"`
}

type contactProfileContactPayload struct {
	*domain.Contact
	StructuredTags    []*domain.Tag              `json:"structured_tags"`
	ExtraPhones       []domain.ContactPhone      `json:"extra_phones"`
	CustomFieldValues []*domain.CustomFieldValue `json:"custom_field_values"`
	DeviceNames       []domain.ContactDeviceName `json:"device_names"`
}

func newContactProfileContactPayload(contact *domain.Contact) contactProfileContactPayload {
	return contactProfileContactPayload{
		Contact: contact, StructuredTags: contact.StructuredTags, ExtraPhones: contact.ExtraPhones,
		CustomFieldValues: contact.CustomFieldValues, DeviceNames: contact.DeviceNames,
	}
}

func (s *Server) registerContactProfileRoutes(protected fiber.Router) {
	profiles := protected.Group("/contact-profiles")
	profiles.Get("/:contactId", s.handleGetContactProfile)
	profiles.Patch("/:contactId", s.handlePatchContactProfile)
	profiles.Get("/:contactId/tags", s.handleSearchContactProfileTags)
	profiles.Get("/:contactId/observations", s.handleListContactProfileObservations)
	profiles.Post("/:contactId/observations", s.handleCreateContactProfileObservation)
	profiles.Delete("/:contactId/observations/:observationId", s.handleDeleteContactProfileObservation)
}

func parseContactProfileID(c *fiber.Ctx) (uuid.UUID, error) {
	contactID, err := uuid.Parse(strings.TrimSpace(c.Params("contactId")))
	if err != nil {
		return uuid.Nil, fiber.NewError(fiber.StatusBadRequest, "Contacto inválido")
	}
	return contactID, nil
}

func parseContactProfileContext(c *fiber.Ctx, contactID uuid.UUID) (contactAvatarContext, error) {
	contextType := strings.TrimSpace(c.Query("context_type", "contact"))
	switch contextType {
	case "contact", "lead", "chat", "event_participant", "program_participant":
	default:
		return contactAvatarContext{}, fiber.NewError(fiber.StatusBadRequest, "Contexto de contacto inválido")
	}
	contextID, err := uuid.Parse(strings.TrimSpace(c.Query("context_id", contactID.String())))
	if err != nil {
		return contactAvatarContext{}, fiber.NewError(fiber.StatusBadRequest, "Identificador de contexto inválido")
	}
	return contactAvatarContext{Type: contextType, ID: contextID}, nil
}

func (s *Server) authorizeContactProfileContext(c *fiber.Ctx, contactID uuid.UUID, profileContext contactAvatarContext) error {
	requiredPermission := map[string]string{
		"contact":             domain.PermContacts,
		"lead":                domain.PermLeads,
		"chat":                domain.PermChats,
		"event_participant":   domain.PermEvents,
		"program_participant": domain.PermPrograms,
	}[profileContext.Type]
	if !s.contactAvatarCallerHasPermission(c, requiredPermission) {
		return fiber.NewError(fiber.StatusForbidden, "No tienes permiso para acceder a este contacto")
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	if s.repos == nil || s.repos.ContactProfile == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "El perfil de contacto no está disponible")
	}
	exists, err := s.repos.ContactProfile.ContextExists(c.Context(), accountID, contactID, profileContext.Type, profileContext.ID)
	if accessErr := contactProfileContextAccessError(exists, err); accessErr != nil {
		return accessErr
	}
	return nil
}

func contactProfileContextAccessError(exists bool, err error) error {
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "No se pudo validar el contexto del contacto")
	}
	if !exists {
		return fiber.NewError(fiber.StatusNotFound, "Contacto no encontrado en este contexto")
	}
	return nil
}

func contactProfileResponse(contact *domain.Contact, profileContext contactAvatarContext, definitions []contactProfileFieldDefinition, observationCount int, canCreateTags bool) fiber.Map {
	return fiber.Map{
		"success": true,
		"contact": newContactProfileContactPayload(contact),
		"context": fiber.Map{"type": profileContext.Type, "id": profileContext.ID},
		// Kept as an empty compatibility field. The canonical editor uses the
		// bounded contextual search endpoint and never downloads the full catalog.
		"available_tags":           make([]contactProfileAvailableTag, 0),
		"observation_count":        observationCount,
		"custom_field_definitions": definitions,
		"capabilities": contactProfileCapabilities{
			CanView: true, CanEdit: true, CanManageAvatar: true, CanManageObservations: true, CanCreateTags: canCreateTags,
		},
	}
}

func (s *Server) loadContactProfileFieldDefinitions(ctx context.Context, accountID uuid.UUID) ([]contactProfileFieldDefinition, error) {
	definitions, err := s.repos.CustomField.GetDefinitionsByAccountID(ctx, accountID)
	if err != nil {
		return nil, err
	}
	availableDefinitions := make([]contactProfileFieldDefinition, 0, len(definitions))
	for _, definition := range definitions {
		options := json.RawMessage(`[]`)
		if len(definition.Config) > 0 {
			var config map[string]json.RawMessage
			if json.Unmarshal(definition.Config, &config) == nil && json.Valid(config["options"]) && len(config["options"]) > 0 {
				options = append(json.RawMessage(nil), config["options"]...)
			}
		}
		availableDefinitions = append(availableDefinitions, contactProfileFieldDefinition{
			ID: definition.ID, Name: definition.Name, Slug: definition.Slug, FieldType: definition.FieldType,
			Options: options, Config: definition.Config, IsRequired: definition.IsRequired, Position: definition.SortOrder,
		})
	}
	return availableDefinitions, nil
}

func (s *Server) resolveContactProfileRequest(c *fiber.Ctx) (uuid.UUID, contactAvatarContext, error) {
	contactID, err := parseContactProfileID(c)
	if err != nil {
		return uuid.Nil, contactAvatarContext{}, err
	}
	profileContext, err := parseContactProfileContext(c, contactID)
	if err != nil {
		return uuid.Nil, contactAvatarContext{}, err
	}
	if err := s.authorizeContactProfileContext(c, contactID, profileContext); err != nil {
		return uuid.Nil, contactAvatarContext{}, err
	}
	return contactID, profileContext, nil
}

func (s *Server) handleGetContactProfile(c *fiber.Ctx) error {
	contactID, profileContext, err := s.resolveContactProfileRequest(c)
	if err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	contact, err := s.services.ContactProfile.Get(c.Context(), accountID, contactID)
	if errors.Is(err, repository.ErrContactProfileNotFound) {
		return fiber.NewError(fiber.StatusNotFound, "Contacto no encontrado")
	}
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar el contacto"})
	}
	definitions, err := s.loadContactProfileFieldDefinitions(c.Context(), accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudieron cargar los campos del contacto"})
	}
	observationCount, err := s.services.ContactProfile.CountObservations(c.Context(), accountID, contactID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar el resumen del historial"})
	}
	return c.JSON(contactProfileResponse(contact, profileContext, definitions, observationCount, s.contactAvatarCallerHasPermission(c, domain.PermTags)))
}

func (s *Server) handleSearchContactProfileTags(c *fiber.Ctx) error {
	contactID, _, err := s.resolveContactProfileRequest(c)
	if err != nil {
		return err
	}
	_ = contactID // Context authorization above binds the search to this Contact.
	search, limit, err := parseContactProfileTagSearch(c.Query("q"), c.Query("limit"))
	if err != nil {
		return err
	}
	if search == "" {
		return c.JSON(fiber.Map{"success": true, "tags": make([]contactProfileAvailableTag, 0), "total": 0})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	tags, total, err := s.services.Tag.ListPaginated(c.Context(), accountID, search, limit, 0)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudieron buscar las etiquetas"})
	}
	available := make([]contactProfileAvailableTag, 0, len(tags))
	for _, tag := range tags {
		available = append(available, contactProfileAvailableTag{ID: tag.ID, Name: tag.Name, Color: tag.Color})
	}
	return c.JSON(fiber.Map{"success": true, "tags": available, "total": total})
}

func parseContactProfileTagSearch(rawSearch, rawLimit string) (string, int, error) {
	search := strings.TrimSpace(rawSearch)
	if utf8.RuneCountInString(search) > 100 {
		return "", 0, fiber.NewError(fiber.StatusUnprocessableEntity, "La búsqueda excede 100 caracteres")
	}
	limit := 20
	if raw := strings.TrimSpace(rawLimit); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 1 || parsed > 25 {
			return "", 0, fiber.NewError(fiber.StatusBadRequest, "El límite debe estar entre 1 y 25")
		}
		limit = parsed
	}
	return search, limit, nil
}

func decodeNullableContactString(raw json.RawMessage, field string, maxLength int) (*string, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%s debe ser texto o null", field)
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if maxLength > 0 && utf8.RuneCountInString(value) > maxLength {
		return nil, fmt.Errorf("%s excede %d caracteres", field, maxLength)
	}
	return &value, nil
}

func decodeStrictContactProfileValue(raw json.RawMessage, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(destination)
}

func parseContactProfileTagIDs(raw json.RawMessage) ([]uuid.UUID, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("tag_ids debe ser una lista; usa [] para limpiar")
	}
	var encoded []string
	if err := decodeStrictContactProfileValue(raw, &encoded); err != nil {
		return nil, fmt.Errorf("tag_ids debe ser una lista de identificadores")
	}
	if len(encoded) > 200 {
		return nil, fmt.Errorf("tag_ids excede 200 elementos")
	}
	result := make([]uuid.UUID, 0, len(encoded))
	seen := make(map[uuid.UUID]struct{}, len(encoded))
	for _, value := range encoded {
		id, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("tag_ids contiene un identificador inválido")
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result, nil
}

func parseContactProfileExtraPhones(raw json.RawMessage) ([]repository.ContactProfileExtraPhonePatch, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("extra_phones debe ser una lista; usa [] para limpiar")
	}
	var encoded []struct {
		ID    *string `json:"id"`
		Phone string  `json:"phone"`
		Label *string `json:"label"`
	}
	if err := decodeStrictContactProfileValue(raw, &encoded); err != nil {
		return nil, fmt.Errorf("extra_phones tiene un formato inválido")
	}
	if len(encoded) > 50 {
		return nil, fmt.Errorf("extra_phones excede 50 elementos")
	}
	result := make([]repository.ContactProfileExtraPhonePatch, 0, len(encoded))
	for _, value := range encoded {
		phone := strings.TrimSpace(value.Phone)
		if phone == "" || utf8.RuneCountInString(phone) > 50 {
			return nil, fmt.Errorf("cada teléfono adicional debe incluir phone válido")
		}
		item := repository.ContactProfileExtraPhonePatch{Phone: phone}
		if value.ID != nil {
			id, err := uuid.Parse(strings.TrimSpace(*value.ID))
			if err != nil {
				return nil, fmt.Errorf("extra_phones contiene un id inválido")
			}
			item.ID = &id
		}
		if value.Label != nil {
			item.Label = strings.TrimSpace(*value.Label)
		}
		result = append(result, item)
	}
	return result, nil
}

func parseContactProfileCustomFields(raw json.RawMessage) ([]repository.ContactProfileCustomFieldPatch, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("custom_field_values debe ser una lista; usa [] para limpiar")
	}
	var encoded []struct {
		FieldID     string          `json:"field_id"`
		ValueText   *string         `json:"value_text"`
		ValueNumber *float64        `json:"value_number"`
		ValueDate   *string         `json:"value_date"`
		ValueBool   *bool           `json:"value_bool"`
		ValueJSON   json.RawMessage `json:"value_json"`
	}
	if err := decodeStrictContactProfileValue(raw, &encoded); err != nil {
		return nil, fmt.Errorf("custom_field_values tiene un formato inválido")
	}
	if len(encoded) > 200 {
		return nil, fmt.Errorf("custom_field_values excede 200 elementos")
	}
	result := make([]repository.ContactProfileCustomFieldPatch, 0, len(encoded))
	for _, value := range encoded {
		fieldID, err := uuid.Parse(strings.TrimSpace(value.FieldID))
		if err != nil {
			return nil, fmt.Errorf("custom_field_values contiene field_id inválido")
		}
		item := repository.ContactProfileCustomFieldPatch{
			FieldID: fieldID, ValueText: value.ValueText, ValueNumber: value.ValueNumber, ValueBool: value.ValueBool,
		}
		if value.ValueDate != nil {
			var parsed time.Time
			var parseErr error
			for _, layout := range []string{time.RFC3339, "2006-01-02"} {
				parsed, parseErr = time.Parse(layout, strings.TrimSpace(*value.ValueDate))
				if parseErr == nil {
					break
				}
			}
			if parseErr != nil {
				return nil, fmt.Errorf("custom_field_values contiene value_date inválido")
			}
			item.ValueDate = &parsed
		}
		if len(value.ValueJSON) > 0 && !bytes.Equal(bytes.TrimSpace(value.ValueJSON), []byte("null")) {
			if !json.Valid(value.ValueJSON) {
				return nil, fmt.Errorf("custom_field_values contiene value_json inválido")
			}
			item.ValueJSON = append(json.RawMessage(nil), value.ValueJSON...)
		}
		result = append(result, item)
	}
	return result, nil
}

func parseContactProfilePatch(body []byte) (repository.ContactProfilePatch, error) {
	var raw map[string]json.RawMessage
	if len(bytes.TrimSpace(body)) == 0 || json.Unmarshal(body, &raw) != nil || raw == nil {
		return repository.ContactProfilePatch{}, fiber.NewError(fiber.StatusBadRequest, "Solicitud inválida")
	}
	patch := repository.ContactProfilePatch{}
	stringFields := map[string]struct {
		max int
		set func(*string)
	}{
		"name":        {255, func(v *string) { patch.NameSet, patch.Name = true, v }},
		"custom_name": {255, func(v *string) { patch.CustomNameSet, patch.CustomName = true, v }},
		"last_name":   {255, func(v *string) { patch.LastNameSet, patch.LastName = true, v }},
		"short_name":  {100, func(v *string) { patch.ShortNameSet, patch.ShortName = true, v }},
		"phone":       {50, func(v *string) { patch.PhoneSet, patch.Phone = true, v }},
		"email":       {255, func(v *string) { patch.EmailSet, patch.Email = true, v }},
		"company":     {255, func(v *string) { patch.CompanySet, patch.Company = true, v }},
		"dni":         {50, func(v *string) { patch.DNISet, patch.DNI = true, v }},
		"address":     {2000, func(v *string) { patch.AddressSet, patch.Address = true, v }},
		"distrito":    {255, func(v *string) { patch.DistritoSet, patch.Distrito = true, v }},
		"ocupacion":   {255, func(v *string) { patch.OcupacionSet, patch.Ocupacion = true, v }},
		"notes":       {10000, func(v *string) { patch.NotesSet, patch.Notes = true, v }},
	}
	for key, value := range raw {
		if config, ok := stringFields[key]; ok {
			parsed, err := decodeNullableContactString(value, key, config.max)
			if err != nil {
				return patch, fiber.NewError(fiber.StatusUnprocessableEntity, err.Error())
			}
			config.set(parsed)
			continue
		}
		switch key {
		case "tag_ids":
			parsed, err := parseContactProfileTagIDs(value)
			if err != nil {
				return patch, fiber.NewError(fiber.StatusUnprocessableEntity, err.Error())
			}
			patch.TagIDsSet = true
			patch.TagIDs = parsed
		case "extra_phones":
			parsed, err := parseContactProfileExtraPhones(value)
			if err != nil {
				return patch, fiber.NewError(fiber.StatusUnprocessableEntity, err.Error())
			}
			patch.ExtraPhonesSet = true
			patch.ExtraPhones = parsed
		case "custom_field_values":
			parsed, err := parseContactProfileCustomFields(value)
			if err != nil {
				return patch, fiber.NewError(fiber.StatusUnprocessableEntity, err.Error())
			}
			patch.CustomFieldValuesSet = true
			patch.CustomFieldValues = parsed
		case "age":
			patch.AgeSet = true
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				patch.Age = nil
				continue
			}
			var age int
			if err := json.Unmarshal(value, &age); err != nil || age < 1 || age > 150 {
				return patch, fiber.NewError(fiber.StatusUnprocessableEntity, "age debe estar entre 1 y 150, o ser null")
			}
			patch.Age = &age
		case "birth_date":
			patch.BirthDateSet = true
			parsed, err := decodeNullableContactString(value, key, 10)
			if err != nil {
				return patch, fiber.NewError(fiber.StatusUnprocessableEntity, err.Error())
			}
			if parsed == nil {
				patch.BirthDate = nil
				continue
			}
			date, err := time.Parse("2006-01-02", *parsed)
			if err != nil {
				return patch, fiber.NewError(fiber.StatusUnprocessableEntity, "birth_date debe usar YYYY-MM-DD")
			}
			patch.BirthDate = &date
		default:
			return patch, fiber.NewError(fiber.StatusBadRequest, "Campo no permitido: "+key)
		}
	}
	return patch, nil
}

func (s *Server) handlePatchContactProfile(c *fiber.Ctx) error {
	contactID, profileContext, err := s.resolveContactProfileRequest(c)
	if err != nil {
		return err
	}
	patch, err := parseContactProfilePatch(c.Body())
	if err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	// Catalogs are loaded before starting the write. A later catalog read cannot
	// turn an already committed PATCH into a false 500 response.
	definitions, err := s.loadContactProfileFieldDefinitions(c.Context(), accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudieron cargar los campos del contacto"})
	}
	observationCount, err := s.services.ContactProfile.CountObservations(c.Context(), accountID, contactID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar el resumen del historial"})
	}
	contact, err := s.services.ContactProfile.Update(c.Context(), accountID, contactID, patch)
	if errors.Is(err, repository.ErrContactProfileNotFound) {
		return fiber.NewError(fiber.StatusNotFound, "Contacto no encontrado")
	}
	if errors.Is(err, repository.ErrContactProfileCollectionInvalid) {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Una colección contiene datos inválidos o ajenos a la cuenta", "code": "invalid_contact_profile_collection"})
	}
	if errors.Is(err, repository.ErrContactIdentityConflict) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "El teléfono ya pertenece a otro contacto", "code": "contact_identity_conflict"})
	}
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo actualizar el contacto"})
	}
	if patch.TagIDsSet {
		if _, reconcileErr := s.services.Event.ReconcileContactEventMembership(c.Context(), accountID, contactID); reconcileErr != nil {
			log.Printf("contact profile tag reconciliation failed for contact %s: %v", contactID, reconcileErr)
		}
	}
	s.afterCanonicalContactProfileChange(accountID, contact)
	return c.JSON(contactProfileResponse(contact, profileContext, definitions, observationCount, s.contactAvatarCallerHasPermission(c, domain.PermTags)))
}

func (s *Server) afterCanonicalContactProfileChange(accountID uuid.UUID, contact *domain.Contact) {
	s.invalidateContactTreeCaches(accountID)
	// Lead detail entries are keyed by lead ID (without the account/contact in
	// the Redis key), so broad list invalidation is not enough. Resolve every
	// related opportunity with both tenant and Contact predicates before
	// deleting its detail and interaction entries.
	s.invalidateLeadDetailsForContacts(context.Background(), accountID, []uuid.UUID{contact.ID})
	s.invalidateProgramsCache(accountID)
	s.invalidateCampaignsCache(accountID)
	if s.hub != nil {
		payload := fiber.Map{"action": "updated", "contact_id": contact.ID, "updated_at": contact.UpdatedAt}
		s.hub.BroadcastToAccount(accountID, ws.EventContactUpdate, payload)
		s.hub.BroadcastToAccount(accountID, ws.EventChatUpdate, payload)
	}
	if s.googleClient != nil && contact.GoogleSync {
		go func() {
			if _, err := s.syncContactToGoogle(context.Background(), accountID, contact.ID); err != nil {
				// The canonical database transaction already succeeded. Google is a
				// best-effort mirror and its existing sync status exposes failures.
				return
			}
		}()
	}
}

func (s *Server) handleListContactProfileObservations(c *fiber.Ctx) error {
	contactID, _, err := s.resolveContactProfileRequest(c)
	if err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	observations, err := s.services.ContactProfile.ListObservations(c.Context(), accountID, contactID, c.QueryInt("limit", 50), c.QueryInt("offset", 0))
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudieron cargar las observaciones"})
	}
	if observations == nil {
		observations = make([]*domain.Interaction, 0)
	}
	total, err := s.services.ContactProfile.CountObservations(c.Context(), accountID, contactID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo cargar el total del historial"})
	}
	return c.JSON(fiber.Map{"success": true, "observations": observations, "total": total})
}

func (s *Server) handleCreateContactProfileObservation(c *fiber.Ctx) error {
	contactID, profileContext, err := s.resolveContactProfileRequest(c)
	if err != nil {
		return err
	}
	var body struct {
		Notes string `json:"notes"`
	}
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Solicitud inválida")
	}
	body.Notes = strings.TrimSpace(body.Notes)
	if body.Notes == "" {
		return fiber.NewError(fiber.StatusUnprocessableEntity, "La observación es obligatoria")
	}
	if utf8.RuneCountInString(body.Notes) > 10000 {
		return fiber.NewError(fiber.StatusUnprocessableEntity, "La observación excede 10000 caracteres")
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	if profileContext.Type == "program_participant" {
		var programID uuid.UUID
		lookupErr := s.repos.DB().QueryRow(c.Context(), `
			SELECT p.id
			FROM program_participants pp
			JOIN programs p ON p.id=pp.program_id AND p.account_id=$1
			WHERE pp.id=$2 AND pp.contact_id=$3
		`, accountID, profileContext.ID, contactID).Scan(&programID)
		switch {
		case lookupErr == nil:
			if handled, guardErr := s.rejectMigratedProgramMutation(c, accountID, programID); handled {
				return guardErr
			}
		case errors.Is(lookupErr, pgx.ErrNoRows):
			return fiber.NewError(fiber.StatusNotFound, "Contacto no encontrado en este contexto")
		default:
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo validar el programa"})
		}
	}
	userID := c.Locals("user_id").(uuid.UUID)
	observation, err := s.services.ContactProfile.CreateObservation(c.Context(), accountID, userID, contactID, profileContext.Type, profileContext.ID, body.Notes)
	if errors.Is(err, repository.ErrContactProfileContextNotFound) {
		return fiber.NewError(fiber.StatusNotFound, "Contacto no encontrado en este contexto")
	}
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo guardar la observación"})
	}
	total, countErr := s.services.ContactProfile.CountObservations(c.Context(), accountID, contactID)
	if countErr != nil {
		log.Printf("contact profile observation count failed after create contact=%s: %v", contactID, countErr)
		total = -1
	}
	s.afterContactProfileObservationChange(accountID, contactID, "created", observation.ID)
	response := fiber.Map{"success": true, "observation": observation}
	if total >= 0 {
		response["total"] = total
	}
	return c.Status(fiber.StatusCreated).JSON(response)
}

func (s *Server) handleDeleteContactProfileObservation(c *fiber.Ctx) error {
	contactID, _, err := s.resolveContactProfileRequest(c)
	if err != nil {
		return err
	}
	observationID, err := uuid.Parse(strings.TrimSpace(c.Params("observationId")))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Observación inválida")
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	var programID *uuid.UUID
	lookupErr := s.repos.DB().QueryRow(c.Context(), `
		SELECT program_id FROM interactions
		WHERE account_id=$1 AND contact_id=$2 AND id=$3
	`, accountID, contactID, observationID).Scan(&programID)
	if lookupErr == nil && programID != nil {
		if handled, guardErr := s.rejectMigratedProgramMutation(c, accountID, *programID); handled {
			return guardErr
		}
	} else if lookupErr != nil && !errors.Is(lookupErr, pgx.ErrNoRows) {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo validar la observación"})
	}
	err = s.services.ContactProfile.DeleteObservation(c.Context(), accountID, contactID, observationID)
	switch {
	case errors.Is(err, repository.ErrAttendanceObservationProtected):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Esta observación de asistencia solo puede eliminarse desde la asistencia", "code": "attendance_observation_protected"})
	case errors.Is(err, repository.ErrContactProfileObservationLocked):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Este registro histórico no es una nota eliminable", "code": "contact_history_entry_protected"})
	case errors.Is(err, repository.ErrContactProfileObservationMissing):
		return fiber.NewError(fiber.StatusNotFound, "Observación no encontrada")
	case err != nil:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo eliminar la observación"})
	}
	total, countErr := s.services.ContactProfile.CountObservations(c.Context(), accountID, contactID)
	if countErr != nil {
		log.Printf("contact profile observation count failed after delete contact=%s: %v", contactID, countErr)
		total = -1
	}
	s.afterContactProfileObservationChange(accountID, contactID, "deleted", observationID)
	response := fiber.Map{"success": true}
	if total >= 0 {
		response["total"] = total
	}
	return c.JSON(response)
}

func (s *Server) afterContactProfileObservationChange(accountID, contactID uuid.UUID, action string, observationID uuid.UUID) {
	if s.cache != nil {
		_ = s.cache.DelPattern(context.Background(), "lead_interactions:"+accountID.String()+":*")
	}
	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventInteractionUpdate, fiber.Map{
			"action": action, "contact_id": contactID, "interaction_id": observationID,
		})
	}
}
