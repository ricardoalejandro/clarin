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
	release, lifecycleErr := p.acquireDeviceOperation(ctx, accountID, deviceID)
	if lifecycleErr != nil {
		return nil, lifecycleErr
	}
	defer release()
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
	release, lifecycleErr := p.acquireDeviceOperation(ctx, accountID, deviceID)
	if lifecycleErr != nil {
		return nil, lifecycleErr
	}
	defer release()
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
	// The pair is evidence from this device's current provider response,
	// persisted before the conservative legacy-row projection runs.
	p.observePeerGroupMetadata(ctx, instance, info, contacts)
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
	identitySnapshot := &GroupParticipantIdentitySnapshot{instance: instance, contacts: contacts, accountID: accountID, deviceID: deviceID}
	if p.repos != nil {
		identitySnapshot.repo = p.repos.Chat
	}
	identityMembers := make([]domain.GroupParticipant, 0, len(info.Participants))
	for _, participant := range info.Participants {
		identityMembers = append(identityMembers, groupReportParticipantIdentity(ctx, instance, participant, contacts))
	}
	identityMembers = identitySnapshot.Resolve(ctx, identityMembers)
	for idx, participant := range info.Participants {
		resolvedMember := identityMembers[idx]
		phoneJID := types.EmptyJID
		if resolvedMember.Phone != "" {
			phoneJID = types.NewJID(resolvedMember.Phone, types.DefaultUserServer)
		}
		primary := participant.JID.ToNonAD()

		var phone *string
		phoneJIDString := ""
		if !phoneJID.IsEmpty() {
			digits := resolvedMember.Phone
			phone = &digits
			phoneJIDString = phoneJID.String()
		}

		whatsappName := resolvedMember.Name
		redacted := strings.TrimSpace(participant.DisplayName)
		if redacted == "" {
			redacted = resolvedMember.RedactedPhone
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

		role := resolvedMember.Role
		if sameReportJID(primary, info.OwnerJID) || sameReportJID(phoneJID, info.OwnerPN) {
			role = "owner"
		}

		snapshot.Members = append(snapshot.Members, domain.WhatsAppGroupReportIdentity{
			Ordinal:       idx,
			WhatsAppName:  whatsappName,
			Phone:         phone,
			RedactedPhone: redactedPtr,
			PhoneJID:      phoneJIDString,
			LID:           resolvedMember.LID,
			Role:          role,
			IsSelf:        resolvedMember.IsSelf,
		})
	}
	return snapshot, nil
}

func groupReportParticipantIdentity(ctx context.Context, instance *DeviceInstance, participant types.GroupParticipant, contacts map[types.JID]types.ContactInfo) domain.GroupParticipant {
	var ownPN types.JID
	if instance.Client.Store.ID != nil {
		ownPN = instance.Client.Store.ID.ToNonAD()
	}
	member := resolveGroupMemberIdentity(participant, ownPN, instance.Client.Store.LID, types.EmptyJID, nil)
	return resolveCachedGroupParticipant(ctx, instance, member, contacts)
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
