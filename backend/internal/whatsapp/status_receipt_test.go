package whatsapp

import (
	"context"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func TestCanonicalStatusViewerJIDPrefersPhoneIdentity(t *testing.T) {
	own := types.NewJID("51999000000", types.DefaultUserServer)
	ownLID := types.NewJID("100000000000", types.HiddenUserServer)
	viewerPN := types.NewJID("51999111111", types.DefaultUserServer)
	viewerLID := types.NewJID("200000000000", types.HiddenUserServer)
	pool := &DevicePool{}
	instance := &DeviceInstance{Client: &whatsmeow.Client{Store: &store.Device{ID: &own, LID: ownLID}}}

	receipt := &events.Receipt{MessageSource: types.MessageSource{
		Chat: types.StatusBroadcastJID, Sender: viewerLID, SenderAlt: viewerPN,
	}}
	if got := pool.canonicalStatusViewerJID(context.Background(), instance, receipt); got != viewerPN.String() {
		t.Fatalf("expected sender PN %q, got %q", viewerPN.String(), got)
	}

	// Some broadcast receipts expose the current user as Sender and the actual
	// viewer as BroadcastListOwner. Own identities must never become viewers.
	receipt = &events.Receipt{MessageSource: types.MessageSource{
		Chat: types.StatusBroadcastJID, Sender: own, SenderAlt: ownLID, BroadcastListOwner: viewerPN,
	}}
	if got := pool.canonicalStatusViewerJID(context.Background(), instance, receipt); got != viewerPN.String() {
		t.Fatalf("expected broadcast owner PN %q, got %q", viewerPN.String(), got)
	}

	receipt = &events.Receipt{MessageSource: types.MessageSource{
		Chat: types.StatusBroadcastJID, Sender: own, SenderAlt: ownLID,
	}}
	if got := pool.canonicalStatusViewerJID(context.Background(), instance, receipt); got != "" {
		t.Fatalf("own identity was accepted as viewer: %q", got)
	}
}
