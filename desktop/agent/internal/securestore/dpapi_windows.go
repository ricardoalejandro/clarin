//go:build windows

package securestore

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

type dpapiProtector struct{}

func platformProtector() (Protector, error) { return dpapiProtector{}, nil }

func (dpapiProtector) Protect(plain, entropy []byte) ([]byte, error) {
	return cryptData(procCryptProtectData, plain, entropy)
}

func (dpapiProtector) Unprotect(ciphertext, entropy []byte) ([]byte, error) {
	return cryptData(procCryptUnprotectData, ciphertext, entropy)
}

func cryptData(proc *syscall.LazyProc, input, entropy []byte) ([]byte, error) {
	if len(input) == 0 {
		return nil, errors.New("DPAPI input is empty")
	}
	inBlob := blob(input)
	entropyBlob := blob(entropy)
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
