package api

import (
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"testing"
)

func TestIdentityRecoveryProgressRequiresChatsOrReports(t *testing.T) {
	if groupIdentityRecoveryCanRead(nil) {
		t.Fatal("anonymous progress access")
	}
	for _, permission := range []string{domain.PermContacts, domain.PermLeads, domain.PermDevices} {
		if groupIdentityRecoveryCanRead(&service.JWTClaims{Role: domain.RoleAgent, Permissions: []string{permission}}) {
			t.Fatal("unrelated module grants progress access")
		}
	}
	for _, permission := range []string{domain.PermChats, domain.PermReports, domain.PermAll} {
		if !groupIdentityRecoveryCanRead(&service.JWTClaims{Role: domain.RoleAgent, Permissions: []string{permission}}) {
			t.Fatal("authorized progress unavailable")
		}
	}
	if !groupIdentityRecoveryCanRead(&service.JWTClaims{IsSuperAdmin: true}) {
		t.Fatal("super admin rejected")
	}
}

func TestCoverageValidationRequiresExplicitZeroAndFalse(t *testing.T) {
	zero := int64(0)
	disabled := false
	valid := coverageSnapshotValidationRequest{IdentityRevision: &zero, GroupRevision: &zero, CRMIdentityRevision: &zero, LeadsPolicyVersion: &zero, LeadsEnabled: &disabled}
	if !valid.complete() {
		t.Fatal("explicit canonical zeros or disabled Leads rejected")
	}
	for _, field := range []string{"identity", "group", "crm", "policy", "enabled"} {
		req := valid
		switch field {
		case "identity":
			req.IdentityRevision = nil
		case "group":
			req.GroupRevision = nil
		case "crm":
			req.CRMIdentityRevision = nil
		case "policy":
			req.LeadsPolicyVersion = nil
		case "enabled":
			req.LeadsEnabled = nil
		}
		if req.complete() {
			t.Fatalf("missing %s accepted as zero", field)
		}
	}
	bad := int64(-1)
	valid.CRMIdentityRevision = &bad
	if valid.complete() {
		t.Fatal("negative revision accepted")
	}
}
