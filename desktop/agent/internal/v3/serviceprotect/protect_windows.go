//go:build windows

package serviceprotect

import (
	"errors"
	"syscall"
	"unsafe"
)

const cryptprotectUIForbidden = 0x1

var (
	crypt32                = syscall.NewLazyDLL("crypt32.dll")
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCryptProtectData   = crypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
	procLocalFree          = kernel32.NewProc("LocalFree")
)

type dataBlob struct {
	size uint32
	data *byte
}

type windowsProtector struct{}

func NewWindowsProtector() (Protector, error) { return windowsProtector{}, nil }

func (windowsProtector) Protect(plain []byte, purpose string) ([]byte, error) {
	context, err := entropy(purpose)
	if err != nil {
		return nil, err
	}
	return cryptData(procCryptProtectData, plain, context)
}

func (windowsProtector) Unprotect(ciphertext []byte, purpose string) ([]byte, error) {
	context, err := entropy(purpose)
	if err != nil {
		return nil, err
	}
	return cryptData(procCryptUnprotectData, ciphertext, context)
}

func cryptData(proc *syscall.LazyProc, input, context []byte) ([]byte, error) {
	if len(input) == 0 {
		return nil, errors.New("DPAPI input is empty")
	}
	inBlob := blob(input)
	entropyBlob := blob(context)
	var outBlob dataBlob
	ok, _, callErr := proc.Call(
		uintptr(unsafe.Pointer(&inBlob)),
		0,
		uintptr(unsafe.Pointer(&entropyBlob)),
		0,
		0,
		cryptprotectUIForbidden,
		uintptr(unsafe.Pointer(&outBlob)),
	)
	if ok == 0 {
		return nil, callErr
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(outBlob.data)))
	return append([]byte(nil), unsafe.Slice(outBlob.data, outBlob.size)...), nil
}

func blob(value []byte) dataBlob {
	if len(value) == 0 {
		return dataBlob{}
	}
	return dataBlob{size: uint32(len(value)), data: &value[0]}
}
