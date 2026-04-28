package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/kommo"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/ws"
)

var (
	cfSlugRegex  = regexp.MustCompile(`[^a-z0-9_]+`)
	cfMultiUnderscore = regexp.MustCompile(`_{2,}`)
)

// slugifyField generates a slug from a field name using underscores
func slugifyField(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	// Replace accented chars with ascii equivalents
	replacer := strings.NewReplacer(
		"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u",
		"ñ", "n", "ü", "u",
	)
	s = replacer.Replace(s)
	s = cfSlugRegex.ReplaceAllString(s, "_")
	s = cfMultiUnderscore.ReplaceAllString(s, "_")
	s = strings.Trim(s, "_")
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}

var validFieldTypes = map[string]bool{
	"text": true, "number": true, "date": true, "select": true,
	"multi_select": true, "checkbox": true, "email": true,
	"phone": true, "url": true, "currency": true,
}

// --- Definition Handlers ---

func (s *Server) handleGetCustomFieldDefinitions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	// Try cache first
	cacheKey := fmt.Sprintf("custom_fields:defs:%s", accountID)
	if cached, err := s.cache.Get(c.Context(), cacheKey); err == nil && len(cached) > 0 {
		var defs []*domain.CustomFieldDefinition
		if err := json.Unmarshal(cached, &defs); err == nil {
			return c.JSON(fiber.Map{"success": true, "fields": defs})
		}
	}

	defs, err := s.repos.CustomField.GetDefinitionsByAccountID(c.Context(), accountID)
	if err != nil {
		log.Printf("[CUSTOM_FIELDS] Error getting definitions: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error al obtener campos personalizados"})
	}
	if defs == nil {
		defs = []*domain.CustomFieldDefinition{}
	}

	// Cache for 5 minutes
	if data, err := json.Marshal(defs); err == nil {
		_ = s.cache.Set(c.Context(), cacheKey, data, 5*time.Minute)
	}

	return c.JSON(fiber.Map{"success": true, "fields": defs})
}

func (s *Server) handleCreateCustomFieldDefinition(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	claims := c.Locals("claims").(*service.JWTClaims)

	// Admin check
	if !isAdmin(claims) {
		return c.Status(403).JSON(fiber.Map{"success": false, "error": "Solo administradores pueden crear campos personalizados"})
	}

	var req struct {
		Name         string           `json:"name"`
		FieldType    string           `json:"field_type"`
		Config       json.RawMessage  `json:"config"`
		IsRequired   bool             `json:"is_required"`
		DefaultValue *string          `json:"default_value"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Datos inválidos"})
	}

	// Validate name
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El nombre del campo es obligatorio"})
	}
	if len(req.Name) > 255 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El nombre no puede exceder 255 caracteres"})
	}

	// Validate field type
	if !validFieldTypes[req.FieldType] {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tipo de campo inválido"})
	}

	// Validate select/multi_select has options
	if req.FieldType == "select" || req.FieldType == "multi_select" {
		if req.Config != nil {
			var cfg struct {
				Options []struct {
					Label string `json:"label"`
					Value string `json:"value"`
				} `json:"options"`
			}
			if err := json.Unmarshal(req.Config, &cfg); err == nil {
				if len(cfg.Options) == 0 {
					return c.Status(400).JSON(fiber.Map{"success": false, "error": "Los campos de tipo selección requieren al menos una opción"})
				}
			}
		} else {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Los campos de tipo selección requieren opciones en la configuración"})
		}
	}

	// Check limit (50 per account)
	count, err := s.repos.CustomField.CountByAccountID(c.Context(), accountID)
	if err != nil {
		log.Printf("[CUSTOM_FIELDS] Error counting fields: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error interno"})
	}
	if count >= 50 {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "Límite de 50 campos personalizados alcanzado"})
	}

	// Check name uniqueness (case-insensitive)
	exists, err := s.repos.CustomField.NameExistsForAccount(c.Context(), accountID, req.Name, nil)
	if err != nil {
		log.Printf("[CUSTOM_FIELDS] Error checking name: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error interno"})
	}
	if exists {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Ya existe un campo con ese nombre"})
	}

	// Generate slug
	slug := slugifyField(req.Name)
	if slug == "" {
		slug = "campo"
	}

	configJSON := req.Config
	if configJSON == nil {
		configJSON = json.RawMessage(`{}`)
	}

	def := &domain.CustomFieldDefinition{
		AccountID:    accountID,
		Name:         req.Name,
		Slug:         slug,
		FieldType:    req.FieldType,
		Config:       configJSON,
		IsRequired:   req.IsRequired,
		DefaultValue: req.DefaultValue,
	}

	if err := s.repos.CustomField.CreateDefinition(c.Context(), def); err != nil {
		log.Printf("[CUSTOM_FIELDS] Error creating definition: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error al crear campo personalizado"})
	}

	// Invalidate cache
	s.invalidateCustomFieldCache(c.Context(), accountID)

	// WebSocket broadcast
	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventCustomFieldDefUpdate, map[string]interface{}{
			"action": "created",
			"field":  def,
		})
	}

	log.Printf("[CUSTOM_FIELDS] Created field '%s' (type: %s) for account %s", def.Name, def.FieldType, accountID)
	return c.Status(201).JSON(fiber.Map{"success": true, "field": def})
}

func (s *Server) handleUpdateCustomFieldDefinition(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	claims := c.Locals("claims").(*service.JWTClaims)

	if !isAdmin(claims) {
		return c.Status(403).JSON(fiber.Map{"success": false, "error": "Solo administradores pueden editar campos personalizados"})
	}

	fieldID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "ID inválido"})
	}

	existing, err := s.repos.CustomField.GetDefinitionByID(c.Context(), accountID, fieldID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error interno"})
	}
	if existing == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Campo no encontrado"})
	}

	var req struct {
		Name         *string          `json:"name"`
		FieldType    *string          `json:"field_type"`
		Config       json.RawMessage  `json:"config"`
		IsRequired   *bool            `json:"is_required"`
		DefaultValue *string          `json:"default_value"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Datos inválidos"})
	}

	// Prevent field_type change if values exist
	if req.FieldType != nil && *req.FieldType != existing.FieldType {
		hasValues, err := s.repos.CustomField.HasValues(c.Context(), fieldID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error interno"})
		}
		if hasValues {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "No se puede cambiar el tipo de un campo que ya tiene valores asignados"})
		}
		// If no values, we still don't allow type change (slug is immutable, type should be too for consistency)
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El tipo de campo no se puede cambiar después de la creación"})
	}

	// Update name
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "El nombre del campo es obligatorio"})
		}
		if len(name) > 255 {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "El nombre no puede exceder 255 caracteres"})
		}
		exists, err := s.repos.CustomField.NameExistsForAccount(c.Context(), accountID, name, &fieldID)
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error interno"})
		}
		if exists {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Ya existe un campo con ese nombre"})
		}
		existing.Name = name
		// Slug does NOT change
	}

	if req.Config != nil {
		existing.Config = req.Config
	}
	if req.IsRequired != nil {
		existing.IsRequired = *req.IsRequired
	}
	if req.DefaultValue != nil {
		existing.DefaultValue = req.DefaultValue
	}

	if err := s.repos.CustomField.UpdateDefinition(c.Context(), existing); err != nil {
		log.Printf("[CUSTOM_FIELDS] Error updating definition: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error al actualizar campo personalizado"})
	}

	// Reload to get updated_at
	updated, _ := s.repos.CustomField.GetDefinitionByID(c.Context(), accountID, fieldID)
	if updated == nil {
		updated = existing
	}

	s.invalidateCustomFieldCache(c.Context(), accountID)

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventCustomFieldDefUpdate, map[string]interface{}{
			"action": "updated",
			"field":  updated,
		})
	}

	return c.JSON(fiber.Map{"success": true, "field": updated})
}

func (s *Server) handleDeleteCustomFieldDefinition(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	claims := c.Locals("claims").(*service.JWTClaims)

	if !isAdmin(claims) {
		return c.Status(403).JSON(fiber.Map{"success": false, "error": "Solo administradores pueden eliminar campos personalizados"})
	}

	fieldID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "ID inválido"})
	}

	existing, err := s.repos.CustomField.GetDefinitionByID(c.Context(), accountID, fieldID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error interno"})
	}
	if existing == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Campo no encontrado"})
	}

	if err := s.repos.CustomField.DeleteDefinition(c.Context(), accountID, fieldID); err != nil {
		log.Printf("[CUSTOM_FIELDS] Error deleting definition: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error al eliminar campo personalizado"})
	}

	s.invalidateCustomFieldCache(c.Context(), accountID)

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventCustomFieldDefUpdate, map[string]interface{}{
			"action":   "deleted",
			"field_id": fieldID.String(),
		})
	}

	log.Printf("[CUSTOM_FIELDS] Deleted field '%s' for account %s", existing.Name, accountID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleReorderCustomFieldDefinitions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	claims := c.Locals("claims").(*service.JWTClaims)

	if !isAdmin(claims) {
		return c.Status(403).JSON(fiber.Map{"success": false, "error": "Solo administradores pueden reordenar campos personalizados"})
	}

	var req struct {
		FieldIDs []string `json:"field_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Datos inválidos"})
	}

	if len(req.FieldIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Lista de IDs vacía"})
	}

	ids := make([]uuid.UUID, len(req.FieldIDs))
	for i, idStr := range req.FieldIDs {
		id, err := uuid.Parse(idStr)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": fmt.Sprintf("ID inválido en posición %d", i)})
		}
		ids[i] = id
	}

	if err := s.repos.CustomField.ReorderDefinitions(c.Context(), accountID, ids); err != nil {
		log.Printf("[CUSTOM_FIELDS] Error reordering definitions: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error al reordenar campos"})
	}

	s.invalidateCustomFieldCache(c.Context(), accountID)

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventCustomFieldDefUpdate, map[string]interface{}{
			"action": "reordered",
		})
	}

	return c.JSON(fiber.Map{"success": true})
}

// --- Value Handlers ---

func (s *Server) handleGetCustomFieldValues(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "ID de contacto inválido"})
	}

	// Verify contact belongs to account
	contact, err := s.repos.Contact.GetByID(c.Context(), contactID)
	if err != nil || contact == nil || contact.AccountID != accountID {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Contacto no encontrado"})
	}

	values, err := s.repos.CustomField.GetValuesByContact(c.Context(), contactID)
	if err != nil {
		log.Printf("[CUSTOM_FIELDS] Error getting values: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error al obtener valores"})
	}
	if values == nil {
		values = []*domain.CustomFieldValue{}
	}

	// Build display values
	displayValues := make([]map[string]interface{}, len(values))
	for i, v := range values {
		displayValues[i] = s.buildCustomFieldValueResponse(v)
	}

	return c.JSON(fiber.Map{"success": true, "values": displayValues})
}

func (s *Server) handleUpsertCustomFieldValue(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "ID de contacto inválido"})
	}

	fieldID, err := uuid.Parse(c.Params("fieldId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "ID de campo inválido"})
	}

	// Verify contact belongs to account
	contact, err := s.repos.Contact.GetByID(c.Context(), contactID)
	if err != nil || contact == nil || contact.AccountID != accountID {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Contacto no encontrado"})
	}

	// Verify field belongs to account
	def, err := s.repos.CustomField.GetDefinitionByID(c.Context(), accountID, fieldID)
	if err != nil || def == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Campo no encontrado"})
	}

	var req struct {
		Value interface{} `json:"value"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Datos inválidos"})
	}

	// If value is null, delete the value
	if req.Value == nil {
		if err := s.repos.CustomField.DeleteValue(c.Context(), fieldID, contactID); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error al eliminar valor"})
		}
		s.broadcastContactUpdate(accountID, contactID)
		return c.JSON(fiber.Map{"success": true})
	}

	// Map value to the correct column based on field type
	val := &domain.CustomFieldValue{
		FieldID:   fieldID,
		ContactID: contactID,
	}

	if err := s.mapValueToColumns(def, req.Value, val); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	if err := s.repos.CustomField.UpsertValue(c.Context(), val); err != nil {
		log.Printf("[CUSTOM_FIELDS] Error upserting value: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error al guardar valor"})
	}

	s.broadcastContactUpdate(accountID, contactID)

	// Re-read the saved value to get proper column data
	savedVals, _ := s.repos.CustomField.GetValuesByContact(c.Context(), contactID)
	var savedResp map[string]interface{}
	for _, sv := range savedVals {
		if sv.FieldID == fieldID {
			savedResp = s.buildCustomFieldValueResponse(sv)
			break
		}
	}
	if savedResp == nil {
		savedResp = map[string]interface{}{"id": val.ID, "field_id": val.FieldID, "contact_id": val.ContactID}
	}

	return c.JSON(fiber.Map{"success": true, "value": savedResp})
}

func (s *Server) handleBatchUpsertCustomFieldValues(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "ID de contacto inválido"})
	}

	// Verify contact belongs to account
	contact, err := s.repos.Contact.GetByID(c.Context(), contactID)
	if err != nil || contact == nil || contact.AccountID != accountID {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Contacto no encontrado"})
	}

	var req struct {
		Values []struct {
			FieldID string      `json:"field_id"`
			Value   interface{} `json:"value"`
		} `json:"values"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Datos inválidos"})
	}

	// Load all definitions for this account
	defs, err := s.repos.CustomField.GetDefinitionsByAccountID(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Error interno"})
	}
	defMap := make(map[string]*domain.CustomFieldDefinition)
	for _, d := range defs {
		defMap[d.ID.String()] = d
	}

	for _, item := range req.Values {
		fid, err := uuid.Parse(item.FieldID)
		if err != nil {
			continue
		}
		def, ok := defMap[item.FieldID]
		if !ok {
			continue
		}

		if item.Value == nil {
			_ = s.repos.CustomField.DeleteValue(c.Context(), fid, contactID)
			continue
		}

		val := &domain.CustomFieldValue{
			FieldID:   fid,
			ContactID: contactID,
		}
		if err := s.mapValueToColumns(def, item.Value, val); err != nil {
			continue // skip invalid values in batch
		}
		_ = s.repos.CustomField.UpsertValue(c.Context(), val)
	}

	s.broadcastContactUpdate(accountID, contactID)

	return c.JSON(fiber.Map{"success": true})
}

// --- Helper functions ---

func (s *Server) mapValueToColumns(def *domain.CustomFieldDefinition, value interface{}, val *domain.CustomFieldValue) error {
	switch def.FieldType {
	case "text":
		str, ok := value.(string)
		if !ok {
			return fmt.Errorf("Se esperaba texto")
		}
		// Check max_length from config
		if def.Config != nil {
			var cfg struct{ MaxLength int `json:"max_length"` }
			if err := json.Unmarshal(def.Config, &cfg); err == nil && cfg.MaxLength > 0 && len(str) > cfg.MaxLength {
				return fmt.Errorf("El texto excede el largo máximo de %d caracteres", cfg.MaxLength)
			}
		}
		val.ValueText = &str

	case "email":
		str, ok := value.(string)
		if !ok {
			return fmt.Errorf("Se esperaba un email")
		}
		str = strings.TrimSpace(str)
		if str != "" && !isValidEmail(str) {
			return fmt.Errorf("Formato de email inválido")
		}
		val.ValueText = &str

	case "phone":
		str, ok := value.(string)
		if !ok {
			return fmt.Errorf("Se esperaba un teléfono")
		}
		str = strings.TrimSpace(str)
		if str != "" {
			str = kommo.NormalizePhone(str)
		}
		val.ValueText = &str

	case "url":
		str, ok := value.(string)
		if !ok {
			return fmt.Errorf("Se esperaba una URL")
		}
		str = strings.TrimSpace(str)
		if str != "" && !strings.HasPrefix(str, "http://") && !strings.HasPrefix(str, "https://") {
			return fmt.Errorf("La URL debe empezar con http:// o https://")
		}
		val.ValueText = &str

	case "select":
		str, ok := value.(string)
		if !ok {
			return fmt.Errorf("Se esperaba un valor de selección")
		}
		// Validate against options
		if def.Config != nil && str != "" {
			var cfg struct {
				Options []struct{ Value string `json:"value"` } `json:"options"`
			}
			if err := json.Unmarshal(def.Config, &cfg); err == nil && len(cfg.Options) > 0 {
				valid := false
				for _, opt := range cfg.Options {
					if opt.Value == str {
						valid = true
						break
					}
				}
				if !valid {
					return fmt.Errorf("Opción inválida")
				}
			}
		}
		val.ValueText = &str

	case "number", "currency":
		num, ok := value.(float64)
		if !ok {
			return fmt.Errorf("Se esperaba un número")
		}
		// Check min/max from config
		if def.Config != nil {
			var cfg struct {
				Min *float64 `json:"min"`
				Max *float64 `json:"max"`
			}
			if err := json.Unmarshal(def.Config, &cfg); err == nil {
				if cfg.Min != nil && num < *cfg.Min {
					return fmt.Errorf("El valor debe ser mayor o igual a %v", *cfg.Min)
				}
				if cfg.Max != nil && num > *cfg.Max {
					return fmt.Errorf("El valor debe ser menor o igual a %v", *cfg.Max)
				}
			}
		}
		val.ValueNumber = &num

	case "date":
		str, ok := value.(string)
		if !ok {
			return fmt.Errorf("Se esperaba una fecha")
		}
		// Parse date
		var t time.Time
		var parseErr error
		for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05Z", "2006-01-02"} {
			t, parseErr = time.Parse(layout, str)
			if parseErr == nil {
				break
			}
		}
		if parseErr != nil {
			return fmt.Errorf("Formato de fecha inválido")
		}
		val.ValueDate = &t

	case "checkbox":
		b, ok := value.(bool)
		if !ok {
			return fmt.Errorf("Se esperaba verdadero o falso")
		}
		val.ValueBool = &b

	case "multi_select":
		// Value should be an array of strings
		arr, ok := value.([]interface{})
		if !ok {
			return fmt.Errorf("Se esperaba una lista de valores")
		}
		strs := make([]string, 0, len(arr))
		for _, item := range arr {
			str, ok := item.(string)
			if !ok {
				return fmt.Errorf("Se esperaba una lista de textos")
			}
			strs = append(strs, str)
		}
		// Validate against options
		if def.Config != nil && len(strs) > 0 {
			var cfg struct {
				Options []struct{ Value string `json:"value"` } `json:"options"`
			}
			if err := json.Unmarshal(def.Config, &cfg); err == nil && len(cfg.Options) > 0 {
				validOpts := make(map[string]bool)
				for _, opt := range cfg.Options {
					validOpts[opt.Value] = true
				}
				for _, s := range strs {
					if !validOpts[s] {
						return fmt.Errorf("Opción inválida: %s", s)
					}
				}
			}
		}
		jsonBytes, err := json.Marshal(strs)
		if err != nil {
			return fmt.Errorf("Error al serializar valores")
		}
		val.ValueJSON = jsonBytes

	default:
		return fmt.Errorf("Tipo de campo no soportado: %s", def.FieldType)
	}

	return nil
}

func (s *Server) buildCustomFieldValueResponse(v *domain.CustomFieldValue) map[string]interface{} {
	resp := map[string]interface{}{
		"id":         v.ID,
		"field_id":   v.FieldID,
		"contact_id": v.ContactID,
		"field_name": v.FieldName,
		"field_slug": v.FieldSlug,
		"field_type": v.FieldType,
		"created_at": v.CreatedAt,
		"updated_at": v.UpdatedAt,
	}
	if v.ValueText != nil {
		resp["value_text"] = *v.ValueText
	}
	if v.ValueNumber != nil {
		resp["value_number"] = *v.ValueNumber
	}
	if v.ValueDate != nil {
		resp["value_date"] = v.ValueDate.Format(time.RFC3339)
	}
	if v.ValueBool != nil {
		resp["value_bool"] = *v.ValueBool
	}
	if v.ValueJSON != nil {
		var arr []string
		if err := json.Unmarshal(v.ValueJSON, &arr); err == nil {
			resp["value_json"] = arr
		}
	}
	return resp
}

func isValidEmail(email string) bool {
	// Simple email validation
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false
	}
	return strings.Contains(parts[1], ".")
}

func isAdmin(claims *service.JWTClaims) bool {
	return claims.IsAdmin || claims.IsSuperAdmin || claims.Role == domain.RoleAdmin || claims.Role == domain.RoleSuperAdmin
}

func (s *Server) broadcastContactUpdate(accountID, contactID uuid.UUID) {
	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventContactUpdate, map[string]interface{}{
			"action":     "updated",
			"contact_id": contactID.String(),
		})
	}
}

func (s *Server) invalidateCustomFieldCache(ctx context.Context, accountID uuid.UUID) {
	_ = s.cache.DelPattern(ctx, fmt.Sprintf("custom_fields:*:%s", accountID))
}
