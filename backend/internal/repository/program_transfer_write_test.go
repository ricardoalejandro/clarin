package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/programtransfer"
)

type transferWriteTx struct {
	pgx.Tx
	query       string
	args        []any
	lookupQuery string
	lookupArgs  []any
	tag         pgconn.CommandTag
	err         error
}

func (tx *transferWriteTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.query, tx.args = sql, args
	return tx.tag, tx.err
}

type programTransferMissingAliasRow struct{}

func (programTransferMissingAliasRow) Scan(...any) error { return pgx.ErrNoRows }

func (tx *transferWriteTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	tx.lookupQuery, tx.lookupArgs = sql, args
	return programTransferMissingAliasRow{}
}

func TestProgramTransferWriteContactWithPendingIdentityUsesOnlyLocalAlias(t *testing.T) {
	account, program, actor, id := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	row := programtransfer.Record{Kind: "contact", ID: id.String(), Fields: map[string]any{
		"name": nil, "phone": nil, "email": nil, "additional_phones": []any{},
	}}
	tx := &transferWriteTx{tag: pgconn.NewCommandTag("INSERT 0 1")}
	if err := WriteProgramTransferRecord(context.Background(), tx, account, program, actor, row, true); err != nil {
		t.Fatalf("pending contact identity must not block historical participation: %v", err)
	}
	alias := "manual_" + id.String() + "@clarin.contact"
	if !strings.Contains(tx.query, "INSERT INTO contacts") || len(tx.args) != 3 || tx.args[0] != id || tx.args[1] != account || tx.args[2] != alias {
		t.Fatal("pending contact was not created with a fresh local identity in the destination account")
	}
	if len(tx.lookupArgs) != 2 || tx.lookupArgs[0] != account || tx.lookupArgs[1] != alias || !strings.Contains(tx.lookupQuery, "alias_type='jid'") {
		t.Fatal("an unverified contact must not be matched by a fabricated phone")
	}
}

func TestProgramTransferWriteUsesLocalScopeAndReportsStaleLink(t *testing.T) {
	account, program, actor, id := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	sessionID, participantID := uuid.NewString(), uuid.NewString()
	row := programtransfer.Record{Kind: "attendance", ID: id.String(), Fields: map[string]any{
		"session_id": sessionID, "participant_id": participantID, "status": "present",
	}}
	tx := &transferWriteTx{tag: pgconn.NewCommandTag("UPDATE 0")}
	if err := WriteProgramTransferRecord(context.Background(), tx, account, program, actor, row, false); !errors.Is(err, ErrProgramTransferRecordScope) {
		t.Fatalf("zero changed rows must invalidate the scoped transfer: %v", err)
	}
	for _, check := range []string{"ps.account_id=r.account_id", "ps.program_id=r.program_id", "pp.program_id=r.program_id", "pa.id=r.id"} {
		if !strings.Contains(tx.query, check) {
			t.Errorf("attendance mutation missing scope %q", check)
		}
	}
	if len(tx.args) != 5 || tx.args[0] != account || tx.args[1] != program || tx.args[2] != id || tx.args[3] != actor {
		t.Fatal("account, program and actor must come from the local import context")
	}
	var fields map[string]any
	if err := json.Unmarshal(tx.args[4].([]byte), &fields); err != nil || fields["session_id"] != sessionID || fields["participant_id"] != participantID {
		t.Fatalf("local references were not passed as parameter data: %v", err)
	}
	tx.tag = pgconn.NewCommandTag("UPDATE 1")
	if err := WriteProgramTransferRecord(context.Background(), tx, account, program, actor, row, false); err != nil {
		t.Fatalf("scoped write failed: %v", err)
	}
}

func TestProgramTransferWriteRejectsWrongProgramAndUnsupportedKindsBeforeSQL(t *testing.T) {
	account, program, actor := uuid.New(), uuid.New(), uuid.New()
	for _, row := range []programtransfer.Record{
		{Kind: "program", ID: uuid.NewString()},
		{Kind: "interaction", ID: "malformed"},
		{Kind: "unrelated", ID: uuid.NewString()},
	} {
		tx := &transferWriteTx{}
		if err := WriteProgramTransferRecord(context.Background(), tx, account, program, actor, row, true); !errors.Is(err, ErrProgramTransferRecordScope) || tx.query != "" {
			t.Errorf("unscoped %s record reached SQL: %v", row.Kind, err)
		}
	}
}

func TestProgramTransferExtraPhonesPromotesExistingSecondaryWithoutDuplicates(t *testing.T) {
	promoted, retained := uuid.New(), uuid.New()
	existing := []ContactProfileExtraPhonePatch{
		{ID: &promoted, Phone: "987654321", Label: "personal"},
		{ID: &retained, Phone: "51912345678", Label: "trabajo"},
	}
	phones, changed, err := mergeProgramTransferExtraPhones(existing, nil, "51987654321", true)
	if err != nil || !changed || len(phones) != 1 || phones[0].ID == nil || *phones[0].ID != retained {
		t.Fatalf("promotion alone must persist removal of the secondary copy and keep other numbers: %v", err)
	}
	phones, changed, err = mergeProgramTransferExtraPhones(existing, []transferContactPhone{
		{Phone: "+51 912 345 678", Label: "imported duplicate"},
		{Phone: "934567891", Label: "new"},
	}, "51987654321", true)
	if err != nil || !changed || len(phones) != 2 || phones[0].Label != "trabajo" || phones[1].Phone != "51934567891" {
		t.Fatalf("promotion and union must preserve local labels and add unique numbers: %v", err)
	}
}
