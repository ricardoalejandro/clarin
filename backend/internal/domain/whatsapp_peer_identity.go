package domain

import (
	"strings"
	"time"
)

// WhatsAppIdentityField records provider facts, never CRM identity or an inferred phone.
// A nil ObservedAt means that an undated history/cache snapshot supplied the value.
type WhatsAppIdentityField struct {
	Value      string     `json:"value"`
	Source     string     `json:"source"`
	ObservedAt *time.Time `json:"observed_at,omitempty"`
	ReceivedAt time.Time  `json:"received_at"`
}

type WhatsAppPeerObservation struct {
	JID        string
	PN         string
	LID        string
	Source     string
	ObservedAt *time.Time
	ReceivedAt time.Time
	Fields     map[string]string
}

type WhatsAppPeerIdentitySnapshot struct {
	Fields      map[string]map[string]WhatsAppIdentityField
	PNForLID    map[string]string
	LIDForPN    map[string]string
	AliasFields map[string]WhatsAppIdentityField
}

func WhatsAppIdentitySourcePriority(source string) int {
	switch source {
	case "alias_reassigned":
		return 200
	case "contact_action", "lid_contact_action":
		return 100
	case "business_name_event":
		return 90
	case "push_name_event", "message":
		return 80
	case "history_account_deleted":
		return 40
	case "history_account", "history_contact":
		return 30
	case "history_message", "stored_message":
		return 20
	case "history_push_name", "history_conversation":
		return 10
	case "provider_cache", "group_metadata":
		return 1
	default:
		return 0
	}
}

// Undated history may fill a missing field, but cannot replace a newer observation
// or revive an explicit empty field. Equal undated sources keep the first value.
func WhatsAppIdentityFieldNewer(next, previous WhatsAppIdentityField) bool {
	if next.ObservedAt != nil && previous.ObservedAt != nil {
		if !next.ObservedAt.Equal(*previous.ObservedAt) {
			return next.ObservedAt.After(*previous.ObservedAt)
		}
	} else if next.ObservedAt != nil {
		return true
	} else if previous.ObservedAt != nil {
		return false
	}
	return WhatsAppIdentitySourcePriority(next.Source) > WhatsAppIdentitySourcePriority(previous.Source)
}

func ValidWhatsAppIdentityField(field string) bool {
	switch field {
	case "full_name", "first_name", "business_name", "push_name", "username", "redacted_phone":
		return true
	default:
		return false
	}
}

func SanitizeWhatsAppIdentityValue(field, value string) (string, bool) {
	if !ValidWhatsAppIdentityField(field) {
		return "", false
	}
	value = strings.TrimSpace(value)
	if field == "username" {
		value = strings.TrimPrefix(value, "@")
	}
	if len([]rune(value)) > 256 {
		return "", false
	}
	for _, r := range value {
		if r < 32 || r == 127 {
			return "", false
		}
	}
	if field == "username" && strings.ContainsAny(value, "@ /\\\t\n\r") {
		return "", false
	}
	if field != "username" && field != "redacted_phone" && (value == "Integrante" || value == "Nombre no disponible" || value == "-") {
		return "", false
	}
	return value, true
}
