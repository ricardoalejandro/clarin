package domain

import "fmt"

const (
	MessageSharingNative        = "native"
	MessageSharingCopy          = "copy"
	MessageContentOriginal      = "original"
	MessageContentAudioDocument = "audio_document"
)

func NormalizeMessageSharingMode(value string) (string, error) {
	if value == "" {
		return MessageSharingNative, nil
	}
	switch value {
	case MessageSharingNative, MessageSharingCopy:
		return value, nil
	}
	return "", fmt.Errorf("modo de envío inválido")
}
func NormalizeMessageContentVariant(value string) (string, error) {
	if value == "" {
		return MessageContentOriginal, nil
	}
	switch value {
	case MessageContentOriginal, MessageContentAudioDocument:
		return value, nil
	}
	return "", fmt.Errorf("variante de contenido inválida")
}

// MessageSharingLimits are local policy inherited by a copied message. They
// never claim that WhatsApp marked that fresh envelope as a native forward.
type MessageSharingLimits struct {
	MaxChats  int `json:"max_chats"`
	MaxGroups int `json:"max_groups"`
}

func (l MessageSharingLimits) Valid() bool {
	return (l.MaxChats == 1 || l.MaxChats == 5) && (l.MaxGroups == 1 || l.MaxGroups == 5) && l.MaxGroups <= l.MaxChats
}
func boundedSharingLimit(value int) int {
	if value == 5 {
		return 5
	}
	return 1
}
func (l MessageSharingLimits) Normalize() MessageSharingLimits {
	l.MaxChats = boundedSharingLimit(l.MaxChats)
	l.MaxGroups = boundedSharingLimit(l.MaxGroups)
	if l.MaxGroups > l.MaxChats {
		l.MaxGroups = l.MaxChats
	}
	return l
}
func MergeMessageSharingLimits(current, incoming *MessageSharingLimits) *MessageSharingLimits {
	if current == nil && incoming == nil {
		return nil
	}
	result := MessageSharingLimits{MaxChats: 5, MaxGroups: 5}
	for _, limits := range []*MessageSharingLimits{current, incoming} {
		if limits == nil {
			continue
		}
		known := limits.Normalize()
		if known.MaxChats < result.MaxChats {
			result.MaxChats = known.MaxChats
		}
		if known.MaxGroups < result.MaxGroups {
			result.MaxGroups = known.MaxGroups
		}
	}
	return &result
}
func EffectiveMessageSharingLimits(message *Message) MessageSharingLimits {
	result := MessageSharingLimits{MaxChats: 5, MaxGroups: 5}
	if message == nil {
		return result
	}
	switch message.Forwarding.Normalize().State {
	case ForwardingForwarded:
		result.MaxGroups = 1
	case ForwardingFrequentlyForwarded:
		result.MaxChats = 1
		result.MaxGroups = 1
	}
	return *MergeMessageSharingLimits(&result, message.SharingLimits)
}

// MessageSharingOutputLimits freezes the restriction of the prepared envelope
// too. A metadata-incomplete own echo must not temporarily widen that policy.
func MessageSharingOutputLimits(source *Message, mode string) (MessageSharingLimits, error) {
	if source == nil {
		return MessageSharingLimits{}, fmt.Errorf("missing sharing source")
	}
	normalized, err := NormalizeMessageSharingMode(mode)
	if err != nil {
		return MessageSharingLimits{}, err
	}
	limits := EffectiveMessageSharingLimits(source)
	if normalized == MessageSharingCopy {
		return limits, nil
	}
	next, err := NextForwarding(*source)
	if err != nil {
		return MessageSharingLimits{}, err
	}
	outgoing := *source
	outgoing.Forwarding = next
	outgoing.SharingLimits = &limits
	return EffectiveMessageSharingLimits(&outgoing), nil
}
