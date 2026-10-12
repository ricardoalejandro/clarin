package repository

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestEventListCancelledFilterAndExplicitStatus(t *testing.T) {
	account := uuid.New()
	for _, status := range []string{"", "active", "draft", "completed", "cancelled"} {
		for _, exclude := range []bool{false, true} {
			query, args := eventListConditions(account, domain.EventFilter{Status: status, ExcludeCancelled: exclude})
			if args[0] != account || !strings.Contains(query, "account_id = $1") {
				t.Fatal("account scope lost")
			}
			if strings.Contains(query, "status <> 'cancelled'") != (exclude && status == "") {
				t.Fatalf("incorrect exclusion: %s", query)
			}
			if status != "" && (len(args) != 2 || args[1] != status || !strings.Contains(query, "status = $2")) {
				t.Fatalf("explicit status lost: %s %#v", query, args)
			}
		}
	}
}

func TestEventListConditionsKeepSearchFolderAndDatesParameterized(t *testing.T) {
	account, folder := uuid.New(), uuid.New()
	from, to := time.Now(), time.Now().Add(time.Hour)
	query, args := eventListConditions(account, domain.EventFilter{Search: "' search", ExcludeCancelled: true, FolderFilter: folder.String(), DateFrom: &from, DateTo: &to})
	want := []any{account, "%' search%", from, to, folder.String()}
	if !reflect.DeepEqual(args, want) || strings.Contains(query, "' search") {
		t.Fatalf("unsafe filter: %s %#v", query, args)
	}
	for _, fragment := range []string{"name ILIKE $2", "event_date >= $3", "event_date <= $4", "folder_id = $5"} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("missing %s: %s", fragment, query)
		}
	}
	root, _ := eventListConditions(account, domain.EventFilter{FolderFilter: "root", ExcludeCancelled: true})
	if !strings.Contains(root, "folder_id IS NULL") {
		t.Fatalf("root scope lost: %s", root)
	}
}
