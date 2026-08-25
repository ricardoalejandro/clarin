package service

import (
	"errors"
	"slices"
	"testing"
)

func TestNormalizeProgramHealthViewColumns(t *testing.T) {
	tests := []struct {
		name    string
		input   []string
		want    []string
		wantErr bool
	}{
		{name: "nil gets defaults", input: nil, want: []string{"health", "attendance", "signals"}},
		{name: "empty is valid", input: []string{}, want: []string{}},
		{name: "canonicalizes order and duplicates", input: []string{"tenure", "health", "enrolled_at", "health"}, want: []string{"health", "enrolled_at", "tenure"}},
		{name: "all values", input: []string{"signals", "tenure", "attendance", "enrolled_at", "health"}, want: []string{"health", "attendance", "signals", "enrolled_at", "tenure"}},
		{name: "unknown is invalid", input: []string{"health", "phone"}, wantErr: true},
		{name: "blank is invalid", input: []string{" "}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeProgramHealthViewColumns(test.input)
			if test.wantErr {
				if !errors.Is(err, ErrProgramInput) {
					t.Fatalf("expected ErrProgramInput, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalize columns: %v", err)
			}
			if !slices.Equal(got, test.want) {
				t.Fatalf("normalize columns = %#v, want %#v", got, test.want)
			}
		})
	}
}
