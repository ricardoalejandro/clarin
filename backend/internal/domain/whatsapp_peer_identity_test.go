package domain

import (
	"testing"
	"time"
)

func TestWhatsAppIdentityFieldMonotonicity(t *testing.T) {
	oldAt := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	newAt := oldAt.Add(time.Minute)
	live := WhatsAppIdentityField{Value: "Current", Source: "message", ObservedAt: &newAt}
	for _, stale := range []WhatsAppIdentityField{{Value: "Old", Source: "history_message", ObservedAt: &oldAt}, {Value: "Old", Source: "history_contact"}, {Value: "Old", Source: "provider_cache"}} {
		if WhatsAppIdentityFieldNewer(stale, live) {
			t.Fatalf("stale source replaced live identity: %+v", stale)
		}
	}
	deleted := WhatsAppIdentityField{Value: "", Source: "contact_action", ObservedAt: &newAt}
	if WhatsAppIdentityFieldNewer(WhatsAppIdentityField{Value: "oldhandle", Source: "history_account"}, deleted) {
		t.Fatal("history revived a removed username")
	}
	if !WhatsAppIdentityFieldNewer(deleted, WhatsAppIdentityField{Value: "oldhandle", Source: "history_account"}) {
		t.Fatal("explicit removal did not beat undated history")
	}
	if WhatsAppIdentityFieldNewer(WhatsAppIdentityField{Value: "Other", Source: "history_contact"}, WhatsAppIdentityField{Value: "First", Source: "history_contact"}) {
		t.Fatal("two undated batches invented freshness")
	}
}
func TestWhatsAppIdentityValueValidation(t *testing.T) {
	for _, value := range []string{"bad@domain", "fake user", "a/b", "a\\b", "name\nline"} {
		if _, ok := SanitizeWhatsAppIdentityValue("username", value); ok {
			t.Fatalf("unsafe username accepted %q", value)
		}
	}
	if got, ok := SanitizeWhatsAppIdentityValue("username", "@Handle.12"); !ok || got != "Handle.12" {
		t.Fatal("delivered username rejected")
	}
	for _, value := range []string{"Integrante", "Nombre no disponible", "-"} {
		if _, ok := SanitizeWhatsAppIdentityValue("push_name", value); ok {
			t.Fatal("placeholder persisted as identity")
		}
	}
}
