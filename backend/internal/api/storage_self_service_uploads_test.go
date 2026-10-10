package api

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOwnUploadEligibilityRequiresDurableOwnershipAndCompletedAge(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	actor := uuid.New()
	owner := storageUploadOwnership{ID: uuid.New(), ActorID: actor, Version: 1, State: "active", Verified: true, UploadedAt: now.Add(-24 * time.Hour)}
	for _, tc := range []struct {
		name       string
		mutate     func(*storageUploadOwnership)
		actor      uuid.UUID
		referenced bool
		want       bool
	}{
		{"exactly 24 hours", func(*storageUploadOwnership) {}, actor, false, true},
		{"newer by one nanosecond", func(o *storageUploadOwnership) { o.UploadedAt = o.UploadedAt.Add(time.Nanosecond) }, actor, false, false},
		{"not verified", func(o *storageUploadOwnership) { o.Verified = false }, actor, false, false},
		{"another actor", func(*storageUploadOwnership) {}, uuid.New(), false, false},
		{"already attached", func(o *storageUploadOwnership) { o.State = "attached" }, actor, false, false},
		{"already removed", func(o *storageUploadOwnership) { o.State = "removed" }, actor, false, false},
		{"new business reference", func(*storageUploadOwnership) {}, actor, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			copy := owner
			tc.mutate(&copy)
			got, reason := storageOwnUploadEligible(copy, tc.actor, tc.referenced, now)
			if got != tc.want || (!got && reason == "") {
				t.Fatalf("eligible=%v reason=%q", got, reason)
			}
		})
	}
}

func TestOwnUploadFingerprintInvalidatesReviewAfterReupload(t *testing.T) {
	owner := storageUploadOwnership{ID: uuid.New(), ActorID: uuid.New(), Version: 1, State: "active", Verified: true, UploadedAt: time.Now()}
	before := storageUseFingerprint(owner)
	owner.Version++
	if storageUseFingerprint(owner) == before {
		t.Fatal("a reupload must invalidate the old review even if the bytes do not change")
	}
}
