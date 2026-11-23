package repository

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func placeholderTestPointer[T any](v T) *T { return &v }

func placeholderTestCandidate() *domain.Message {
	return &domain.Message{AccountID: uuid.New(), ChatID: uuid.New(), DeviceID: placeholderTestPointer(uuid.New()),
		MessageID: "provider-id", FromJID: placeholderTestPointer("51999000111@s.whatsapp.net"),
		MessageType: placeholderTestPointer("text"), Body: placeholderTestPointer("actual provider text")}
}

func TestGroupPlaceholderCandidate(t *testing.T) {
	tests := []struct {
		name   string
		change func(*domain.Message)
		want   bool
	}{
		{"text", func(*domain.Message) {}, true},
		{"literal whitespace text", func(m *domain.Message) { m.Body = placeholderTestPointer(" ") }, true},
		{"empty transport", func(m *domain.Message) { m.Body = placeholderTestPointer("") }, false},
		{"missing body", func(m *domain.Message) { m.Body = nil }, false},
		{"revoked candidate", func(m *domain.Message) { m.IsRevoked = true }, false},
		{"edited candidate", func(m *domain.Message) { m.IsEdited = true }, false},
		{"view once", func(m *domain.Message) { m.IsViewOnce = true }, false},
		{"deleted media", func(m *domain.Message) { m.MediaDeleted = true }, false},
		{"missing account", func(m *domain.Message) { m.AccountID = uuid.Nil }, false},
		{"missing chat", func(m *domain.Message) { m.ChatID = uuid.Nil }, false},
		{"missing device", func(m *domain.Message) { m.DeviceID = nil }, false},
		{"missing provider ID", func(m *domain.Message) { m.MessageID = "" }, false},
		{"missing author", func(m *domain.Message) { m.FromJID = nil }, false},
		{"group is not author", func(m *domain.Message) { m.FromJID = placeholderTestPointer("120001@g.us") }, false},
		{"cloud provider", func(m *domain.Message) { m.Provider = placeholderTestPointer("whatsapp_cloud") }, false},
		{"reaction", func(m *domain.Message) { m.MessageType = placeholderTestPointer("reaction") }, false},
		{"uncaptioned provider media", func(m *domain.Message) { m.MessageType = placeholderTestPointer("image"); m.Body = nil }, true},
		{"unavailable provider document", func(m *domain.Message) {
			m.MessageType = placeholderTestPointer("document")
			m.Body = nil
			m.MediaUnavailableReason = "group_media_too_large"
		}, true},
		{"location", func(m *domain.Message) {
			m.MessageType = placeholderTestPointer("location")
			m.Latitude = placeholderTestPointer(0.0)
			m.Longitude = placeholderTestPointer(0.0)
		}, true},
		{"incomplete location", func(m *domain.Message) {
			m.MessageType = placeholderTestPointer("location")
			m.Latitude = placeholderTestPointer(0.0)
		}, false},
		{"contact", func(m *domain.Message) {
			m.MessageType = placeholderTestPointer("contact")
			m.ContactVCard = placeholderTestPointer("BEGIN:VCARD")
		}, true},
		{"empty contact", func(m *domain.Message) { m.MessageType = placeholderTestPointer("contact") }, false},
		{"poll", func(m *domain.Message) {
			m.MessageType = placeholderTestPointer("poll")
			m.PollQuestion = placeholderTestPointer("Question?")
		}, true},
		{"empty poll", func(m *domain.Message) { m.MessageType = placeholderTestPointer("poll") }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := placeholderTestCandidate()
			tt.change(m)
			_, got := groupPlaceholderCandidate(m)
			if got != tt.want {
				t.Fatalf("eligible = %v, want %v", got, tt.want)
			}
			if !tt.want {
				if repaired, err := repairGroupPlaceholderTx(context.Background(), nil, m); err != nil || repaired {
					t.Fatalf("ineligible candidate reached transaction: repaired=%v err=%v", repaired, err)
				}
			}
		})
	}
	if _, ok := groupPlaceholderCandidate(nil); ok {
		t.Fatal("nil candidate accepted")
	}
	for _, author := range []string{"51999000111:8@s.whatsapp.net", "7001:2@lid"} {
		m := placeholderTestCandidate()
		m.FromJID = &author
		got, ok := groupPlaceholderCandidate(m)
		if !ok || (got != "51999000111@s.whatsapp.net" && got != "7001@lid") {
			t.Fatalf("author was not normalized: %q", got)
		}
	}
}
