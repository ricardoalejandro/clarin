package service

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/types"
)

// WhatsAppCoverageSnapshotCheck describes the exact result the actor is exporting.
// The account is always supplied by authenticated context, never this payload.
type WhatsAppCoverageSnapshotCheck struct {
	DeviceID            uuid.UUID
	GroupID             string
	IdentityRevision    int64
	GroupRevision       int64
	CRMIdentityRevision int64
	LeadsPolicyVersion  int64
	LeadsEnabled        bool
}

func coverageSnapshotRevisionsMatch(expected WhatsAppCoverageSnapshotCheck, identity, group, crm, policy int64, leadsEnabled bool) bool {
	return expected.IdentityRevision >= 0 && expected.GroupRevision >= 0 && expected.CRMIdentityRevision >= 0 &&
		expected.IdentityRevision == identity && expected.GroupRevision == group && expected.CRMIdentityRevision == crm &&
		expected.LeadsPolicyVersion == policy && expected.LeadsEnabled == leadsEnabled
}

func (s *ReportService) ValidateWhatsAppCoverageSnapshot(ctx context.Context, accountID uuid.UUID, expected WhatsAppCoverageSnapshotCheck) error {
	if _, err := s.reportDevice(ctx, accountID, expected.DeviceID); err != nil {
		return err
	}
	group, err := types.ParseJID(strings.TrimSpace(expected.GroupID))
	if err != nil || group.Server != types.GroupServer || group.IsEmpty() {
		return ErrReportInvalidGroup
	}
	identityRevision, groupRevision, err := s.repos.Chat.SnapshotVersionByGroupJID(ctx, accountID, expected.DeviceID, group.ToNonAD().String())
	if err != nil {
		return err
	}
	crmRevision, err := s.repos.Chat.CRMRevision(ctx, accountID)
	if err != nil {
		return err
	}
	policy, err := s.repos.Account.GetLeadPolicy(ctx, accountID)
	if err != nil {
		return err
	}
	if !coverageSnapshotRevisionsMatch(expected, identityRevision, groupRevision, crmRevision, policy.Version, policy.LeadsEnabled) {
		return ErrReportSnapshotChanged
	}
	return nil
}

func CoverageSnapshotCheckFromReport(report *domain.WhatsAppGroupCoverageReport) WhatsAppCoverageSnapshotCheck {
	return WhatsAppCoverageSnapshotCheck{DeviceID: report.Device.ID, GroupID: report.Group.ID, IdentityRevision: report.IdentityRevision,
		GroupRevision: report.GroupRevision, CRMIdentityRevision: report.CRMIdentityRevision, LeadsPolicyVersion: report.LeadsPolicyVersion, LeadsEnabled: report.LeadsEnabled}
}
