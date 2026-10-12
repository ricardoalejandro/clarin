package repository

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestLogbookShortNameIdentityConvergesAcrossCaptureAndExport(t *testing.T) {
	pool := eventLogbookPool(t)
	r := &LogbookRepository{db: pool}
	ctx := context.Background()
	f := eventLogbookFixture(t, pool)
	// A Contact may have a valid short_name while all higher-priority names are blank.
	// Participant identity is deliberately stale and must never override Contact.
	logbookExec(t, pool, `UPDATE contacts c SET custom_name='', name=' ', push_name='', short_name='  Ana  ', phone='5550100' FROM event_participants ep WHERE ep.contact_id=c.id AND ep.id=$1`, f.alpha)
	lb := createTestLogbook(t, r, f, "2026-10-12")
	var err error
	lb, err = r.Update(ctx, f.account, f.event, lb.ID, LogbookPatch{
		ExpectedVersion:    lb.Version,
		SavedFilterPresent: true,
		SavedFilter:        json.RawMessage(`{"text_search":"Ana"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := r.PreviewPage(ctx, f.account, f.event, lb.ID, LogbookPageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if preview.Total != 1 || len(preview.Items) != 1 || preview.Items[0].ParticipantID != f.alpha || preview.Items[0].ParticipantName != "Ana" {
		t.Fatalf("short-name audience missing from preview: %#v", preview)
	}
	lb, err = r.CaptureSnapshot(ctx, f.account, f.event, lb.ID, nil, LogbookWriteOptions{ExpectedVersion: lb.Version})
	if err != nil {
		t.Fatal(err)
	}
	if lb.TotalParticipants != 1 || len(lb.Entries) != 1 || lb.Entries[0].ParticipantName != "Ana" {
		t.Fatalf("captured audience differs from preview: %#v", lb)
	}
	entries, err := r.EntriesPage(ctx, f.account, f.event, lb.ID, LogbookPageOptions{Search: "Ana"})
	if err != nil {
		t.Fatal(err)
	}
	if entries.Total != 1 || len(entries.Items) != 1 || entries.Items[0].ParticipantName != "Ana" {
		t.Fatalf("entry search lost short-name identity: %#v", entries)
	}
	// CSV and XLSX export both consume this stream.
	var exported []*domain.EventLogbookEntry
	err = r.StreamEntries(ctx, f.account, f.event, lb.ID, lb.Version, func(entry *domain.EventLogbookEntry) error {
		exported = append(exported, entry)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(exported) != 1 || exported[0].ParticipantID != f.alpha || exported[0].ParticipantName != "Ana" {
		t.Fatalf("export identity differs from captured audience: %#v", exported)
	}
}
