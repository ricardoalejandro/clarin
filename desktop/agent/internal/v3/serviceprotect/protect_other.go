//go:build !windows

package serviceprotect

func NewWindowsProtector() (Protector, error) { return nil, ErrUnavailable }
