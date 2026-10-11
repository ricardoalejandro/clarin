package main

import (
	"net/url"
	"testing"
)

func TestRegressionFixtureKeepsRawKeyIdentityAndDefaultProfile(t *testing.T) {
	file := mediaFile{Label: "legacy_percent", ObjectKey: "account/qa-browser/run/Porcentaje %20 + ? # 中文.pdf"}
	plain := fixtureMediaURL(&manifest{}, file)
	if plain != "/api/media/file/"+file.ObjectKey {
		t.Fatal("default fixture URL contract changed")
	}
	encoded := fixtureMediaURL(&manifest{Profile: "regression"}, file)
	parsed, err := url.Parse(encoded)
	if err != nil || parsed.Path != plain || parsed.RawQuery != "" || parsed.Fragment != "" {
		t.Fatal("regression fixture failed to preserve the exact raw object key")
	}
	file.Label = "legacy_plain"
	file.ObjectKey = "account/qa-browser/run/Canción de otoño (versión 2).pdf"
	if fixtureMediaURL(&manifest{Profile: "regression"}, file) != "/api/media/file/"+file.ObjectKey {
		t.Fatal("plain legacy fixture was silently canonicalized")
	}
}

func TestRegressionFaultActionsRejectOrdinaryAndCleanedManifestsBeforeAccess(t *testing.T) {
	for _, m := range []*manifest{{}, {Profile: "regression", State: "cleaned"}} {
		lab := laboratory{}
		if err := lab.regressionNoise(m); err == nil {
			t.Fatal("noise accepted an ordinary or cleaned fixture")
		}
		if err := lab.regressionMissing(m); err == nil {
			t.Fatal("missing-object fault accepted an ordinary or cleaned fixture")
		}
	}
}
