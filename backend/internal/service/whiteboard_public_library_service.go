package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	WhiteboardPublicLibraryOrigin = "https://libraries.excalidraw.com"
	publicLibraryHost             = "libraries.excalidraw.com"
	publicLibraryFetchTimeout     = 12 * time.Second
)

var ErrWhiteboardPublicLibrary = errors.New("invalid public whiteboard library")

var whiteboardPublicLibraryIPv6GlobalPrefix = netip.MustParsePrefix("2000::/3")

// Go's IsGlobalUnicast intentionally includes private and several
// special-purpose ranges. The catalog fetcher needs a narrower definition:
// only publicly routed destination addresses are eligible.
var whiteboardPublicLibraryDeniedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.31.196.0/24"),
	netip.MustParsePrefix("192.52.193.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("192.175.48.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("::/96"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("5f00::/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("fec0::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

func ValidatePublicWhiteboardLibraryURL(raw string) (*url.URL, error) {
	if len(raw) == 0 || len(raw) > 2048 || strings.ContainsAny(raw, "\r\n\\") {
		return nil, ErrWhiteboardPublicLibrary
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != publicLibraryHost || parsed.Port() != "" || parsed.User != nil || parsed.Opaque != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return nil, ErrWhiteboardPublicLibrary
	}
	if parsed.EscapedPath() != parsed.Path || path.Clean(parsed.Path) != parsed.Path || !strings.HasPrefix(parsed.Path, "/libraries/") || !strings.HasSuffix(strings.ToLower(parsed.Path), ".excalidrawlib") {
		return nil, ErrWhiteboardPublicLibrary
	}
	parts := strings.Split(strings.TrimPrefix(parsed.Path, "/libraries/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." {
		return nil, ErrWhiteboardPublicLibrary
	}
	return parsed, nil
}

func unsafePublicLibraryIP(ip net.IP) bool {
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() {
		return true
	}
	// Fail closed for IPv6 space outside IANA's currently allocated global
	// unicast block. IsGlobalUnicast intentionally accepts deprecated and
	// unallocated ranges such as site-local fec0::/10 and 4000::/3.
	if address.Is6() && !whiteboardPublicLibraryIPv6GlobalPrefix.Contains(address) {
		return true
	}
	for _, prefix := range whiteboardPublicLibraryDeniedPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

// NewPublicWhiteboardLibraryHTTPClient resolves and dials only the exact
// official host. Redirects are rejected and a DNS result in a private range is
// never contacted, even if the public hostname is rebound.
func NewPublicWhiteboardLibraryHTTPClient() *http.Client {
	resolver := net.DefaultResolver
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 20 * time.Second}
	transport := &http.Transport{
		Proxy:                 nil,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 7 * time.Second,
		IdleConnTimeout:       30 * time.Second,
		MaxIdleConns:          4,
		MaxIdleConnsPerHost:   2,
	}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || !strings.EqualFold(host, publicLibraryHost) || port != "443" {
			return nil, ErrWhiteboardPublicLibrary
		}
		addresses, err := resolver.LookupIPAddr(ctx, publicLibraryHost)
		if err != nil || len(addresses) == 0 {
			return nil, fmt.Errorf("resolve public library host: %w", err)
		}
		for _, address := range addresses {
			if unsafePublicLibraryIP(address.IP) {
				return nil, ErrWhiteboardPublicLibrary
			}
		}
		var lastErr error
		for _, resolved := range addresses {
			connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(resolved.IP.String(), port))
			if dialErr == nil {
				return connection, nil
			}
			lastErr = dialErr
		}
		return nil, lastErr
	}
	return &http.Client{
		Transport: transport,
		Timeout:   publicLibraryFetchTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return ErrWhiteboardPublicLibrary
		},
	}
}

func FetchPublicWhiteboardLibrary(ctx context.Context, client *http.Client, rawURL string) (json.RawMessage, string, error) {
	parsed, err := ValidatePublicWhiteboardLibraryURL(rawURL)
	if err != nil || client == nil {
		return nil, "", ErrWhiteboardPublicLibrary
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, "", ErrWhiteboardPublicLibrary
	}
	request.Header.Set("Accept", "application/vnd.excalidrawlib+json, application/json, application/octet-stream;q=0.8")
	request.Header.Set("User-Agent", "Clarin-Whiteboards/1.0")
	response, err := client.Do(request)
	if err != nil {
		return nil, "", ErrWhiteboardPublicLibrary
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > MaxWhiteboardLibraryBytes {
		return nil, "", ErrWhiteboardPublicLibrary
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, MaxWhiteboardLibraryBytes+1))
	if err != nil || len(payload) > MaxWhiteboardLibraryBytes {
		return nil, "", ErrWhiteboardPublicLibrary
	}
	validated, err := ValidateWhiteboardLibrary(payload)
	if err != nil {
		return nil, "", ErrWhiteboardPublicLibrary
	}
	return validated, parsed.String(), nil
}

// NamespacePublicWhiteboardLibraryItems gives every imported item an ID tied
// to the one-time import. Retrying the same import is therefore idempotent,
// while IDs from an unrelated catalog cannot collide with Mi biblioteca.
func NamespacePublicWhiteboardLibraryItems(library json.RawMessage, importID uuid.UUID) (json.RawMessage, error) {
	if importID == uuid.Nil {
		return nil, ErrWhiteboardPublicLibrary
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(library, &envelope) != nil {
		return nil, ErrWhiteboardPublicLibrary
	}
	var items []json.RawMessage
	if json.Unmarshal(envelope["libraryItems"], &items) != nil {
		return nil, ErrWhiteboardPublicLibrary
	}
	for index, rawItem := range items {
		var item map[string]json.RawMessage
		if len(strings.TrimSpace(string(rawItem))) > 0 && strings.TrimSpace(string(rawItem))[0] == '[' {
			seed := sha256.Sum256(rawItem)
			itemID := uuid.NewSHA1(importID, append([]byte(fmt.Sprintf("legacy:%d:", index)), seed[:]...)).String()
			wrapped, err := json.Marshal(map[string]any{
				"id": itemID, "status": "published", "created": int64(1), "elements": json.RawMessage(rawItem),
			})
			if err != nil {
				return nil, ErrWhiteboardPublicLibrary
			}
			items[index] = wrapped
			continue
		}
		if json.Unmarshal(rawItem, &item) != nil || item == nil {
			return nil, ErrWhiteboardPublicLibrary
		}
		var originalID string
		_ = json.Unmarshal(item["id"], &originalID)
		seed := sha256.Sum256(rawItem)
		itemID := uuid.NewSHA1(importID, append([]byte(fmt.Sprintf("item:%d:%s:", index, originalID)), seed[:]...)).String()
		encodedID, _ := json.Marshal(itemID)
		item["id"] = encodedID
		encoded, err := json.Marshal(item)
		if err != nil {
			return nil, ErrWhiteboardPublicLibrary
		}
		items[index] = encoded
	}
	encodedItems, _ := json.Marshal(items)
	envelope["libraryItems"] = encodedItems
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return nil, ErrWhiteboardPublicLibrary
	}
	validated, err := ValidateWhiteboardLibrary(encoded)
	if err != nil {
		return nil, ErrWhiteboardPublicLibrary
	}
	return validated, nil
}
