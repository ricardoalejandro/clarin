package domain

import (
	"context"
	"github.com/google/uuid"
	"strings"
	"time"
)

func IsGroupJID(jid string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(jid)), "@g.us")
}

type ChatGroup struct {
	Subject            string     `json:"subject"`
	Description        string     `json:"description"`
	AvatarURL          *string    `json:"avatar_url,omitempty"`
	ParticipantCount   int        `json:"participant_count"`
	MembershipStatus   string     `json:"membership_status"`
	Announce           bool       `json:"announce"`
	IsAdmin            bool       `json:"is_admin"`
	Suspended          bool       `json:"suspended"`
	Kind               string     `json:"kind"`
	CanSend            bool       `json:"can_send"`
	SendDisabledReason string     `json:"send_disabled_reason,omitempty"`
	SyncedAt           *time.Time `json:"synced_at,omitempty"`
}

type GroupParticipant struct {
	JID           string `json:"jid"`
	LID           string `json:"lid,omitempty"`
	Phone         string `json:"phone,omitempty"`
	Name          string `json:"name"`
	Role          string `json:"role"`
	IsSelf        bool   `json:"is_self"`
	RedactedPhone string `json:"redacted_phone,omitempty"`
	NameSource    string `json:"name_source,omitempty"`
	AvatarURL     string `json:"avatar_url,omitempty"`
	AvatarSource  string `json:"avatar_source,omitempty"`
	WhatsAppName  string `json:"whatsapp_name,omitempty"`
}

type GroupParticipantContactContext struct {
	ContactID uuid.UUID  `json:"contact_id"`
	Context   string     `json:"context"`
	ChatID    *uuid.UUID `json:"chat_id,omitempty"`
}

type GroupParticipantCapabilities struct {
	CanMessage            bool   `json:"can_message"`
	MessageDisabledReason string `json:"message_disabled_reason,omitempty"`
	CanQueryAvatar        bool   `json:"can_query_avatar"`
	CanQueryAbout         bool   `json:"can_query_about"`
	CanListCommonGroups   bool   `json:"can_list_common_groups"`
}

type GroupParticipantProfile struct {
	Participant         GroupParticipant                `json:"participant"`
	DeviceID            uuid.UUID                       `json:"device_id"`
	IdentityFingerprint string                          `json:"identity_fingerprint"`
	ContactContext      *GroupParticipantContactContext `json:"contact_context,omitempty"`
	Capabilities        GroupParticipantCapabilities    `json:"capabilities"`
}

type GroupCommonGroup struct {
	ChatID           uuid.UUID  `json:"chat_id"`
	Subject          string     `json:"subject"`
	ParticipantCount int        `json:"participant_count"`
	SyncedAt         *time.Time `json:"synced_at,omitempty"`
}

type MessageMention struct {
	JID  string `json:"jid"`
	Name string `json:"name,omitempty"`
}
type GroupReceipt struct {
	JID         string     `json:"jid"`
	Name        string     `json:"name,omitempty"`
	DeliveredAt *time.Time `json:"delivered_at,omitempty"`
	ReadAt      *time.Time `json:"read_at,omitempty"`
}

type mentionsContextKey struct{}

func WithMessageMentions(ctx context.Context, mentions []MessageMention) context.Context {
	if mutable, ok := ctx.(interface{ SetUserValue(any, any) }); ok {
		mutable.SetUserValue(mentionsContextKey{}, mentions)
		return ctx
	}
	return context.WithValue(ctx, mentionsContextKey{}, mentions)
}
func MessageMentionsFrom(ctx context.Context) []MessageMention {
	value, _ := ctx.Value(mentionsContextKey{}).([]MessageMention)
	return value
}

func (g *ChatGroup) ResolveSendCapability(connected bool) {
	g.CanSend = false
	g.SendDisabledReason = ""
	switch {
	case !connected:
		g.SendDisabledReason = "El dispositivo no está conectado"
	case g.MembershipStatus != "member":
		g.SendDisabledReason = "El dispositivo ya no pertenece al grupo o no se ha verificado su membresía"
	case g.Suspended:
		g.SendDisabledReason = "WhatsApp ha suspendido este grupo"
	case g.Kind == "community":
		g.SendDisabledReason = "Esta comunidad es un contenedor; abre uno de sus grupos"
	case g.Announce && !g.IsAdmin:
		g.SendDisabledReason = "Solo los administradores pueden enviar mensajes"
	default:
		g.CanSend = true
	}
}
