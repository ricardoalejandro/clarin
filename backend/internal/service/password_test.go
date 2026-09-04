package service

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateStrongPasswordUsesUnicodeCodePointsAndCategories(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		password string
		valid    bool
	}{
		{name: "unicode upper and lower", password: "Ábcdefgh1!", valid: true},
		{name: "unicode digit", password: "Abcdefgh١!", valid: true},
		{name: "unicode other number is not a decimal digit", password: "Abcdefghi²!", valid: false},
		{name: "unicode symbol", password: "Abcdefgh1€", valid: true},
		{name: "space is not a symbol", password: "Abcdefgh1 ", valid: false},
		{name: "accented letter is not a symbol", password: "Abcdefgh1é", valid: false},
		{name: "nine code points", password: "Abcdefg1!", valid: false},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := ValidateStrongPassword(test.password)
			if test.valid && err != nil {
				t.Fatalf("ValidateStrongPassword() error = %v", err)
			}
			if !test.valid && !errors.Is(err, ErrPasswordPolicy) {
				t.Fatalf("ValidateStrongPassword() error = %v, want ErrPasswordPolicy", err)
			}
		})
	}
}

func TestValidateStrongPasswordRejectsBcryptOverflow(t *testing.T) {
	t.Parallel()
	password := "Aa1!" + strings.Repeat("x", 69)
	if len(password) != 73 {
		t.Fatalf("test password has %d bytes, want 73", len(password))
	}
	err := ValidateStrongPassword(password)
	if !errors.Is(err, ErrPasswordPolicy) || !strings.Contains(err.Error(), "72 bytes") {
		t.Fatalf("ValidateStrongPassword() error = %v, want 72-byte policy error", err)
	}
}

func TestValidateStrongPasswordCountsMultibyteCharactersAsOne(t *testing.T) {
	t.Parallel()
	// Nine code points but more than ten bytes must still fail the minimum.
	err := ValidateStrongPassword("Ábcdef1!€")
	if !errors.Is(err, ErrPasswordPolicy) || !strings.Contains(err.Error(), "10 caracteres") {
		t.Fatalf("ValidateStrongPassword() error = %v, want code-point minimum error", err)
	}
}
