package main

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestV4SignerRejectsNativeAuthorityAndCrossOrigin(t *testing.T) {
	s, err := loadV4Signer(t.TempDir(), "4", "http://localhost:19444")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	s.now = func() time.Time { return now }
	id := "01234567-89ab-4def-8123-456789abcdef"
	a := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))
	b := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))
	valid := v4Lease{Issuer: "clarin-offline-v4", Audience: "http://localhost:19444", IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(24 * time.Hour).Unix(), ID: id, Version: 4, BrowserProfileID: id, GrantID: id, UserID: id, AccountID: id, CredentialEpoch: 1, AuthorityEpoch: 2, GrantRevision: 1, SelectionRevision: 1, SelectionDigest: strings.Repeat("a", 64), LoginBindingSHA256: strings.Repeat("b", 64), Actions: []string{"tasks.read", "tasks.create"}, MaxStorageBytes: 1 << 20, BrowserKeyThumbprint: a, GrantSigningKeyThumbprint: b}
	if !s.validateLease(valid) {
		t.Fatal("valid browser lease denied")
	}
	mutations := map[string]func(*v4Lease){"native": func(l *v4Lease) { l.Version = 3 }, "issuer": func(l *v4Lease) { l.Issuer = "clarin-offline-v3" }, "origin": func(l *v4Lease) { l.Audience = "https://clarin.naperu.cloud" }, "over24hours": func(l *v4Lease) { l.ExpiresAt++ }, "samekey": func(l *v4Lease) { l.GrantSigningKeyThumbprint = l.BrowserKeyThumbprint }, "writewithoutread": func(l *v4Lease) { l.Actions = []string{"tasks.create"} }, "unapprovedwrite": func(l *v4Lease) { l.Actions = []string{"contacts.write"} }, "missingaccount": func(l *v4Lease) { l.AccountID = "" }}
	for name, change := range mutations {
		t.Run(name, func(t *testing.T) {
			l := valid
			change(&l)
			if s.validateLease(l) {
				t.Fatal("invalid browser lease accepted")
			}
		})
	}
}

func TestV4KeyPersistenceAndDowngrade(t *testing.T) {
	dir := t.TempDir()
	one, err := loadV4Signer(dir, "4", "")
	if err != nil {
		t.Fatal(err)
	}
	two, err := loadV4Signer(dir, "4", "")
	if err != nil {
		t.Fatal(err)
	}
	if one.key.D.Cmp(two.key.D) != 0 {
		t.Fatal("signing key changed on reload")
	}
	if _, err = loadV4Signer(dir, "5", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = loadV4Signer(dir, "4", ""); err == nil {
		t.Fatal("key downgrade accepted")
	}
	if _, err = loadV4Signer(t.TempDir(), "4", "http://remote.example.invalid"); err == nil {
		t.Fatal("insecure remote origin accepted")
	}
}
