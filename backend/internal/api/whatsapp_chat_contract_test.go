package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestApplyDeviceRuntimePolicyAdvertisesReactionOnlyForConnectedWeb(t *testing.T) {
	t.Parallel()

	connected := domain.DeviceStatusConnected
	disconnected := domain.DeviceStatusDisconnected
	web := domain.DeviceProviderWhatsAppWeb
	cloud := domain.DeviceProviderWhatsAppCloudAPI
	server := &Server{}

	tests := []struct {
		name   string
		device *domain.Device
		want   bool
	}{
		{name: "connected web", device: &domain.Device{Status: &connected, Provider: &web}, want: true},
		{name: "disconnected web", device: &domain.Device{Status: &disconnected, Provider: &web}, want: false},
		{name: "connected cloud", device: &domain.Device{Status: &connected, Provider: &cloud}, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			server.applyDeviceRuntimePolicy(tt.device)
			if got := tt.device.RuntimeCapabilities.CanSendReaction; got != tt.want {
				t.Fatalf("CanSendReaction = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestDeviceRuntimeCapabilitiesSerializesReactionCapability(t *testing.T) {
	t.Parallel()

	encoded, err := json.Marshal(domain.DeviceRuntimeCapabilities{CanSendReaction: true})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if string(encoded) != `{"can_start_chat":false,"can_check_whatsapp":false,"can_send_reaction":true,"can_send_sticker":false,"can_send_animated_sticker":false,"can_publish_status":false,"can_publish_status_link":false,"can_sync_own_status":false}` {
		t.Fatalf("runtime capabilities JSON = %s", encoded)
	}
}

func TestResolveContactLinkIssue(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	contactID := uuid.New()
	otherContactID := uuid.New()

	tests := []struct {
		name    string
		contact *domain.Contact
		chat    *domain.Chat
		want    string
	}{
		{name: "missing contact", want: "contact_not_found"},
		{name: "other account", contact: &domain.Contact{ID: contactID, AccountID: uuid.New()}, want: "contact_not_found"},
		{name: "group", contact: &domain.Contact{ID: contactID, AccountID: accountID, IsGroup: true}, want: "contact_not_found"},
		{name: "unlinked chat", contact: &domain.Contact{ID: contactID, AccountID: accountID}, chat: &domain.Chat{AccountID: accountID}},
		{name: "same contact", contact: &domain.Contact{ID: contactID, AccountID: accountID}, chat: &domain.Chat{AccountID: accountID, ContactID: &contactID}},
		{name: "different contact", contact: &domain.Contact{ID: contactID, AccountID: accountID}, chat: &domain.Chat{AccountID: accountID, ContactID: &otherContactID}, want: "chat_contact_conflict"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := resolveContactLinkIssue(tt.contact, tt.chat, accountID); got != tt.want {
				t.Fatalf("resolveContactLinkIssue() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestWhatsAppChatResolutionMode(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		name        string
		hasChat     bool
		deviceCount int
		want        string
	}{
		{name: "new without device", want: "no_device"},
		{name: "history without device", hasChat: true, want: "read_only"},
		{name: "one device", deviceCount: 1, want: "open_direct"},
		{name: "one device with history", hasChat: true, deviceCount: 1, want: "open_direct"},
		{name: "multiple devices", deviceCount: 2, want: "choose_device"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := whatsAppChatResolutionMode(tt.hasChat, tt.deviceCount); got != tt.want {
				t.Fatalf("whatsAppChatResolutionMode(%t, %d) = %q, want %q", tt.hasChat, tt.deviceCount, got, tt.want)
			}
		})
	}
}

func TestClassifyWhatsAppChatCreationError(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "context disappeared", err: pgx.ErrNoRows, wantStatus: fiber.StatusNotFound, wantCode: "chat_context_not_found"},
		{name: "chat linked concurrently", err: fmt.Errorf("wrapped: %w", repository.ErrChatContactConflict), wantStatus: fiber.StatusConflict, wantCode: "chat_contact_conflict"},
		{name: "identity changed concurrently", err: repository.ErrContactIdentityConflict, wantStatus: fiber.StatusConflict, wantCode: "contact_identity_conflict"},
		{name: "internal failure", err: errors.New("database unavailable"), wantStatus: fiber.StatusInternalServerError, wantCode: "chat_creation_failed"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			status, code, message := classifyWhatsAppChatCreationError(tt.err)
			if status != tt.wantStatus || code != tt.wantCode || strings.TrimSpace(message) == "" {
				t.Fatalf("classifyWhatsAppChatCreationError() = (%d, %q, %q), want (%d, %q, non-empty)", status, code, message, tt.wantStatus, tt.wantCode)
			}
		})
	}
}

func TestNormalizeReactionOperationID(t *testing.T) {
	t.Parallel()

	if got, ok := normalizeReactionOperationID("  operation-123  "); !ok || got != "operation-123" {
		t.Fatalf("normalizeReactionOperationID() = %q, %t", got, ok)
	}
	generated, ok := normalizeReactionOperationID("")
	if !ok {
		t.Fatal("empty legacy operation ID must remain compatible")
	}
	if _, err := uuid.Parse(generated); err != nil {
		t.Fatalf("generated operation ID = %q, want UUID: %v", generated, err)
	}
	if _, ok := normalizeReactionOperationID(strings.Repeat("x", 129)); ok {
		t.Fatal("oversized operation ID was accepted")
	}
}

func TestReactionMutationResponseCarriesCanonicalFields(t *testing.T) {
	t.Parallel()

	timestamp := time.Date(2026, time.August, 13, 15, 0, 0, 0, time.UTC)
	reaction := &domain.MessageReaction{Emoji: "👍", Timestamp: timestamp}
	mutation := &domain.MessageReactionMutation{
		Reaction: reaction, Removed: false, Timestamp: timestamp,
		Provider: domain.DeviceProviderWhatsAppWeb, OperationID: "operation-123",
	}
	payload := reactionMutationResponse(mutation, "applied")

	if payload["success"] != true || payload["state"] != "applied" || payload["reaction"] != reaction {
		t.Fatalf("reaction response core fields = %#v", payload)
	}
	if payload["timestamp"] != timestamp || payload["provider"] != domain.DeviceProviderWhatsAppWeb || payload["operation_id"] != "operation-123" {
		t.Fatalf("reaction response reconciliation fields = %#v", payload)
	}
}

func TestReactionDeviceIssue(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	connected := domain.DeviceStatusConnected
	disconnected := domain.DeviceStatusDisconnected
	web := domain.DeviceProviderWhatsAppWeb
	cloud := domain.DeviceProviderWhatsAppCloudAPI
	capable := &domain.DeviceRuntimeCapabilities{CanSendReaction: true}
	unsupported := &domain.DeviceRuntimeCapabilities{}

	for _, tt := range []struct {
		name   string
		device *domain.Device
		want   string
	}{
		{name: "missing", want: "device_not_found"},
		{name: "other account", device: &domain.Device{AccountID: uuid.New()}, want: "device_not_found"},
		{name: "disconnected", device: &domain.Device{AccountID: accountID, Status: &disconnected, Provider: &web, RuntimeCapabilities: capable}, want: "device_disconnected"},
		{name: "cloud", device: &domain.Device{AccountID: accountID, Status: &connected, Provider: &cloud, RuntimeCapabilities: capable}, want: "reaction_provider_unsupported"},
		{name: "capability off", device: &domain.Device{AccountID: accountID, Status: &connected, Provider: &web, RuntimeCapabilities: unsupported}, want: "reaction_unsupported"},
		{name: "connected web", device: &domain.Device{AccountID: accountID, Status: &connected, Provider: &web, RuntimeCapabilities: capable}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := reactionDeviceIssue(tt.device, accountID); got != tt.want {
				t.Fatalf("reactionDeviceIssue() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestReactionTargetIssue(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	chatID := uuid.New()
	deviceID := uuid.New()
	otherDeviceID := uuid.New()
	messageTypeText := domain.MessageTypeText
	messageTypeReaction := domain.MessageTypeReaction
	valid := func() *domain.Message {
		return &domain.Message{AccountID: accountID, ChatID: chatID, DeviceID: &deviceID, MessageID: "wamid.target", MessageType: &messageTypeText}
	}

	otherAccount := valid()
	otherAccount.AccountID = uuid.New()
	otherChat := valid()
	otherChat.ChatID = uuid.New()
	otherDevice := valid()
	otherDevice.DeviceID = &otherDeviceID
	revoked := valid()
	revoked.IsRevoked = true
	reactionRecord := valid()
	reactionRecord.MessageType = &messageTypeReaction
	unpersisted := valid()
	unpersisted.MessageID = ""

	for _, tt := range []struct {
		name    string
		message *domain.Message
		want    string
	}{
		{name: "missing", want: "message_not_found"},
		{name: "other account", message: otherAccount, want: "message_not_found"},
		{name: "other chat", message: otherChat, want: "message_not_found"},
		{name: "other device", message: otherDevice, want: "reaction_target_device_mismatch"},
		{name: "revoked", message: revoked, want: "reaction_target_revoked"},
		{name: "reaction record", message: reactionRecord, want: "reaction_target_type"},
		{name: "unpersisted", message: unpersisted, want: "reaction_target_unpersisted"},
		{name: "valid", message: valid()},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := reactionTargetIssue(tt.message, accountID, chatID, deviceID); got != tt.want {
				t.Fatalf("reactionTargetIssue() = %q, want %q", got, tt.want)
			}
		})
	}
}
