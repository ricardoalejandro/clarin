package cryptokit

import (
	"bytes"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	jose "github.com/go-jose/go-jose/v4"
	"golang.org/x/crypto/argon2"

	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

const (
	JWEAlgorithm        = jose.ECDH_ES_A256KW
	JWEEncryption       = jose.A256GCM
	JWSAlgorithm        = jose.ES256
	PasswordMemoryKiB   = uint32(64 * 1024)
	PasswordIterations  = uint32(3)
	PasswordParallelism = uint8(1)
	keyBytes            = 32
	maxSecretPayload    = 64 << 10
	maxRecordPayload    = 32 << 20
)

type GrantSecrets struct {
	DEK           []byte
	SigningKey    *ecdsa.PrivateKey
	EncryptionKey *ecdsa.PrivateKey
}

func (s *GrantSecrets) Destroy() {
	if s == nil {
		return
	}
	zero(s.DEK)
	if s.SigningKey != nil {
		s.SigningKey.D.SetInt64(0)
		s.SigningKey = nil
	}
	if s.EncryptionKey != nil {
		s.EncryptionKey.D.SetInt64(0)
		s.EncryptionKey = nil
	}
}

type encodedGrantSecrets struct {
	Version            int    `json:"version"`
	TupleBinding       string `json:"tuple_binding"`
	LoginBindingSHA256 string `json:"login_binding_sha256"`
	DEK                string `json:"dek"`
	SigningPKCS8       string `json:"signing_pkcs8"`
	EncryptionPKCS8    string `json:"encryption_pkcs8"`
}

type WrappedGrantSecrets struct {
	Version     int    `json:"version"`
	KDF         string `json:"kdf"`
	MemoryKiB   uint32 `json:"memory_kib"`
	Iterations  uint32 `json:"iterations"`
	Parallelism uint8  `json:"parallelism"`
	Salt        string `json:"salt"`
	Nonce       string `json:"nonce"`
	Ciphertext  string `json:"ciphertext"`
}

type SealedRecord struct {
	Version    int    `json:"version"`
	Algorithm  string `json:"algorithm"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

func GenerateGrantSecrets() (*GrantSecrets, error) {
	dek := make([]byte, keyBytes)
	if _, err := io.ReadFull(rand.Reader, dek); err != nil {
		return nil, err
	}
	signingKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		zero(dek)
		return nil, err
	}
	encryptionKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		zero(dek)
		return nil, err
	}
	return &GrantSecrets{DEK: dek, SigningKey: signingKey, EncryptionKey: encryptionKey}, nil
}

func PublicJWK(key *ecdsa.PublicKey, keyID, use, algorithm string) (jose.JSONWebKey, error) {
	if key == nil || key.Curve != elliptic.P256() || strings.TrimSpace(keyID) == "" {
		return jose.JSONWebKey{}, errors.New("P-256 public key and key id are required")
	}
	jwk := jose.JSONWebKey{Key: key, KeyID: keyID, Use: use, Algorithm: algorithm}
	if !jwk.Valid() || !jwk.IsPublic() {
		return jose.JSONWebKey{}, errors.New("invalid public JWK")
	}
	return jwk, nil
}

func ParsePublicJWK(raw json.RawMessage, expectedUse string) (jose.JSONWebKey, error) {
	if len(raw) == 0 || len(raw) > 16<<10 {
		return jose.JSONWebKey{}, errors.New("public JWK is missing or excessive")
	}
	var jwk jose.JSONWebKey
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&jwk); err != nil {
		return jose.JSONWebKey{}, errors.New("invalid public JWK")
	}
	key, ok := jwk.Key.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() || !jwk.Valid() || !jwk.IsPublic() || jwk.KeyID == "" {
		return jose.JSONWebKey{}, errors.New("public JWK must be a valid P-256 key with kid")
	}
	if expectedUse != "" && jwk.Use != expectedUse {
		return jose.JSONWebKey{}, errors.New("public JWK use rejected")
	}
	return jwk, nil
}

func Thumbprint(jwk jose.JSONWebKey) (string, error) {
	public := jwk.Public()
	thumbprint, err := public.Thumbprint(crypto.SHA256)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(thumbprint), nil
}

func WrapGrantSecrets(password []byte, tuple model.Tuple, loginBinding string, secrets *GrantSecrets) ([]byte, error) {
	if err := tuple.Validate(); err != nil {
		return nil, err
	}
	if !validSHA256Hex(loginBinding) || len(password) == 0 || len(password) > 1024 || secrets == nil || len(secrets.DEK) != keyBytes || secrets.SigningKey == nil || secrets.EncryptionKey == nil || secrets.SigningKey.Curve != elliptic.P256() || secrets.EncryptionKey.Curve != elliptic.P256() {
		return nil, errors.New("password and complete grant secrets are required")
	}
	signingDER, err := x509.MarshalPKCS8PrivateKey(secrets.SigningKey)
	if err != nil {
		return nil, err
	}
	encryptionDER, err := x509.MarshalPKCS8PrivateKey(secrets.EncryptionKey)
	if err != nil {
		zero(signingDER)
		return nil, err
	}
	defer zero(signingDER)
	defer zero(encryptionDER)
	plain, err := json.Marshal(encodedGrantSecrets{
		Version: model.ProtocolVersion, TupleBinding: tuple.Binding(), LoginBindingSHA256: loginBinding,
		DEK:             base64.RawURLEncoding.EncodeToString(secrets.DEK),
		SigningPKCS8:    base64.RawURLEncoding.EncodeToString(signingDER),
		EncryptionPKCS8: base64.RawURLEncoding.EncodeToString(encryptionDER),
	})
	if err != nil {
		return nil, err
	}
	defer zero(plain)
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, err
	}
	credentialInput := boundCredentialInput(password, loginBinding)
	defer zero(credentialInput)
	key := argon2.IDKey(credentialInput, salt, PasswordIterations, PasswordMemoryKiB, PasswordParallelism, keyBytes)
	defer zero(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ciphertext := aead.Seal(nil, nonce, plain, grantCredentialAAD(tuple, loginBinding))
	return json.Marshal(WrappedGrantSecrets{
		Version: model.ProtocolVersion, KDF: "argon2id", MemoryKiB: PasswordMemoryKiB, Iterations: PasswordIterations, Parallelism: PasswordParallelism,
		Salt: base64.RawURLEncoding.EncodeToString(salt), Nonce: base64.RawURLEncoding.EncodeToString(nonce), Ciphertext: base64.RawURLEncoding.EncodeToString(ciphertext),
	})
}

func UnwrapGrantSecrets(password, wrapped []byte, tuple model.Tuple, loginBinding string) (*GrantSecrets, error) {
	if len(password) == 0 || len(password) > 1024 || len(wrapped) == 0 || len(wrapped) > maxSecretPayload {
		return nil, errors.New("wrapped grant secrets rejected")
	}
	if err := tuple.Validate(); err != nil {
		return nil, err
	}
	if !validSHA256Hex(loginBinding) {
		return nil, errors.New("wrapped grant login binding rejected")
	}
	var envelope WrappedGrantSecrets
	decoder := json.NewDecoder(strings.NewReader(string(wrapped)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil || envelope.Version != model.ProtocolVersion || envelope.KDF != "argon2id" || envelope.MemoryKiB != PasswordMemoryKiB || envelope.Iterations != PasswordIterations || envelope.Parallelism != PasswordParallelism {
		return nil, errors.New("wrapped grant parameters rejected")
	}
	salt, err := base64.RawURLEncoding.DecodeString(envelope.Salt)
	if err != nil || len(salt) != 16 {
		return nil, errors.New("wrapped grant salt rejected")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		return nil, errors.New("wrapped grant nonce rejected")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return nil, errors.New("wrapped grant ciphertext rejected")
	}
	credentialInput := boundCredentialInput(password, loginBinding)
	defer zero(credentialInput)
	key := argon2.IDKey(credentialInput, salt, PasswordIterations, PasswordMemoryKiB, PasswordParallelism, keyBytes)
	defer zero(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(nonce) != aead.NonceSize() {
		return nil, errors.New("wrapped grant nonce rejected")
	}
	plain, err := aead.Open(nil, nonce, ciphertext, grantCredentialAAD(tuple, loginBinding))
	if err != nil {
		return nil, errors.New("offline credential rejected")
	}
	defer zero(plain)
	var encoded encodedGrantSecrets
	// Decode directly from the wipeable plaintext buffer. Converting this
	// private-key bundle to string would leave an immutable duplicate in the Go
	// heap after the byte slice is zeroed.
	strict := json.NewDecoder(bytes.NewReader(plain))
	strict.DisallowUnknownFields()
	if err := strict.Decode(&encoded); err != nil || encoded.Version != model.ProtocolVersion || encoded.TupleBinding != tuple.Binding() || encoded.LoginBindingSHA256 != loginBinding {
		return nil, errors.New("wrapped grant binding rejected")
	}
	dek, err := base64.RawURLEncoding.DecodeString(encoded.DEK)
	if err != nil || len(dek) != keyBytes {
		return nil, errors.New("wrapped grant data key rejected")
	}
	signingKey, err := parseP256Private(encoded.SigningPKCS8)
	if err != nil {
		zero(dek)
		return nil, errors.New("wrapped signing key rejected")
	}
	encryptionKey, err := parseP256Private(encoded.EncryptionPKCS8)
	if err != nil {
		zero(dek)
		return nil, errors.New("wrapped encryption key rejected")
	}
	return &GrantSecrets{DEK: dek, SigningKey: signingKey, EncryptionKey: encryptionKey}, nil
}

func boundCredentialInput(password []byte, loginBinding string) []byte {
	value := make([]byte, 0, len(password)+len(loginBinding)+32)
	value = append(value, "CLARIN-OFFLINE-V3-CREDENTIAL"...)
	value = append(value, 0)
	value = append(value, loginBinding...)
	value = append(value, 0)
	value = append(value, password...)
	return value
}

func grantCredentialAAD(tuple model.Tuple, loginBinding string) []byte {
	return []byte(tuple.Binding() + "\nLOGIN-BINDING-SHA256\n" + loginBinding)
}

func validSHA256Hex(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}

func SealRecord(dek, aad, plain []byte) ([]byte, error) {
	if len(dek) != keyBytes || len(aad) == 0 || len(plain) == 0 || len(plain) > maxRecordPayload {
		return nil, errors.New("record encryption input rejected")
	}
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ciphertext := aead.Seal(nil, nonce, plain, aad)
	return json.Marshal(SealedRecord{Version: model.ProtocolVersion, Algorithm: "A256GCM", Nonce: base64.RawURLEncoding.EncodeToString(nonce), Ciphertext: base64.RawURLEncoding.EncodeToString(ciphertext)})
}

func OpenRecord(dek, aad, sealed []byte) ([]byte, error) {
	if len(dek) != keyBytes || len(aad) == 0 || len(sealed) == 0 || len(sealed) > maxRecordPayload+4096 {
		return nil, errors.New("record decryption input rejected")
	}
	var envelope SealedRecord
	decoder := json.NewDecoder(strings.NewReader(string(sealed)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil || envelope.Version != model.ProtocolVersion || envelope.Algorithm != "A256GCM" {
		return nil, errors.New("record encryption envelope rejected")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		return nil, errors.New("record nonce rejected")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return nil, errors.New("record ciphertext rejected")
	}
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(nonce) != aead.NonceSize() {
		return nil, errors.New("record nonce rejected")
	}
	plain, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, errors.New("encrypted record authentication failed")
	}
	return plain, nil
}

func SignCompact(payload []byte, privateKey *ecdsa.PrivateKey, keyID, typ string) (string, error) {
	if len(payload) == 0 || privateKey == nil || privateKey.Curve != elliptic.P256() || keyID == "" || typ == "" {
		return "", errors.New("JWS signing input rejected")
	}
	options := (&jose.SignerOptions{}).WithType(jose.ContentType(typ))
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: JWSAlgorithm, Key: jose.JSONWebKey{Key: privateKey, KeyID: keyID, Algorithm: string(JWSAlgorithm), Use: "sig"}}, options)
	if err != nil {
		return "", err
	}
	object, err := signer.Sign(payload)
	if err != nil {
		return "", err
	}
	return object.CompactSerialize()
}

func VerifyCompact(token string, publicKey *ecdsa.PublicKey, expectedKeyID, expectedType string) ([]byte, error) {
	if token == "" || publicKey == nil || publicKey.Curve != elliptic.P256() || expectedKeyID == "" || expectedType == "" {
		return nil, errors.New("JWS verification input rejected")
	}
	object, err := jose.ParseSignedCompact(token, []jose.SignatureAlgorithm{JWSAlgorithm})
	if err != nil || len(object.Signatures) != 1 {
		return nil, errors.New("JWS format or algorithm rejected")
	}
	header := object.Signatures[0].Protected
	if header.Algorithm != string(JWSAlgorithm) || header.KeyID != expectedKeyID || headerValue(header, jose.HeaderType) != expectedType || len(object.Signatures[0].Unprotected.ExtraHeaders) != 0 || object.Signatures[0].Unprotected.Algorithm != "" || object.Signatures[0].Unprotected.KeyID != "" {
		return nil, errors.New("JWS protected header rejected")
	}
	payload, err := object.Verify(publicKey)
	if err != nil {
		return nil, errors.New("JWS signature rejected")
	}
	return payload, nil
}

func EncryptCompact(payload []byte, publicKey *ecdsa.PublicKey, keyID, typ string) (string, error) {
	if len(payload) == 0 || publicKey == nil || publicKey.Curve != elliptic.P256() || keyID == "" || typ == "" {
		return "", errors.New("JWE encryption input rejected")
	}
	options := (&jose.EncrypterOptions{}).WithType(jose.ContentType(typ))
	encrypter, err := jose.NewEncrypter(JWEEncryption, jose.Recipient{Algorithm: JWEAlgorithm, Key: publicKey, KeyID: keyID}, options)
	if err != nil {
		return "", err
	}
	object, err := encrypter.Encrypt(payload)
	if err != nil {
		return "", err
	}
	return object.CompactSerialize()
}

func EncryptOperationCompact(innerJWS []byte, publicKey *ecdsa.PublicKey, keyID string) (string, error) {
	if len(innerJWS) == 0 || len(innerJWS) > 1<<20 || publicKey == nil || publicKey.Curve != elliptic.P256() || keyID == "" {
		return "", errors.New("operation JWE input rejected")
	}
	options := (&jose.EncrypterOptions{}).
		WithType(jose.ContentType("clarin-offline-operation+jwe")).
		WithContentType(jose.ContentType("clarin-offline-operation+jws"))
	encrypter, err := jose.NewEncrypter(JWEEncryption, jose.Recipient{Algorithm: JWEAlgorithm, Key: publicKey, KeyID: keyID}, options)
	if err != nil {
		return "", err
	}
	object, err := encrypter.Encrypt(innerJWS)
	if err != nil {
		return "", err
	}
	return object.CompactSerialize()
}

func DecryptCompact(token string, privateKey *ecdsa.PrivateKey, expectedKeyID, expectedType string) ([]byte, error) {
	if token == "" || privateKey == nil || privateKey.Curve != elliptic.P256() || expectedKeyID == "" || expectedType == "" {
		return nil, errors.New("JWE decryption input rejected")
	}
	object, err := jose.ParseEncryptedCompact(token, []jose.KeyAlgorithm{JWEAlgorithm}, []jose.ContentEncryption{JWEEncryption})
	if err != nil {
		return nil, errors.New("JWE format or algorithm rejected")
	}
	if object.Header.Algorithm != string(JWEAlgorithm) || object.Header.KeyID != expectedKeyID || headerValue(object.Header, jose.HeaderType) != expectedType {
		return nil, errors.New("JWE protected header rejected")
	}
	for name := range object.Header.ExtraHeaders {
		if name != jose.HeaderType && name != jose.HeaderKey("enc") && name != jose.HeaderKey("epk") {
			return nil, errors.New("JWE extension rejected")
		}
	}
	payload, err := object.Decrypt(privateKey)
	if err != nil {
		return nil, errors.New("JWE authentication failed")
	}
	return payload, nil
}

// DecryptNestedCompact opens a server-to-grant envelope and enforces both the
// outer type and the declared inner JWS type. Encryption to a public grant key
// proves confidentiality only; callers must still verify the returned JWS
// against the pinned backend signing ring before using its payload.
func DecryptNestedCompact(token string, privateKey *ecdsa.PrivateKey, expectedKeyID, expectedType, expectedContentType string) ([]byte, error) {
	if token == "" || len(token) > 32<<20 || privateKey == nil || privateKey.Curve != elliptic.P256() || expectedKeyID == "" || expectedType == "" || expectedContentType == "" {
		return nil, errors.New("nested JWE decryption input rejected")
	}
	object, err := jose.ParseEncryptedCompact(token, []jose.KeyAlgorithm{JWEAlgorithm}, []jose.ContentEncryption{JWEEncryption})
	if err != nil {
		return nil, errors.New("nested JWE format or algorithm rejected")
	}
	header := object.Header
	if header.Algorithm != string(JWEAlgorithm) || header.KeyID != expectedKeyID || headerValue(header, jose.HeaderType) != expectedType || headerValue(header, jose.HeaderContentType) != expectedContentType {
		return nil, errors.New("nested JWE protected header rejected")
	}
	// enc and epk are mandatory standard ECDH-ES JWE protected parameters.
	// go-jose exposes them through ExtraHeaders; zip and every unrelated
	// extension remain rejected.
	allowed := map[jose.HeaderKey]bool{jose.HeaderType: true, jose.HeaderContentType: true, jose.HeaderKey("enc"): true, jose.HeaderKey("epk"): true}
	for name := range header.ExtraHeaders {
		if !allowed[name] {
			return nil, errors.New("nested JWE extension rejected")
		}
	}
	payload, err := object.Decrypt(privateKey)
	if err != nil {
		return nil, errors.New("nested JWE authentication failed")
	}
	if len(payload) < 64 || len(payload) > 16<<20 {
		zero(payload)
		return nil, errors.New("nested JWE payload size rejected")
	}
	return payload, nil
}

// DecryptLocalCredential accepts only the credential envelope emitted by the
// Clarin browser runtime. Custom protected headers bind the ciphertext to the
// v3 protocol and configured HTTPS origin; every other extension is rejected.
func DecryptLocalCredential(token string, privateKey *ecdsa.PrivateKey, expectedKeyID, expectedType, expectedOrigin string) ([]byte, error) {
	if token == "" || len(token) > 32<<10 || privateKey == nil || privateKey.Curve != elliptic.P256() || expectedKeyID == "" || expectedType == "" || expectedOrigin == "" {
		return nil, errors.New("credential JWE input rejected")
	}
	object, err := jose.ParseEncryptedCompact(token, []jose.KeyAlgorithm{JWEAlgorithm}, []jose.ContentEncryption{JWEEncryption})
	if err != nil {
		return nil, errors.New("credential JWE format rejected")
	}
	header := object.Header
	if header.Algorithm != string(JWEAlgorithm) || header.KeyID != expectedKeyID || headerValue(header, jose.HeaderType) != expectedType {
		return nil, errors.New("credential JWE protected header rejected")
	}
	allowed := map[jose.HeaderKey]bool{jose.HeaderType: true, jose.HeaderKey("enc"): true, jose.HeaderKey("epk"): true, jose.HeaderKey("v"): true, jose.HeaderKey("origin"): true}
	for name := range header.ExtraHeaders {
		if !allowed[name] {
			return nil, errors.New("credential JWE extension rejected")
		}
	}
	version, versionOK := numericHeader(header.ExtraHeaders[jose.HeaderKey("v")])
	origin, originOK := header.ExtraHeaders[jose.HeaderKey("origin")].(string)
	if !versionOK || version != model.ProtocolVersion || !originOK || origin != expectedOrigin {
		return nil, errors.New("credential JWE origin or version rejected")
	}
	payload, err := object.Decrypt(privateKey)
	if err != nil {
		return nil, errors.New("credential JWE authentication failed")
	}
	return payload, nil
}

func numericHeader(value any) (int, bool) {
	switch number := value.(type) {
	case float64:
		return int(number), number == float64(int(number))
	case int:
		return number, true
	case json.Number:
		parsed, err := number.Int64()
		return int(parsed), err == nil && int64(int(parsed)) == parsed
	default:
		return 0, false
	}
}

func Hash(raw []byte) string {
	digest := sha256.Sum256(raw)
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func IntentHash(dek, raw []byte) (string, error) {
	if len(dek) != keyBytes || len(raw) == 0 || len(raw) > 1<<20 {
		return "", errors.New("operation intent hash input rejected")
	}
	mac := hmac.New(sha256.New, dek)
	_, _ = mac.Write([]byte("CLARIN-OFFLINE-V3-OPERATION-INTENT\x00"))
	_, _ = mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func parseP256Private(encoded string) (*ecdsa.PrivateKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	defer zero(raw)
	parsed, err := x509.ParsePKCS8PrivateKey(raw)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, errors.New("private key is not P-256")
	}
	return key, nil
}

func headerValue(header jose.Header, name jose.HeaderKey) string {
	value, ok := header.ExtraHeaders[name]
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return text
}

func RecordAAD(tuple model.Tuple, module, resourceType, resourceID string, revision int64) []byte {
	return []byte(fmt.Sprintf("CLARIN-OFFLINE-V3-RECORD\n%s\n%s\n%s\n%s\n%d", tuple.Binding(), module, resourceType, resourceID, revision))
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
