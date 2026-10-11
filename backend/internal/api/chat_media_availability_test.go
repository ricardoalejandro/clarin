package api

import (
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"testing"
)

func TestChatMediaAvailabilityBatchIsolationAndExactURLs(t *testing.T) {
	account, foreign := uuid.New(), uuid.New()
	removed := account.String() + "/uploads/photo one%20.png"
	active := account.String() + "/uploads/active.png"
	s := &Server{}
	makeMessage := func(owner uuid.UUID, raw string) *domain.Message {
		return &domain.Message{AccountID: owner, MediaURL: &raw, MediaFilename: strPtr("kept.png")}
	}
	rows := []*domain.Message{
		makeMessage(account, "/api/media/file/"+account.String()+"/uploads/photo%20one%2520.png"),
		makeMessage(account, "/api/media/file/"+account.String()+"/uploads/photo%20one%2520.png?preview=old"),
		makeMessage(account, "/api/media/file/"+active),
		makeMessage(account, "https://unrelated.invalid/api/media/file/"+removed),
		makeMessage(foreign, "/api/media/file/"+removed),
		makeMessage(account, "/api/media/file/"+foreign.String()+"/uploads/foreign.png"),
		nil,
	}
	calls := 0
	err := projectChatMediaAvailability(context.Background(), account, rows, s.ordinaryObjectKeyFromURL, func(_ context.Context, id uuid.UUID, keys []string) (map[string]bool, error) {
		calls++
		if id != account || len(keys) != 2 || keys[0] != removed || keys[1] != active {
			t.Fatalf("wrong lookup scope/keys: %s %v", id, keys)
		}
		return map[string]bool{removed: true}, nil
	})
	if err != nil || calls != 1 {
		t.Fatalf("projection: calls=%d err=%v", calls, err)
	}
	for _, index := range []int{0, 1} {
		if !rows[index].MediaDeleted || rows[index].MediaURL != nil || *rows[index].MediaFilename != "kept.png" {
			t.Fatalf("deleted projection %d", index)
		}
	}
	for _, index := range []int{2, 3, 4, 5} {
		if rows[index].MediaDeleted || rows[index].MediaURL == nil {
			t.Fatalf("unrelated/active changed: %d", index)
		}
	}
}

func TestChatMediaAvailabilityBoundedFailureDoesNotPartiallyProject(t *testing.T) {
	account := uuid.New()
	s := &Server{}
	rows := make([]*domain.Message, 201)
	for i := range rows {
		raw := fmt.Sprintf("/api/media/file/%s/uploads/%d.png", account, i)
		rows[i] = &domain.Message{AccountID: account, MediaURL: &raw}
	}
	calls := 0
	err := projectChatMediaAvailability(context.Background(), account, rows, s.ordinaryObjectKeyFromURL, func(_ context.Context, _ uuid.UUID, keys []string) (map[string]bool, error) {
		calls++
		if len(keys) > 200 {
			t.Fatal("unbounded lookup")
		}
		if calls == 2 {
			return nil, errors.New("inventory unavailable")
		}
		return map[string]bool{keys[0]: true}, nil
	})
	if err == nil || calls != 2 {
		t.Fatalf("wanted bounded error: %d %v", calls, err)
	}
	for _, row := range rows {
		if row.MediaDeleted || row.MediaURL == nil {
			t.Fatal("partial projection on lookup failure")
		}
	}
}

func TestChatMediaAvailabilityDoesNotLookUpTextOrKnownDeleted(t *testing.T) {
	account := uuid.New()
	raw := "/api/media/file/" + account.String() + "/uploads/removed.png"
	row := &domain.Message{AccountID: account, MediaURL: &raw, MediaDeleted: true}
	err := projectChatMediaAvailability(context.Background(), account, []*domain.Message{{AccountID: account}, row}, (&Server{}).ordinaryObjectKeyFromURL, func(context.Context, uuid.UUID, []string) (map[string]bool, error) {
		t.Fatal("unexpected inventory query")
		return nil, nil
	})
	if err != nil || row.MediaURL != nil || !row.MediaDeleted {
		t.Fatal("known deletion must suppress URL")
	}
}
