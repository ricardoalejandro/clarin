package api

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestContactProfileMissingContextUsesNotFoundContract(t *testing.T) {
	err := contactProfileContextAccessError(false, nil)
	var fiberErr *fiber.Error
	if !errors.As(err, &fiberErr) || fiberErr.Code != fiber.StatusNotFound {
		t.Fatalf("a missing or cross-account context must be indistinguishable from a 404, got %v", err)
	}
	if err := contactProfileContextAccessError(true, nil); err != nil {
		t.Fatalf("an existing context must be authorized, got %v", err)
	}
	backendFailure := errors.New("database unavailable")
	err = contactProfileContextAccessError(false, backendFailure)
	if !errors.As(err, &fiberErr) || fiberErr.Code != fiber.StatusInternalServerError {
		t.Fatalf("repository failures must not be misreported as missing, got %v", err)
	}
}

func TestParseContactProfilePatchPreservesOmittedAndNull(t *testing.T) {
	patch, err := parseContactProfilePatch([]byte(`{"custom_name":null,"email":"  alexis@example.com  ","birth_date":"2000-02-29","age":42}`))
	if err != nil {
		t.Fatalf("parse patch: %v", err)
	}
	if !patch.CustomNameSet || patch.CustomName != nil {
		t.Fatalf("custom_name null must be an explicit clear: %+v", patch)
	}
	if patch.PhoneSet {
		t.Fatal("omitted phone must remain untouched")
	}
	if !patch.EmailSet || patch.Email == nil || *patch.Email != "alexis@example.com" {
		t.Fatalf("email was not normalized: %#v", patch.Email)
	}
	if !patch.AgeSet || patch.Age == nil || *patch.Age != 42 {
		t.Fatalf("age was not decoded: %#v", patch.Age)
	}
	wantDate := time.Date(2000, time.February, 29, 0, 0, 0, 0, time.UTC)
	if !patch.BirthDateSet || patch.BirthDate == nil || !patch.BirthDate.Equal(wantDate) {
		t.Fatalf("birth date was not decoded: %#v", patch.BirthDate)
	}
}

func TestParseContactProfilePatchRejectsUnknownAndInvalidAge(t *testing.T) {
	if _, err := parseContactProfilePatch([]byte(`{"lead_status":"won"}`)); err == nil {
		t.Fatal("contextual/commercial fields must not enter the Contact patch")
	}
	if _, err := parseContactProfilePatch([]byte(`{"age":0}`)); err == nil {
		t.Fatal("age zero must not silently clear; explicit null is required")
	}
}

func TestParseContactProfilePatchCollectionPresence(t *testing.T) {
	tagID := uuid.New()
	fieldID := uuid.New()
	patch, err := parseContactProfilePatch([]byte(`{
		"tag_ids":["` + tagID.String() + `","` + tagID.String() + `"],
		"extra_phones":[],
		"custom_field_values":[{"field_id":"` + fieldID.String() + `","value_bool":false}]
	}`))
	if err != nil {
		t.Fatalf("parse collection patch: %v", err)
	}
	if !patch.TagIDsSet || len(patch.TagIDs) != 1 || patch.TagIDs[0] != tagID {
		t.Fatalf("tag_ids presence/deduplication lost: %#v", patch.TagIDs)
	}
	if !patch.ExtraPhonesSet || patch.ExtraPhones == nil || len(patch.ExtraPhones) != 0 {
		t.Fatalf("explicit [] must remain an explicit phone clear: %#v", patch.ExtraPhones)
	}
	if !patch.CustomFieldValuesSet || len(patch.CustomFieldValues) != 1 || patch.CustomFieldValues[0].ValueBool == nil || *patch.CustomFieldValues[0].ValueBool {
		t.Fatalf("custom field false value was not preserved: %#v", patch.CustomFieldValues)
	}

	omitted, err := parseContactProfilePatch([]byte(`{"notes":"sin tocar colecciones"}`))
	if err != nil {
		t.Fatalf("parse omitted collections: %v", err)
	}
	if omitted.TagIDsSet || omitted.ExtraPhonesSet || omitted.CustomFieldValuesSet {
		t.Fatalf("omitted collections must remain untouched: %+v", omitted)
	}

	cleared, err := parseContactProfilePatch([]byte(`{"tag_ids":[],"extra_phones":[],"custom_field_values":[]}`))
	if err != nil {
		t.Fatalf("parse explicit collection clear: %v", err)
	}
	if !cleared.TagIDsSet || !cleared.ExtraPhonesSet || !cleared.CustomFieldValuesSet ||
		cleared.TagIDs == nil || cleared.ExtraPhones == nil || cleared.CustomFieldValues == nil {
		t.Fatalf("empty collections must be distinguishable from omission: %+v", cleared)
	}
}

func TestParseContactProfilePatchRejectsNullCollections(t *testing.T) {
	for _, field := range []string{"tag_ids", "extra_phones", "custom_field_values"} {
		if _, err := parseContactProfilePatch([]byte(`{"` + field + `":null}`)); err == nil {
			t.Fatalf("%s null must be rejected; [] is the clear operation", field)
		}
	}
}

func TestParseContactProfilePatchAllowsNullCustomValueAsRemoval(t *testing.T) {
	fieldID := uuid.New()
	patch, err := parseContactProfilePatch([]byte(`{"custom_field_values":[{"field_id":"` + fieldID.String() + `","value_text":null}]}`))
	if err != nil {
		t.Fatalf("parse null custom value: %v", err)
	}
	if !patch.CustomFieldValuesSet || len(patch.CustomFieldValues) != 1 || patch.CustomFieldValues[0].FieldID != fieldID || patch.CustomFieldValues[0].ValueText != nil {
		t.Fatalf("null custom value must reach replacement validation as a removal: %+v", patch)
	}
}

func TestContactProfilePayloadKeepsEmptyCanonicalCollections(t *testing.T) {
	contact := &domain.Contact{ID: uuid.New(), AccountID: uuid.New(), JID: "51999999999@s.whatsapp.net"}
	contact.StructuredTags = make([]*domain.Tag, 0)
	contact.ExtraPhones = make([]domain.ContactPhone, 0)
	contact.CustomFieldValues = make([]*domain.CustomFieldValue, 0)
	contact.DeviceNames = make([]domain.ContactDeviceName, 0)

	encoded, err := json.Marshal(newContactProfileContactPayload(contact))
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	for _, field := range []string{"structured_tags", "extra_phones", "custom_field_values", "device_names"} {
		value, ok := payload[field]
		if !ok {
			t.Fatalf("%s must be present even when empty: %s", field, encoded)
		}
		items, ok := value.([]any)
		if !ok || len(items) != 0 {
			t.Fatalf("%s must be an empty array, got %#v", field, value)
		}
	}
}

func TestContactProfileResponseKeepsEmptyEditorCatalogs(t *testing.T) {
	contact := &domain.Contact{ID: uuid.New(), AccountID: uuid.New(), JID: "51999999999@s.whatsapp.net"}
	contact.StructuredTags = make([]*domain.Tag, 0)
	contact.ExtraPhones = make([]domain.ContactPhone, 0)
	contact.CustomFieldValues = make([]*domain.CustomFieldValue, 0)
	contact.DeviceNames = make([]domain.ContactDeviceName, 0)
	response := contactProfileResponse(
		contact,
		contactAvatarContext{Type: "contact", ID: contact.ID},
		make([]contactProfileFieldDefinition, 0),
		7,
		true,
	)
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	for _, field := range []string{"available_tags", "custom_field_definitions"} {
		items, ok := payload[field].([]any)
		if !ok || len(items) != 0 {
			t.Fatalf("%s must be an empty array, got %#v", field, payload[field])
		}
	}
	if payload["observation_count"] != float64(7) {
		t.Fatalf("observation count missing from lazy-history summary: %#v", payload["observation_count"])
	}
	capabilities, ok := payload["capabilities"].(map[string]any)
	if !ok || capabilities["can_create_tags"] != true {
		t.Fatalf("tag creation capability missing: %#v", payload["capabilities"])
	}
}

func TestParseContactProfileTagSearchIsBounded(t *testing.T) {
	search, limit, err := parseContactProfileTagSearch("  prioridad  ", "")
	if err != nil || search != "prioridad" || limit != 20 {
		t.Fatalf("unexpected default tag search: %q, %d, %v", search, limit, err)
	}
	if _, limit, err := parseContactProfileTagSearch("cliente", "25"); err != nil || limit != 25 {
		t.Fatalf("valid explicit limit rejected: %d, %v", limit, err)
	}
	for _, raw := range []string{"0", "26", "abc"} {
		if _, _, err := parseContactProfileTagSearch("cliente", raw); err == nil {
			t.Fatalf("limit %q must be rejected", raw)
		}
	}
	if _, _, err := parseContactProfileTagSearch(strings.Repeat("a", 101), "20"); err == nil {
		t.Fatal("oversized tag search must be rejected")
	}
}
