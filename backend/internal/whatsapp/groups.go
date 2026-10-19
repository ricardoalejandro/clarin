package whatsapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
	"log"
	"strings"
	"sync"
	"time"
)

var groupAvatarSlots = make(chan struct{}, 4)

type groupSendContextKey struct{}
type groupContactsContextKey struct{}
type groupHistoryContextKey struct{}
type groupSendAuthorization struct {
	AccountID, DeviceID, ChatID uuid.UUID
	JID                         string
}

func groupSenderIdentity(source types.MessageSource) types.JID {
	for _, candidate := range []types.JID{source.SenderAlt, source.Sender} {
		if candidate.Server == types.DefaultUserServer {
			return candidate.ToNonAD()
		}
	}
	return source.Sender.ToNonAD()
}

func groupProjection(info *types.GroupInfo, ownPN, ownLID types.JID, joined bool) (*domain.ChatGroup, []domain.GroupParticipant) {
	g := &domain.ChatGroup{Subject: strings.TrimSpace(info.Name), Description: info.Topic, Announce: info.IsAnnounce, Suspended: info.Suspended, Kind: groupKind(info), MembershipStatus: "unknown"}
	if g.Subject == "" {
		g.Subject = "Grupo sin nombre"
	}
	if joined {
		g.MembershipStatus = "member"
	}
	members := make([]domain.GroupParticipant, 0, len(info.Participants))
	for _, part := range info.Participants {
		jid := part.JID.ToNonAD()
		pn := part.PhoneNumber.ToNonAD()
		lid := part.LID.ToNonAD()
		if pn.IsEmpty() && jid.Server == types.DefaultUserServer {
			pn = jid
		}
		if lid.IsEmpty() && jid.Server == types.HiddenUserServer {
			lid = jid
		}
		if !pn.IsEmpty() {
			jid = pn
		}
		if jid.IsEmpty() {
			continue
		}
		member := domain.GroupParticipant{JID: jid.String(), Name: part.DisplayName, Role: "member"}
		if !lid.IsEmpty() {
			member.LID = lid.String()
		}
		if !pn.IsEmpty() {
			member.Phone = pn.User
		}
		if member.Name == "" {
			if member.Phone != "" {
				member.Name = member.Phone
			} else {
				member.Name = "Integrante"
			}
		}
		if part.IsSuperAdmin {
			member.Role = "super_admin"
		} else if part.IsAdmin {
			member.Role = "admin"
		}
		member.IsSelf = sameReportJID(jid, ownPN) || sameReportJID(lid, ownLID) || sameReportJID(part.JID, ownLID)
		if member.IsSelf {
			g.MembershipStatus = "member"
			g.IsAdmin = part.IsAdmin || part.IsSuperAdmin
		}
		members = append(members, member)
	}
	g.ParticipantCount = groupParticipantCount(info)
	g.ResolveSendCapability(true)
	return g, members
}

func (p *DevicePool) saveGroupInfo(ctx context.Context, instance *DeviceInstance, info *types.GroupInfo, joined bool) (*domain.Chat, error) {
	chat, err := p.repos.Chat.GetOrCreateGroup(ctx, instance.AccountID, instance.ID, info.JID.ToNonAD().String(), info.Name)
	if err != nil {
		return nil, err
	}
	p.queueInitialGroupAvatar(instance, chat)
	ownPN := types.EmptyJID
	if instance.Client.Store.ID != nil {
		ownPN = instance.Client.Store.ID.ToNonAD()
	}
	g, members := groupProjection(info, ownPN, instance.Client.Store.LID.ToNonAD(), joined)
	// One provider-local snapshot lookup, never CRM Contact writes for participants.
	contacts, ok := ctx.Value(groupContactsContextKey{}).(map[types.JID]types.ContactInfo)
	var contactErr error
	if !ok {
		contacts, contactErr = instance.Client.Store.Contacts.GetAllContacts(ctx)
	}
	if contactErr == nil {
		for i := range members {
			j, _ := types.ParseJID(members[i].JID)
			l, _ := types.ParseJID(members[i].LID)
			if name := bestGroupContactName(findGroupContactInfo(contacts, j, l)); name != "" {
				members[i].Name = name
			}
		}
	}
	if err = p.repos.Chat.SaveGroup(ctx, instance.AccountID, chat.ID, g, members); err != nil {
		return nil, err
	}
	if err = p.repos.Chat.HydrateGroups(ctx, instance.AccountID, []*domain.Chat{chat}); err != nil {
		return nil, err
	}
	return chat, nil
}

func (p *DevicePool) SyncGroups(ctx context.Context, accountID, deviceID uuid.UUID) (int, error) {
	if !p.GroupsEnabledForAccount(accountID) {
		return 0, fmt.Errorf("los grupos todavía no están habilitados para esta cuenta")
	}
	operationCtx, release, err := p.retainDeviceOperation(ctx, accountID, deviceID)
	if err != nil {
		return 0, err
	}
	defer release()
	lockValue, _ := p.groupSyncLocks.LoadOrStore(deviceID, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	if !lock.TryLock() {
		return 0, fmt.Errorf("ya hay una actualización de grupos en curso")
	}
	defer lock.Unlock()
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return 0, err
	}
	instance.mu.RLock()
	receive := instance.ReceiveMessages
	instance.mu.RUnlock()
	if !receive {
		return 0, ErrHistorySyncReceiveDisabled
	}
	requestCtx, cancel := context.WithTimeout(operationCtx, 45*time.Second)
	defer cancel()
	groups, err := instance.Client.GetJoinedGroups(requestCtx)
	if err != nil {
		return 0, err
	}
	contacts, _ := instance.Client.Store.Contacts.GetAllContacts(requestCtx)
	requestCtx = context.WithValue(requestCtx, groupContactsContextKey{}, contacts)
	count := 0
	joinedJIDs := []string{}
	for _, info := range groups {
		if info == nil || info.JID.Server != types.GroupServer {
			continue
		}
		joinedJIDs = append(joinedJIDs, info.JID.ToNonAD().String())
		hidden, e := p.repos.Chat.GroupHidden(requestCtx, accountID, deviceID, info.JID.ToNonAD().String())
		if e != nil {
			return count, e
		}
		if hidden {
			continue
		}
		chat, e := p.saveGroupInfo(requestCtx, instance, info, true)
		if e != nil {
			return count, e
		}
		count++
		p.broadcastGroup(chat)
	}
	if err := p.repos.Chat.ReconcileJoinedGroups(requestCtx, accountID, deviceID, joinedJIDs); err != nil {
		return count, err
	}
	if p.hub != nil {
		p.hub.BroadcastToAccountWithPermission(accountID, domain.PermChats, "groups_synced", map[string]interface{}{"device_id": deviceID, "synced": count})
	}
	p.invalidateAccountMessageCaches(accountID)
	if p.cache != nil {
		_ = p.cache.DelPattern(ctx, "chats:"+accountID.String()+":*")
	}
	return count, nil
}

func (p *DevicePool) RefreshGroup(ctx context.Context, accountID, deviceID uuid.UUID, jid string) (*domain.Chat, error) {
	if !p.GroupsEnabledForAccount(accountID) {
		return nil, fmt.Errorf("los grupos todavía no están habilitados para esta cuenta")
	}
	operationCtx, release, err := p.retainDeviceOperation(ctx, accountID, deviceID)
	if err != nil {
		return nil, err
	}
	defer release()
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return nil, err
	}
	parsed, err := types.ParseJID(jid)
	if err != nil || parsed.Server != types.GroupServer {
		return nil, fmt.Errorf("grupo inválido")
	}
	requestCtx, cancel := context.WithTimeout(operationCtx, 20*time.Second)
	defer cancel()
	info, err := instance.Client.GetGroupInfo(requestCtx, parsed)
	if err != nil {
		return nil, err
	}
	chat, err := p.saveGroupInfo(requestCtx, instance, info, false)
	if err == nil {
		p.broadcastGroup(chat)
	}
	return chat, err
}

func (p *DevicePool) broadcastGroup(chat *domain.Chat) {
	if chat != nil && p.hub != nil {
		p.hub.BroadcastToAccountWithPermission(chat.AccountID, domain.PermChats, "chat_group_updated", map[string]interface{}{"chat_id": chat.ID, "device_id": chat.DeviceID, "chat": chat, "group": chat.Group})
	}
}

func (p *DevicePool) handleGroupInfo(ctx context.Context, instance *DeviceInstance, evt *events.GroupInfo) {
	if !p.GroupsEnabledForAccount(instance.AccountID) {
		return
	}
	instance.mu.RLock()
	receive := instance.ReceiveMessages
	instance.mu.RUnlock()
	if !receive {
		return
	}
	for _, left := range evt.Leave {
		if (instance.Client.Store.ID != nil && sameReportJID(left, *instance.Client.Store.ID)) || sameReportJID(left, instance.Client.Store.LID) {
			_ = p.repos.Chat.MarkGroupLeft(ctx, instance.AccountID, instance.ID, evt.JID.String())
			chat, _ := p.repos.Chat.FindByDeviceJID(ctx, instance.AccountID, instance.ID, evt.JID.String())
			if chat != nil {
				_ = p.repos.Chat.HydrateGroups(ctx, instance.AccountID, []*domain.Chat{chat})
				p.broadcastGroup(chat)
			}
			return
		}
	}
	if evt.Delete != nil && evt.Delete.Deleted {
		_ = p.repos.Chat.MarkGroupLeft(ctx, instance.AccountID, instance.ID, evt.JID.String())
		chat, _ := p.repos.Chat.FindByDeviceJID(ctx, instance.AccountID, instance.ID, evt.JID.String())
		if chat != nil {
			_ = p.repos.Chat.HydrateGroups(ctx, instance.AccountID, []*domain.Chat{chat})
			p.broadcastGroup(chat)
		}
		return
	}
	// A metadata event refreshes its own group only, never the whole chat list.
	if hidden, _ := p.repos.Chat.GroupHidden(ctx, instance.AccountID, instance.ID, evt.JID.String()); hidden {
		return
	}
	_, _ = p.RefreshGroup(ctx, instance.AccountID, instance.ID, evt.JID.String())
}

func (p *DevicePool) PrepareGroupSend(ctx context.Context, accountID, deviceID, chatID uuid.UUID, jid string, mentions []domain.MessageMention, requireSend bool) (context.Context, error) {
	if !p.GroupsEnabledForAccount(accountID) {
		return ctx, fmt.Errorf("los grupos todavía no están habilitados para esta cuenta")
	}
	chat, err := p.repos.Chat.GetByID(ctx, chatID)
	if err != nil || chat == nil || chat.AccountID != accountID || chat.DeviceID == nil || *chat.DeviceID != deviceID || chat.JID != jid || !domain.IsGroupJID(jid) {
		return ctx, fmt.Errorf("grupo no encontrado en este dispositivo")
	}
	refreshed := chat
	err = p.repos.Chat.HydrateGroups(ctx, accountID, []*domain.Chat{chat})
	if err != nil {
		return ctx, err
	}
	if requireSend || chat.Group == nil || chat.Group.SyncedAt == nil || time.Since(*chat.Group.SyncedAt) > time.Minute {
		refreshed, err = p.RefreshGroup(ctx, accountID, deviceID, jid)
	}
	if err != nil {
		return ctx, fmt.Errorf("no se pudo verificar la membresía del grupo: %w", err)
	}
	if refreshed.Group == nil || refreshed.Group.MembershipStatus != "member" {
		return ctx, fmt.Errorf("el dispositivo no pertenece al grupo")
	}
	if (requireSend || refreshed.Group.Suspended || refreshed.Group.Kind == "community") && !refreshed.Group.CanSend {
		return ctx, fmt.Errorf("%s", refreshed.Group.SendDisabledReason)
	}
	if len(mentions) > 100 {
		return ctx, fmt.Errorf("demasiadas menciones")
	}
	canonical := []domain.MessageMention{}
	seen := map[string]bool{}
	for _, mention := range mentions {
		parsed, e := types.ParseJID(mention.JID)
		if e != nil || (parsed.Server != types.DefaultUserServer && parsed.Server != types.HiddenUserServer) {
			return ctx, fmt.Errorf("mención inválida")
		}
		var member domain.GroupParticipant
		var raw []byte
		e = p.repos.DB().QueryRow(ctx, `SELECT member::text FROM chat_groups CROSS JOIN LATERAL jsonb_array_elements(participants) member WHERE account_id=$1 AND chat_id=$2 AND (member->>'jid'=$3 OR member->>'lid'=$3) LIMIT 1`, accountID, chatID, parsed.ToNonAD().String()).Scan(&raw)
		if e != nil {
			return ctx, fmt.Errorf("la persona mencionada ya no pertenece al grupo")
		}
		if e = json.Unmarshal(raw, &member); e != nil {
			return ctx, e
		}
		if !seen[member.JID] {
			canonical = append(canonical, domain.MessageMention{JID: parsed.ToNonAD().String(), Name: member.Name})
			seen[member.JID] = true
		}
	}
	auth := groupSendAuthorization{accountID, deviceID, chatID, jid}
	if mutable, ok := ctx.(interface{ SetUserValue(any, any) }); ok {
		mutable.SetUserValue(groupSendContextKey{}, auth)
	} else {
		ctx = context.WithValue(ctx, groupSendContextKey{}, auth)
	}
	return domain.WithMessageMentions(ctx, canonical), nil
}

func (p *DevicePool) requireGroupSend(ctx context.Context, instance *DeviceInstance, jid types.JID) error {
	if instance == nil || !p.GroupsEnabledForAccount(instance.AccountID) {
		return fmt.Errorf("los grupos no están disponibles en este dispositivo")
	}
	auth, ok := ctx.Value(groupSendContextKey{}).(groupSendAuthorization)
	if !ok || auth.AccountID != instance.AccountID || auth.DeviceID != instance.ID || auth.JID != jid.ToNonAD().String() {
		return fmt.Errorf("los grupos solo admiten operaciones manuales desde su conversación verificada")
	}
	return nil
}

func applyOutboundGroupMentions(ctx context.Context, jid types.JID, message *waE2E.Message) {
	mentions := domain.MessageMentionsFrom(ctx)
	if jid.Server != types.GroupServer || len(mentions) == 0 {
		return
	}
	info := &waE2E.ContextInfo{}
	for _, m := range mentions {
		info.MentionedJID = append(info.MentionedJID, m.JID)
	}
	apply := func(target **waE2E.ContextInfo) {
		if *target == nil {
			*target = info
		} else {
			(*target).MentionedJID = info.MentionedJID
		}
	}
	switch {
	case message.GetConversation() != "":
		message.ExtendedTextMessage = &waE2E.ExtendedTextMessage{Text: proto.String(message.GetConversation()), ContextInfo: info}
		message.Conversation = nil
	case message.ExtendedTextMessage != nil:
		apply(&message.ExtendedTextMessage.ContextInfo)
	case message.ImageMessage != nil:
		apply(&message.ImageMessage.ContextInfo)
	case message.VideoMessage != nil:
		apply(&message.VideoMessage.ContextInfo)
	case message.DocumentMessage != nil:
		apply(&message.DocumentMessage.ContextInfo)
	case message.AudioMessage != nil:
		apply(&message.AudioMessage.ContextInfo)
	}
}

func groupMessageMentions(message *waE2E.Message) []domain.MessageMention {
	for depth := 0; message != nil && depth < 8; depth++ {
		switch {
		case message.EphemeralMessage != nil:
			message = message.EphemeralMessage.Message
		case message.ViewOnceMessage != nil:
			message = message.ViewOnceMessage.Message
		case message.ViewOnceMessageV2 != nil:
			message = message.ViewOnceMessageV2.Message
		case message.DocumentWithCaptionMessage != nil:
			message = message.DocumentWithCaptionMessage.Message
		default:
			depth = 8
		}
	}
	var info *waE2E.ContextInfo
	switch {
	case message.GetExtendedTextMessage() != nil:
		info = message.GetExtendedTextMessage().GetContextInfo()
	case message.GetImageMessage() != nil:
		info = message.GetImageMessage().GetContextInfo()
	case message.GetVideoMessage() != nil:
		info = message.GetVideoMessage().GetContextInfo()
	case message.GetDocumentMessage() != nil:
		info = message.GetDocumentMessage().GetContextInfo()
	case message.GetAudioMessage() != nil:
		info = message.GetAudioMessage().GetContextInfo()
	}
	out := []domain.MessageMention{}
	for _, jid := range info.GetMentionedJID() {
		out = append(out, domain.MessageMention{JID: jid})
	}
	return out
}

// A sender-key distribution and the user payload can be separate events with
// the same WhatsApp ID. Technical empty-text events must not consume that ID.
// Media without captions remains content, even before its download succeeds.
func (p *DevicePool) groupMessageHasContent(ctx context.Context, evt *events.Message) bool {
	if evt == nil || evt.Message == nil {
		return false
	}
	if evt.Message.GetReactionMessage() != nil || groupPollCreation(evt.Message) != nil || evt.Message.GetPollUpdateMessage() != nil || groupEventProtocol(evt) != nil {
		return true
	}
	content, _ := p.extractGroupMessageContent(ctx, nil, evt.Message, evt.Info.Chat.String(), evt.Info.ID, evt.IsViewOnce)
	return content.Body != "" || content.MessageType != domain.MessageTypeText
}

func (p *DevicePool) handleGroupMessage(ctx context.Context, instance *DeviceInstance, evt *events.Message) {
	if !p.GroupsEnabledForAccount(instance.AccountID) {
		return
	}
	if !p.groupMessageHasContent(ctx, evt) {
		return
	}
	instance.mu.RLock()
	receive := instance.ReceiveMessages
	instance.mu.RUnlock()
	if !receive && !evt.Info.IsFromMe {
		return
	}
	visible, err := p.repos.Chat.RevealGroupActivity(ctx, instance.AccountID, instance.ID, evt.Info.Chat.String(), evt.Info.Timestamp)
	if err != nil || !visible {
		return
	}
	if reaction := evt.Message.GetReactionMessage(); reaction != nil {
		p.handleReaction(ctx, instance, evt, reaction)
		return
	}
	if poll := groupPollCreation(evt.Message); poll != nil {
		p.handlePollCreation(ctx, instance, evt, poll)
		return
	}
	if vote := evt.Message.GetPollUpdateMessage(); vote != nil {
		p.handlePollUpdate(ctx, instance, evt, vote)
		return
	}
	chat, err := p.repos.Chat.GetOrCreateGroup(ctx, instance.AccountID, instance.ID, evt.Info.Chat.ToNonAD().String(), "")
	if err != nil {
		return
	}
	if protocol := groupEventProtocol(evt); protocol != nil {
		p.applyGroupProtocol(ctx, instance, chat, protocol)
		return
	}
	content, _ := p.extractGroupMessageContent(ctx, instance, evt.Message, chat.JID, evt.Info.ID, evt.IsViewOnce)
	sender := groupSenderIdentity(evt.Info.MessageSource).String()
	status := "received"
	if evt.Info.IsFromMe {
		status = "sent"
	}
	msg := &domain.Message{AccountID: instance.AccountID, DeviceID: &instance.ID, ChatID: chat.ID, MessageID: evt.Info.ID, FromJID: &sender, FromName: strPtr(evt.Info.PushName), Body: &content.Body, MessageType: &content.MessageType, MediaURL: content.MediaURL, MediaMimetype: content.MediaMimetype, MediaFilename: content.MediaFilename, MediaSize: content.MediaSize, MediaAssetID: content.MediaAssetID, IsFromMe: evt.Info.IsFromMe, Status: &status, Timestamp: evt.Info.Timestamp, Latitude: content.Latitude, Longitude: content.Longitude, ContactName: content.ContactName, ContactPhone: content.ContactPhone, ContactVCard: content.ContactVCard, IsViewOnce: content.IsViewOnce || evt.IsViewOnce, Mentions: groupMessageMentions(evt.Message)}
	msg.MediaUnavailableReason = content.MediaUnavailableReason
	quote := p.extractMessageQuote(ctx, instance, chat.ID, evt.Message)
	quote.Apply(msg)
	if msg.IsFromMe {
		msg.Sender = &domain.MessageSender{Origin: "whatsapp_external"}
	}
	p.attachReceivedLinkPreview(ctx, msg, evt.Message, evt.IsViewOnce)
	if err = p.repos.Message.Create(ctx, msg); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			p.enrichReceivedLinkPreview(ctx, instance, msg)
			p.hydrateMessageQuote(ctx, instance.AccountID, chat.ID, msg.MessageID, quote)
		}
		return
	}
	if msg.MediaURL == nil {
		p.rememberGroupMedia(ctx, instance.AccountID, chat.ID, evt)
	}
	_ = p.repos.Message.HydrateMentions(ctx, instance.AccountID, chat.ID, []*domain.Message{msg})
	p.invalidateChatCaches(instance.AccountID, chat.ID)
	if msg.RepairedPlaceholder {
		p.broadcastGroupMessageRepair(ctx, instance, msg)
		return
	}
	if chat.ContactCreated {
		p.queueInitialGroupAvatar(instance, chat)
		go func() {
			refreshCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			_, _ = p.RefreshGroup(refreshCtx, instance.AccountID, instance.ID, chat.JID)
		}()
	}
	p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, ws.EventNewMessage, map[string]interface{}{"chat_id": chat.ID, "device_id": instance.ID, "chat_jid": chat.JID, "message": msg, "sender_name": evt.Info.PushName, "is_from_me": evt.Info.IsFromMe})
}

func (p *DevicePool) broadcastGroupMessageRepair(ctx context.Context, instance *DeviceInstance, message *domain.Message) {
	data := map[string]interface{}{"chat_id": message.ChatID, "device_id": instance.ID, "message": message}
	if state, err := p.repos.Chat.State(ctx, instance.AccountID, message.ChatID); err == nil {
		data["chat_state"] = state
	}
	p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, "message_media_updated", data)
	// The list's established legacy invalidation refreshes its preview silently;
	// a state-only versioned event intentionally changes attention counters only.
	p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, ws.EventChatUpdate, map[string]interface{}{"chat_id": message.ChatID, "device_id": instance.ID})
}

func (p *DevicePool) applyGroupProtocol(ctx context.Context, instance *DeviceInstance, chat *domain.Chat, protocol *waE2E.ProtocolMessage) {
	id := protocol.GetKey().GetID()
	event := ""
	body := ""
	var preview *domain.MessageLinkPreview
	var previewVersion int64
	switch protocol.GetType() {
	case waE2E.ProtocolMessage_REVOKE:
		if err := p.repos.Message.RevokeInChat(ctx, instance.AccountID, chat.ID, id, &previewVersion); err != nil {
			return
		}
		event = ws.EventMessageRevoked
	case waE2E.ProtocolMessage_MESSAGE_EDIT:
		edited := p.extractMessageContent(ctx, nil, protocol.GetEditedMessage(), chat.JID, id)
		body = edited.Body
		editedAt := time.UnixMilli(protocol.GetTimestampMS())
		if protocol.GetTimestampMS() <= 0 {
			editedAt = time.Time{}
		}
		snapshot := &domain.Message{AccountID: instance.AccountID, Body: &body}
		p.attachReceivedLinkPreview(ctx, snapshot, protocol.GetEditedMessage(), false)
		applied, err := p.repos.Message.ApplyGroupMessageEdit(ctx, instance.AccountID, chat.ID, id, body, groupMessageMentions(protocol.GetEditedMessage()), editedAt, snapshot.LinkPreview, snapshot.LinkPreviewMediaAssetID, snapshot)
		if err != nil || !applied {
			return
		}
		preview = snapshot.LinkPreview
		previewVersion = snapshot.LinkPreviewVersion
		event = ws.EventMessageEdited
	default:
		return
	}
	p.invalidateChatCaches(instance.AccountID, chat.ID)
	p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, event, map[string]interface{}{"chat_id": chat.ID, "device_id": instance.ID, "chat_jid": chat.JID, "message_id": id, "new_body": body, "link_preview": preview, "link_preview_version": previewVersion, "mentions": groupMessageMentions(protocol.GetEditedMessage())})
}

func (p *DevicePool) handleGroupReceipt(ctx context.Context, instance *DeviceInstance, evt *events.Receipt) {
	if !p.GroupsEnabledForAccount(instance.AccountID) {
		return
	}
	chat, err := p.repos.Chat.FindByDeviceJID(ctx, instance.AccountID, instance.ID, evt.Chat.ToNonAD().String())
	if err != nil || chat == nil {
		return
	}
	if evt.Type == types.ReceiptTypeReadSelf || evt.Type == types.ReceiptTypePlayedSelf {
		for _, id := range evt.MessageIDs {
			_, _, _ = p.repos.Chat.MarkAsRead(ctx, instance.AccountID, chat.ID, id)
		}
		p.invalidateChatCaches(instance.AccountID, chat.ID)
		return
	}
	status := ""
	switch evt.Type {
	case types.ReceiptTypeRead, types.ReceiptTypePlayed:
		status = "read"
	case types.ReceiptTypeDelivered:
		status = "delivered"
	default:
		return
	}
	sender := groupSenderIdentity(evt.MessageSource).String()
	if sender == "" {
		return
	}
	for _, id := range evt.MessageIDs {
		if err = p.repos.Message.SaveGroupReceipt(ctx, instance.AccountID, chat.ID, id, sender, status, evt.Timestamp); err != nil {
			log.Printf("[GroupReceipt] persistence failed account=%s chat=%s: %v", instance.AccountID, chat.ID, err)
		}
	}
	p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, "group_message_receipt", map[string]interface{}{"chat_id": chat.ID, "device_id": instance.ID, "message_ids": evt.MessageIDs, "jid": sender, "status": status, "timestamp": evt.Timestamp})
}

func (p *DevicePool) sendGroupReadReceipt(ctx context.Context, instance *DeviceInstance, jid types.JID, ids []string) error {
	if err := p.requireGroupSend(ctx, instance, jid); err != nil {
		return err
	}
	if len(ids) > 500 {
		return fmt.Errorf("demasiados mensajes")
	}
	chat, err := p.repos.Chat.FindByDeviceJID(ctx, instance.AccountID, instance.ID, jid.String())
	if err != nil {
		return err
	}
	if chat == nil {
		return fmt.Errorf("grupo no encontrado")
	}
	rows, err := p.repos.DB().Query(ctx, `SELECT message_id,from_jid FROM messages WHERE account_id=$1 AND chat_id=$2 AND message_id=ANY($3::text[]) AND NOT is_from_me AND from_jid IS NOT NULL`, instance.AccountID, chat.ID, ids)
	if err != nil {
		return err
	}
	grouped := map[string][]types.MessageID{}
	for rows.Next() {
		var id, sender string
		if err = rows.Scan(&id, &sender); err != nil {
			rows.Close()
			return err
		}
		grouped[sender] = append(grouped[sender], types.MessageID(id))
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for sender, keys := range grouped {
		author, e := types.ParseJID(sender)
		if e != nil {
			return e
		}
		if e = instance.Client.MarkRead(ctx, keys, time.Now(), jid, author); e != nil {
			return e
		}
	}
	return nil
}

func groupPollCreation(message *waE2E.Message) *waE2E.PollCreationMessage {
	if message.GetPollCreationMessage() != nil {
		return message.GetPollCreationMessage()
	}
	if message.GetPollCreationMessageV2() != nil {
		return message.GetPollCreationMessageV2()
	}
	return message.GetPollCreationMessageV3()
}

func shouldSyncProviderContact(info types.ContactInfo, hasDirectConversation bool) bool {
	return hasDirectConversation || strings.TrimSpace(info.FullName) != "" || strings.TrimSpace(info.FirstName) != ""
}

func groupEventProtocol(event *events.Message) *waE2E.ProtocolMessage {
	if event == nil {
		return nil
	}
	message := event.RawMessage
	if message == nil {
		message = event.Message
	}
	for depth := 0; message != nil && depth < 8; depth++ {
		if protocol := message.GetProtocolMessage(); protocol != nil {
			return protocol
		}
		switch {
		case message.GetDeviceSentMessage() != nil:
			message = message.GetDeviceSentMessage().GetMessage()
		case message.GetBotInvokeMessage() != nil:
			message = message.GetBotInvokeMessage().GetMessage()
		case message.GetEphemeralMessage() != nil:
			message = message.GetEphemeralMessage().GetMessage()
		case message.GetEditedMessage() != nil:
			message = message.GetEditedMessage().GetMessage()
		default:
			return nil
		}
	}
	return nil
}

// Disabled by default; the account allowlist supports a staged provider rollout.
func (p *DevicePool) GroupsEnabledForAccount(accountID uuid.UUID) bool {
	if p == nil || p.cfg == nil || !p.cfg.WhatsAppGroupChatsEnabled || accountID == uuid.Nil {
		return false
	}
	allow := strings.TrimSpace(p.cfg.WhatsAppGroupChatAccounts)
	if allow == "" {
		return true
	}
	for _, raw := range strings.Split(allow, ",") {
		id, err := uuid.Parse(strings.TrimSpace(raw))
		if err == nil && id == accountID {
			return true
		}
	}
	return false
}

func (p *DevicePool) queueInitialGroupAvatar(instance *DeviceInstance, chat *domain.Chat) {
	if chat == nil || !chat.ContactCreated || chat.ContactID == nil || chat.ContactAvatarURL != nil {
		return
	}
	contactID, jid := *chat.ContactID, chat.JID
	go func() {
		groupAvatarSlots <- struct{}{}
		defer func() { <-groupAvatarSlots }()
		p.FetchInitialContactAvatar(instance, contactID, jid)
	}()
}
