package api

import (
	"github.com/google/uuid"
	"testing"
)

func TestUseProjectionSharedHiddenAndRecoverableMedia(t *testing.T) {
	message, hidden := uuid.New(), uuid.New()
	visible := storageSelfServiceUse{UseID: "visible", Type: "chats", SourceID: message, Label: "Conversación autorizada", CanRemove: true}
	file := storageSelfServiceFile{Status: "active", refs: []storageSelfServiceReference{{Origin: "chats", ID: message.String()}, {Origin: "private_work", ID: hidden.String(), Label: "No revelar"}}}
	storageApplyUseProjection(&file, []storageSelfServiceUse{visible})
	if file.CanRemove || !file.CanRemoveUses || !file.RetainedElsewhere || file.ReferencesCount != 1 || len(file.Origins) != 1 {
		t.Fatalf("unexpected capability projection: %+v", file)
	}
	if file.Origins[0].Label != "Conversación autorizada" {
		t.Fatal("hidden reference leaked")
	}
}

func TestUseProjectionGroupsMirrorsWithoutInventingHiddenUses(t *testing.T) {
	parent, attachment := uuid.New(), uuid.New()
	file := storageSelfServiceFile{Status: "active", refs: []storageSelfServiceReference{{Origin: "quick_replies", ID: parent.String()}, {Origin: "quick_replies", ID: attachment.String()}}}
	use := storageSelfServiceUse{UseID: "reply", Type: "quick_replies", SourceID: attachment, ParentID: parent, CanRemove: true, ReferenceIDs: []string{"quick_replies|" + parent.String(), "quick_replies|" + attachment.String()}}
	storageApplyUseProjection(&file, []storageSelfServiceUse{use})
	if !file.CanRemove || file.RetainedElsewhere || file.ReferencesCount != 1 {
		t.Fatalf("canonical use counted as mirrors: %+v", file)
	}
	file.Status = "trash"
	storageApplyUseProjection(&file, []storageSelfServiceUse{use})
	if file.CanRemove {
		t.Fatal("a recovery entry must never become a file-removal candidate")
	}
}

func TestUseProjectionProtectedHistoryBlocksWholeFileRemoval(t *testing.T) {
	current, history := uuid.New(), uuid.New()
	file := storageSelfServiceFile{Status: "active", refs: []storageSelfServiceReference{{Origin: "private_whiteboards", ID: current.String()}, {Origin: "private_whiteboards", ID: history.String()}}}
	uses := []storageSelfServiceUse{
		{UseID: "current", Type: "whiteboards", SourceID: current, CanRemove: true, ReferenceIDs: []string{"private_whiteboards|" + current.String()}},
		{UseID: "history", Type: "whiteboards", SourceID: history, CanRemove: false, ReferenceIDs: []string{"private_whiteboards|" + history.String()}},
	}
	storageApplyUseProjection(&file, uses)
	if file.CanRemove || !file.CanRemoveUses || file.RetainedElsewhere || file.ReferencesCount != 2 {
		t.Fatalf("history protection failed: %+v", file)
	}
}

func TestPrivateNamespaceNeedsTheCanonicalResourceAdapter(t *testing.T) {
	account := uuid.New()
	key := account.String() + "/_private/tasks/attachments/report.pdf"
	chat := storageSelfServiceUse{AccountID: account, ObjectKey: key, Adapter: "ordinary", Type: "chats"}
	if storageSelfServiceHasAuthorizedPrivateUse(account, key, []storageSelfServiceUse{chat}) {
		t.Fatal("a chat reference must not authorize a Work object")
	}
	work := chat
	work.Adapter = "private_work"
	work.Type = "tasks"
	if !storageSelfServiceHasAuthorizedPrivateUse(account, key, []storageSelfServiceUse{work}) {
		t.Fatal("the authorized Work adapter should expose its attachment")
	}
	work.AccountID = uuid.New()
	if storageSelfServiceHasAuthorizedPrivateUse(account, key, []storageSelfServiceUse{work}) {
		t.Fatal("foreign account use authorized a private object")
	}
}
