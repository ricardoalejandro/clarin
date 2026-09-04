package service

import (
	"errors"
	"unicode"
	"unicode/utf8"
)

var ErrPasswordPolicy = errors.New("password does not satisfy the security policy")

type PasswordPolicyError struct {
	Message string
}

func (e *PasswordPolicyError) Error() string {
	return e.Message
}

func (e *PasswordPolicyError) Unwrap() error {
	return ErrPasswordPolicy
}

func ValidateStrongPassword(password string) error {
	if !utf8.ValidString(password) {
		return &PasswordPolicyError{Message: "La contraseña contiene texto no válido."}
	}
	if utf8.RuneCountInString(password) < 10 {
		return &PasswordPolicyError{Message: "La contraseña debe tener al menos 10 caracteres."}
	}
	// bcrypt only consumes credentials up to 72 bytes. Rejecting longer input
	// avoids two visually different passwords authenticating as the same value.
	if len(password) > 72 {
		return &PasswordPolicyError{Message: "La contraseña no puede superar 72 bytes en UTF-8."}
	}
	var hasUpper, hasLower, hasDigit, hasSymbol bool
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			hasUpper = true
		case unicode.IsLower(r):
			hasLower = true
		case unicode.IsDigit(r):
			hasDigit = true
		case unicode.IsPunct(r) || unicode.IsSymbol(r):
			hasSymbol = true
		}
	}
	if !hasUpper || !hasLower || !hasDigit || !hasSymbol {
		return &PasswordPolicyError{Message: "Usa una contraseña con mayúscula, minúscula, número y símbolo."}
	}
	return nil
}
