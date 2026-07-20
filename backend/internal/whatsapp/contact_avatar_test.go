package whatsapp

import (
	"errors"
	"fmt"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

func TestClassifyProfilePictureLookup(t *testing.T) {
	tests := []struct {
		name     string
		picture  *types.ProfilePictureInfo
		err      error
		wantCode string
	}{
		{name: "visible photo", picture: &types.ProfilePictureInfo{URL: "https://example.invalid/avatar.jpg"}},
		{name: "not set", err: whatsmeow.ErrProfilePictureNotSet, wantCode: ProfilePictureCodeNotSet},
		{name: "not set wrapped", err: fmt.Errorf("lookup: %w", whatsmeow.ErrProfilePictureNotSet), wantCode: ProfilePictureCodeNotSet},
		{name: "private", err: whatsmeow.ErrProfilePictureUnauthorized, wantCode: ProfilePictureCodePrivate},
		{name: "provider failure", err: errors.New("temporary provider failure"), wantCode: ProfilePictureCodeUnavailable},
		{name: "missing response", picture: nil, wantCode: ProfilePictureCodeNotSet},
		{name: "blank url", picture: &types.ProfilePictureInfo{URL: "  "}, wantCode: ProfilePictureCodeNotSet},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			err := classifyProfilePictureLookup(testCase.picture, testCase.err)
			if testCase.wantCode == "" {
				if err != nil {
					t.Fatalf("classifyProfilePictureLookup() error = %v", err)
				}
				return
			}
			if got := ProfilePictureErrorCode(err); got != testCase.wantCode {
				t.Fatalf("ProfilePictureErrorCode() = %q, want %q", got, testCase.wantCode)
			}
		})
	}
}

func TestProfilePictureEmptyCodes(t *testing.T) {
	if !IsProfilePictureEmptyCode(ProfilePictureCodeNotSet) {
		t.Fatal("not-set photo must be treated as an empty result")
	}
	if !IsProfilePictureEmptyCode(ProfilePictureCodePrivate) {
		t.Fatal("private photo must be treated as an empty result")
	}
	if IsProfilePictureEmptyCode(ProfilePictureCodeUnavailable) {
		t.Fatal("provider failure must not be treated as an empty result")
	}
}
