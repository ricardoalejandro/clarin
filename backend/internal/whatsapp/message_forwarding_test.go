package whatsapp

import (
	"context"
	"encoding/binary"
	"errors"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/config"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
	"testing"
)

func TestProviderForwardingDoesNotInheritQuote(t *testing.T) {
	quote := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("quoted"), ContextInfo: &waE2E.ContextInfo{IsForwarded: proto.Bool(true), ForwardingScore: proto.Uint32(8)}}}
	raw := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("reply"), ContextInfo: &waE2E.ContextInfo{QuotedMessage: quote}}}
	message := &domain.Message{}
	applyProviderForwarding(message, raw)
	if message.Forwarding.State != domain.ForwardingNotForwarded {
		t.Fatal("a quoted forward classified its parent")
	}
	applyProviderForwarding(message, quote)
	if message.Forwarding.State != domain.ForwardingFrequentlyForwarded || *message.Forwarding.Score != 8 {
		t.Fatal("provider metadata lost")
	}
}

func TestProviderForwardingWrappersAndAudio(t *testing.T) {
	raw := &waE2E.Message{DocumentWithCaptionMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(false), ContextInfo: &waE2E.ContextInfo{IsForwarded: proto.Bool(true)}}}}}
	message := &domain.Message{}
	applyProviderForwarding(message, raw)
	if message.Forwarding.State != domain.ForwardingForwarded || message.Forwarding.Score != nil || message.AudioPTT == nil || *message.AudioPTT {
		t.Fatal("partial metadata or audio semantics were invented")
	}
	applyProviderForwarding(message, &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{}})
	if message.Forwarding.State != domain.ForwardingUnknown {
		t.Fatal("technical event declared an original")
	}
}

func TestNativeForwardFreshEnvelopeAndRoundTrip(t *testing.T) {
	text, kind := "QA source", domain.MessageTypeText
	source := &domain.Message{Body: &text, MessageType: &kind, Forwarding: originalForwarding(), QuotedBody: proto.String("private quote"), QuotedMessageID: proto.String("private source"), Mentions: []domain.MessageMention{{}}}
	raw, forwarding, err := buildNativeForward(source, nil)
	if err != nil || forwarding.State != domain.ForwardingForwarded || *forwarding.Score != 1 {
		t.Fatalf("native forward: %v", err)
	}
	payload, err := proto.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	decoded := &waE2E.Message{}
	if err = proto.Unmarshal(payload, decoded); err != nil {
		t.Fatal(err)
	}
	info := decoded.GetExtendedTextMessage().GetContextInfo()
	if !info.GetIsForwarded() || info.GetForwardingScore() != 1 || info.GetStanzaID() != "" || info.GetQuotedMessage() != nil || len(info.GetMentionedJID()) != 0 || info.GetParticipant() != "" {
		t.Fatal("forward context not isolated")
	}
	source.IsFromMe = true
	raw, _, err = buildNativeForward(source, nil)
	if err != nil || raw.GetExtendedTextMessage().GetContextInfo().GetIsForwarded() {
		t.Fatal("own original was falsely labelled")
	}
	source.IsViewOnce = true
	if _, _, err = buildNativeForward(source, nil); err == nil {
		t.Fatal("view-once forwarded")
	}
}

func TestNativeForwardMediaPreservesVoiceAndFilename(t *testing.T) {
	caption, kind := "QA caption", domain.MessageTypeAudio
	source := &domain.Message{Body: &caption, MessageType: &kind, Forwarding: originalForwarding(), AudioPTT: proto.Bool(false)}
	media := &PreUploadedMedia{URL: "https://example.invalid/media", Mimetype: "audio/ogg", OriginalFilename: "QA.txt", OriginalURL: "/api/media/file/qa"}
	raw, _, err := buildNativeForward(source, media)
	if err != nil || raw.GetAudioMessage().GetPTT() {
		t.Fatal("audio became voice note")
	}
	source.AudioPTT = nil
	if _, _, err = buildNativeForward(source, media); err == nil {
		t.Fatal("unknown audio semantics forwarded")
	}
	kind = domain.MessageTypeDocument
	raw, _, err = buildNativeForward(source, media)
	if err != nil || raw.GetDocumentMessage().GetFileName() != "QA.txt" || raw.GetDocumentMessage().GetCaption() != caption {
		t.Fatal("document metadata lost")
	}
	kind = domain.MessageTypeContact
	if _, _, err = buildNativeForward(source, media); err == nil {
		t.Fatal("contact silently copied as text")
	}
}

func TestEditedWrapperCannotInventNegativeForwardingEvidence(t *testing.T) {
	raw := &waE2E.Message{EditedMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("edited body")}}}}
	message := &domain.Message{}
	applyProviderForwarding(message, raw)
	if message.Forwarding.State != domain.ForwardingUnknown {
		t.Fatal("partial edit declared an original")
	}
	raw.EditedMessage.Message.ExtendedTextMessage.ContextInfo = &waE2E.ContextInfo{IsForwarded: proto.Bool(true), ForwardingScore: proto.Uint32(6)}
	applyProviderForwarding(message, raw)
	if message.Forwarding.State != domain.ForwardingFrequentlyForwarded {
		t.Fatal("positive metadata in edit was discarded")
	}
}
func testWebPChunk(tag string, payload []byte) []byte {
	out := make([]byte, 8+len(payload)+(len(payload)&1))
	copy(out, tag)
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(payload)))
	copy(out[8:], payload)
	return out
}
func testWebPContainer(chunks ...[]byte) []byte {
	out := []byte("RIFF0000WEBP")
	for _, chunk := range chunks {
		out = append(out, chunk...)
	}
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(out)-8))
	return out
}
func TestStickerForwardPreservesVerifiedAnimation(t *testing.T) {
	static := testWebPContainer(testWebPChunk("VP8L", []byte{0x2f}))
	header := make([]byte, 10)
	header[0] = 0x02
	frame := append(make([]byte, 16), testWebPChunk("VP8L", []byte{0x2f})...)
	animated := testWebPContainer(testWebPChunk("VP8X", header), testWebPChunk("ANIM", make([]byte, 6)), testWebPChunk("ANMF", frame))
	for _, tc := range []struct {
		data []byte
		want bool
	}{{static, false}, {animated, true}} {
		got, err := stickerWebPAnimation(tc.data)
		if err != nil || got != tc.want {
			t.Fatal("WebP animation misclassified", got, err)
		}
		kind := domain.MessageTypeSticker
		source := &domain.Message{MessageType: &kind, Forwarding: originalForwarding()}
		media := &PreUploadedMedia{StickerAnimationKnown: true, StickerAnimated: got}
		raw, _, err := buildNativeForward(source, media)
		if err != nil || raw.GetStickerMessage().GetIsAnimated() != tc.want {
			t.Fatal("sticker animation flag lost", err)
		}
	}
	malformed := [][]byte{[]byte("not a sticker"), animated[:len(animated)-1], testWebPContainer(testWebPChunk("VP8X", header)), testWebPContainer(testWebPChunk("ANMF", frame))}
	for _, data := range malformed {
		if _, err := stickerWebPAnimation(data); err == nil {
			t.Fatal("incomplete animation treated as still image")
		}
	}
	kind := domain.MessageTypeSticker
	if _, _, err := buildNativeForward(&domain.Message{MessageType: &kind, Forwarding: originalForwarding()}, &PreUploadedMedia{}); err == nil {
		t.Fatal("unknown animation forwarded")
	}
}
func TestNativeForwardRevalidatesOriginalAfterPreparation(t *testing.T) {
	text, kind := "Original", "text"
	source := &domain.Message{Body: &text, MessageType: &kind, Forwarding: originalForwarding()}
	copy := *source
	if !sameNativeForwardSource(source, &copy) {
		t.Fatal("stable source rejected")
	}
	copy.IsRevoked = true
	if sameNativeForwardSource(source, &copy) {
		t.Fatal("revoked source survived upload")
	}
	copy = *source
	copy.MediaUnavailableReason = "expired"
	if sameNativeForwardSource(source, &copy) {
		t.Fatal("unavailable source survived preparation")
	}
	copy = *source
	copy.MediaRecoverable = true
	if sameNativeForwardSource(source, &copy) {
		t.Fatal("source requiring recovery survived preparation")
	}
	copy = *source
	newText := "edited"
	copy.Body = &newText
	if sameNativeForwardSource(source, &copy) {
		t.Fatal("edited source survived upload")
	}
}

func TestNativeForwardingRequiresExplicitVerifiedRollout(t *testing.T) {
	device, other := uuid.New(), uuid.New()
	var absent *DevicePool
	if absent.NativeForwardingEnabledForDevice(device) {
		t.Fatal("nil pool enabled forwarding")
	}
	pool := &DevicePool{cfg: &config.Config{}}
	if pool.NativeForwardingEnabledForDevice(device) {
		t.Fatal("unverified forwarding enabled by default")
	}
	pool.cfg.WhatsAppNativeForwardingEnabled = true
	pool.cfg.WhatsAppNativeForwardingDeviceIDs = "invalid," + device.String()
	if !pool.NativeForwardingEnabledForDevice(device) || pool.NativeForwardingEnabledForDevice(other) || pool.NativeForwardingEnabledForDevice(uuid.Nil) {
		t.Fatal("verified-device allowlist was bypassed")
	}
}

func TestNativeForwardTargetCannotBeRecreatedOrReassigned(t *testing.T) {
	account, device, contact, id := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	expected := &domain.Chat{ID: id, AccountID: account, DeviceID: &device, ContactID: &contact, JID: "51900000123@s.whatsapp.net"}
	current := *expected
	if !sameNativeForwardTarget(expected, &current) {
		t.Fatal("stable destination rejected")
	}
	for _, change := range []func(*domain.Chat){func(c *domain.Chat) { c.ID = uuid.New() }, func(c *domain.Chat) { c.AccountID = uuid.New() }, func(c *domain.Chat) { v := uuid.New(); c.DeviceID = &v }, func(c *domain.Chat) { v := uuid.New(); c.ContactID = &v }, func(c *domain.Chat) { c.JID = "51900000456@s.whatsapp.net" }} {
		current = *expected
		change(&current)
		if sameNativeForwardTarget(expected, &current) {
			t.Fatal("changed destination accepted")
		}
	}
	if sameNativeForwardTarget(expected, nil) {
		t.Fatal("deleted destination accepted")
	}
	body := "QA text with nullable legacy type"
	raw, _, err := buildNativeForward(&domain.Message{Body: &body, Forwarding: originalForwarding()}, nil)
	if err != nil || raw.GetExtendedTextMessage().GetText() != body {
		t.Fatal("nullable text type treated as media")
	}
}

func TestProviderEventRetainsEditTruthAfterWhatsmeowUnwrap(t *testing.T) {
	raw := &waE2E.Message{EditedMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("synthetic edit")}}}}
	evt := (&events.Message{RawMessage: raw}).UnwrapRaw()
	if !evt.IsEdit || evt.Message.GetEditedMessage() != nil {
		t.Fatal("test did not exercise actual provider unwrap")
	}
	message := &domain.Message{}
	applyProviderEventForwarding(message, evt)
	if message.Forwarding.State != domain.ForwardingUnknown {
		t.Fatal("unwrapped partial edit invented an original")
	}
	// The explicit flag remains authoritative even for a pre-unwrapped raw field.
	evt.RawMessage = evt.Message
	applyProviderEventForwarding(message, evt)
	if message.Forwarding.State != domain.ForwardingUnknown {
		t.Fatal("edit flag ignored for pre-unwrapped raw payload")
	}
	// Some adapters retain only the parsed message plus IsEdit.
	evt.RawMessage = nil
	applyProviderEventForwarding(message, evt)
	if message.Forwarding.State != domain.ForwardingUnknown {
		t.Fatal("parsed edit flag was ignored")
	}
	evt.Message.ExtendedTextMessage.ContextInfo = &waE2E.ContextInfo{IsForwarded: proto.Bool(true), ForwardingScore: proto.Uint32(6)}
	applyProviderEventForwarding(message, evt)
	if message.Forwarding.State != domain.ForwardingFrequentlyForwarded {
		t.Fatal("positive edit metadata lost")
	}
	evt.IsEdit = false
	evt.Message.ExtendedTextMessage.ContextInfo = nil
	applyProviderEventForwarding(message, evt)
	if message.Forwarding.State != domain.ForwardingNotForwarded {
		t.Fatal("complete original event lost")
	}
}

func TestNativeForwardGroupPermissionIsFreshAndRequired(t *testing.T) {
	account, device, contact, chatID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	target := &domain.Chat{ID: chatID, AccountID: account, DeviceID: &device, ContactID: &contact, JID: "12345@g.us"}
	ctx := context.Background()
	type checkKey struct{}
	calls := 0
	changed := errors.New("synthetic membership changed during media preparation")
	verify := func(c context.Context, a, d, id uuid.UUID, jid string, mentions []domain.MessageMention, requireSend bool) (context.Context, error) {
		calls++
		if a != account || d != device || id != chatID || jid != target.JID || !requireSend || len(mentions) != 0 {
			t.Fatal("stale or cross-scope group verification")
		}
		if calls == 1 {
			return c, changed
		}
		return context.WithValue(c, checkKey{}, true), nil
	}
	_, err := refreshNativeForwardGroup(ctx, account, device, target, verify)
	var failure *domain.ForwardSendError
	if !errors.As(err, &failure) || failure.OutcomeUnknown || !errors.Is(err, changed) {
		t.Fatal("changed group permission did not stop the transport before sending")
	}
	fresh, err := refreshNativeForwardGroup(ctx, account, device, target, verify)
	if err != nil || fresh.Value(checkKey{}) != true || calls != 2 {
		t.Fatal("fresh provider context lost")
	}
	private := *target
	private.JID = "51900000000@s.whatsapp.net"
	if _, err = refreshNativeForwardGroup(ctx, account, device, &private, verify); err != nil || calls != 2 {
		t.Fatal("private destination used group permissions")
	}
	foreign := *target
	foreign.AccountID = uuid.New()
	if _, err = refreshNativeForwardGroup(ctx, account, device, &foreign, verify); err == nil || calls != 2 {
		t.Fatal("foreign destination refreshed a provider group")
	}
}
