package whatsapp

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/config"
	"github.com/valyala/fasthttp"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
	"testing"
	"time"
)

func TestGroupSenderIdentityKeepsAuthorSeparateFromConversation(t *testing.T) {
	group := types.NewJID("120001", types.GroupServer)
	pn := types.NewJID("51999000111", types.DefaultUserServer)
	lid := types.NewJID("7001", types.HiddenUserServer)
	source := types.MessageSource{Chat: group, Sender: lid, SenderAlt: pn, IsGroup: true}
	if actual := groupSenderIdentity(source); actual != pn {
		t.Fatalf("author identity %v", actual)
	}
	pool := &DevicePool{}
	if actual := pool.resolveMessagePeerIdentity(context.Background(), nil, source); actual.JID != group {
		t.Fatalf("conversation was replaced by member: %v", actual)
	}
}

func TestGroupProjectionMembershipAndAnnouncement(t *testing.T) {
	pn := types.NewJID("51999000111", types.DefaultUserServer)
	lid := types.NewJID("7001", types.HiddenUserServer)
	info := &types.GroupInfo{Participants: []types.GroupParticipant{{JID: lid, PhoneNumber: pn, LID: lid}}}
	info.Name = "Equipo"
	info.IsAnnounce = true
	group, members := groupProjection(info, pn, lid, false)
	if group.MembershipStatus != "member" || group.CanSend || len(members) != 1 || members[0].JID != pn.String() || members[0].LID != lid.String() {
		t.Fatal("incorrect membership/announcement capability")
	}
	info.Participants[0].IsAdmin = true
	group, _ = groupProjection(info, pn, lid, false)
	if !group.CanSend {
		t.Fatal("admin cannot send")
	}
	group.ResolveSendCapability(false)
	if group.CanSend {
		t.Fatal("disconnected send enabled")
	}
	info.Participants = nil
	group, _ = groupProjection(info, pn, lid, false)
	if group.CanSend || group.MembershipStatus != "unknown" {
		t.Fatal("missing membership accepted")
	}
}

func TestGroupMentionsPreserveReplyAndMutableRequestContext(t *testing.T) {
	var request fasthttp.RequestCtx
	mentions := []domain.MessageMention{{JID: "51999000111@s.whatsapp.net", Name: "Ana"}}
	domain.WithMessageMentions(&request, mentions)
	quoted := &waE2E.ContextInfo{StanzaID: proto.String("original"), Participant: proto.String("51999000112@s.whatsapp.net")}
	msg := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("Hola @51999000111"), ContextInfo: quoted}}
	applyOutboundGroupMentions(&request, types.NewJID("120001", types.GroupServer), msg)
	if msg.ExtendedTextMessage.ContextInfo.GetStanzaID() != "original" || len(msg.ExtendedTextMessage.ContextInfo.MentionedJID) != 1 {
		t.Fatal("mention lost quote/context")
	}
	direct := &waE2E.Message{Conversation: proto.String("hola")}
	applyOutboundGroupMentions(&request, types.NewJID("51999000111", types.DefaultUserServer), direct)
	if direct.ExtendedTextMessage != nil {
		t.Fatal("direct message changed by group mentions")
	}
}

func TestGroupOutboundRequiresExactManualAuthorization(t *testing.T) {
	pool := &DevicePool{cfg: &config.Config{WhatsAppGroupChatsEnabled: true}}
	instance := &DeviceInstance{ID: uuid.New(), AccountID: uuid.New()}
	jid := types.NewJID("120001", types.GroupServer)
	if pool.requireGroupSend(context.Background(), instance, jid) == nil {
		t.Fatal("automated group send accepted")
	}
	auth := groupSendAuthorization{AccountID: instance.AccountID, DeviceID: instance.ID, ChatID: uuid.New(), JID: jid.String(), BindingRevision: 4}
	ctx := context.WithValue(context.Background(), groupSendContextKey{}, auth)
	chat := &domain.Chat{ID: auth.ChatID, AccountID: auth.AccountID, DeviceID: &auth.DeviceID, JID: auth.JID, BindingRevision: 4}
	if !validGroupSendBinding(auth, chat, uuid.Nil) {
		t.Fatal("legacy bound group rejected")
	}
	if !sameGroupSendConversation(chat, chat, instance.AccountID, instance.ID, jid.String()) {
		t.Fatal("same refreshed conversation rejected")
	}
	different := *chat
	different.ID = uuid.New()
	if sameGroupSendConversation(chat, &different, instance.AccountID, instance.ID, jid.String()) {
		t.Fatal("refresh silently changed authorized conversation")
	}
	different = *chat
	otherDevice := uuid.New()
	different.DeviceID = &otherDevice
	if sameGroupSendConversation(chat, &different, instance.AccountID, instance.ID, jid.String()) {
		t.Fatal("refresh silently changed sender")
	}
	if pool.requireGroupSend(ctx, instance, jid) == nil {
		t.Fatal("missing persistence validation accepted")
	}
	chat.BindingRevision++
	if validGroupSendBinding(auth, chat, uuid.Nil) {
		t.Fatal("binding change during upload accepted")
	}
	chat.BindingRevision = 4
	owner := uuid.New()
	chat.WhatsAppOwnerID = &owner
	chat.BindingState = "verified_continuity"
	if !validGroupSendBinding(auth, chat, owner) {
		t.Fatal("current verified owner rejected")
	}
	if validGroupSendBinding(auth, chat, uuid.New()) {
		t.Fatal("different own identity accepted")
	}
	chat.BindingState = "conflict"
	if validGroupSendBinding(auth, chat, owner) {
		t.Fatal("conflicting binding accepted")
	}
	if pool.requireGroupSend(ctx, instance, types.NewJID("120002", types.GroupServer)) == nil {
		t.Fatal("authorization reused for another group")
	}
	instance.ID = uuid.New()
	if pool.requireGroupSend(ctx, instance, jid) == nil {
		t.Fatal("authorization reused on another device")
	}
}

func TestGroupHistoryAdvancesAcrossDuplicateOnlyPages(t *testing.T) {
	now := time.Now()
	anchor := &types.MessageInfo{ID: "new", Timestamp: now}
	older := &types.MessageInfo{ID: "duplicate", Timestamp: now.Add(-time.Hour)}
	if !historyAnchorAdvances(anchor, older) {
		t.Fatal("older duplicate page stopped recovery")
	}
	if historyAnchorAdvances(anchor, anchor) || historyAnchorAdvances(anchor, nil) {
		t.Fatal("non-progressing page loops")
	}
}

func TestGroupMediaRecoveryIsBoundedAndNeverReopensViewOnce(t *testing.T) {
	image := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{FileLength: proto.Uint64(1024)}}
	if recoverableGroupMedia(image) == nil {
		t.Fatal("ordinary history image not recoverable")
	}
	viewOnce := &waE2E.Message{ViewOnceMessage: &waE2E.FutureProofMessage{Message: image}}
	if recoverableGroupMedia(viewOnce) != nil {
		t.Fatal("view-once history made replayable")
	}
	image.ImageMessage.FileLength = proto.Uint64(65 << 20)
	if recoverableGroupMedia(image) != nil {
		t.Fatal("unbounded media recovery enabled")
	}
	if recoverableGroupMedia(&waE2E.Message{Conversation: proto.String("hola")}) != nil {
		t.Fatal("text serialized as media")
	}
}

func TestGroupOnlyPushNamesNeverEnterPersonalContactSync(t *testing.T) {
	if shouldSyncProviderContact(types.ContactInfo{PushName: "Autor del grupo"}, false) {
		t.Fatal("group-only push name became CRM identity")
	}
	if !shouldSyncProviderContact(types.ContactInfo{FullName: "Contacto guardado"}, false) {
		t.Fatal("explicit address book entry excluded")
	}
	if !shouldSyncProviderContact(types.ContactInfo{PushName: "Conversación directa"}, true) {
		t.Fatal("existing direct peer excluded")
	}
}

func TestGroupMediaRecoveryHonorsProviderUnwrappedViewOnce(t *testing.T) {
	image := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{FileLength: proto.Uint64(1024)}}
	event := (&events.Message{RawMessage: &waE2E.Message{ViewOnceMessageV2Extension: &waE2E.FutureProofMessage{Message: image}}}).UnwrapRaw()
	if !event.IsViewOnce || event.Message.ImageMessage == nil {
		t.Fatal("provider fixture not unwrapped")
	}
	if recoverableGroupEventMedia(event) != nil {
		t.Fatal("unwrapped view-once enabled permanent recovery")
	}
}

func TestGroupHistoryEditSurvivesProviderFlattening(t *testing.T) {
	edited := &waE2E.Message{Conversation: proto.String("corregido")}
	protocol := &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), Key: &waCommon.MessageKey{ID: proto.String("original")}, EditedMessage: edited}
	raw := &waE2E.Message{EditedMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{ProtocolMessage: protocol}}}
	event := (&events.Message{RawMessage: raw}).UnwrapRaw()
	// ParseWebMessage flattens the protocol after UnwrapRaw.
	event.Info.ID = protocol.GetKey().GetID()
	event.Message = edited
	if found := groupEventProtocol(event); found == nil || found.GetKey().GetID() != "original" || found.GetEditedMessage().GetConversation() != "corregido" {
		t.Fatal("history edit treated as duplicate plain message")
	}
}

func TestGroupRolloutIsDisabledByDefaultAndAccountScoped(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	pool := &DevicePool{}
	if pool.GroupsEnabledForAccount(a) {
		t.Fatal("missing config enabled groups")
	}
	pool.cfg = &config.Config{}
	if pool.GroupsEnabledForAccount(a) {
		t.Fatal("default enabled groups")
	}
	pool.cfg.WhatsAppGroupChatsEnabled = true
	pool.cfg.WhatsAppGroupChatAccounts = " " + a.String() + ", invalid "
	if !pool.GroupsEnabledForAccount(a) || pool.GroupsEnabledForAccount(b) {
		t.Fatal("allowlist did not isolate account")
	}
	pool.cfg.WhatsAppGroupChatAccounts = "invalid"
	if pool.GroupsEnabledForAccount(a) {
		t.Fatal("invalid allowlist enabled all")
	}
	pool.cfg.WhatsAppGroupChatAccounts = ""
	if !pool.GroupsEnabledForAccount(b) || pool.GroupsEnabledForAccount(uuid.Nil) {
		t.Fatal("global rollout capability wrong")
	}
	pool.cfg.WhatsAppGroupChatsEnabled = false
	if pool.GroupsEnabledForAccount(a) {
		t.Fatal("disabled rollout ignored")
	}
}
