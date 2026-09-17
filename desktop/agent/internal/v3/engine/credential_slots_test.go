package engine

import (
	"errors"
	"testing"
)

func TestCredentialWorkIsBoundedAndNonBlocking(t *testing.T) {
	service := &Engine{credentialSlots: make(chan struct{}, 2)}
	first, err := service.credentialSlot()
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.credentialSlot()
	if err != nil {
		first()
		t.Fatal(err)
	}
	if _, err := service.credentialSlot(); !errors.Is(err, ErrCredentialBusy) {
		second()
		first()
		t.Fatalf("third concurrent Argon2 job was not rejected: %v", err)
	}
	first()
	third, err := service.credentialSlot()
	if err != nil {
		second()
		t.Fatalf("released Argon2 slot did not become reusable: %v", err)
	}
	third()
	second()
}
