package whatsapp

import (
	"github.com/google/uuid"
	"testing"
)

func TestCRMIdentityRevisionNoticesAreMonotonicAndAccountScoped(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	seen := map[uuid.UUID]int64{}
	if advanceCRMIdentityRevision(seen, a, 0) {
		t.Fatal("initial baseline notified")
	}
	if advanceCRMIdentityRevision(seen, b, 9) {
		t.Fatal("other account borrowed baseline")
	}
	if !advanceCRMIdentityRevision(seen, a, 1) {
		t.Fatal("committed change not notified")
	}
	for _, v := range []int64{1, 0, -1} {
		if advanceCRMIdentityRevision(seen, a, v) {
			t.Fatal("old revision notified")
		}
	}
	if seen[b] != 9 || !advanceCRMIdentityRevision(seen, b, 10) || seen[a] != 1 {
		t.Fatal("account states mixed")
	}
}
