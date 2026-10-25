package repository

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestGroupParticipantsCursorScopesAndAdminBoundary(t *testing.T) {
	account, chat := uuid.New(), uuid.New()
	for _, role := range []string{"admin", "super_admin", "member", ""} {
		t.Run(role, func(t *testing.T) {
			member := domain.GroupParticipant{JID: "700123@lid", Role: role}
			raw := encodeGroupParticipantsCursor(account, chat, "  Búsqueda  ", 17, member)
			cursor, err := decodeGroupParticipantsCursor(raw, account, chat, "Búsqueda")
			wantRank := 1
			if role == "admin" || role == "super_admin" {
				wantRank = 0
			}
			if err != nil || cursor == nil || cursor.JID != member.JID || cursor.Rank != wantRank || cursor.GroupRevision != 17 {
				t.Fatalf("lost page boundary: %+v %v", cursor, err)
			}
			for _, scope := range []struct {
				account, chat uuid.UUID
				search        string
			}{{uuid.New(), chat, "Búsqueda"}, {account, uuid.New(), "Búsqueda"}, {account, chat, "another query"}} {
				if _, err = decodeGroupParticipantsCursor(raw, scope.account, scope.chat, scope.search); !errors.Is(err, ErrGroupParticipantsCursorReset) {
					t.Fatalf("cursor crossed its query scope: %v", err)
				}
			}
		})
	}
	if cursor, err := decodeGroupParticipantsCursor("", account, chat, ""); cursor != nil || err != nil {
		t.Fatal("first page must not require a cursor", err)
	}
}

func TestGroupParticipantsCursorRejectsLegacyAndInvalidVersions(t *testing.T) {
	account, chat := uuid.New(), uuid.New()
	raw := encodeGroupParticipantsCursor(account, chat, "", 2, domain.GroupParticipant{JID: "700123@lid", Role: "admin"})
	base, err := decodeGroupParticipantsCursor(raw, account, chat, "")
	if err != nil {
		t.Fatal(err)
	}
	cases := []string{"700123@lid", "gp2.invalid", "gp1.!", strings.Repeat("x", 2049)}
	for _, change := range []func(*groupParticipantsCursor){
		func(c *groupParticipantsCursor) { c.Version = 2 },
		func(c *groupParticipantsCursor) { c.Order = "jid" },
		func(c *groupParticipantsCursor) { c.Rank = -1 },
		func(c *groupParticipantsCursor) { c.Rank = 2 },
		func(c *groupParticipantsCursor) { c.GroupRevision = -1 },
		func(c *groupParticipantsCursor) { c.JID = "" },
	} {
		cursor := *base
		change(&cursor)
		body, _ := json.Marshal(cursor)
		cases = append(cases, groupParticipantsCursorPrefix+base64.RawURLEncoding.EncodeToString(body))
	}
	for i, candidate := range cases {
		if _, err = decodeGroupParticipantsCursor(candidate, account, chat, ""); !errors.Is(err, ErrGroupParticipantsCursorReset) {
			t.Errorf("invalid cursor %d accepted: %v", i, err)
		}
	}
}
