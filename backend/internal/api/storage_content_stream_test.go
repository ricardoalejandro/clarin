package api

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestStorageByteRange(t *testing.T) {
	for _, tc := range []struct {
		raw                 string
		size, start, length int64
		valid               bool
	}{
		{"bytes=0-0", 100, 0, 1, true}, {"bytes=10-19", 100, 10, 10, true}, {"bytes=10-", 100, 10, 90, true},
		{"bytes=-10", 100, 90, 10, true}, {"bytes=-200", 100, 0, 100, true}, {"bytes=90-200", 100, 90, 10, true},
		{"bytes=-0", 100, 0, 0, false}, {"bytes=100-", 100, 0, 0, false}, {"bytes=4-3", 100, 0, 0, false},
		{"bytes=a-4", 100, 0, 0, false}, {"bytes=0x10-20", 100, 0, 0, false}, {"items=0-1", 100, 0, 0, false},
		{"bytes=0-1,3-4", 100, 0, 0, false}, {"bytes=--1", 100, 0, 0, false}, {"bytes=0-", 0, 0, 0, false},
		{"bytes=9223372036854775808-", 100, 0, 0, false}, {"bytes=0- 4", 100, 0, 0, false},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			start, length, err := storageByteRange(tc.raw, tc.size)
			if (err == nil) != tc.valid || (tc.valid && (start != tc.start || length != tc.length)) {
				t.Fatalf("range=%d,%d,%v", start, length, err)
			}
		})
	}
}
func TestStorageIfRange(t *testing.T) {
	modified := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		value string
		want  bool
	}{{"", true}, {"\"same\"", true}, {"\"old\"", false}, {"W/\"same\"", false}, {"Sun, 11 Oct 2026 12:00:00 GMT", true}, {"Sun, 11 Oct 2026 11:59:59 GMT", false}, {"invalid", false}} {
		if got := storageIfRangeMatches(tc.value, "\"same\"", modified); got != tc.want {
			t.Fatalf("If-Range %q=%v", tc.value, got)
		}
	}
}

type storageCloseProbe struct {
	*strings.Reader
	closed bool
}

func (p *storageCloseProbe) Close() error { p.closed = true; return errors.New("close sentinel") }
func TestStorageResponseStreamCancelsAndCloses(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reader := &storageCloseProbe{Reader: strings.NewReader("data")}
	stream := &storageResponseStream{ReadCloser: reader, cancel: cancel}
	if stream.Close() == nil || !reader.closed || ctx.Err() != context.Canceled {
		t.Fatal("stream leaked body/context")
	}
}
