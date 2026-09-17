//go:build !windows

package principalpipe

import (
	"context"
	"errors"
)

const Name = "clarin-offline-v3-principal-unavailable"

type CompleteFunc func(ctx context.Context, challengeID, windowsSID, displayName string) error

func Serve(context.Context, string, CompleteFunc) error {
	return errors.New("Windows named pipe unavailable")
}
func Complete(string) error               { return errors.New("Windows named pipe unavailable") }
func ExpectedHelperPath() (string, error) { return "", errors.New("Windows helper unavailable") }
