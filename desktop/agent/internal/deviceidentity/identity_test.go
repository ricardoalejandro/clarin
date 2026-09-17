package deviceidentity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"testing"
)

func TestPublicPEMFromCNGBlob(t *testing.T) {
	x, y := elliptic.P256().ScalarBaseMult([]byte{1})
	blob := make([]byte, 8+2*p256CoordinateBytes)
	binary.LittleEndian.PutUint32(blob[:4], ecdsaPublicP256Magic)
	binary.LittleEndian.PutUint32(blob[4:8], p256CoordinateBytes)
	x.FillBytes(blob[8 : 8+p256CoordinateBytes])
	y.FillBytes(blob[8+p256CoordinateBytes:])

	encoded, err := PublicPEMFromCNGBlob(base64.StdEncoding.EncodeToString(blob))
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(encoded))
	if block == nil {
		t.Fatal("expected public PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, ok := parsed.(*ecdsa.PublicKey)
	if !ok || publicKey.X.Cmp(x) != 0 || publicKey.Y.Cmp(y) != 0 {
		t.Fatal("CNG coordinates changed during conversion")
	}
}

func TestPublicPEMFromCNGBlobRejectsInvalidData(t *testing.T) {
	for _, encoded := range []string{"not-base64", base64.StdEncoding.EncodeToString(make([]byte, 72)), base64.StdEncoding.EncodeToString(make([]byte, 8))} {
		if _, err := PublicPEMFromCNGBlob(encoded); err == nil {
			t.Fatalf("expected invalid blob %q to fail", encoded)
		}
	}
}

func TestNormalizeECDSASignatureAcceptsP1363AndASN1(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("clarin-offline"))
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	p1363 := make([]byte, 64)
	r.FillBytes(p1363[:32])
	s.FillBytes(p1363[32:])
	der, err := NormalizeECDSASignature(p1363)
	if err != nil || !ecdsa.VerifyASN1(&privateKey.PublicKey, digest[:], der) {
		t.Fatalf("P1363 conversion failed: %v", err)
	}
	canonical, err := NormalizeECDSASignature(der)
	if err != nil || !ecdsa.VerifyASN1(&privateKey.PublicKey, digest[:], canonical) {
		t.Fatalf("ASN.1 normalization failed: %v", err)
	}
	if _, err := NormalizeECDSASignature([]byte("invalid")); err == nil {
		t.Fatal("expected malformed signature to fail")
	}
}

func TestSoftwareIdentitySignsWithDPAPICompatibleMaterial(t *testing.T) {
	identity, err := GenerateSoftwareIdentity()
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(identity.PublicKeyPEM))
	if block == nil {
		t.Fatal("expected public PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := parsed.(*ecdsa.PublicKey)
	digest := sha256.Sum256([]byte("fallback"))
	signature, err := SignSoftware(identity.PrivateKeyPKCS8, digest[:])
	if err != nil || !ecdsa.VerifyASN1(publicKey, digest[:], signature) {
		t.Fatalf("software signature failed: %v", err)
	}
	if _, err := SignSoftware("invalid", digest[:]); err == nil {
		t.Fatal("expected invalid private key to fail")
	}
}
