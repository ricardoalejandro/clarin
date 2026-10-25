package api

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestTaskRemovalExecutionRequiresReviewedScopeAndStableOperation(t *testing.T) {
	t.Parallel()
	id := uuid.NewString()
	for _, raw := range []string{
		`{}`, `null`, `[]`, `{"mode":"delete_everything"}`,
		`{"mode":"trash_all"}`,
		`{"mode":"trash_all","preview_token":"reviewed","operation_id":"invalid"}`,
		`{"mode":"trash_all","preview_token":"reviewed","operation_id":"00000000-0000-0000-0000-000000000000"}`,
		`{"mode":"preserve_contents","destination_list_id":"00000000-0000-0000-0000-000000000000"}`,
	} {
		if _, _, err := parseTaskRemovalRequest([]byte(raw), true); err == nil {
			t.Fatalf("unreviewed removal accepted: %s", raw)
		}
	}
	raw, _ := json.Marshal(map[string]any{
		"mode": "preserve_contents", "destination_list_id": id, "preview_token": "scope-v1",
		"operation_id": id, "confirmation_name": " Lista ", "cancel_future_events": true, "confirm_access_changes": true,
	})
	request, operationID, err := parseTaskRemovalRequest(raw, true)
	if err != nil || operationID.String() != id || request.DestinationListID == nil || request.DestinationListID.String() != id ||
		request.PreviewToken != "scope-v1" || request.ConfirmationName != " Lista " || !request.CancelFutureEvents || !request.ConfirmAccessChanges {
		t.Fatalf("reviewed removal lost scope, exact name or replay identity: %#v, %s, %v", request, operationID, err)
	}
	_, replayID, err := parseTaskRemovalRequest(raw, true)
	if err != nil || replayID != operationID {
		t.Fatal("a retry changed its operation identity")
	}
}

func TestTaskRemovalPreviewDoesNotRequireAnExecutionIdentity(t *testing.T) {
	t.Parallel()
	request, operationID, err := parseTaskRemovalRequest([]byte(`{"mode":"trash_all"}`), false)
	if err != nil || request.Mode != "trash_all" || operationID != uuid.Nil {
		t.Fatalf("preparation should be read only: %#v %s %v", request, operationID, err)
	}
}

func TestTaskRemovalTargetRoutesRejectZeroAndInvalidIDs(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	handler := func(c *fiber.Ctx) error {
		kind, id, err := taskRemovalTarget(c)
		if err != nil {
			return c.SendStatus(400)
		}
		return c.JSON(fiber.Map{"type": kind, "id": id})
	}
	app.Post("/lists/:listId/remove", handler)
	app.Post("/folders/:folderId/remove", handler)
	app.Post("/environments/:environmentId/remove", handler)
	for _, kind := range []string{"lists", "folders", "environments"} {
		for _, raw := range []string{"invalid", uuid.Nil.String(), uuid.NewString()} {
			response, err := app.Test(httptest.NewRequest("POST", "/"+kind+"/"+raw+"/remove", nil))
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			want := 400
			if parsed, err := uuid.Parse(raw); err == nil && parsed != uuid.Nil {
				want = 200
			}
			if response.StatusCode != want {
				t.Fatalf("%s/%s status=%d want=%d", kind, raw, response.StatusCode, want)
			}
		}
	}
}

func TestTaskEnvironmentTombstoneAndPurgeEffectsKeepAudiencePrivate(t *testing.T) {
	environment, op, viewer, board := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	payload := taskEnvironmentTombstonePayload(environment, op, "environment_purged")
	if len(payload) != 4 || payload["environment_id"] != environment || payload["operation_id"] != op || payload["structure_changed"] != true || payload["action"] != "environment_purged" {
		t.Fatalf("unsafe tombstone fields: %v", payload)
	}
	raw, err := json.Marshal(domain.TaskTrashPurgeResult{Environments: 1, ViewerUserIDs: []uuid.UUID{viewer}, WhiteboardIDs: []uuid.UUID{board}})
	if err != nil || bytes.Contains(raw, []byte(viewer.String())) || bytes.Contains(raw, []byte(board.String())) {
		t.Fatal("internal audience/board effects leaked in HTTP JSON")
	}
}
