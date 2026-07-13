package service

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/whatsapp"
)

var (
	ErrReportDeviceNotFound      = errors.New("report device not found")
	ErrReportUnsupportedDevice   = errors.New("report device provider is not supported")
	ErrReportDeviceNotConnected  = errors.New("report device is not connected")
	ErrReportInvalidGroup        = errors.New("report group is invalid")
	ErrReportGroupNotFound       = errors.New("report group not found")
	ErrReportWhatsAppUnavailable = errors.New("whatsapp report data is unavailable")
)

type ReportService struct {
	repos *repository.Repositories
	pool  *whatsapp.DevicePool
}

func NewReportService(repos *repository.Repositories, pool *whatsapp.DevicePool) *ReportService {
	return &ReportService{repos: repos, pool: pool}
}

func (s *ReportService) reportDevice(ctx context.Context, accountID, deviceID uuid.UUID) (*domain.Device, error) {
	device, err := s.repos.Device.GetByID(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	if device == nil || device.AccountID != accountID {
		return nil, ErrReportDeviceNotFound
	}
	provider := domain.DeviceProviderWhatsAppWeb
	if device.Provider != nil && strings.TrimSpace(*device.Provider) != "" {
		provider = strings.TrimSpace(*device.Provider)
	}
	if provider != domain.DeviceProviderWhatsAppWeb {
		return nil, ErrReportUnsupportedDevice
	}
	if s.pool == nil {
		return nil, ErrReportDeviceNotConnected
	}
	return device, nil
}

func (s *ReportService) ListWhatsAppGroups(ctx context.Context, accountID, deviceID uuid.UUID) ([]domain.WhatsAppGroupOption, error) {
	if _, err := s.reportDevice(ctx, accountID, deviceID); err != nil {
		return nil, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	groups, err := s.pool.ListJoinedGroupOptions(requestCtx, accountID, deviceID)
	if err != nil {
		return nil, translateWhatsAppReportError(err)
	}
	return groups, nil
}

func (s *ReportService) GenerateWhatsAppGroupCoverage(ctx context.Context, accountID, deviceID uuid.UUID, groupID string) (*domain.WhatsAppGroupCoverageReport, error) {
	device, err := s.reportDevice(ctx, accountID, deviceID)
	if err != nil {
		return nil, err
	}
	whatsAppCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	snapshot, err := s.pool.LoadGroupSnapshot(whatsAppCtx, accountID, deviceID, groupID)
	cancel()
	if err != nil {
		return nil, translateWhatsAppReportError(err)
	}

	matches, err := s.repos.Report.MatchWhatsAppGroupMembers(ctx, accountID, snapshot.Members)
	if err != nil {
		return nil, err
	}
	uniqueIDs := make([]uuid.UUID, 0, len(matches))
	seenIDs := make(map[uuid.UUID]bool)
	for _, candidateIDs := range matches {
		if len(candidateIDs) != 1 || seenIDs[candidateIDs[0]] {
			continue
		}
		seenIDs[candidateIDs[0]] = true
		uniqueIDs = append(uniqueIDs, candidateIDs[0])
	}
	contacts, err := s.repos.Report.GetWhatsAppReportContacts(ctx, accountID, uniqueIDs)
	if err != nil {
		return nil, err
	}

	report := &domain.WhatsAppGroupCoverageReport{
		GeneratedAt: time.Now().UTC(),
		Members:     make([]domain.WhatsAppGroupCoverageMember, 0, len(snapshot.Members)),
	}
	report.Device.ID = device.ID
	report.Device.Name = reportString(device.Name)
	report.Device.Phone = reportString(device.Phone)
	report.Group.ID = snapshot.ID
	report.Group.Name = snapshot.Name
	report.Group.ParticipantCount = snapshot.ParticipantCount
	report.Group.Kind = snapshot.Kind
	report.Group.Suspended = snapshot.Suspended

	for _, identity := range snapshot.Members {
		member := domain.WhatsAppGroupCoverageMember{
			WhatsAppName:        identity.WhatsAppName,
			Phone:               identity.Phone,
			RedactedPhone:       identity.RedactedPhone,
			Role:                identity.Role,
			IsSelf:              identity.IsSelf,
			MatchedContactCount: len(matches[identity.Ordinal]),
		}
		candidateIDs := matches[identity.Ordinal]
		switch {
		case len(candidateIDs) > 1:
			exists := true
			member.ExistsInClarin = &exists
			member.CoverageStatus = domain.ReportCoverageAmbiguous
		case len(candidateIDs) == 1:
			matchedContact := contacts[candidateIDs[0]]
			if matchedContact == nil {
				exists := false
				member.ExistsInClarin = &exists
				member.MatchedContactCount = 0
				member.CoverageStatus = domain.ReportCoverageNotRegistered
				break
			}
			exists := true
			member.ExistsInClarin = &exists
			member.Contact = matchedContact
			switch {
			case member.Contact != nil && len(member.Contact.ActiveLeads) > 0:
				member.CoverageStatus = domain.ReportCoverageActiveManagement
			case member.Contact != nil && member.Contact.HistoricalLeadCount > 0:
				member.CoverageStatus = domain.ReportCoverageHistoricalOnly
			default:
				member.CoverageStatus = domain.ReportCoverageContactOnly
			}
		case identity.Phone == nil:
			member.ExistsInClarin = nil
			member.CoverageStatus = domain.ReportCoverageUnidentifiable
		default:
			exists := false
			member.ExistsInClarin = &exists
			member.CoverageStatus = domain.ReportCoverageNotRegistered
		}
		report.Members = append(report.Members, member)
	}
	report.Summary = buildWhatsAppCoverageSummary(report.Members)
	return report, nil
}

func translateWhatsAppReportError(err error) error {
	switch {
	case errors.Is(err, whatsapp.ErrGroupReportAccountMismatch):
		return ErrReportDeviceNotFound
	case errors.Is(err, whatsapp.ErrGroupReportDeviceNotConnected):
		return ErrReportDeviceNotConnected
	case errors.Is(err, whatsapp.ErrGroupReportInvalidGroup):
		return ErrReportInvalidGroup
	case errors.Is(err, whatsapp.ErrGroupReportGroupNotFound):
		return ErrReportGroupNotFound
	default:
		return ErrReportWhatsAppUnavailable
	}
}

func buildWhatsAppCoverageSummary(members []domain.WhatsAppGroupCoverageMember) domain.WhatsAppGroupCoverageSummary {
	summary := domain.WhatsAppGroupCoverageSummary{TotalGroupMembers: len(members)}
	for _, member := range members {
		if member.IsSelf {
			continue
		}
		summary.EvaluatedMembers++
		switch member.CoverageStatus {
		case domain.ReportCoverageActiveManagement:
			summary.ActiveManagementMembers++
			summary.RegisteredMembers++
			summary.EligibleMembers++
		case domain.ReportCoverageHistoricalOnly:
			summary.HistoricalOnlyMembers++
			summary.RegisteredMembers++
			summary.EligibleMembers++
		case domain.ReportCoverageContactOnly:
			summary.ContactOnlyMembers++
			summary.RegisteredMembers++
			summary.EligibleMembers++
		case domain.ReportCoverageNotRegistered:
			summary.NotRegisteredMembers++
			summary.EligibleMembers++
		case domain.ReportCoverageUnidentifiable:
			summary.UnidentifiableMembers++
		case domain.ReportCoverageAmbiguous:
			summary.AmbiguousMembers++
		}
		if member.Contact != nil && member.Contact.DoNotContact {
			summary.DoNotContactMembers++
		}
	}
	if summary.EligibleMembers > 0 {
		registration := roundReportPercent(summary.RegisteredMembers, summary.EligibleMembers)
		management := roundReportPercent(summary.ActiveManagementMembers, summary.EligibleMembers)
		summary.RegistrationCoveragePercent = &registration
		summary.ManagementCoveragePercent = &management
	}
	return summary
}

func roundReportPercent(value, total int) float64 {
	return math.Round((float64(value)/float64(total))*1000) / 10
}

func reportString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
