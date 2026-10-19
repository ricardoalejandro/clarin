package whatsapp

import "go.mau.fi/whatsmeow/types"

// A provider page can contain only duplicates or protocol events and still advance history.
func historyAnchorAdvances(previous, candidate *types.MessageInfo) bool {
	return candidate != nil && candidate.ID != "" && (previous == nil || candidate.Timestamp.Before(previous.Timestamp))
}
