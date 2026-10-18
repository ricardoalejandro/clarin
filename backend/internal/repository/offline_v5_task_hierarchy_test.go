package repository

import "testing"

func TestOfflineV5TaskAccessNeverRaisesChildGrant(t *testing.T) {
	for _, test := range []struct {
		rank          int
		edit, comment bool
		level         string
	}{
		{0, true, true, "none"}, {1, true, true, "view"}, {2, true, true, "comment"},
		{3, true, true, "edit"}, {3, true, false, "edit"}, {4, true, true, "edit"}, {4, false, true, "comment"}, {4, false, false, "view"},
	} {
		actual := offlineV5TaskAccess(test.rank, test.edit, test.comment)
		if actual.Level != test.level || actual.CanManageAccess || actual.CanDelete || actual.CanComment && !test.comment {
			t.Fatalf("offline access escaped grant: %#v => %#v", test, actual)
		}
	}
}
