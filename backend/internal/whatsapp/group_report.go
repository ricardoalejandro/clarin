package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/types"
)

var (
	ErrGroupReportDeviceNotConnected = errors.New("whatsapp device is not connected")
	ErrGroupReportAccountMismatch    = errors.New("whatsapp device does not belong to account")
	ErrGroupReportInvalidGroup       = errors.New("invalid whatsapp group")
	ErrGroupReportGroupNotFound      = errors.New("whatsapp group not found")
	ErrGroupReportUpstream           = errors.New("whatsapp group request failed")
)

func (p *DevicePool) reportDevice(accountID, deviceID uuid.UUID) (*DeviceInstance, error) {
	p.mu.RLock()
	instance := p.devices[deviceID]
	p.mu.RUnlock()
	if instance == nil || instance.Client == nil {
		return nil, ErrGroupReportDeviceNotConnected
	}
	if instance.AccountID != accountID {
		return nil, ErrGroupReportAccountMismatch
	}
	if !instance.Client.IsConnected() || !instance.Client.IsLoggedIn() {
		return nil, ErrGroupReportDeviceNotConnected
	}
	return instance, nil
}

func groupKind(info *types.GroupInfo) string {
	if info.IsParent {
		return "community"
	}
	if info.IsAnnounce {
		return "announcement"
	}
	return "group"
}

func groupParticipantCount(info *types.GroupInfo) int {
	if info.ParticipantCount > 0 {
		return info.ParticipantCount
	}
	return len(info.Participants)
}

func (p *DevicePool) ListJoinedGroupOptions(ctx context.Context, accountID, deviceID uuid.UUID) ([]domain.WhatsAppGroupOption, error) {
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return nil, err
	}
	groups, err := instance.Client.GetJoinedGroups(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrGroupReportUpstream, err)
	}
	options := make([]domain.WhatsAppGroupOption, 0, len(groups))
	for _, group := range groups {
		if group == nil || group.JID.Server != types.GroupServer {
			continue
		}
		name := strings.TrimSpace(group.Name)
		if name == "" {
			name = "Grupo sin nombre"
		}
		options = append(options, domain.WhatsAppGroupOption{
			ID:               group.JID.ToNonAD().String(),
			Name:             name,
			ParticipantCount: groupParticipantCount(group),
			Kind:             groupKind(group),
			Suspended:        group.Suspended,
		})
	}
	sort.SliceStable(options, func(i, j int) bool {
		return strings.ToLower(options[i].Name) < strings.ToLower(options[j].Name)
	})
	return options, nil
}

func (p *DevicePool) LoadGroupSnapshot(ctx context.Context, accountID, deviceID uuid.UUID, groupID string) (*domain.WhatsAppGroupSnapshot, error) {
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return nil, err
	}
	groupJID, err := types.ParseJID(strings.TrimSpace(groupID))
	if err != nil || groupJID.Server != types.GroupServer {
		return nil, ErrGroupReportInvalidGroup
	}
	info, err := instance.Client.GetGroupInfo(ctx, groupJID.ToNonAD())
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrGroupReportUpstream, err)
	}
	if info == nil || info.JID.IsEmpty() {
		return nil, ErrGroupReportGroupNotFound
	}

	contacts, err := instance.Client.Store.Contacts.GetAllContacts(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrGroupReportUpstream, err)
	}
	name := strings.TrimSpace(info.Name)
	if name == "" {
		name = "Grupo sin nombre"
	}
	snapshot := &domain.WhatsAppGroupSnapshot{
		ID:               info.JID.ToNonAD().String(),
		Name:             name,
		ParticipantCount: groupParticipantCount(info),
		Kind:             groupKind(info),
		Suspended:        info.Suspended,
		Members:          make([]domain.WhatsAppGroupReportIdentity, 0, len(info.Participants)),
	}
	for idx, participant := range info.Participants {
		phoneJID := participant.PhoneNumber.ToNonAD()
		lid := participant.LID.ToNonAD()
		primary := participant.JID.ToNonAD()
		if phoneJID.IsEmpty() && primary.Server == types.DefaultUserServer {
			phoneJID = primary
		}
		if lid.IsEmpty() && primary.Server == types.HiddenUserServer {
			lid = primary
		}
		if phoneJID.IsEmpty() && !lid.IsEmpty() {
			if resolved, resolveErr := instance.Client.Store.LIDs.GetPNForLID(ctx, lid); resolveErr == nil && !resolved.IsEmpty() {
				phoneJID = resolved.ToNonAD()
			}
		}

		var phone *string
		phoneJIDString := ""
		if !phoneJID.IsEmpty() {
			digits := normalizeGroupReportPhone(phoneJID.User)
			if digits != "" {
				phone = &digits
				phoneJIDString = digits + "@" + types.DefaultUserServer
			}
		}
		lidString := ""
		if !lid.IsEmpty() {
			lidString = lid.String()
		}

		contactInfo := findGroupContactInfo(contacts, phoneJID, primary, lid)
		whatsappName := bestGroupContactName(contactInfo)
		redacted := strings.TrimSpace(participant.DisplayName)
		if redacted == "" {
			redacted = strings.TrimSpace(contactInfo.RedactedPhone)
		}
		var redactedPtr *string
		if redacted != "" {
			redactedPtr = &redacted
		}
		if whatsappName == "" {
			if phone != nil {
				whatsappName = *phone
			} else if redacted != "" {
				whatsappName = redacted
			} else {
				whatsappName = "Integrante sin nombre"
			}
		}

		role := "member"
		if sameReportJID(primary, info.OwnerJID) || sameReportJID(phoneJID, info.OwnerPN) {
			role = "owner"
		} else if participant.IsSuperAdmin {
			role = "super_admin"
		} else if participant.IsAdmin {
			role = "admin"
		}
		isSelf := false
		if instance.Client.Store.ID != nil && sameReportJID(phoneJID, instance.Client.Store.ID.ToNonAD()) {
			isSelf = true
		}
		if !instance.Client.Store.LID.IsEmpty() && sameReportJID(lid, instance.Client.Store.LID.ToNonAD()) {
			isSelf = true
		}

		snapshot.Members = append(snapshot.Members, domain.WhatsAppGroupReportIdentity{
			Ordinal:       idx,
			WhatsAppName:  whatsappName,
			Phone:         phone,
			RedactedPhone: redactedPtr,
			PhoneJID:      phoneJIDString,
			LID:           lidString,
			Role:          role,
			IsSelf:        isSelf,
		})
	}
	return snapshot, nil
}

func sameReportJID(left, right types.JID) bool {
	return !left.IsEmpty() && !right.IsEmpty() && left.ToNonAD().String() == right.ToNonAD().String()
}

func normalizeGroupReportPhone(value string) string {
	var digits strings.Builder
	for _, char := range value {
		if char >= '0' && char <= '9' {
			digits.WriteRune(char)
		}
	}
	result := digits.String()
	if len(result) == 9 && strings.HasPrefix(result, "9") {
		return "51" + result
	}
	return result
}

func findGroupContactInfo(contacts map[types.JID]types.ContactInfo, candidates ...types.JID) types.ContactInfo {
	for _, candidate := range candidates {
		if candidate.IsEmpty() {
			continue
		}
		if info, ok := contacts[candidate.ToNonAD()]; ok {
			return info
		}
	}
	return types.ContactInfo{}
}

func bestGroupContactName(info types.ContactInfo) string {
	for _, value := range []string{info.FullName, info.FirstName, info.BusinessName, info.PushName} {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
