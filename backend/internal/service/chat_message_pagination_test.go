package service

import "testing"

func TestMessageHistoryPaginationBounds(t *testing.T) {
	for _, tc := range []struct{ limit, offset, wantLimit, wantOffset int }{
		{0, 0, 50, 0}, {-1, -5, 50, 0}, {500, 50, 200, 50}, {49, 220, 49, 220}, {200, 0, 200, 0},
	} {
		limit, offset := NormalizeMessagePagination(tc.limit, tc.offset)
		if limit != tc.wantLimit || offset != tc.wantOffset {
			t.Fatalf("pagination(%d,%d)=(%d,%d), want(%d,%d)", tc.limit, tc.offset, limit, offset, tc.wantLimit, tc.wantOffset)
		}
	}
}
