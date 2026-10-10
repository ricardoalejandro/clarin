package storage

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

func TestCanonicalMediaURLExactConfiguredOriginsAndAccount(t *testing.T) {
	account := uuid.NewString()
	key := account + "/uploads/photo one.png"
	store := &Storage{publicURL: "https://media.example/storage", internalURL: "http://minio:9000", bucket: "clarin-media"}
	for _, raw := range []string{"https://media.example/storage/clarin-media/" + account + "/uploads/photo%20one.png", "http://minio:9000/clarin-media/" + account + "/uploads/photo%20one.png"} {
		actual, ok := store.OrdinaryObjectKeyFromURL(raw)
		if !ok || actual != key {
			t.Fatal("configured URL did not resolve")
		}
		if got := store.CanonicalMediaURL(raw); got != "/api/media/file/"+account+"/uploads/photo%20one.png" {
			t.Fatal("wrong canonical URL", got)
		}
	}
	for _, raw := range []string{
		"https://evil.example/storage/clarin-media/" + key,
		"https://media.example.evil/storage/clarin-media/" + key,
		"https://media.example/storage/clarin-media-other/" + key,
		"https://user@media.example/storage/clarin-media/" + key,
		"https://media.example/storage/clarin-media/" + account + "/_private/tasks/private.pdf",
		"https://media.example/storage/clarin-media/" + account + "/../victim/file.png",
		"/api/media/file/" + key + "?media_access=signed",
		"text https://media.example/storage/clarin-media/" + key,
	} {
		if got := store.CanonicalMediaURL(raw); got != raw {
			t.Fatalf("untrusted/protected input rewritten: %q", raw)
		}
	}
	if got := store.GetPublicURL(account + "/uploads/file.jpg"); got != "/api/media/file/"+account+"/uploads/file.jpg" {
		t.Fatal("new URL bypassed authorization")
	}
}

func TestEnsureOrdinaryBucketRemovesAnonymousPolicy(t *testing.T) {
	for _, denyRemoval := range []bool{false, true} {
		t.Run(map[bool]string{false: "enforced", true: "fail closed"}[denyRemoval], func(t *testing.T) {
			removed := false
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Has("location") {
					w.Header().Set("Content-Type", "application/xml")
					_, _ = w.Write([]byte(`<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>`))
					return
				}
				if r.Method == http.MethodHead {
					w.WriteHeader(http.StatusOK)
					return
				}
				if r.Method == http.MethodDelete && r.URL.Query().Has("policy") {
					removed = true
					if denyRemoval {
						w.WriteHeader(http.StatusForbidden)
						_, _ = w.Write([]byte(`<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>`))
						return
					}
					w.WriteHeader(http.StatusNoContent)
					return
				}
				t.Errorf("unexpected storage request %s %s", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusBadRequest)
			}))
			defer endpoint.Close()
			client, err := minio.New(strings.TrimPrefix(endpoint.URL, "http://"), &minio.Options{Creds: credentials.NewStaticV4("test-access", "test-secret", ""), Secure: false, Region: "us-east-1"})
			if err != nil {
				t.Fatal(err)
			}
			store := &Storage{client: client, bucket: "test-media"}
			err = store.ensureBucket(context.Background())
			if !removed {
				t.Fatal("anonymous bucket policy left in place")
			}
			if denyRemoval && err == nil {
				t.Fatal("startup accepted unsuccessful privacy enforcement")
			}
			if !denyRemoval && err != nil {
				t.Fatal(err)
			}
		})
	}
}
