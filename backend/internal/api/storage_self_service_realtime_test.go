package api

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
)

func TestStorageChangedReachesAccountReadersWithoutDisclosingMedia(t *testing.T) {
	hub := ws.NewHub()
	account, otherAccount := uuid.New(), uuid.New()
	register := func(accountID uuid.UUID, permissions map[string]bool) *ws.Client {
		t.Helper()
		client := &ws.Client{ID: uuid.NewString(), AccountID: accountID, UserID: uuid.New(), Send: make(chan []byte, 4), Permissions: permissions}
		if !hub.RegisterAtAuthorityEpoch(client, hub.AuthorityEpoch(accountID, client.UserID)) {
			t.Fatal("realtime fixture registration failed")
		}
		return client
	}
	reader := register(account, map[string]bool{domain.PermChats: true})
	manager := register(account, map[string]bool{domain.PermSettings: true})
	foreign := register(otherAccount, map[string]bool{domain.PermChats: true, domain.PermSettings: true})
	t.Cleanup(func() {
		hub.DisconnectAccountForAuthority(account)
		hub.DisconnectAccountForAuthority(otherAccount)
	})
	go hub.Run()
	s := &Server{hub: hub}
	s.storageSelfServicePublishChanged(account, "private-file-key-must-not-leak.pdf")
	// FIFO marker proves the previous fanout finished before the negative
	// assertion; a late message to the other account cannot pass by timing.
	hub.BroadcastToAccount(otherAccount, "qa_barrier", nil)
	read := func(client *ws.Client) map[string]any {
		t.Helper()
		select {
		case payload := <-client.Send:
			var event map[string]any
			if err := json.Unmarshal(payload, &event); err != nil {
				t.Fatal(err)
			}
			return event
		case <-time.After(time.Second):
			t.Fatal("account reader did not receive storage invalidation")
			return nil
		}
	}
	for _, client := range []*ws.Client{reader, manager} {
		event := read(client)
		data, ok := event["data"].(map[string]any)
		if !ok || event["event"] != "storage_changed" || event["account_id"] != account.String() || len(event) != 3 {
			t.Fatalf("invalid account invalidation envelope: %v", event)
		}
		if len(data) != 3 || data["account_id"] != account.String() || data["reason"] != "changed" {
			t.Fatalf("invalidation disclosed media metadata: %v", data)
		}
		if revision, ok := data["revision"].(float64); !ok || revision <= 0 {
			t.Fatalf("invalidation revision missing: %v", data)
		}
	}
	if event := read(foreign); event["event"] != "qa_barrier" {
		t.Fatalf("storage invalidation crossed the account boundary: %v", event)
	}
}
