package domain

import (
	"encoding/json"
	"github.com/google/uuid"
	"sort"
	"strings"
	"time"
)

const WhatsAppIdentityRecoveryVersion = 1

type WhatsAppIdentityRecoveryStatus struct {
	State             string    `json:"state"`
	Phase             string    `json:"phase"`
	Processed         int       `json:"processed"`
	Resolved          int       `json:"resolved"`
	Pending           int       `json:"pending"`
	Conflicts         int       `json:"conflicts"`
	UnresolvedMembers int       `json:"unresolved_members"`
	LastErrorCode     string    `json:"last_error_code,omitempty"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type WhatsAppIdentityRecoveryRun struct {
	ID                   uuid.UUID
	AccountID            uuid.UUID
	DeviceID             uuid.UUID
	SessionFingerprint   string
	SessionGeneration    int64
	Version              int
	Phase                string
	Attempts             int
	LeaseID              uuid.UUID
	AppStateAcknowledged bool
}

// This exact JSONB shape is also built by the database group trigger. Identity
// display names, timestamps and cache provenance never change membership revision.
func WhatsAppGroupIdentityVersionMaterial(group *ChatGroup, members []GroupParticipant) []byte {
	type member struct {
		JID   string `json:"jid"`
		LID   string `json:"lid"`
		Phone string `json:"phone"`
		Role  string `json:"role"`
	}
	value := struct {
		Members    []member `json:"members"`
		Announce   bool     `json:"announce"`
		Suspended  bool     `json:"suspended"`
		Kind       string   `json:"kind"`
		Membership string   `json:"membership"`
	}{Members: []member{}, Kind: "group", Membership: "unknown"}
	if group != nil {
		value.Announce = group.Announce
		value.Suspended = group.Suspended
		value.Kind = group.Kind
		value.Membership = group.MembershipStatus
		if value.Kind == "" {
			value.Kind = "group"
		}
		if value.Membership == "" {
			value.Membership = "unknown"
		}
	}
	for _, m := range members {
		lid := m.LID
		if lid == "" && strings.HasSuffix(m.JID, "@lid") {
			lid = m.JID
		}
		phone := m.Phone
		if phone == "" && strings.HasSuffix(m.JID, "@s.whatsapp.net") {
			phone = strings.TrimSuffix(m.JID, "@s.whatsapp.net")
		}
		jid := m.JID
		if lid != "" {
			jid = lid
		}
		role := m.Role
		if role == "" {
			role = "member"
		}
		value.Members = append(value.Members, member{jid, lid, phone, role})
	}
	sort.Slice(value.Members, func(i, j int) bool { return value.Members[i].JID < value.Members[j].JID })
	raw, _ := json.Marshal(value)
	return raw
}

func WhatsAppIdentityRecoveryRetryDelay(attempt int) time.Duration {
	switch attempt {
	case 0, 1:
		return 30 * time.Second
	case 2:
		return 2 * time.Minute
	default:
		return 10 * time.Minute
	}
}
