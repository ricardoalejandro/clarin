package api

import "testing"

func TestIsCommercialDisinterestReason(t *testing.T) {
	tests := []struct {
		reason string
		want   bool
	}{
		{"No está interesado", true},
		{"  NO   ESTA INTERESADA en este curso ", true},
		{"Cliente no está interesado por ahora", true},
		{"Solicitó no recibir más mensajes", false},
		{"Número equivocado", false},
	}
	for _, test := range tests {
		if got := isCommercialDisinterestReason(test.reason); got != test.want {
			t.Errorf("isCommercialDisinterestReason(%q)=%v, want %v", test.reason, got, test.want)
		}
	}
}
