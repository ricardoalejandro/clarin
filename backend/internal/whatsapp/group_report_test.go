package whatsapp

import "testing"

func TestNormalizeGroupReportPhone(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "international", in: "+51 987-654-321", want: "51987654321"},
		{name: "peru local", in: "987654321", want: "51987654321"},
		{name: "jid user", in: "51987654321", want: "51987654321"},
		{name: "empty", in: "anonymous", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeGroupReportPhone(tt.in); got != tt.want {
				t.Fatalf("normalizeGroupReportPhone(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
