package whatsapp

import "testing"

func TestMediaDisplayFilename(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		preferred string
		rawURL    string
		want      string
	}{
		{name: "original browser filename", preferred: "contrato final.pdf", rawURL: "/api/media/file/account/uploads/hash.pdf", want: "contrato final.pdf"},
		{name: "strip path components", preferred: "../../contrato.pdf", want: "contrato.pdf"},
		{name: "strip windows path components", preferred: `C:\fakepath\reporte.xlsx`, want: "reporte.xlsx"},
		{name: "fallback to URL path", rawURL: "https://media.example.test/uploads/manual.pdf?token=ignored", want: "manual.pdf"},
		{name: "safe empty fallback", want: "documento"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := mediaDisplayFilename(tt.preferred, tt.rawURL); got != tt.want {
				t.Fatalf("mediaDisplayFilename(%q, %q) = %q, want %q", tt.preferred, tt.rawURL, got, tt.want)
			}
		})
	}
}
