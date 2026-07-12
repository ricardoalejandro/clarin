package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
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
	mediaProxyPrefix     = "/api/media/file/"
	maxMediaDownloadSize = int64(100 << 20) // 100 MiB hard safety limit for in-memory uploads.
	maxMediaRedirects    = 5
	mediaDownloadTimeout = 45 * time.Second
)

var nonPublicMediaPrefixes = []netip.Prefix{
	// IPv4 special-use ranges that may otherwise report as global unicast.
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	// IPv6 local, discard, benchmarking and documentation ranges.
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("fec0::/10"),
}

func internalStorageBaseURL(endpoint string, useSSL bool) string {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return ""
	}
	if strings.Contains(endpoint, "://") {
		return strings.TrimRight(endpoint, "/")
	}
	scheme := "http"
	if useSSL {
		scheme = "https"
	}
	return scheme + "://" + strings.TrimRight(endpoint, "/")
}

// mediaStorageObjectKey recognizes Clarin proxy URLs and configured MinIO URLs,
// then enforces that the object belongs to the device's account.
func mediaStorageObjectKey(rawURL, publicBaseURL, internalBaseURL, bucket string, accountID uuid.UUID) (string, bool, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", false, errors.New("media URL is empty")
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", false, fmt.Errorf("invalid media URL: %w", err)
	}
	isHTTPProxyURL := !parsed.IsAbs() || parsed.Scheme == "http" || parsed.Scheme == "https"
	if isHTTPProxyURL && strings.HasPrefix(parsed.Path, mediaProxyPrefix) {
		objectKey := strings.TrimPrefix(parsed.Path, mediaProxyPrefix)
		validated, validateErr := validateAccountMediaObjectKey(objectKey, accountID)
		return validated, true, validateErr
	}

	for _, baseURL := range []string{publicBaseURL, internalBaseURL} {
		objectKey, matches, extractErr := configuredStorageObjectKey(parsed, baseURL, bucket)
		if extractErr != nil {
			return "", matches, extractErr
		}
		if !matches {
			continue
		}
		validated, validateErr := validateAccountMediaObjectKey(objectKey, accountID)
		return validated, true, validateErr
	}

	return "", false, nil
}

func configuredStorageObjectKey(candidate *url.URL, baseURL, bucket string) (string, bool, error) {
	baseURL = strings.TrimSpace(baseURL)
	bucket = strings.Trim(bucket, "/")
	if baseURL == "" || bucket == "" || candidate == nil || !candidate.IsAbs() {
		return "", false, nil
	}

	base, err := url.Parse(baseURL)
	if err != nil || !base.IsAbs() || base.Hostname() == "" {
		return "", false, nil
	}
	if !sameURLOrigin(candidate, base) {
		return "", false, nil
	}
	if candidate.User != nil {
		return "", true, errors.New("configured storage URL must not contain credentials")
	}

	prefix := strings.TrimRight(base.Path, "/") + "/" + bucket + "/"
	if !strings.HasPrefix(candidate.Path, prefix) {
		return "", false, nil
	}
	return strings.TrimPrefix(candidate.Path, prefix), true, nil
}

func sameURLOrigin(left, right *url.URL) bool {
	if left == nil || right == nil ||
		!strings.EqualFold(left.Scheme, right.Scheme) ||
		!strings.EqualFold(left.Hostname(), right.Hostname()) {
		return false
	}
	return effectiveURLPort(left) == effectiveURLPort(right)
}

func effectiveURLPort(value *url.URL) string {
	if value == nil {
		return ""
	}
	if port := value.Port(); port != "" {
		return port
	}
	switch strings.ToLower(value.Scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}

func validateAccountMediaObjectKey(objectKey string, accountID uuid.UUID) (string, error) {
	objectKey = strings.TrimPrefix(strings.TrimSpace(objectKey), "/")
	if objectKey == "" {
		return "", errors.New("storage object key is empty")
	}
	if strings.Contains(objectKey, "\\") || strings.ContainsRune(objectKey, '\x00') {
		return "", errors.New("storage object key contains invalid characters")
	}

	segments := strings.Split(objectKey, "/")
	if len(segments) < 2 || segments[0] != accountID.String() {
		return "", errors.New("media object does not belong to the device account")
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return "", errors.New("storage object key contains an invalid path segment")
		}
	}
	return objectKey, nil
}

func validateRemoteMediaURL(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, fmt.Errorf("invalid remote media URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("remote media URL must use http or https")
	}
	if parsed.Opaque != "" || parsed.Hostname() == "" {
		return nil, errors.New("remote media URL must include a valid host")
	}
	if parsed.User != nil {
		return nil, errors.New("remote media URL must not contain credentials")
	}
	if parsed.Fragment != "" {
		return nil, errors.New("remote media URL must not contain a fragment")
	}

	host := parsed.Hostname()
	if strings.Contains(host, "%") || strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return nil, errors.New("remote media host is not public")
	}
	if addr, parseErr := netip.ParseAddr(host); parseErr == nil && !isPublicMediaAddr(addr) {
		return nil, errors.New("remote media host is not public")
	}
	return parsed, nil
}

func isPublicMediaIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	return ok && isPublicMediaAddr(addr)
}

func isPublicMediaAddr(addr netip.Addr) bool {
	if !addr.IsValid() {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() ||
		addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() ||
		addr.IsMulticast() || addr.IsUnspecified() {
		return false
	}
	for _, prefix := range nonPublicMediaPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func validateMediaRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > maxMediaRedirects {
		return fmt.Errorf("remote media exceeded %d redirects", maxMediaRedirects)
	}
	if req == nil || req.URL == nil {
		return errors.New("remote media redirect URL is missing")
	}
	if _, err := validateRemoteMediaURL(req.URL.String()); err != nil {
		return fmt.Errorf("unsafe remote media redirect: %w", err)
	}
	if len(via) > 0 && via[len(via)-1].URL != nil &&
		via[len(via)-1].URL.Scheme == "https" && req.URL.Scheme != "https" {
		return errors.New("remote media redirect cannot downgrade HTTPS to HTTP")
	}
	return nil
}

func safeMediaDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("invalid remote media address: %w", err)
	}

	var addresses []net.IPAddr
	if parsed := net.ParseIP(host); parsed != nil {
		addresses = []net.IPAddr{{IP: parsed}}
	} else {
		addresses, err = net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve remote media host: %w", err)
		}
	}
	if len(addresses) == 0 {
		return nil, errors.New("remote media host resolved to no addresses")
	}
	for _, resolved := range addresses {
		if !isPublicMediaIP(resolved.IP) {
			return nil, errors.New("remote media host resolved to a non-public address")
		}
	}

	dialer := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	var lastErr error
	for _, resolved := range addresses {
		if network == "tcp4" && resolved.IP.To4() == nil {
			continue
		}
		if network == "tcp6" && resolved.IP.To4() != nil {
			continue
		}
		connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(resolved.IP.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		lastErr = dialErr
	}
	if lastErr == nil {
		lastErr = errors.New("no compatible public address")
	}
	return nil, fmt.Errorf("failed to connect to remote media host: %w", lastErr)
}

func newSafeMediaHTTPClient() *http.Client {
	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            safeMediaDialContext,
		ForceAttemptHTTP2:      true,
		DisableCompression:     true,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  15 * time.Second,
		ExpectContinueTimeout:  time.Second,
		IdleConnTimeout:        30 * time.Second,
		MaxResponseHeaderBytes: 1 << 20,
	}
	return &http.Client{
		Transport:     transport,
		Timeout:       mediaDownloadTimeout,
		CheckRedirect: validateMediaRedirect,
	}
}

func readLimitedMedia(reader io.Reader, contentLength, maxBytes int64) ([]byte, error) {
	if contentLength > maxBytes {
		return nil, fmt.Errorf("media exceeds the %d-byte download limit", maxBytes)
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("media exceeds the %d-byte download limit", maxBytes)
	}
	return data, nil
}

func normalizeMediaMIMEType(contentType, objectKey string, data []byte) string {
	if parsed, _, err := mime.ParseMediaType(strings.TrimSpace(contentType)); err == nil && parsed != "" {
		return parsed
	}
	if extensionType := mime.TypeByExtension(strings.ToLower(path.Ext(objectKey))); extensionType != "" {
		if parsed, _, err := mime.ParseMediaType(extensionType); err == nil && parsed != "" {
			return parsed
		}
	}
	return http.DetectContentType(data)
}

func downloadRemoteMedia(ctx context.Context, rawURL string) ([]byte, string, error) {
	parsed, err := validateRemoteMediaURL(rawURL)
	if err != nil {
		return nil, "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, "", errors.New("failed to build remote media request")
	}
	request.Header.Set("Accept-Encoding", "identity")

	client := newSafeMediaHTTPClient()
	if transport, ok := client.Transport.(*http.Transport); ok {
		defer transport.CloseIdleConnections()
	}
	response, err := client.Do(request)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) && urlErr.Err != nil {
			err = urlErr.Err
		}
		return nil, "", fmt.Errorf("remote media download failed: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, "", fmt.Errorf("remote media returned HTTP status %d", response.StatusCode)
	}
	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return nil, "", errors.New("remote media returned an unsupported content encoding")
	}
	data, err := readLimitedMedia(response.Body, response.ContentLength, maxMediaDownloadSize)
	if err != nil {
		return nil, "", fmt.Errorf("failed to read remote media: %w", err)
	}
	return data, normalizeMediaMIMEType(response.Header.Get("Content-Type"), parsed.Path, data), nil
}

func (p *DevicePool) loadMediaForUpload(ctx context.Context, accountID uuid.UUID, mediaURL string) ([]byte, string, error) {
	internalBaseURL := internalStorageBaseURL(p.cfg.MinioEndpoint, p.cfg.MinioUseSSL)
	objectKey, stored, err := mediaStorageObjectKey(
		mediaURL,
		p.cfg.MinioPublicURL,
		internalBaseURL,
		p.cfg.MinioBucket,
		accountID,
	)
	if err != nil {
		return nil, "", err
	}
	if !stored {
		return downloadRemoteMedia(ctx, mediaURL)
	}
	if p.storage == nil {
		return nil, "", errors.New("media storage is not configured")
	}

	info, err := p.storage.GetFileInfo(ctx, objectKey)
	if err != nil {
		return nil, "", fmt.Errorf("failed to inspect media in storage: %w", err)
	}
	if info.Size > maxMediaDownloadSize {
		return nil, "", fmt.Errorf("stored media exceeds the %d-byte upload limit", maxMediaDownloadSize)
	}
	data, err := p.storage.GetFile(ctx, objectKey)
	if err != nil {
		return nil, "", fmt.Errorf("failed to read media from storage: %w", err)
	}
	if int64(len(data)) > maxMediaDownloadSize {
		return nil, "", fmt.Errorf("stored media exceeds the %d-byte upload limit", maxMediaDownloadSize)
	}
	return data, normalizeMediaMIMEType(info.ContentType, objectKey, data), nil
}
