package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

// HTTP supports multiple ranges, but this endpoint deliberately accepts one.
// Reject malformed and unsatisfiable ranges instead of sending unintended bytes.
func storageByteRange(raw string, size int64) (start, length int64, err error) {
	if size <= 0 || !strings.HasPrefix(raw, "bytes=") || strings.Contains(raw, ",") {
		return 0, 0, fmt.Errorf("invalid range")
	}
	value := strings.TrimPrefix(raw, "bytes=")
	parts := strings.Split(value, "-")
	if len(parts) != 2 || (parts[0] == "" && parts[1] == "") {
		return 0, 0, fmt.Errorf("invalid range")
	}
	parse := func(value string) (int64, error) {
		if value == "" || strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			return 0, fmt.Errorf("invalid range")
		}
		return strconv.ParseInt(value, 10, 64)
	}
	if parts[0] == "" {
		suffix, e := parse(parts[1])
		if e != nil || suffix <= 0 {
			return 0, 0, fmt.Errorf("invalid suffix")
		}
		if suffix > size {
			suffix = size
		}
		return size - suffix, suffix, nil
	}
	start, err = parse(parts[0])
	if err != nil || start >= size {
		return 0, 0, fmt.Errorf("invalid start")
	}
	end := size - 1
	if parts[1] != "" {
		end, err = parse(parts[1])
		if err != nil || end < start {
			return 0, 0, fmt.Errorf("invalid end")
		}
		if end >= size {
			end = size - 1
		}
	}
	return start, end - start + 1, nil
}

func storageIfRangeMatches(value, etag string, modified time.Time) bool {
	if value == "" || value == etag {
		return true
	}
	if strings.HasPrefix(value, "W/") || strings.HasPrefix(value, "\"") {
		return false
	}
	date, err := http.ParseTime(value)
	return err == nil && !modified.Truncate(time.Second).After(date)
}

// Fiber owns and closes response streams after completion or disconnect. Never
// defer cancellation in the handler: that would cancel before the body is sent.
type storageResponseStream struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (s *storageResponseStream) Close() error { defer s.cancel(); return s.ReadCloser.Close() }

func (s *Server) sendStorageStream(c *fiber.Ctx, key string, size int64, etag, providerETag string, modified time.Time) error {
	start, length := int64(0), size
	if raw := c.Get(fiber.HeaderRange); raw != "" && storageIfRangeMatches(c.Get(fiber.HeaderIfRange), etag, modified) {
		var err error
		start, length, err = storageByteRange(raw, size)
		if err != nil {
			c.Set(fiber.HeaderContentRange, fmt.Sprintf("bytes */%d", size))
			return c.Status(fiber.StatusRequestedRangeNotSatisfiable).Send(nil)
		}
		c.Status(fiber.StatusPartialContent)
		c.Set(fiber.HeaderContentRange, fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, size))
	}
	c.Set(fiber.HeaderContentLength, strconv.FormatInt(length, 10))
	if c.Method() == fiber.MethodHead || length == 0 {
		return c.Send(nil)
	}
	// The body outlives the handler's authorization deadline. Its independent,
	// bounded context ends on stream Close, including client disconnection.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	reader, err := s.storage.OpenFileRange(ctx, key, start, length, providerETag)
	if err != nil {
		cancel()
		return storageObjectReadError(c, err)
	}
	return c.SendStream(&storageResponseStream{ReadCloser: reader, cancel: cancel}, int(length))
}
