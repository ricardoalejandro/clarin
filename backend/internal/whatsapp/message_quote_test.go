package whatsapp

import (
	"testing"

	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/proto/waE2E"
)

func TestQuotesUseAuthenticContextAcrossLiveAndWrappedHistory(t *testing.T) {
	info := &waE2E.ContextInfo{StanzaID: strPtr("stanza-one"), Participant: strPtr("51900000001@s.whatsapp.net"), QuotedMessage: &waE2E.Message{Conversation: strPtr("Respuesta\ncon Unicode á")}}
	for _, message := range []*waE2E.Message{
		{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: strPtr("reply"), ContextInfo: info}},
		{ImageMessage: &waE2E.ImageMessage{ContextInfo: info}},
		{EphemeralMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{AudioMessage: &waE2E.AudioMessage{ContextInfo: info}}}},
	} {
		quote := extractQuote(message, "51900000001:12@s.whatsapp.net", nil)
		if quote.MessageID == nil || *quote.MessageID != "stanza-one" || quote.Body == nil || *quote.Body != "Respuesta\ncon Unicode á" || quote.IsFromMe == nil || !*quote.IsFromMe {
			t.Fatalf("quote context lost: %+v", quote)
		}
		var persisted domain.Message
		quote.Apply(&persisted)
		if persisted.QuotedMessageID == nil || persisted.QuotedIsFromMe == nil {
			t.Fatal("quote persistence fields missing")
		}
	}
}

func TestQuoteUnknownHistoryIsNotInvented(t *testing.T) {
	if quote := extractQuote(&waE2E.Message{Conversation: strPtr("no quote")}, "", nil); quote.MessageID != nil {
		t.Fatal("invented historical quote")
	}
	message := &waE2E.Message{StickerMessage: &waE2E.StickerMessage{ContextInfo: &waE2E.ContextInfo{StanzaID: strPtr("known")}}}
	quote := extractQuote(message, "", nil)
	if quote.MessageID == nil || quote.Body != nil || quote.IsFromMe != nil {
		t.Fatal("invented missing quote content or author")
	}
	original := &domain.Message{Body: strPtr("exact stored body"), IsFromMe: false, FromJID: strPtr("sender@test")}
	quote = extractQuote(message, "", original)
	if quote.Body == nil || *quote.Body != "exact stored body" || quote.IsFromMe == nil || *quote.IsFromMe {
		t.Fatal("exact original was not used")
	}
}

func TestQuoteDirectionDoesNotGuessAcrossPNAndLID(t *testing.T) {
	message := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{ContextInfo: &waE2E.ContextInfo{StanzaID: strPtr("original"), Participant: strPtr("123456@lid")}}}
	if quote := extractQuote(message, "51900000001@s.whatsapp.net", nil); quote.IsFromMe != nil {
		t.Fatal("unknown LID was classified as another author")
	}
	if quote := extractQuote(message, "51900000001@s.whatsapp.net", nil, "123456@lid"); quote.IsFromMe == nil || !*quote.IsFromMe {
		t.Fatal("own verified LID not recognized")
	}
}
