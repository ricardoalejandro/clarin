package repository

import (
	"encoding/json"
	"errors"
	"testing"
)

type programListRowsStub struct {
	remaining   int
	scanErr     error
	terminalErr error
}

func (rows *programListRowsStub) Next() bool {
	if rows.remaining == 0 {
		return false
	}
	rows.remaining--
	return true
}
func (rows *programListRowsStub) Scan(...any) error { return rows.scanErr }
func (rows *programListRowsStub) Err() error        { return rows.terminalErr }

func TestProgramListEmptySerializesAsArray(t *testing.T) {
	programs, err := scanProgramList(&programListRowsStub{})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(programs)
	if err != nil || string(encoded) != "[]" {
		t.Fatalf("empty list = %s, %v", encoded, err)
	}
}

func TestProgramListRejectsScanAndTerminalErrors(t *testing.T) {
	want := errors.New("interrupted query")
	for _, rows := range []*programListRowsStub{
		{remaining: 1, scanErr: want},
		{remaining: 1, terminalErr: want},
		{terminalErr: want},
	} {
		programs, err := scanProgramList(rows)
		if !errors.Is(err, want) || programs != nil {
			t.Fatalf("partial list accepted: %#v, %v", programs, err)
		}
	}
}
