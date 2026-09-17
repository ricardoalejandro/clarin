package deviceidentity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"math/big"
	"strings"
)

const (
	ecdsaPublicP256Magic = 0x31534345 // BCRYPT_ECDSA_PUBLIC_P256_MAGIC ("ECS1")
	p256CoordinateBytes  = 32
)

type SoftwareIdentity struct {
	PublicKeyPEM    string
	PrivateKeyPKCS8 string
}

type ecdsaSignature struct {
	R *big.Int
	S *big.Int
}

// PublicPEMFromCNGBlob converts the Windows CNG EccPublicBlob format supported
// by Windows PowerShell 5.1 into the standard SPKI PEM accepted by Clarin.
func PublicPEMFromCNGBlob(encoded string) (string, error) {
	blob, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return "", errors.New("decode CNG public key")
	}
	if len(blob) != 8+2*p256CoordinateBytes {
		return "", errors.New("unexpected CNG public key size")
	}
	if binary.LittleEndian.Uint32(blob[:4]) != ecdsaPublicP256Magic || binary.LittleEndian.Uint32(blob[4:8]) != p256CoordinateBytes {
		return "", errors.New("unexpected CNG public key format")
	}
	publicKey := &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(blob[8 : 8+p256CoordinateBytes]),
		Y:     new(big.Int).SetBytes(blob[8+p256CoordinateBytes:]),
	}
	if !publicKey.Curve.IsOnCurve(publicKey.X, publicKey.Y) {
		return "", errors.New("invalid CNG public key point")
	}
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return "", errors.New("encode CNG public key")
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}

// GenerateSoftwareIdentity is the zero-configuration fallback for Windows
// profiles where the named CNG provider is unavailable. The caller persists
// PrivateKeyPKCS8 only inside the CurrentUser DPAPI store.
func GenerateSoftwareIdentity() (SoftwareIdentity, error) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return SoftwareIdentity{}, err
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return SoftwareIdentity{}, err
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		return SoftwareIdentity{}, err
	}
	return SoftwareIdentity{
		PublicKeyPEM:    string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})),
		PrivateKeyPKCS8: base64.StdEncoding.EncodeToString(privateDER),
	}, nil
}

func SignSoftware(privateKeyPKCS8 string, digest []byte) ([]byte, error) {
	encoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(privateKeyPKCS8))
	if err != nil {
		return nil, errors.New("decode DPAPI device key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(encoded)
	if err != nil {
		return nil, errors.New("parse DPAPI device key")
	}
	privateKey, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || privateKey.Curve != elliptic.P256() {
		return nil, errors.New("DPAPI device key must be ECDSA P-256")
	}
	return ecdsa.SignASN1(rand.Reader, privateKey, digest)
}

// NormalizeECDSASignature accepts both the fixed-width P1363 result returned
// by Windows PowerShell 5.1 and an ASN.1 result returned by newer runtimes.
func NormalizeECDSASignature(signature []byte) ([]byte, error) {
	if len(signature) == 2*p256CoordinateBytes {
		return asn1.Marshal(ecdsaSignature{
			R: new(big.Int).SetBytes(signature[:p256CoordinateBytes]),
			S: new(big.Int).SetBytes(signature[p256CoordinateBytes:]),
		})
	}
	var parsed ecdsaSignature
	rest, err := asn1.Unmarshal(signature, &parsed)
	if err != nil || len(rest) != 0 || parsed.R == nil || parsed.S == nil || parsed.R.Sign() <= 0 || parsed.S.Sign() <= 0 || parsed.R.BitLen() > 256 || parsed.S.BitLen() > 256 {
		return nil, errors.New("invalid ECDSA signature format")
	}
	return asn1.Marshal(parsed)
}
