package serviceprotect

import "errors"

var ErrUnavailable = errors.New("Windows service protection is unavailable")

// Protector is deliberately small so persistence tests can exercise catalog
// transactions without making DPAPI a cross-platform dependency. Production
// construction on Windows always uses NewWindowsProtector.
type Protector interface {
	Protect(plain []byte, purpose string) ([]byte, error)
	Unprotect(ciphertext []byte, purpose string) ([]byte, error)
}

func entropy(purpose string) ([]byte, error) {
	if purpose == "" || len(purpose) > 512 {
		return nil, errors.New("service protection purpose rejected")
	}
	return []byte("clarin-offline-v3-service:" + purpose), nil
}
