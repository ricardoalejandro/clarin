package service

import "testing"

func TestCoverageSnapshotRejectsEveryStaleDimension(t *testing.T) {
	base := WhatsAppCoverageSnapshotCheck{IdentityRevision: 3, GroupRevision: 5, CRMIdentityRevision: 7, LeadsPolicyVersion: 11, LeadsEnabled: true}
	if !coverageSnapshotRevisionsMatch(base, 3, 5, 7, 11, true) {
		t.Fatal("current snapshot rejected")
	}
	for _, tc := range []struct {
		name                         string
		identity, group, crm, policy int64
		leads                        bool
	}{
		{"identity", 4, 5, 7, 11, true}, {"membership", 3, 6, 7, 11, true}, {"contact", 3, 5, 8, 11, true}, {"policy", 3, 5, 7, 12, true}, {"leads", 3, 5, 7, 11, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if coverageSnapshotRevisionsMatch(base, tc.identity, tc.group, tc.crm, tc.policy, tc.leads) {
				t.Fatal("stale export allowed")
			}
		})
	}
	zero := WhatsAppCoverageSnapshotCheck{}
	if !coverageSnapshotRevisionsMatch(zero, 0, 0, 0, 0, false) {
		t.Fatal("canonical empty revision rejected")
	}
	zero.IdentityRevision = -1
	if coverageSnapshotRevisionsMatch(zero, -1, 0, 0, 0, false) {
		t.Fatal("invalid revision accepted")
	}
}
