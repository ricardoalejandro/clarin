package service

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestWhiteboardPublicLibraryHandoffHashesArePurposeBound(t *testing.T) {
	t.Parallel()
	secret := strings.Repeat("a", 43)
	navigationHash := HashWhiteboardLibraryNavigationSecret(secret)
	callbackHash := HashWhiteboardLibraryCallbackSecret(secret)
	if len(navigationHash) != 64 || len(callbackHash) != 64 || navigationHash == callbackHash {
		t.Fatalf("public-library handoff hashes are not purpose-bound")
	}
	if navigationHash != HashWhiteboardLibraryNavigationSecret(secret) || callbackHash != HashWhiteboardLibraryCallbackSecret(secret) {
		t.Fatal("public-library handoff hashes are not deterministic")
	}
}

type publicLibraryRoundTripper func(*http.Request) (*http.Response, error)

func (fn publicLibraryRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestValidatePublicWhiteboardLibraryURLUsesExactOfficialPath(t *testing.T) {
	t.Parallel()
	valid := "https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib"
	if parsed, err := ValidatePublicWhiteboardLibraryURL(valid); err != nil || parsed.String() != valid {
		t.Fatalf("official URL rejected: %#v %v", parsed, err)
	}
	for _, candidate := range []string{
		"http://libraries.excalidraw.com/libraries/a/b.excalidrawlib",
		"https://libraries.excalidraw.com.evil.invalid/libraries/a/b.excalidrawlib",
		"https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/a.excalidrawlib",
		"https://libraries.excalidraw.com/libraries/a/../b.excalidrawlib",
		"https://libraries.excalidraw.com/libraries/a/b.excalidrawlib?download=1",
		"https://libraries.excalidraw.com/libraries/a/b.excalidrawlib?",
		"https://libraries.excalidraw.com/libraries/a/b.json",
		"https://127.0.0.1/libraries/a/b.excalidrawlib",
	} {
		if _, err := ValidatePublicWhiteboardLibraryURL(candidate); err == nil {
			t.Fatalf("unsafe public library URL accepted: %s", candidate)
		}
	}
}

func TestPublicWhiteboardLibraryDialRejectsIanaSpecialPurposeAddresses(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		"0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1",
		"192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
		"224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "fc00::1",
		"fe80::1", "fec0::1", "4000::1", "::127.0.0.1", "64:ff9b::1", "100::1", "2001:db8::1", "2002::1", "3fff::1", "ff02::1",
	} {
		if !unsafePublicLibraryIP(net.ParseIP(raw)) {
			t.Fatalf("special-purpose address accepted: %s", raw)
		}
	}
	for _, raw := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"} {
		if unsafePublicLibraryIP(net.ParseIP(raw)) {
			t.Fatalf("public unicast address rejected: %s", raw)
		}
	}
	if !unsafePublicLibraryIP(nil) || !unsafePublicLibraryIP(net.IP{1, 2, 3}) {
		t.Fatal("invalid address representation was accepted")
	}
}

func TestFetchPublicWhiteboardLibraryBoundsAndValidatesBeforeRender(t *testing.T) {
	t.Parallel()
	// Several prominent entries in the official catalog (including the
	// Software Architecture library) still use Excalidraw's v1 `library`
	// envelope. The server must normalize it before the browser sees it.
	payload := `{"type":"excalidrawlib","version":1,"library":[[{"id":"rect","type":"rectangle","version":1,"versionNonce":2}]]}`
	client := &http.Client{Transport: publicLibraryRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.URL.Hostname() != publicLibraryHost || request.URL.Path != "/libraries/author/catalog.excalidrawlib" {
			t.Fatalf("unexpected request target: %s", request.URL)
		}
		return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(payload)), Body: io.NopCloser(strings.NewReader(payload)), Header: make(http.Header)}, nil
	})}
	validated, sourceURL, err := FetchPublicWhiteboardLibrary(context.Background(), client,
		"https://libraries.excalidraw.com/libraries/author/catalog.excalidrawlib")
	if err != nil || sourceURL == "" || !strings.Contains(string(validated), `"source":"clarin"`) ||
		!strings.Contains(string(validated), `"libraryItems"`) || strings.Contains(string(validated), `"library":`) {
		t.Fatalf("valid library was not sanitized: %s %q %v", validated, sourceURL, err)
	}

	redirectClient := &http.Client{Transport: publicLibraryRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusFound, Body: io.NopCloser(strings.NewReader("redirect")), Header: http.Header{"Location": []string{"https://example.invalid/"}}}, nil
	})}
	if _, _, err := FetchPublicWhiteboardLibrary(context.Background(), redirectClient,
		"https://libraries.excalidraw.com/libraries/author/catalog.excalidrawlib"); err == nil {
		t.Fatal("redirect response was accepted")
	}

	oversizedClient := &http.Client{Transport: publicLibraryRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, ContentLength: -1,
			Body: io.NopCloser(strings.NewReader(strings.Repeat("x", MaxWhiteboardLibraryBytes+1))), Header: make(http.Header)}, nil
	})}
	if _, _, err := FetchPublicWhiteboardLibrary(context.Background(), oversizedClient,
		"https://libraries.excalidraw.com/libraries/author/catalog.excalidrawlib"); err == nil {
		t.Fatal("oversized response was accepted")
	}
}

func TestOfficialSoftwareArchitectureLibraryIntegration(t *testing.T) {
	if os.Getenv("CLARIN_TEST_OFFICIAL_EXCALIDRAW_LIBRARY") != "1" {
		t.Skip("set CLARIN_TEST_OFFICIAL_EXCALIDRAW_LIBRARY=1 for the opt-in network integration check")
	}
	const officialURL = "https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib"
	validated, sourceURL, err := FetchPublicWhiteboardLibrary(
		context.Background(),
		NewPublicWhiteboardLibraryHTTPClient(),
		officialURL,
	)
	if err != nil {
		t.Fatalf("official Software Architecture library failed validation: %v", err)
	}
	if sourceURL != officialURL {
		t.Fatalf("official source changed during validation: %q", sourceURL)
	}
	var envelope struct {
		Version      int               `json:"version"`
		Library      []json.RawMessage `json:"library"`
		LibraryItems []json.RawMessage `json:"libraryItems"`
	}
	if json.Unmarshal(validated, &envelope) != nil || envelope.Version != 2 || len(envelope.Library) != 0 || len(envelope.LibraryItems) == 0 {
		t.Fatalf("official legacy library was not canonicalized: %s", validated)
	}
}

func TestNamespacePublicWhiteboardLibraryItemsIsStableAndCollisionFree(t *testing.T) {
	t.Parallel()
	importID := uuid.New()
	library := json.RawMessage(`{"type":"excalidrawlib","libraryItems":[
		{"id":"same","elements":[{"id":"one","type":"rectangle","version":1,"versionNonce":2}]},
		{"id":"same","elements":[{"id":"two","type":"ellipse","version":1,"versionNonce":3}]},
		[{"id":"legacy","type":"diamond","version":1,"versionNonce":4}]
	]}`)
	first, err := NamespacePublicWhiteboardLibraryItems(library, importID)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := NamespacePublicWhiteboardLibraryItems(library, importID)
	if err != nil || string(first) != string(retry) {
		t.Fatalf("same import did not produce stable IDs: %v", err)
	}
	var envelope struct {
		LibraryItems []struct {
			ID string `json:"id"`
		} `json:"libraryItems"`
	}
	if err := json.Unmarshal(first, &envelope); err != nil || len(envelope.LibraryItems) != 3 {
		t.Fatalf("unexpected normalized library: %s (%v)", first, err)
	}
	seen := map[string]bool{}
	for _, item := range envelope.LibraryItems {
		if item.ID == "" || seen[item.ID] {
			t.Fatalf("missing or duplicate deterministic item ID: %#v", envelope.LibraryItems)
		}
		seen[item.ID] = true
	}
	otherImport, err := NamespacePublicWhiteboardLibraryItems(library, uuid.New())
	if err != nil || string(otherImport) == string(first) {
		t.Fatal("unrelated import reused the same item namespace")
	}
}
