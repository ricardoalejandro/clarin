package repository

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestGroupParticipantsAdminFirstPostgresPagination(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	repo := NewRepositories(db).Chat
	device, otherDevice := uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO devices(id,account_id,name) VALUES($1,$3,'Order first'),($2,$3,'Order second')`, device, otherDevice, f.account)
	chat, err := repo.GetOrCreateGroup(ctx, f.account, device, "1200771@g.us", "Order QA")
	if err != nil {
		t.Fatal(err)
	}
	other, err := repo.GetOrCreateGroup(ctx, f.account, otherDevice, chat.JID, "Other device order QA")
	if err != nil {
		t.Fatal(err)
	}
	metadata := &domain.ChatGroup{Subject: "Order QA", MembershipStatus: "member", Kind: "group"}
	members := make([]domain.GroupParticipant, 137)
	for i := range members {
		role := "member"
		if i >= 70 {
			role = "admin"
			if i%2 == 0 {
				role = "super_admin"
			}
		}
		name := fmt.Sprintf("Member %03d", i)
		if i == 5 || i == 125 {
			name = "Needle " + name
		}
		members[i] = domain.GroupParticipant{JID: fmt.Sprintf("519000%05d@s.whatsapp.net", i), Name: name, Role: role}
	}
	save := func() {
		t.Helper()
		// Provider array order is deliberately different from the established JID order.
		reversed := make([]domain.GroupParticipant, len(members))
		for i := range members {
			reversed[len(members)-i-1] = members[i]
		}
		if err := repo.SaveGroup(ctx, f.account, chat.ID, metadata, reversed); err != nil {
			t.Fatal(err)
		}
	}
	save()
	if err = repo.SaveGroup(ctx, f.account, other.ID, metadata, []domain.GroupParticipant{{JID: "51900099999@s.whatsapp.net", Role: "admin"}}); err != nil {
		t.Fatal(err)
	}
	var beforeContacts, beforeChats int
	integrityScanCount(t, db, `SELECT count(*) FROM contacts WHERE account_id=$1`, f.account, &beforeContacts)
	integrityScanCount(t, db, `SELECT count(*) FROM chats WHERE account_id=$1`, f.account, &beforeChats)
	collect := func(legacy bool, search string, matching []string, limit int) []string {
		t.Helper()
		all, cursor := []string{}, ""
		seen := map[string]bool{}
		for pageIndex := 0; pageIndex < 200; pageIndex++ {
			var page []domain.GroupParticipant
			var next string
			var err error
			if legacy {
				page, next, err = repo.GroupParticipantsMatching(ctx, f.account, chat.ID, search, cursor, limit, matching)
			} else {
				page, next, err = repo.GroupParticipantsAdminFirst(ctx, f.account, chat.ID, search, cursor, limit, matching)
			}
			if err != nil || len(page) > limit {
				t.Fatalf("page failed or exceeded limit: size=%d err=%v", len(page), err)
			}
			for _, member := range page {
				if seen[member.JID] {
					t.Fatal("participant repeated across pages")
				}
				seen[member.JID] = true
				all = append(all, member.JID)
			}
			if next == "" {
				return all
			}
			if next == cursor {
				t.Fatal("cursor repeated")
			}
			cursor = next
		}
		t.Fatal("pagination did not end")
		return nil
	}
	want := []string{}
	for _, member := range members[70:] {
		want = append(want, member.JID)
	}
	for _, member := range members[:70] {
		want = append(want, member.JID)
	}
	if got := collect(false, "", nil, 50); !reflect.DeepEqual(got, want) {
		t.Fatal("admins must precede every member before pagination, retaining JID order within both blocks")
	}
	legacyWant := []string{}
	for _, member := range members {
		legacyWant = append(legacyWant, member.JID)
	}
	if got := collect(true, "", nil, 50); !reflect.DeepEqual(got, legacyWant) {
		t.Fatal("legacy ordering changed")
	}
	legacyFirst, legacyCursor, err := repo.GroupParticipants(ctx, f.account, chat.ID, "", "", 50)
	if err != nil || len(legacyFirst) != 50 || legacyCursor != members[49].JID {
		t.Fatal("legacy cursor contract changed", err)
	}
	if got := collect(false, "Needle", nil, 1); !reflect.DeepEqual(got, []string{members[125].JID, members[5].JID}) {
		t.Fatal("SQL name search lost admin ordering")
	}
	matching := []string{members[1].JID, members[71].JID, members[50].JID, members[100].JID}
	if got := collect(false, "Name only available in the authorized projection", matching, 1); !reflect.DeepEqual(got, []string{members[71].JID, members[100].JID, members[1].JID, members[50].JID}) {
		t.Fatal("projected name search lost its order or page boundary")
	}
	if got := collect(false, "Member", []string{}, 50); len(got) != 0 {
		t.Fatal("empty authoritative matches fell back to stored names")
	}
	first, cursor, err := repo.GroupParticipantsAdminFirst(ctx, f.account, chat.ID, "", "", 50, nil)
	if err != nil || len(first) != 50 || cursor == "" || first[0].JID != members[70].JID {
		t.Fatal("first admin page failed", err)
	}
	for _, scope := range []struct {
		account, chat uuid.UUID
		search, after string
	}{{f.account, chat.ID, "", legacyCursor}, {uuid.New(), chat.ID, "", cursor}, {f.account, other.ID, "", cursor}, {f.account, chat.ID, "changed", cursor}} {
		if _, _, err = repo.GroupParticipantsAdminFirst(ctx, scope.account, scope.chat, scope.search, scope.after, 50, nil); !errors.Is(err, ErrGroupParticipantsCursorReset) {
			t.Fatal("foreign, legacy or changed-query cursor was accepted", err)
		}
	}
	if foreign, _, err := repo.GroupParticipantsAdminFirst(ctx, uuid.New(), chat.ID, "", "", 50, nil); err != nil || len(foreign) != 0 {
		t.Fatal("new ordering crossed account scope", err)
	}
	members[0].Role, members[70].Role = "admin", "member"
	save()
	if _, _, err = repo.GroupParticipantsAdminFirst(ctx, f.account, chat.ID, "", cursor, 50, nil); !errors.Is(err, ErrGroupParticipantsCursorReset) {
		t.Fatal("role changes must invalidate the earlier page boundary", err)
	}
	fresh, _, err := repo.GroupParticipantsAdminFirst(ctx, f.account, chat.ID, "", "", 50, nil)
	if err != nil || len(fresh) != 50 || fresh[0].JID != members[0].JID {
		t.Fatal("restarting after a role change did not include the promoted admin", err)
	}
	legacyNext, _, err := repo.GroupParticipants(ctx, f.account, chat.ID, "", legacyCursor, 50)
	if err != nil || len(legacyNext) != 50 || legacyNext[0].JID != members[50].JID {
		t.Fatal("legacy continuation was changed to the new cursor mode", err)
	}
	for _, role := range []string{"member", "admin", "super_admin"} {
		for i := range members {
			members[i].Role = role
		}
		save()
		if got := collect(false, "", nil, 50); !reflect.DeepEqual(got, legacyWant) {
			t.Fatalf("single role %s changed relative JID ordering", role)
		}
	}
	if err = repo.SaveGroup(ctx, f.account, chat.ID, metadata, nil); err != nil {
		t.Fatal(err)
	}
	if empty, next, err := repo.GroupParticipantsAdminFirst(ctx, f.account, chat.ID, "", "", 50, nil); err != nil || empty == nil || len(empty) != 0 || next != "" {
		t.Fatal("empty group must remain a successful empty page", err)
	}
	var afterContacts, afterChats int
	integrityScanCount(t, db, `SELECT count(*) FROM contacts WHERE account_id=$1`, f.account, &afterContacts)
	integrityScanCount(t, db, `SELECT count(*) FROM chats WHERE account_id=$1`, f.account, &afterChats)
	if beforeContacts != afterContacts || beforeChats != afterChats {
		t.Fatal("ordering reads changed CRM records")
	}
}
