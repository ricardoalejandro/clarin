package whatsapp

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

func TestCanonicalReactionSenderJID(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "canonical phone jid",
			raw:  "51987654321@s.whatsapp.net",
			want: "51987654321@s.whatsapp.net",
		},
		{
			name: "linked device suffix",
			raw:  "51987654321:17@s.whatsapp.net",
			want: "51987654321@s.whatsapp.net",
		},
		{
			name: "agent and linked device suffix",
			raw:  "51987654321.1:17@s.whatsapp.net",
			want: "51987654321@s.whatsapp.net",
		},
		{
			name: "surrounding whitespace",
			raw:  " 51987654321:3@s.whatsapp.net ",
			want: "51987654321@s.whatsapp.net",
		},
		{
			name: "invalid value remains stable",
			raw:  "not a jid",
			want: "not a jid",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := canonicalReactionSenderJID(tt.raw); got != tt.want {
				t.Fatalf("canonicalReactionSenderJID(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestOwnReactionSenderJIDPrefersCanonicalStoreID(t *testing.T) {
	t.Parallel()

	ownJID := types.JID{
		User:   "51987654321",
		Device: 17,
		Server: types.DefaultUserServer,
	}
	client := whatsmeow.NewClient(&store.Device{ID: &ownJID}, nil)
	instance := &DeviceInstance{
		Client: client,
		JID:    "stale:4@s.whatsapp.net",
	}

	if got, want := ownReactionSenderJID(instance), "51987654321@s.whatsapp.net"; got != want {
		t.Fatalf("ownReactionSenderJID() = %q, want %q", got, want)
	}
}

func TestReactionTargetSenderJID(t *testing.T) {
	t.Parallel()

	chat := types.JID{
		User:   "51911111111",
		Device: 8,
		Server: types.DefaultUserServer,
	}

	got, err := reactionTargetSenderJID(chat, "", true)
	if err != nil {
		t.Fatalf("own target sender: %v", err)
	}
	if !got.IsEmpty() {
		t.Fatalf("own target sender = %q, want empty JID", got.String())
	}
	got, err = reactionTargetSenderJID(chat, "", false)
	if err != nil {
		t.Fatalf("direct target sender: %v", err)
	}
	if want := "51911111111@s.whatsapp.net"; got.String() != want {
		t.Fatalf("remote target sender = %q, want %q", got.String(), want)
	}

	group := types.NewJID("120363123456789", types.GroupServer)
	if _, err := reactionTargetSenderJID(group, "", false); err == nil {
		t.Fatal("group target without sender JID must fail")
	}
	got, err = reactionTargetSenderJID(group, "51922222222:7@s.whatsapp.net", false)
	if err != nil {
		t.Fatalf("group target sender: %v", err)
	}
	if want := "51922222222@s.whatsapp.net"; got.String() != want {
		t.Fatalf("group target sender = %q, want %q", got.String(), want)
	}
}

func TestWhatsmeowBuildReactionSetsKeyAndTimestamp(t *testing.T) {
	t.Parallel()

	ownJID := types.NewJID("51987654321", types.DefaultUserServer)
	client := whatsmeow.NewClient(&store.Device{ID: &ownJID}, nil)
	chat := types.NewJID("51911111111", types.DefaultUserServer)

	targetSender, err := reactionTargetSenderJID(chat, "", false)
	if err != nil {
		t.Fatalf("reactionTargetSenderJID() error = %v", err)
	}
	msg := client.BuildReaction(chat, targetSender, "message-id", "👍")
	reaction := msg.GetReactionMessage()
	if reaction == nil {
		t.Fatal("BuildReaction returned no reaction message")
	}
	if reaction.GetSenderTimestampMS() <= 0 {
		t.Fatalf("reaction timestamp = %d, want positive unix milliseconds", reaction.GetSenderTimestampMS())
	}
	if got, want := reaction.GetKey().GetRemoteJID(), chat.String(); got != want {
		t.Fatalf("remote JID = %q, want %q", got, want)
	}
	if reaction.GetKey().GetFromMe() {
		t.Fatal("remote target key marked as from me")
	}
	if got, want := reaction.GetKey().GetID(), "message-id"; got != want {
		t.Fatalf("target message id = %q, want %q", got, want)
	}
}

func TestReactionEventTimestampPrefersSenderMilliseconds(t *testing.T) {
	t.Parallel()

	fallback := time.Date(2026, time.July, 11, 6, 0, 0, 0, time.UTC)
	senderTimestamp := fallback.Add(275 * time.Millisecond)

	if got := reactionEventTimestamp(fallback, senderTimestamp.UnixMilli()); !got.Equal(senderTimestamp) {
		t.Fatalf("reactionEventTimestamp() = %s, want %s", got, senderTimestamp)
	}
	if got := reactionEventTimestamp(fallback, 0); !got.Equal(fallback) {
		t.Fatalf("reactionEventTimestamp() fallback = %s, want %s", got, fallback)
	}
}
