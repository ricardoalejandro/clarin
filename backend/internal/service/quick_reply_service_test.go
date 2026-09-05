package service

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestNormalizeQuickReplyShortcut(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "trims slash and lowercases", raw: " /SaLuDo_1 ", want: "saludo_1"},
		{name: "keeps unicode letters", raw: "/Información", want: "información"},
		{name: "allows hyphen", raw: "seguimiento-2", want: "seguimiento-2"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := NormalizeQuickReplyShortcut(test.raw)
			if err != nil {
				t.Fatalf("NormalizeQuickReplyShortcut() error = %v", err)
			}
			if got != test.want {
				t.Fatalf("NormalizeQuickReplyShortcut() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestNormalizeQuickReplyShortcutRejectsInvalidValues(t *testing.T) {
	for _, raw := range []string{"", "/", "dos palabras", "hola!", strings.Repeat("a", 101)} {
		if _, err := NormalizeQuickReplyShortcut(raw); !errors.Is(err, ErrQuickReplyValidation) {
			t.Fatalf("NormalizeQuickReplyShortcut(%q) error = %v, want ErrQuickReplyValidation", raw, err)
		}
	}
}

func TestPrepareQuickReplyCanonicalizesDraft(t *testing.T) {
	assetID := uuid.New()
	quickReply := &domain.QuickReply{
		Shortcut: " /SALUDO ",
		Title:    "  Saludo inicial  ",
		Body:     "  Hola  ",
		Attachments: []domain.QuickReplyAttachment{{
			MediaAssetID: &assetID,
			Caption:      "  Portada  ",
			Position:     4,
		}},
	}
	if err := prepareQuickReply(quickReply); err != nil {
		t.Fatalf("prepareQuickReply() error = %v", err)
	}
	if quickReply.Shortcut != "saludo" || quickReply.Title != "Saludo inicial" || quickReply.Body != "Hola" {
		t.Fatalf("prepareQuickReply() did not canonicalize text: %#v", quickReply)
	}
	if quickReply.Attachments[0].Caption != "Portada" || quickReply.Attachments[0].Position != 0 {
		t.Fatalf("prepareQuickReply() did not canonicalize attachment: %#v", quickReply.Attachments[0])
	}
}

func TestPrepareQuickReplyPreservesTrustedLegacyAttachmentReference(t *testing.T) {
	quickReply := &domain.QuickReply{
		Shortcut: "legacy",
		Attachments: []domain.QuickReplyAttachment{{
			ID: uuid.New(),
		}},
	}
	if err := prepareQuickReply(quickReply); err != nil {
		t.Fatalf("prepareQuickReply() error = %v", err)
	}
}

func TestPrepareQuickReplyRejectsUninventoriedNewAttachment(t *testing.T) {
	quickReply := &domain.QuickReply{
		Shortcut:    "archivo",
		Attachments: []domain.QuickReplyAttachment{{}},
	}
	if err := prepareQuickReply(quickReply); !errors.Is(err, ErrQuickReplyValidation) {
		t.Fatalf("prepareQuickReply() error = %v, want ErrQuickReplyValidation", err)
	}
}
