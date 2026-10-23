package repository

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestTaskRemovalConfirmationRejectsUnreviewedOrChangedDecision(t *testing.T) {
	p := &domain.TaskContainerRemovalPreview{Name: "Lista de prueba", PreviewToken: "canonical", RequiresName: true, RequiresEventCancellation: true, RequiresAccessConfirmation: true, CanExecute: true}
	req := domain.TaskContainerRemovalRequest{Mode: "trash_all", PreviewToken: "canonical", ConfirmationName: p.Name, CancelFutureEvents: true, ConfirmAccessChanges: true}
	if err := taskRemovalConfirmationsValid(p, req); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		change func(*domain.TaskContainerRemovalRequest)
		want   error
	}{
		{"stale", func(r *domain.TaskContainerRemovalRequest) { r.PreviewToken = "older" }, ErrTaskRemovalPreviewChanged},
		{"empty token", func(r *domain.TaskContainerRemovalRequest) { r.PreviewToken = "" }, ErrTaskRemovalPreviewChanged},
		{"exact name", func(r *domain.TaskContainerRemovalRequest) { r.ConfirmationName = "Lista de prueba " }, ErrTaskTrashConfirmation},
		{"future cancellation", func(r *domain.TaskContainerRemovalRequest) { r.CancelFutureEvents = false }, ErrWorkEventCancelRequired},
		{"access confirmation", func(r *domain.TaskContainerRemovalRequest) { r.ConfirmAccessChanges = false }, ErrTaskAccessInvalid},
	} {
		t.Run(test.name, func(t *testing.T) {
			changed := req
			test.change(&changed)
			if !errors.Is(taskRemovalConfirmationsValid(p, changed), test.want) {
				t.Fatalf("did not require %s", test.name)
			}
		})
	}
	p.CanExecute = false
	if !errors.Is(taskRemovalConfirmationsValid(p, req), ErrTaskRemovalInvalid) {
		t.Fatal("blocked preview accepted")
	}
}

func TestTaskRemovalReplayHashBindsActorTargetModeDestinationAndConfirmations(t *testing.T) {
	actor, target, destination := uuid.New(), uuid.New(), uuid.New()
	req := domain.TaskContainerRemovalRequest{Mode: "preserve_contents", DestinationListID: &destination, PreviewToken: "reviewed", ConfirmationName: "A", ConfirmAccessChanges: true}
	canonical := taskRemovalRequestHash(actor, target, "list", req)
	if canonical != taskRemovalRequestHash(actor, target, "list", req) {
		t.Fatal("unstable hash")
	}
	for _, changed := range []domain.TaskContainerRemovalRequest{{Mode: "trash_all", PreviewToken: "reviewed"}, {Mode: req.Mode, DestinationListID: &destination, PreviewToken: "changed"}, {Mode: req.Mode, DestinationListID: &destination, PreviewToken: "reviewed", ConfirmationName: "B"}} {
		if canonical == taskRemovalRequestHash(actor, target, "list", changed) {
			t.Fatal("changed operation payload reused canonical hash")
		}
	}
	if canonical == taskRemovalRequestHash(uuid.New(), target, "list", req) || canonical == taskRemovalRequestHash(actor, uuid.New(), "list", req) || canonical == taskRemovalRequestHash(actor, target, "folder", req) {
		t.Fatal("hash failed to bind operation identity")
	}
}

func TestTaskRemovalInputLimitsModesAndExplicitDestination(t *testing.T) {
	id := uuid.New()
	nilID := uuid.Nil
	for _, test := range []struct {
		kind    string
		request domain.TaskContainerRemovalRequest
		valid   bool
	}{
		{"list", domain.TaskContainerRemovalRequest{Mode: "trash_all"}, true},
		{"folder", domain.TaskContainerRemovalRequest{Mode: "preserve_contents"}, true},
		{"environment", domain.TaskContainerRemovalRequest{Mode: "trash_all"}, false},
		{"list", domain.TaskContainerRemovalRequest{Mode: "delete"}, false},
		{"list", domain.TaskContainerRemovalRequest{Mode: "trash_all", DestinationListID: &id}, false},
		{"list", domain.TaskContainerRemovalRequest{Mode: "preserve_contents", DestinationListID: &nilID}, false},
	} {
		if (validateTaskRemovalRequest(test.kind, test.request) == nil) != test.valid {
			t.Fatalf("unexpected validity for %#v", test)
		}
	}
}
