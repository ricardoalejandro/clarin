package api

import "testing"

func TestParseProgramAttendanceHistoryLimit(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want int
	}{
		{raw: "", want: 25},
		{raw: " 25 ", want: 25},
		{raw: "1", want: 1},
		{raw: "50", want: 50},
	} {
		got, err := parseProgramAttendanceHistoryLimit(test.raw)
		if err != nil || got != test.want {
			t.Fatalf("parse limit %q = %d, %v; want %d", test.raw, got, err, test.want)
		}
	}
	for _, raw := range []string{"0", "51", "-1", "abc", "1.5"} {
		if _, err := parseProgramAttendanceHistoryLimit(raw); err == nil {
			t.Fatalf("expected limit %q to fail", raw)
		}
	}
}
