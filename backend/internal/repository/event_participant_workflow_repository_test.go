package repository

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestEventParticipantCandidateIncludesRuleMatchContract(t *testing.T) {
	payload, err := json.Marshal(domain.EventParticipantCandidate{RuleMatch: true})
	if err != nil {
		t.Fatalf("marshal candidate: %v", err)
	}
	if !strings.Contains(string(payload), `"rule_match":true`) {
		t.Fatalf("candidate JSON = %s, want explicit rule_match", payload)
	}
}

func TestCandidateSearchTermsNormalizesPhoneVariants(t *testing.T) {
	tests := []struct {
		name       string
		search     string
		rawDigits  string
		normalized string
	}{
		{name: "local formatted", search: "+949 450-211", rawDigits: "%949450211%", normalized: "%51949450211%"},
		{name: "country code", search: "+51 949 450 211", rawDigits: "%51949450211%", normalized: "%51949450211%"},
		{name: "whatsapp jid", search: "51949450211@s.whatsapp.net", rawDigits: "%51949450211%", normalized: "%51949450211%"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, rawDigits, normalized := candidateSearchTerms(tt.search)
			if rawDigits != tt.rawDigits {
				t.Fatalf("raw digit pattern = %q, want %q", rawDigits, tt.rawDigits)
			}
			if normalized != tt.normalized {
				t.Fatalf("normalized digit pattern = %q, want %q", normalized, tt.normalized)
			}
		})
	}
}

func TestCandidateEligibilityPredicateUsesDatabaseRuleEvaluation(t *testing.T) {
	accountID := uuid.New()
	baseArgs := []interface{}{accountID, uuid.New()}

	noRuleSQL, noRuleArgs, err := candidateEligibilityPredicate(EventRuleConfig{FormulaType: "simple"}, baseArgs, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if noRuleSQL != "TRUE" || len(noRuleArgs) != len(baseArgs) {
		t.Fatalf("no-rule predicate = %q with %d args", noRuleSQL, len(noRuleArgs))
	}

	includeID, excludeID := uuid.New(), uuid.New()
	simpleSQL, simpleArgs, err := candidateEligibilityPredicate(EventRuleConfig{
		FormulaType: "simple",
		FormulaMode: "AND",
		Includes:    []uuid.UUID{includeID},
		Excludes:    []uuid.UUID{excludeID},
	}, baseArgs, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(simpleArgs) != len(baseArgs)+2 || !strings.Contains(simpleSQL, "$3::uuid[]") || !strings.Contains(simpleSQL, "$4::uuid[]") {
		t.Fatalf("simple predicate/args not remapped safely: %q (%d args)", simpleSQL, len(simpleArgs))
	}

	advancedSQL, advancedArgs, err := candidateEligibilityPredicate(EventRuleConfig{FormulaType: "advanced", Formula: `"julio" and not "bloqueado"`}, baseArgs, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if len(advancedArgs) <= len(baseArgs) || !strings.Contains(advancedSQL, "$3") || strings.Contains(advancedSQL, "c.account_id = $1") {
		t.Fatalf("advanced predicate/args not remapped safely: %q (%d args)", advancedSQL, len(advancedArgs))
	}
}

func TestContactMatchesRuleFactsStrictSemantics(t *testing.T) {
	julioID := uuid.New()
	bloqueadoID := uuid.New()
	tibioID := uuid.New()
	facts := contactRuleFacts{
		TagIDs:   map[uuid.UUID]struct{}{julioID: {}, tibioID: {}},
		TagNames: []string{"julio", "tibio"},
	}
	tests := []struct {
		name    string
		config  EventRuleConfig
		facts   contactRuleFacts
		matches bool
	}{
		{name: "no rules accepts any account contact", config: EventRuleConfig{FormulaType: "simple"}, facts: contactRuleFacts{}, matches: true},
		{name: "or include matched", config: EventRuleConfig{FormulaType: "simple", FormulaMode: "OR", Includes: []uuid.UUID{bloqueadoID, julioID}}, facts: facts, matches: true},
		{name: "and include requires all", config: EventRuleConfig{FormulaType: "simple", FormulaMode: "AND", Includes: []uuid.UUID{julioID, bloqueadoID}}, facts: facts, matches: false},
		{name: "exclude overrides include", config: EventRuleConfig{FormulaType: "simple", FormulaMode: "OR", Includes: []uuid.UUID{julioID}, Excludes: []uuid.UUID{tibioID}}, facts: facts, matches: false},
		{name: "exclusion only accepts when absent", config: EventRuleConfig{FormulaType: "simple", Excludes: []uuid.UUID{bloqueadoID}}, facts: facts, matches: true},
		{name: "advanced evaluates names", config: EventRuleConfig{FormulaType: "advanced", Formula: `"julio" and not "bloqueado"`}, facts: facts, matches: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			matched, err := contactMatchesRuleFacts(tt.config, tt.facts)
			if err != nil {
				t.Fatal(err)
			}
			if matched != tt.matches {
				t.Fatalf("matched = %v, want %v", matched, tt.matches)
			}
		})
	}
}

func TestClassifyParticipantCandidate(t *testing.T) {
	active := CandidateMembershipActive
	inactive := CandidateMembershipInactive
	tests := []struct {
		name             string
		eventStatus      string
		hasRules         bool
		matches          bool
		persistedState   *string
		membershipStatus string
		eligibility      string
		canAdd           bool
	}{
		{name: "no rules available", eventStatus: domain.EventStatusActive, membershipStatus: CandidateMembershipNotAdded, eligibility: CandidateEligibilityEligible, canAdd: true},
		{name: "already active is visible no-op", eventStatus: domain.EventStatusActive, persistedState: &active, membershipStatus: CandidateMembershipActive, eligibility: CandidateEligibilityEligible, canAdd: false},
		{name: "inactive can reactivate", eventStatus: domain.EventStatusActive, persistedState: &inactive, membershipStatus: CandidateMembershipInactive, eligibility: CandidateEligibilityEligible, canAdd: true},
		{name: "strict rule rejects unmatched", eventStatus: domain.EventStatusActive, hasRules: true, matches: false, membershipStatus: CandidateMembershipNotAdded, eligibility: CandidateEligibilityRuleIneligible, canAdd: false},
		{name: "strict rule accepts matched", eventStatus: domain.EventStatusActive, hasRules: true, matches: true, membershipStatus: CandidateMembershipNotAdded, eligibility: CandidateEligibilityEligible, canAdd: true},
		{name: "completed event is frozen", eventStatus: domain.EventStatusCompleted, matches: true, membershipStatus: CandidateMembershipNotAdded, eligibility: CandidateEligibilityEventFrozen, canAdd: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			membershipStatus, eligibility, canAdd := classifyParticipantCandidate(tt.eventStatus, tt.hasRules, tt.matches, tt.persistedState)
			if membershipStatus != tt.membershipStatus || eligibility != tt.eligibility || canAdd != tt.canAdd {
				t.Fatalf("got (%q,%q,%v), want (%q,%q,%v)", membershipStatus, eligibility, canAdd, tt.membershipStatus, tt.eligibility, tt.canAdd)
			}
		})
	}
}

func TestEventParticipantAddSummaryChangedExcludesNoOpsAndRejected(t *testing.T) {
	summary := EventParticipantAddSummary{Created: 2, Reactivated: 3, AlreadyActive: 5, Rejected: 7}
	if got := summary.Changed(); got != 5 {
		t.Fatalf("Changed() = %d, want 5", got)
	}
}

func TestAppendAlreadyActiveNoOpDoesNotCountAsChange(t *testing.T) {
	contactID, participantID, stageID := uuid.New(), uuid.New(), uuid.New()
	participant := &domain.EventParticipant{ContactID: &contactID}
	summary := EventParticipantAddSummary{Results: make([]*EventParticipantAddResult, 0)}
	if !appendAlreadyActiveNoOp(&summary, participant, contactID, existingEventParticipant{ID: participantID, MembershipState: CandidateMembershipActive, StageID: &stageID}) {
		t.Fatal("active membership must short-circuit as no-op")
	}
	if summary.AlreadyActive != 1 || summary.Changed() != 0 || len(summary.Results) != 1 || summary.Results[0].Outcome != ParticipantAddAlreadyActive {
		t.Fatalf("unexpected no-op summary: %#v", summary)
	}
	if participant.ID != participantID || participant.StageID == nil || *participant.StageID != stageID {
		t.Fatalf("participant did not retain persisted membership identity: %#v", participant)
	}
}

func TestStrictAddAutoTagSyncFollowsEventRules(t *testing.T) {
	if strictAddAutoTagSync(EventRuleConfig{FormulaType: "simple"}) {
		t.Fatal("event without rules must not enable automatic rule synchronization")
	}
	if !strictAddAutoTagSync(EventRuleConfig{FormulaType: "simple", Includes: []uuid.UUID{uuid.New()}}) {
		t.Fatal("rule-governed manual add must remain synchronized with future rule changes")
	}
}

func TestTargetedRuleReconciliationRequiresStrictPolicy(t *testing.T) {
	if targetedRuleReconciliationEnabled("audit_only") {
		t.Fatal("audit-only rollout must not mutate memberships")
	}
	if !targetedRuleReconciliationEnabled("strict") {
		t.Fatal("strict policy must reconcile rule-governed membership changes")
	}
}

func TestActivationRuleApplicationRespectsRolloutPolicy(t *testing.T) {
	rule := EventRuleConfig{FormulaType: "simple", Includes: []uuid.UUID{uuid.New()}}
	if shouldApplyActivationRules("audit_only", rule) {
		t.Fatal("draft activation must not silently enable strict membership for audit-only accounts")
	}
	if !shouldApplyActivationRules("strict", rule) {
		t.Fatal("strict draft activation must apply initial rule membership")
	}
	if shouldApplyActivationRules("strict", EventRuleConfig{FormulaType: "simple"}) {
		t.Fatal("event without rules must not run rule reconciliation")
	}
}
