package whatsapp

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/config"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

func TestCopyBuildsOriginalWithoutRequiringForwardingMetadata(t *testing.T) {
	for _, provenance := range []domain.MessageForwarding{{State: domain.ForwardingUnknown}, {State: domain.ForwardingForwarded}, {State: domain.ForwardingFrequentlyForwarded, Score: proto.Uint32(8)}} {
		source := &domain.Message{Body: proto.String("Content to share"), MessageType: proto.String(domain.MessageTypeText), Forwarding: provenance, QuotedMessageID: proto.String("private-source-id"), QuotedBody: proto.String("private quote"), QuotedSender: proto.String("private participant"), Mentions: []domain.MessageMention{{}}}
		raw, truth, err := buildSharedMessage(source, nil, domain.MessageSharingCopy, domain.MessageContentOriginal)
		if err != nil || truth.State != domain.ForwardingNotForwarded || truth.Score == nil || *truth.Score != 0 {
			t.Fatalf("copy inherited native provenance or required its score: %+v %v", truth, err)
		}
		wire, err := proto.Marshal(raw)
		if err != nil {
			t.Fatal(err)
		}
		decoded := &waE2E.Message{}
		if err = proto.Unmarshal(wire, decoded); err != nil {
			t.Fatal(err)
		}
		info := decoded.GetExtendedTextMessage().GetContextInfo()
		if info == nil || info.IsForwarded != nil || info.ForwardingScore != nil || info.GetStanzaID() != "" || info.GetQuotedMessage() != nil || info.GetParticipant() != "" || len(info.GetMentionedJID()) != 0 || raw.GetExtendedTextMessage().GetText() != *source.Body {
			t.Fatal("copy included source context or native forwarding flags")
		}
		observed := &domain.Message{}
		applyProviderForwarding(observed, raw)
		if observed.Forwarding.State != domain.ForwardingNotForwarded || observed.Forwarding.Score == nil || *observed.Forwarding.Score != 0 {
			t.Fatal("provider round trip failed to classify the new envelope")
		}
	}
	if _, _, err := buildNativeForward(&domain.Message{Body: proto.String("Unknown source"), Forwarding: domain.MessageForwarding{State: domain.ForwardingUnknown}}, nil); err == nil {
		t.Fatal("native forwarding stopped enforcing known provenance")
	}
}

func TestCopyAudioDocumentUsesDocumentUploadAndPreservesBytesMetadata(t *testing.T) {
	for _, ptt := range []*bool{nil, proto.Bool(false), proto.Bool(true)} {
		source := &domain.Message{MessageType: proto.String(domain.MessageTypeAudio), MediaURL: proto.String("/api/media/file/private-object"), MediaMimetype: proto.String("audio/ogg; codecs=opus"), AudioPTT: ptt, Forwarding: domain.MessageForwarding{State: domain.ForwardingUnknown}}
		kind, uploadKind, err := sharedContentKinds(source, domain.MessageSharingCopy, domain.MessageContentAudioDocument)
		if err != nil || kind != domain.MessageTypeAudio || uploadKind != domain.MessageTypeDocument {
			t.Fatalf("audio file was uploaded with audio encryption semantics: %s %s %v", kind, uploadKind, err)
		}
		media := &PreUploadedMedia{URL: "https://example.invalid/uploaded", DirectPath: "/fresh-upload", MediaKey: []byte{1, 2}, FileSHA256: []byte{3, 4}, FileEncSHA256: []byte{5, 6}, FileLength: 42, Mimetype: "application/octet-stream", OriginalMimetype: "audio/ogg", OriginalURL: "/private/source-id"}
		raw, truth, err := buildSharedMessage(source, media, domain.MessageSharingCopy, domain.MessageContentAudioDocument)
		doc := raw.GetDocumentMessage()
		if err != nil || doc == nil || raw.GetAudioMessage() != nil || doc.GetMimetype() != "audio/ogg; codecs=opus" || doc.GetFileName() != "audio.ogg" || doc.GetFileLength() != 42 || doc.GetContextInfo().IsForwarded != nil || truth.State != domain.ForwardingNotForwarded {
			t.Fatalf("audio file payload lost format or advertised forwarding: %v %+v", err, doc)
		}
		if string(doc.MediaKey) != string(media.MediaKey) || string(doc.FileSHA256) != string(media.FileSHA256) || string(doc.FileEncSHA256) != string(media.FileEncSHA256) {
			t.Fatal("document payload altered uploaded bytes/keys")
		}
		source.MediaFilename = proto.String("folder/mi audio.ogg")
		raw, _, err = buildSharedMessage(source, media, domain.MessageSharingCopy, domain.MessageContentAudioDocument)
		if err != nil || raw.GetDocumentMessage().GetFileName() != "mi audio.ogg" {
			t.Fatal("original audio filename was not retained safely")
		}
	}
}

func TestSharedAudioOriginalPreservesKnownPTTAndRejectsAmbiguousOriginal(t *testing.T) {
	media := &PreUploadedMedia{Mimetype: "audio/ogg; codecs=opus", Audio: &preparedAudio{Mimetype: "audio/ogg; codecs=opus", Seconds: 2, VoiceCompatible: true}}
	source := &domain.Message{MessageType: proto.String(domain.MessageTypeAudio), Forwarding: originalForwarding()}
	for _, mode := range []string{domain.MessageSharingCopy, domain.MessageSharingNative} {
		source.AudioPTT = nil
		if _, _, err := buildSharedMessage(source, media, mode, domain.MessageContentOriginal); err == nil {
			t.Fatal("unknown audio became a voice note")
		}
		for _, ptt := range []bool{false, true} {
			source.AudioPTT = proto.Bool(ptt)
			raw, _, err := buildSharedMessage(source, media, mode, domain.MessageContentOriginal)
			if err != nil || raw.GetAudioMessage().PTT == nil || raw.GetAudioMessage().GetPTT() != ptt {
				t.Fatal("original voice/audio semantics changed")
			}
		}
	}
	if _, _, err := buildSharedMessage(source, media, domain.MessageSharingNative, domain.MessageContentAudioDocument); err == nil {
		t.Fatal("native audio was converted to a document")
	}
	source.MessageType = proto.String(domain.MessageTypeImage)
	if _, _, err := buildSharedMessage(source, media, domain.MessageSharingCopy, domain.MessageContentAudioDocument); err == nil {
		t.Fatal("non-audio acquired audio file variant")
	}
}

func TestSharedContentRestrictionsApplyBeforeEitherModeUploads(t *testing.T) {
	base := domain.Message{Body: proto.String("Content"), MessageType: proto.String(domain.MessageTypeImage), Forwarding: originalForwarding()}
	for _, change := range []func(*domain.Message){func(m *domain.Message) { m.IsRevoked = true }, func(m *domain.Message) { m.IsViewOnce = true }, func(m *domain.Message) { m.MediaDeleted = true }, func(m *domain.Message) { m.MediaUnavailableReason = "expired" }, func(m *domain.Message) { m.MediaRecoverable = true }, func(m *domain.Message) { m.MessageType = proto.String(domain.MessageTypeContact) }, func(m *domain.Message) { m.MessageType = proto.String(domain.MessageTypeLocation) }} {
		for _, mode := range []string{domain.MessageSharingCopy, domain.MessageSharingNative} {
			source := base
			change(&source)
			if _, _, err := sharedContentKinds(&source, mode, domain.MessageContentOriginal); err == nil {
				t.Fatalf("unavailable or unsupported source accepted by %s", mode)
			}
		}
	}
	if _, _, err := buildSharedMessage(&base, nil, domain.MessageSharingCopy, domain.MessageContentOriginal); err == nil {
		t.Fatal("media without prepared file became a new message")
	}
	if _, _, err := buildSharedMessage(&domain.Message{Body: proto.String("  ")}, nil, domain.MessageSharingCopy, domain.MessageContentOriginal); err == nil {
		t.Fatal("empty text was sent")
	}
}

func TestCopyStickerRequiresVerifiedAnimation(t *testing.T) {
	source := &domain.Message{MessageType: proto.String(domain.MessageTypeSticker)}
	for _, animated := range []bool{false, true} {
		raw, _, err := buildSharedMessage(source, &PreUploadedMedia{StickerAnimationKnown: true, StickerAnimated: animated}, domain.MessageSharingCopy, domain.MessageContentOriginal)
		if err != nil || raw.GetStickerMessage().GetIsAnimated() != animated || raw.GetStickerMessage().GetContextInfo().GetIsForwarded() {
			t.Fatal("copy sticker lost animation or acquired forwarding metadata")
		}
	}
	if _, _, err := buildSharedMessage(source, &PreUploadedMedia{}, domain.MessageSharingCopy, domain.MessageContentOriginal); err == nil {
		t.Fatal("copy guessed sticker animation")
	}
}

func TestCopyDoesNotRequireNativeCapability(t *testing.T) {
	device := uuid.New()
	pool := &DevicePool{cfg: &config.Config{}, devices: map[uuid.UUID]*DeviceInstance{}}
	// An outer lifecycle operation is represented without touching a database.
	ctx := context.WithValue(context.Background(), deviceLifecycleContextKey{}, device)
	_, err := pool.ShareMessageWithID(ctx, device, "51900000001@s.whatsapp.net", nil, "reserved", domain.MessageSharingCopy, domain.MessageContentOriginal)
	var failure *domain.ForwardSendError
	if !errors.As(err, &failure) || failure.Code != "device_unavailable" || failure.OutcomeUnknown {
		t.Fatal("copy was blocked by the unrelated native capability", err)
	}
	_, err = pool.ForwardMessageWithID(ctx, device, "51900000001@s.whatsapp.net", nil, "reserved")
	if !errors.As(err, &failure) || failure.Code != "forward_capability_unverified" || failure.OutcomeUnknown {
		t.Fatal("native compatibility wrapper bypassed its gate", err)
	}
}

func TestSharedPersistenceKeepsPolicySeparateFromForwardingAndSourceIdentity(t *testing.T) {
	instance := &DeviceInstance{ID: uuid.New(), AccountID: uuid.New(), JID: "51900000001@s.whatsapp.net"}
	chat := &domain.Chat{ID: uuid.New()}
	source := &domain.Message{ID: uuid.New(), ChatID: uuid.New(), MessageID: "private-source", Body: proto.String("Source"), MessageType: proto.String(domain.MessageTypeAudio), AudioPTT: proto.Bool(true), MediaMimetype: proto.String("audio/mp4"), Forwarding: domain.MessageForwarding{State: domain.ForwardingFrequentlyForwarded, Score: proto.Uint32(8)}, QuotedMessageID: proto.String("private quote"), Mentions: []domain.MessageMention{{}}}
	limits := domain.EffectiveMessageSharingLimits(source)
	message := sharedMessageForPersistence(instance, chat, source, nil, "reserved-provider-id", time.Now(), originalForwarding(), domain.MessageContentAudioDocument, limits)
	if message.MessageID != "reserved-provider-id" || message.ID != uuid.Nil || message.ChatID != chat.ID || message.DeviceID == nil || *message.DeviceID != instance.ID || !message.IsFromMe || message.Forwarding.State != domain.ForwardingNotForwarded || *message.Forwarding.Score != 0 || message.SharingLimits == nil || message.SharingLimits.MaxChats != 1 || message.SharingLimits.MaxGroups != 1 {
		t.Fatalf("new envelope laundered policy or reused source identity: %+v", message)
	}
	if message.QuotedMessageID != nil || len(message.Mentions) != 0 || message.AudioPTT != nil || *message.MessageType != domain.MessageTypeDocument || *message.MediaFilename != "audio.m4a" || *message.MediaMimetype != "audio/mp4" {
		t.Fatal("document persistence contradicted the fresh payload")
	}
	source.SharingLimits = &domain.MessageSharingLimits{MaxChats: 1, MaxGroups: 1}
	source.Forwarding = originalForwarding()
	if effective := domain.EffectiveMessageSharingLimits(source); effective.MaxChats != 1 || effective.MaxGroups != 1 {
		t.Fatal("copying an already-copied message removed inherited restrictions")
	}
}

type sharedStoreStub struct {
	createErr           error
	existing, canonical *domain.Message
	mergeErr            error
	calls               []string
	limits              domain.MessageSharingLimits
}

func (s *sharedStoreStub) Create(context.Context, *domain.Message) error {
	s.calls = append(s.calls, "create")
	return s.createErr
}
func (s *sharedStoreStub) GetByMessageID(context.Context, uuid.UUID, string) (*domain.Message, error) {
	s.calls = append(s.calls, "echo")
	return s.existing, nil
}
func (s *sharedStoreStub) MergeMessageSharingLimits(_ context.Context, a, d, c uuid.UUID, id string, limits domain.MessageSharingLimits) (*domain.Message, error) {
	s.calls = append(s.calls, "merge")
	s.limits = limits
	if s.canonical != nil && (s.canonical.AccountID != a || s.canonical.DeviceID == nil || *s.canonical.DeviceID != d || s.canonical.ChatID != c || s.canonical.MessageID != id) {
		return s.canonical, nil
	}
	return s.canonical, s.mergeErr
}
func TestSharedPersistenceEchoRaceStillMergesInheritedPolicy(t *testing.T) {
	device := uuid.New()
	message := &domain.Message{AccountID: uuid.New(), DeviceID: &device, ChatID: uuid.New(), MessageID: "reserved", IsFromMe: true, Forwarding: originalForwarding()}
	limits := domain.MessageSharingLimits{MaxChats: 1, MaxGroups: 1}
	canonical := *message
	canonical.ID = uuid.New()
	canonical.SharingLimits = &limits
	for _, echoWins := range []bool{false, true} {
		store := &sharedStoreStub{existing: message, canonical: &canonical}
		if echoWins {
			store.createErr = pgx.ErrNoRows
		}
		got, err := persistSharedMessage(context.Background(), store, message, limits)
		if err != nil || got != &canonical || store.limits != limits || store.calls[len(store.calls)-1] != "merge" || (echoWins && len(store.calls) != 3) {
			t.Fatalf("echo winner skipped canonical policy merge: %+v %v", store, err)
		}
	}
	for _, setup := range []func(*sharedStoreStub){func(s *sharedStoreStub) { s.createErr = errors.New("insert failed") }, func(s *sharedStoreStub) { s.mergeErr = errors.New("merge failed") }, func(s *sharedStoreStub) { s.canonical = nil }, func(s *sharedStoreStub) { copy := canonical; copy.AccountID = uuid.New(); s.canonical = &copy }, func(s *sharedStoreStub) { s.createErr = pgx.ErrNoRows; s.existing = nil }} {
		store := &sharedStoreStub{existing: message, canonical: &canonical}
		setup(store)
		_, err := persistSharedMessage(context.Background(), store, message, limits)
		var failure *domain.ForwardSendError
		if !errors.As(err, &failure) || failure.Code != "forward_persistence_pending" || !failure.OutcomeUnknown {
			t.Fatalf("post-provider failure became safely retryable: %v", err)
		}
	}
}

func TestNativeSharedPersistenceRetainsStricterBuiltOutputPolicy(t *testing.T) {
	instance := &DeviceInstance{ID: uuid.New(), AccountID: uuid.New()}
	chat := &domain.Chat{ID: uuid.New()}
	for _, tc := range []struct {
		source domain.MessageForwarding
		want   domain.MessageSharingLimits
	}{
		{domain.MessageForwarding{State: domain.ForwardingNotForwarded}, domain.MessageSharingLimits{MaxChats: 5, MaxGroups: 1}},
		{domain.MessageForwarding{State: domain.ForwardingForwarded, Score: proto.Uint32(4)}, domain.MessageSharingLimits{MaxChats: 1, MaxGroups: 1}},
	} {
		source := &domain.Message{Body: proto.String("Native source"), Forwarding: tc.source}
		_, builtForwarding, err := buildNativeForward(source, nil)
		if err != nil {
			t.Fatal(err)
		}
		limits := sharedOutputLimits(source, builtForwarding)
		message := sharedMessageForPersistence(instance, chat, source, nil, "reserved", time.Now(), builtForwarding, domain.MessageContentOriginal, limits)
		if message.SharingLimits == nil || *message.SharingLimits != tc.want {
			t.Fatalf("native output retained weaker source-only policy: %+v want %+v", message.SharingLimits, tc.want)
		}
		// A partial own echo cannot yet prove native flags. Its separately
		// persisted policy still prevents a new copy widening the result.
		message.Forwarding = domain.MessageForwarding{State: domain.ForwardingUnknown}
		if got := domain.EffectiveMessageSharingLimits(message); got != tc.want {
			t.Fatalf("partial echo widened native output policy: %+v want %+v", got, tc.want)
		}
	}
}
