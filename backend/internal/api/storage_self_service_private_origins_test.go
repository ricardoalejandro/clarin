package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func TestStoragePrivateAdaptersRequireTheirOwnModulePermission(t *testing.T) {
	actor := storageUseActor{AccountID: uuid.New(), UserID: uuid.New(), Claims: &service.JWTClaims{Role: "member", Permissions: []string{domain.PermSettings}}}
	for _, adapter := range []storagePrivateUseAdapter{{}, {whiteboards: true}} {
		uses, err := adapter.List(context.Background(), nil, nil, actor, actor.AccountID.String()+"/private.png")
		if err != nil || len(uses) != 0 {
			t.Fatalf("settings granted %s access: %#v %v", adapter.Name(), uses, err)
		}
	}
}

func TestStoragePrivateUseReviewBindsAccountLocationAndDomainVersion(t *testing.T) {
	actor := storageUseActor{AccountID: uuid.New(), UserID: uuid.New()}
	ref := repository.PrivateStorageReference{Kind: "task_attachments", Origin: "tasks", ID: uuid.New(), ParentID: uuid.New(), ObjectKey: actor.AccountID.String() + "/private.pdf", Version: "1:task", CanRemove: true}
	adapter := storagePrivateUseAdapter{}
	initial := adapter.use(actor, ref)
	ref.Version = "2:task"
	changed := adapter.use(actor, ref)
	if initial.UseID != changed.UseID || initial.Fingerprint == changed.Fingerprint {
		t.Fatal("a newer domain state must invalidate the review without creating another use")
	}
	other := actor
	other.AccountID = uuid.New()
	if adapter.use(other, ref).UseID == initial.UseID {
		t.Fatal("use identity crossed accounts")
	}
	if len(initial.ReferenceIDs) != 1 || initial.ReferenceIDs[0] != "private_work|"+ref.ID.String() {
		t.Fatal("private physical-reference coverage was lost")
	}
}

func TestStorageWhiteboardRevisionUseCannotBeDetached(t *testing.T) {
	actor := storageUseActor{AccountID: uuid.New(), UserID: uuid.New()}
	ref := repository.PrivateStorageReference{Kind: "whiteboard_revision_assets", Origin: "whiteboards", ID: uuid.New(), ParentID: uuid.New(), ObjectKey: actor.AccountID.String() + "/_private/whiteboards/image.png", BlockedReason: "Se conserva para recuperar una versión de la pizarra."}
	use := (storagePrivateUseAdapter{whiteboards: true}).use(actor, ref)
	if use.CanRemove || use.BlockedReason == "" || use.Type != "whiteboards" {
		t.Fatal("immutable revision was exposed as removable media")
	}
}
