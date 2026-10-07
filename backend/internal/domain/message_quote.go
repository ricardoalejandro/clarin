package domain

// MessageQuote holds only quote context supplied by WhatsApp or an exact
// account/chat-scoped original. Unknown historical context stays unknown.
type MessageQuote struct {
	MessageID *string
	Body      *string
	Sender    *string
	IsFromMe  *bool
}

func (q MessageQuote) Apply(message *Message) {
	message.QuotedMessageID, message.QuotedBody = q.MessageID, q.Body
	message.QuotedSender, message.QuotedIsFromMe = q.Sender, q.IsFromMe
}
