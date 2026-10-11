package api

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/storage"
)

type storageSelectedQueryProbe struct {
	calls   int
	account uuid.UUID
	needles []string
}

func (p *storageSelectedQueryProbe) Query(ctx context.Context, _ string, args ...any) (pgx.Rows, error) {
	p.calls++
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p.account = args[0].(uuid.UUID)
	p.needles = args[1].([]string)
	return nil, errors.New("selected reference query reached database")
}
func (*storageSelectedQueryProbe) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("unexpected row query")
}

func TestStorageReviewCollectsFortySelectedReferencesOnce(t *testing.T) {
	account := uuid.New()
	probe := &storageSelectedQueryProbe{}
	selection := storageUseSelection{Action: "trash"}
	for i := 0; i < 40; i++ {
		selection.Targets = append(selection.Targets, storageUseTarget{ObjectKey: fmt.Sprintf("%s/chat/file-%d.pdf", account, i), Mode: "file"})
	}
	_, err := (&Server{}).storageReviewReferenceContext(context.Background(), probe, storageUseActor{AccountID: account}, selection)
	if err == nil || probe.calls != 1 || probe.account != account || len(probe.needles) != 40 {
		t.Fatalf("selected review must issue one account-scoped reference query; calls=%d", probe.calls)
	}
	for _, bad := range []storageUseSelection{
		{Action: "trash", Targets: []storageUseTarget{{ObjectKey: uuid.New().String() + "/foreign.pdf", Mode: "file"}}},
		{Action: "trash", Targets: []storageUseTarget{{ObjectKey: account.String() + "/chat/file.pdf", Mode: "file"}, {ObjectKey: account.String() + "/chat/file.pdf", Mode: "file"}}},
		{Action: "trash", Targets: []storageUseTarget{{ObjectKey: account.String() + "/chat/file.pdf", Mode: "unknown"}}},
	} {
		before := probe.calls
		if _, err = (&Server{}).storageReviewReferenceContext(context.Background(), probe, storageUseActor{AccountID: account}, bad); !errors.Is(err, errStorageUseProtected) || probe.calls != before {
			t.Fatal("invalid or foreign selection reached reference query")
		}
	}
}

func TestStorageSelectedReferenceSnapshotNeverCrossesItsReadPhase(t *testing.T) {
	account, foreign := uuid.New(), uuid.New()
	key := account.String() + "/chat/file.pdf"
	probe := &storageSelectedQueryProbe{}
	refs := []storageSelfServiceReference{{Origin: "chats", ID: uuid.NewString()}}
	ctx := context.WithValue(context.Background(), storageSelectedReferenceSnapshotKey{}, &storageSelectedReferenceSnapshot{account: account, querier: probe, stores: []*storage.Storage{nil}, refs: map[string][]storageSelfServiceReference{key: refs}})
	got, err := storageSelfServiceObjectReferences(ctx, probe, account, key, nil)
	if err != nil || len(got) != 1 || probe.calls != 0 {
		t.Fatal("read phase did not reuse its selected references")
	}
	if _, ok := storageSelectedReferences(ctx, probe, foreign, foreign.String()+"/chat/file.pdf", nil); ok {
		t.Fatal("reference snapshot crossed account")
	}
	if _, ok := storageSelectedReferences(ctx, &storageSelectedQueryProbe{}, account, key, nil); ok {
		t.Fatal("reference snapshot crossed database/transaction")
	}
	if _, ok := storageSelectedReferences(ctx, probe, account, account.String()+"/chat/other.pdf", nil); ok {
		t.Fatal("snapshot asserted absence for a key it did not load")
	}
	if _, ok := storageSelectedReferences(ctx, probe, account, key); ok {
		t.Fatal("snapshot crossed storage-origin context")
	}
	if _, ok := storageSelectedReferences(context.Background(), probe, account, key, nil); ok {
		t.Fatal("snapshot survived its read phase")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, ok := storageSelectedReferences(cancelled, probe, account, key, nil); ok {
		t.Fatal("cancelled work reused cached references")
	}
}

func TestStorageMissingReviewNeverInventsBytesOrRemovals(t *testing.T) {
	key := uuid.NewString() + "/chat/missing.pdf"
	uses := []storageSelfServiceUse{{UseID: "one", Filename: "Documento.pdf", Fingerprint: "before"}}
	refs := []storageSelfServiceReference{{Origin: "chats", ID: "message"}}
	item := storageMissingUseReviewItem(key, uses, refs)
	if item.Eligible || item.SizeBytes != 0 || item.TrashBytes != 0 || item.EstimatedFreedBytes != 0 || item.RemovedUses != 0 || item.WillTrash || len(item.UseIDs) != 0 || item.Filename != "Documento.pdf" || item.MediaType != "document" || item.Reason == "" {
		t.Fatal("physically absent object offered a mutation or invented bytes")
	}
	uses[0].Fingerprint = "changed"
	if storageMissingUseReviewItem(key, uses, refs).Fingerprint == item.Fingerprint {
		t.Fatal("changed business use did not invalidate blocked review")
	}
}

func TestStorageReviewDistinguishesConflictsFromOperationalFailures(t *testing.T) {
	for _, err := range []error{errStorageUseProtected, errStorageUseChanged, pgx.ErrNoRows, fmt.Errorf("wrapped: %w", errStorageUseChanged)} {
		if !storageUseSelectionConflict(err) {
			t.Fatal("real selection conflict lost its409classification")
		}
	}
	for _, err := range []error{context.DeadlineExceeded, context.Canceled, errors.New("database unavailable"), errors.New("object store offline"), nil} {
		if storageUseSelectionConflict(err) {
			t.Fatal("operational failure was misreported as a changed selection")
		}
	}
}
