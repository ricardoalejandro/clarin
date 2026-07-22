package api

import (
	"strings"
	"testing"
)

func TestCanonicalLeadExpressionsNeverResurrectLinkedSnapshots(t *testing.T) {
	linkedExpressions := []string{
		canonicalLeadNameExpr,
		canonicalLeadLastNameExpr,
		canonicalLeadPhoneExpr,
		canonicalLeadEmailExpr,
		canonicalLeadCompanyExpr,
	}
	for _, expression := range linkedExpressions {
		if !strings.Contains(expression, "CASE WHEN l.contact_id IS NULL") {
			t.Fatalf("expression does not distinguish detached Leads: %s", expression)
		}
		if strings.Contains(expression, "COALESCE(c.phone,l.phone)") ||
			strings.Contains(expression, "COALESCE(c.email,l.email)") ||
			strings.Contains(expression, "COALESCE(c.company,l.company)") {
			t.Fatalf("linked Contact expression falls through to a Lead snapshot: %s", expression)
		}
	}
	if !strings.Contains(canonicalLeadNameExpr, "c.phone,c.jid,''") {
		t.Fatalf("canonical display name must remain scan-safe when names are missing: %s", canonicalLeadNameExpr)
	}
}

func TestCanonicalParticipantExpressionsRecognizeLeadLinkedContact(t *testing.T) {
	expressions := []string{
		canonicalParticipantNameExpr,
		canonicalParticipantLastNameExpr,
		canonicalParticipantPhoneExpr,
		canonicalParticipantEmailExpr,
	}
	for _, expression := range expressions {
		if !strings.Contains(expression, "COALESCE(p.contact_id,l.contact_id) IS NULL") {
			t.Fatalf("participant expression ignores its Lead-linked Contact: %s", expression)
		}
	}
	if !strings.Contains(canonicalParticipantNameExpr, "contact.phone,contact.jid,''") {
		t.Fatalf("canonical participant display name must remain scan-safe: %s", canonicalParticipantNameExpr)
	}
}

func TestCanonicalSearchClausesReuseOneBoundArgument(t *testing.T) {
	leadClause := canonicalLeadSearchClause(7, true)
	if strings.Count(leadClause, "$7") != 6 || !strings.Contains(leadClause, "LOWER(l.title) LIKE $7") {
		t.Fatalf("lead search clause does not reuse the expected parameter: %s", leadClause)
	}
	if strings.Contains(leadClause, "COALESCE(c.email,l.email)") {
		t.Fatalf("lead search can resurrect a cleared canonical email: %s", leadClause)
	}

	participantClause := canonicalParticipantSearchClause(4)
	if strings.Count(participantClause, "$4") != 4 {
		t.Fatalf("participant search clause does not reuse the expected parameter: %s", participantClause)
	}
	if !strings.Contains(participantClause, "COALESCE(p.contact_id,l.contact_id)") {
		t.Fatalf("participant search ignores a Lead-linked Contact: %s", participantClause)
	}
}
