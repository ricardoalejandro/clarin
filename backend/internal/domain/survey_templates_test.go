package domain

import "testing"

func TestSurveyInstanceNameNormalizationCollapsesWhitespaceAndCase(t *testing.T) {
	first := SurveyInstanceNameKey("  Conócete   a ti Mismo  ")
	second := SurveyInstanceNameKey("CONÓCETE A TI MISMO")
	if first != second {
		t.Fatalf("expected equal normalized names, got %q and %q", first, second)
	}
	if clean := CleanSurveyInstanceName("  Aplicación\n  final "); clean != "Aplicación final" {
		t.Fatalf("unexpected clean name %q", clean)
	}
}

func TestSurveyInstanceNameNormalizationUsesUnicodeCompatibility(t *testing.T) {
	if SurveyInstanceNameKey("Ａplicación") != SurveyInstanceNameKey("Aplicación") {
		t.Fatal("compatibility-equivalent names must collide")
	}
}
