package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

const (
	ForwardingUnknown             = "unknown"
	ForwardingNotForwarded        = "not_forwarded"
	ForwardingForwarded           = "forwarded"
	ForwardingFrequentlyForwarded = "frequently_forwarded"
)

// MessageForwarding describes observed provider metadata, never the original author.
// A legacy message has unknown provenance rather than an invented negative.
type MessageForwarding struct {
	State string  `json:"state"`
	Score *uint32 `json:"score"`
}

func (f MessageForwarding) Normalize() MessageForwarding {
	switch f.State {
	case ForwardingNotForwarded, ForwardingForwarded, ForwardingFrequentlyForwarded:
	default:
		f.State = ForwardingUnknown
	}
	if f.Score != nil {
		value := *f.Score
		f.Score = &value
		if value >= 5 {
			f.State = ForwardingFrequentlyForwarded
		} else if value > 0 && f.State != ForwardingFrequentlyForwarded {
			f.State = ForwardingForwarded
		}
	}
	if f.State == ForwardingNotForwarded {
		value := uint32(0)
		f.Score = &value
	}
	if (f.State == ForwardingForwarded || f.State == ForwardingFrequentlyForwarded) && f.Score != nil && *f.Score == 0 {
		f.Score = nil
	}
	if f.State == ForwardingUnknown || (f.State == ForwardingFrequentlyForwarded && f.Score != nil && *f.Score < 5) {
		f.Score = nil
	}
	return f
}

func (f MessageForwarding) MarshalJSON() ([]byte, error) {
	type plain MessageForwarding
	return json.Marshal(plain(f.Normalize()))
}

// ClassifyProviderForwarding must only be called with supported=true after the
// actual supported content envelope has been observed, not on a partial patch.
func ClassifyProviderForwarding(flag *bool, score *uint32, supported bool) MessageForwarding {
	if !supported {
		return MessageForwarding{State: ForwardingUnknown}
	}
	state := ForwardingNotForwarded
	if flag != nil && *flag {
		state = ForwardingForwarded
	}
	if state == ForwardingNotForwarded && score == nil {
		value := uint32(0)
		score = &value
	}
	return (MessageForwarding{State: state, Score: score}).Normalize()
}

func MergeMessageForwarding(current, incoming MessageForwarding) MessageForwarding {
	current = current.Normalize()
	incoming = incoming.Normalize()
	rank := func(state string) int {
		switch state {
		case ForwardingNotForwarded:
			return 1
		case ForwardingForwarded:
			return 2
		case ForwardingFrequentlyForwarded:
			return 3
		}
		return 0
	}
	result := current
	if rank(incoming.State) > rank(current.State) {
		result.State = incoming.State
	}
	if incoming.Score != nil && (result.Score == nil || *incoming.Score > *result.Score) {
		result.Score = incoming.Score
	}
	return result.Normalize()
}

// ForwardSendError classifies only whether the transport was attempted. An
// unknown outcome must be reconciled by provider message ID, never replayed.
type ForwardSendError struct {
	Code           string
	OutcomeUnknown bool
	Err            error
}

func (e *ForwardSendError) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return fmt.Sprintf("forward failed: %s", e.Code)
}
func (e *ForwardSendError) Unwrap() error { return e.Err }

// NextForwarding follows the source account's outgoing authorship, never the
// identity of an arbitrary Clarin operator. Existing provenance is retained.
func NextForwarding(original Message) (MessageForwarding, error) {
	f := original.Forwarding.Normalize()
	if f.State == ForwardingUnknown {
		return f, &ForwardSendError{Code: "forwarding_source_unknown", Err: fmt.Errorf("sincroniza el mensaje para conocer su procedencia antes de reenviarlo")}
	}
	if f.Score == nil {
		return f, &ForwardSendError{Code: "forwarding_score_unknown", Err: fmt.Errorf("WhatsApp no entregó el contador necesario para reenviar este mensaje")}
	}
	if f.State == ForwardingNotForwarded && original.IsFromMe {
		return f, nil
	}
	score := *f.Score
	if score < ^uint32(0) {
		score++
	}
	return (MessageForwarding{State: ForwardingForwarded, Score: &score}).Normalize(), nil
}

// MessageForwardFingerprint freezes only content/provenance affecting this
// operation. Read receipts, reactions and display-name updates are independent.
func MessageForwardFingerprint(m *Message) string {
	if m == nil {
		return ""
	}
	value := struct {
		ID          any
		Account     any
		Device      any
		Chat        any
		Provider    any
		Body        any
		Kind        any
		Media       any
		Mimetype    any
		Filename    any
		Size        any
		Asset       any
		Revoked     bool
		ViewOnce    bool
		Deleted     bool
		Unavailable string
		Recoverable bool
		Own         bool
		Audio       *bool
		Forwarding  MessageForwarding
	}{m.ID, m.AccountID, m.DeviceID, m.ChatID, m.Provider, m.Body, m.MessageType, m.MediaURL, m.MediaMimetype, m.MediaFilename, m.MediaSize, m.MediaAssetID, m.IsRevoked, m.IsViewOnce, m.MediaDeleted, m.MediaUnavailableReason, m.MediaRecoverable, m.IsFromMe, m.AudioPTT, m.Forwarding.Normalize()}
	raw, _ := json.Marshal(value)
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}
