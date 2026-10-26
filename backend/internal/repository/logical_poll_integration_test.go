package repository

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"testing"
	"time"
)

func logicalPollFixture(t *testing.T, pool *pgxpool.Pool) continuityMediaFixture {
	t.Helper()
	f := continuityMediaTree(t, pool)
	integrityExec(t, pool, `UPDATE messages SET message_type='poll',media_mimetype=NULL,body='Synthetic poll' WHERE account_id=$1`, f.account)
	return f
}
func logicalPollVote(t *testing.T, pool *pgxpool.Pool, message uuid.UUID, voter string, names []string, at time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `INSERT INTO poll_votes(message_id,voter_jid,selected_names,timestamp) VALUES($1,$2,$3,$4)`, message, voter, names, at); err != nil {
		t.Fatal(err)
	}
}
func logicalPollOptions(t *testing.T, pool *pgxpool.Pool, message uuid.UUID) {
	t.Helper()
	integrityExec(t, pool, `INSERT INTO poll_options(message_id,name,vote_count) VALUES($1,'One',99),($1,'Two',99)`, message)
}
func assertLogicalPollCounts(t *testing.T, options []*domain.PollOption, one, two int) {
	t.Helper()
	if len(options) != 2 {
		t.Fatalf("poll lost option definitions: %+v", options)
	}
	counts := map[string]int{}
	for _, o := range options {
		counts[o.Name] = o.VoteCount
	}
	if counts["One"] != one || counts["Two"] != two {
		t.Fatalf("merged counts %v, want %d/%d", counts, one, two)
	}
}

func TestLogicalPollKeepsOldOptionsAndVotesBehindCurrentPlaceholder(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := logicalPollFixture(t, pool)
	r := NewRepositories(pool).Poll
	ctx := context.Background()
	logicalPollOptions(t, pool, f.oldMessage)
	logicalPollVote(t, pool, f.oldMessage, "51900000202@s.whatsapp.net", []string{"One"}, time.Now())
	reconcileContinuityMedia(t, pool, f)
	for _, id := range []uuid.UUID{f.oldMessage, f.currentMessage} {
		options, err := r.GetOptions(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		assertLogicalPollCounts(t, options, 1, 0)
		votes, err := r.GetVotes(ctx, id)
		if err != nil || len(votes) != 1 {
			t.Fatalf("historical votes disappeared: %+v %v", votes, err)
		}
	}
}

func TestLogicalPollMergesPartialSnapshotsNewestVerifiedVoterAndIsolation(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := logicalPollFixture(t, pool)
	ctx := context.Background()
	repos := NewRepositories(pool)
	logicalPollOptions(t, pool, f.oldMessage)
	logicalPollOptions(t, pool, f.currentMessage)
	privatePeerProof(t, pool, f.account, f.device, "51900000202@s.whatsapp.net", "70202@lid")
	if _, err := repos.Chat.BindWhatsAppOwner(ctx, f.account, f.device, "51900000201@s.whatsapp.net", "70201@lid", "synthetic-private-session"); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	for _, v := range []struct {
		message uuid.UUID
		jid     string
		names   []string
		later   bool
	}{
		{f.oldMessage, "70202@lid", []string{"One"}, false}, {f.currentMessage, "51900000202@s.whatsapp.net", []string{"Two"}, true},
		{f.oldMessage, "51900000203@s.whatsapp.net", []string{"One"}, false}, {f.currentMessage, "51900000203@s.whatsapp.net", []string{"One", "Two"}, true},
		{f.oldMessage, "70201@lid", []string{"Two"}, false}, {f.currentMessage, "51900000201@s.whatsapp.net", []string{"One"}, true},
		{f.oldMessage, "70204@lid", []string{"One"}, false}, {f.currentMessage, "51900000204@s.whatsapp.net", []string{"Two"}, true},
		{f.oldMessage, "51900000205@s.whatsapp.net", []string{"One"}, false}, {f.currentMessage, "51900000205@s.whatsapp.net", []string{}, true},
	} {
		at := base
		if v.later {
			at = base.Add(time.Minute)
		}
		logicalPollVote(t, pool, v.message, v.jid, v.names, at)
	}
	// Another account observed the otherwise-unproven pair. It must neither
	// collapse these two voters nor add any of its own poll votes.
	foreign := logicalPollFixture(t, pool)
	privatePeerProof(t, pool, foreign.account, foreign.device, "51900000204@s.whatsapp.net", "70204@lid")
	if _, err := repos.Chat.BindWhatsAppOwner(ctx, foreign.account, foreign.device, "51900000201@s.whatsapp.net", "70201@lid", "synthetic-private-session"); err != nil {
		t.Fatal(err)
	}
	logicalPollVote(t, pool, foreign.oldMessage, "51900000206@s.whatsapp.net", []string{"Two"}, base.Add(2*time.Minute))
	reconcileContinuityMedia(t, pool, f)
	for _, id := range []uuid.UUID{f.oldMessage, f.currentMessage} {
		options, err := repos.Poll.GetOptions(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		assertLogicalPollCounts(t, options, 3, 3)
		votes, err := repos.Poll.GetVotes(ctx, id)
		if err != nil || len(votes) != 6 {
			t.Fatalf("votes were summed or foreign proof leaked: %+v %v", votes, err)
		}
		foundCorrection := false
		for _, v := range votes {
			if v.VoterJID == "51900000205@s.whatsapp.net" {
				foundCorrection = true
				if len(v.SelectedNames) != 0 {
					t.Fatal("an older snapshot resurrected a withdrawn selection")
				}
			}
		}
		if !foundCorrection {
			t.Fatal("empty latest selection was lost")
		}
	}
	var votes, options int
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM poll_votes WHERE message_id IN(SELECT id FROM messages WHERE account_id=$1)`, f.account, &votes)
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM poll_options WHERE message_id IN(SELECT id FROM messages WHERE account_id=$1) AND vote_count=99`, f.account, &options)
	if votes != 10 || options != 4 {
		t.Fatal("projection rewrote physical poll history or cached snapshots")
	}
	if _, err := repos.Chat.EnsureWhatsAppIdentitySession(ctx, f.account, f.device, "new-poll-session"); err != nil {
		t.Fatal(err)
	}
	current, err := repos.Poll.GetVotes(ctx, f.oldMessage)
	if err != nil || len(current) != 7 {
		t.Fatalf("replaced session still legitimized peer PN/LID: %d %v", len(current), err)
	}
}
