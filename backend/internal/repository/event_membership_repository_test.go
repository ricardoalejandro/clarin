package repository

import (
	"testing"

	"github.com/google/uuid"
)

func TestEventRuleConfigHasRulesSupportsExclusionOnly(t *testing.T) {
	tagID := uuid.New()
	if !(EventRuleConfig{FormulaType: "simple", Excludes: []uuid.UUID{tagID}}).HasRules() {
		t.Fatal("an exclusion-only rule must be authoritative")
	}
	if (EventRuleConfig{FormulaType: "simple"}).HasRules() {
		t.Fatal("an empty simple configuration must mean no rules")
	}
	if !(EventRuleConfig{FormulaType: "advanced", Formula: `not "JULIO"`}).HasRules() {
		t.Fatal("a pure negative advanced formula must be authoritative")
	}
}

func TestMembershipFingerprintIsOrderIndependent(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	cfgA := EventRuleConfig{FormulaType: "simple", FormulaMode: "or", Includes: []uuid.UUID{a, b}}
	cfgB := EventRuleConfig{FormulaType: "simple", FormulaMode: "OR", Includes: []uuid.UUID{b, a}}
	gotA := membershipFingerprint(7, cfgA, []uuid.UUID{a, b})
	gotB := membershipFingerprint(7, cfgB, []uuid.UUID{b, a})
	if gotA != gotB {
		t.Fatalf("fingerprint changed with set order: %s != %s", gotA, gotB)
	}
	if gotA == membershipFingerprint(8, cfgA, []uuid.UUID{a, b}) {
		t.Fatal("fingerprint must include the rule revision")
	}
}
