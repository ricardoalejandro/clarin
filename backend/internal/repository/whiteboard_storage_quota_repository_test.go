package repository

import "testing"

func TestWhiteboardQuotaDeltaCountsOnlyNewReservedBytes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name                string
		requested, existing int64
		status              string
		exists              bool
		want                int64
	}{
		{name: "new", requested: 100, want: 100},
		{name: "active dedupe", requested: 100, existing: 100, status: "active", exists: true, want: 0},
		{name: "pending retry", requested: 90, existing: 100, status: "whiteboard_upload_pending", exists: true, want: 0},
		{name: "larger replacement", requested: 140, existing: 100, status: "whiteboard_snapshot_pending", exists: true, want: 40},
		{name: "deleted object", requested: 100, existing: 100, status: "deleted", exists: true, want: 100},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := whiteboardQuotaDelta(test.requested, test.existing, test.status, test.exists); got != test.want {
				t.Fatalf("quota delta = %d, want %d", got, test.want)
			}
		})
	}
}
