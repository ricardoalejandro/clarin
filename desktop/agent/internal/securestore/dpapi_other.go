//go:build !windows

package securestore

import "errors"

func platformProtector() (Protector, error) {
	return nil, errors.New("DPAPI secure storage is available only on Windows")
}
