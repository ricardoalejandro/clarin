package whatsapp

import (
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestMediaStorageObjectKeyEnforcesAccountIsolation(t *testing.T) {
	t.Parallel()

	accountID := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	otherAccountID := "22222222-2222-2222-2222-222222222222"
	publicBase := "https://media.example.com/storage"
	internalBase := "http://minio:9000"
	bucket := "clarin-media"

	tests := []struct {
		name       string
		rawURL     string
		wantKey    string
		wantStored bool
		wantErr    bool
	}{
		{
			name:       "own proxy object",
			rawURL:     "/api/media/file/11111111-1111-1111-1111-111111111111/uploads/photo.jpg",
			wantKey:    "11111111-1111-1111-1111-111111111111/uploads/photo.jpg",
			wantStored: true,
		},
		{
			name:       "own public MinIO object",
			rawURL:     "https://media.example.com/storage/clarin-media/11111111-1111-1111-1111-111111111111/uploads/photo.jpg?signature=ignored",
			wantKey:    "11111111-1111-1111-1111-111111111111/uploads/photo.jpg",
			wantStored: true,
		},
		{
			name:       "own internal MinIO object",
			rawURL:     "http://minio:9000/clarin-media/11111111-1111-1111-1111-111111111111/uploads/photo.jpg",
			wantKey:    "11111111-1111-1111-1111-111111111111/uploads/photo.jpg",
			wantStored: true,
		},
		{
			name:       "other account proxy object",
			rawURL:     "/api/media/file/" + otherAccountID + "/uploads/private.pdf",
			wantStored: true,
			wantErr:    true,
		},
		{
			name:       "other account absolute proxy object",
			rawURL:     "https://clarin.example.com/api/media/file/" + otherAccountID + "/uploads/private.pdf",
			wantStored: true,
			wantErr:    true,
		},
		{
			name:       "account prefix collision",
			rawURL:     "/api/media/file/11111111-1111-1111-1111-111111111111evil/uploads/private.pdf",
			wantStored: true,
			wantErr:    true,
		},
		{
			name:       "encoded traversal",
			rawURL:     "/api/media/file/11111111-1111-1111-1111-111111111111/%2e%2e/" + otherAccountID + "/private.pdf",
			wantStored: true,
			wantErr:    true,
		},
		{
			name:       "other account public MinIO object",
			rawURL:     publicBase + "/clarin-media/" + otherAccountID + "/private.pdf",
			wantStored: true,
			wantErr:    true,
		},
		{
			name:       "lookalike storage hostname",
			rawURL:     "https://media.example.com.evil.test/storage/clarin-media/" + accountID.String() + "/photo.jpg",
			wantStored: false,
		},
		{
			name:       "arbitrary remote URL",
			rawURL:     "https://cdn.example.com/photo.jpg",
			wantStored: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			gotKey, gotStored, err := mediaStorageObjectKey(tt.rawURL, publicBase, internalBase, bucket, accountID)
			if (err != nil) != tt.wantErr {
				t.Fatalf("mediaStorageObjectKey() error = %v, wantErr %t", err, tt.wantErr)
			}
			if gotStored != tt.wantStored {
				t.Fatalf("mediaStorageObjectKey() stored = %t, want %t", gotStored, tt.wantStored)
			}
			if gotKey != tt.wantKey {
				t.Fatalf("mediaStorageObjectKey() key = %q, want %q", gotKey, tt.wantKey)
			}
		})
	}
}

func TestValidateRemoteMediaURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		rawURL  string
		wantErr bool
	}{
		{name: "public HTTPS host", rawURL: "https://cdn.example.com/photo.jpg"},
		{name: "public IPv4 literal", rawURL: "http://1.1.1.1/photo.jpg"},
		{name: "unsupported scheme", rawURL: "file:///etc/passwd", wantErr: true},
		{name: "URL credentials", rawURL: "https://user:secret@cdn.example.com/photo.jpg", wantErr: true},
		{name: "loopback IPv4", rawURL: "http://127.0.0.1/admin", wantErr: true},
		{name: "loopback IPv6", rawURL: "http://[::1]/admin", wantErr: true},
		{name: "private IPv4", rawURL: "http://10.0.0.8/admin", wantErr: true},
		{name: "link local metadata", rawURL: "http://169.254.169.254/latest/meta-data", wantErr: true},
		{name: "unspecified", rawURL: "http://0.0.0.0/admin", wantErr: true},
		{name: "multicast", rawURL: "http://224.0.0.1/data", wantErr: true},
		{name: "localhost name", rawURL: "http://service.localhost/data", wantErr: true},
		{name: "fragment", rawURL: "https://cdn.example.com/file#fragment", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := validateRemoteMediaURL(tt.rawURL)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateRemoteMediaURL(%q) error = %v, wantErr %t", tt.rawURL, err, tt.wantErr)
			}
		})
	}
}

func TestIsPublicMediaIP(t *testing.T) {
	t.Parallel()

	tests := []struct {
		address string
		want    bool
	}{
		{address: "1.1.1.1", want: true},
		{address: "8.8.8.8", want: true},
		{address: "2606:4700:4700::1111", want: true},
		{address: "10.1.2.3"},
		{address: "100.64.1.2"},
		{address: "127.0.0.1"},
		{address: "169.254.169.254"},
		{address: "192.0.2.10"},
		{address: "198.51.100.10"},
		{address: "224.0.0.1"},
		{address: "255.255.255.255"},
		{address: "::1"},
		{address: "fc00::1"},
		{address: "fe80::1"},
		{address: "ff02::1"},
		{address: "2001:db8::1"},
	}

	for _, tt := range tests {
		t.Run(tt.address, func(t *testing.T) {
			t.Parallel()
			if got := isPublicMediaIP(net.ParseIP(tt.address)); got != tt.want {
				t.Fatalf("isPublicMediaIP(%s) = %t, want %t", tt.address, got, tt.want)
			}
		})
	}
}

func TestValidateMediaRedirect(t *testing.T) {
	t.Parallel()

	httpsOrigin, _ := http.NewRequest(http.MethodGet, "https://origin.example.com/file", nil)
	publicHTTPS, _ := http.NewRequest(http.MethodGet, "https://cdn.example.com/file", nil)
	if err := validateMediaRedirect(publicHTTPS, []*http.Request{httpsOrigin}); err != nil {
		t.Fatalf("safe public redirect rejected: %v", err)
	}

	privateTarget, _ := http.NewRequest(http.MethodGet, "http://169.254.169.254/metadata", nil)
	if err := validateMediaRedirect(privateTarget, []*http.Request{httpsOrigin}); err == nil {
		t.Fatal("private redirect target was accepted")
	}

	publicHTTP, _ := http.NewRequest(http.MethodGet, "http://cdn.example.com/file", nil)
	if err := validateMediaRedirect(publicHTTP, []*http.Request{httpsOrigin}); err == nil {
		t.Fatal("HTTPS downgrade redirect was accepted")
	}

	tooMany := make([]*http.Request, maxMediaRedirects+1)
	for i := range tooMany {
		tooMany[i] = httpsOrigin
	}
	if err := validateMediaRedirect(publicHTTPS, tooMany); err == nil {
		t.Fatal("redirect chain above the limit was accepted")
	}
}

func TestReadLimitedMedia(t *testing.T) {
	t.Parallel()

	data, err := readLimitedMedia(strings.NewReader("12345"), 5, 5)
	if err != nil || string(data) != "12345" {
		t.Fatalf("exact-limit body failed: data=%q err=%v", data, err)
	}
	if _, err := readLimitedMedia(strings.NewReader("123456"), -1, 5); err == nil {
		t.Fatal("streamed body above limit was accepted")
	}
	if _, err := readLimitedMedia(strings.NewReader("short"), 6, 5); err == nil {
		t.Fatal("declared body above limit was accepted")
	}
}
