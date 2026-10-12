package service

import (
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestBuildWhatsAppCoverageSummaryExcludesSelfAndUncertainMatches(t *testing.T) {
	trueValue := true
	members := []domain.WhatsAppGroupCoverageMember{
		{IsSelf: true, CoverageStatus: domain.ReportCoverageActiveManagement},
		{CoverageStatus: domain.ReportCoverageActiveManagement, ExistsInClarin: &trueValue, Contact: &domain.WhatsAppReportContact{DoNotContact: true}},
		{CoverageStatus: domain.ReportCoverageHistoricalOnly, ExistsInClarin: &trueValue},
		{CoverageStatus: domain.ReportCoverageContactOnly, ExistsInClarin: &trueValue},
		{CoverageStatus: domain.ReportCoverageNotRegistered},
		{CoverageStatus: domain.ReportCoverageUnidentifiable},
		{CoverageStatus: domain.ReportCoverageAmbiguous, ExistsInClarin: &trueValue},
	}

	summary := buildWhatsAppCoverageSummary(members)
	if summary.TotalGroupMembers != 7 || summary.EvaluatedMembers != 6 {
		t.Fatalf("unexpected totals: %+v", summary)
	}
	if summary.EligibleMembers != 4 || summary.RegisteredMembers != 3 {
		t.Fatalf("unexpected eligible/registered totals: %+v", summary)
	}
	if summary.UnidentifiableMembers != 1 || summary.AmbiguousMembers != 1 || summary.DoNotContactMembers != 1 {
		t.Fatalf("unexpected exception totals: %+v", summary)
	}
	if summary.RegistrationCoveragePercent == nil || *summary.RegistrationCoveragePercent != 75 {
		t.Fatalf("registration coverage = %v, want 75", summary.RegistrationCoveragePercent)
	}
	if summary.ManagementCoveragePercent == nil || *summary.ManagementCoveragePercent != 25 {
		t.Fatalf("management coverage = %v, want 25", summary.ManagementCoveragePercent)
	}
}

func TestBuildWhatsAppCoverageSummaryLeavesPercentagesNullWithoutEligibleMembers(t *testing.T) {
	summary := buildWhatsAppCoverageSummary([]domain.WhatsAppGroupCoverageMember{
		{IsSelf: true, CoverageStatus: domain.ReportCoverageActiveManagement},
		{CoverageStatus: domain.ReportCoverageUnidentifiable},
		{CoverageStatus: domain.ReportCoverageAmbiguous},
	})
	if summary.RegistrationCoveragePercent != nil || summary.ManagementCoveragePercent != nil {
		t.Fatalf("percentages should be nil without eligible members: %+v", summary)
	}
}

func TestWhatsAppReportDisabledPolicyPreservesContactWithoutLeads(t *testing.T) {
	contact := &domain.WhatsAppReportContact{DisplayName: "Synthetic contact", DoNotContact: true, Tags: []domain.WhatsAppReportTag{{Name: "Contact tag"}}, ActiveLeads: []domain.WhatsAppReportLead{{Title: "Commercial context"}}, HistoricalLeadCount: 2}
	got := whatsAppReportContactForPolicy(contact, false)
	if got.DisplayName != contact.DisplayName || !got.DoNotContact || len(got.Tags) != 1 || len(got.ActiveLeads) != 0 || got.HistoricalLeadCount != 0 {
		t.Fatalf("unexpected independent contact: %+v", got)
	}
	if len(contact.ActiveLeads) != 1 || contact.HistoricalLeadCount != 2 {
		t.Fatal("mutated source")
	}
	if whatsAppReportContactForPolicy(contact, true) != contact {
		t.Fatal("enabled context changed")
	}
	if whatsAppReportContactForPolicy(nil, false) != nil {
		t.Fatal("missing contact became present")
	}
}
