package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestTagSearchContextPermissions(t *testing.T) {
	for _, test := range []struct {
		context, permission    string
		commercial, automation bool
	}{{"contact_create", domain.PermContacts, false, false}, {"lead_create", domain.PermLeads, true, false}, {"lead_import", domain.PermLeads, true, false}, {"automation", domain.PermAutomations, true, true}, {"other", "", false, false}} {
		permission, commercial, automation := tagSearchContextPermission(test.context)
		if permission != test.permission || commercial != test.commercial || automation != test.automation {
			t.Fatalf("unexpected context authority: %s", test.context)
		}
	}
}

func TestTagSearchIDHydrationIsBoundedAndDeduplicated(t *testing.T) {
	id := uuid.New()
	ids, err := parseTagSearchIDs(id.String() + "," + id.String())
	if err != nil || len(ids) != 1 {
		t.Fatalf("duplicate ids: %v %v", ids, err)
	}
	for _, raw := range []string{"invalid", uuid.Nil.String(), strings.Repeat(id.String()+",", 25) + id.String()} {
		if _, err := parseTagSearchIDs(raw); err == nil {
			t.Fatal("invalid hydration accepted")
		}
	}
}

func TestManualLeadTagIDsParserPreservesEmptyAndRejectsNull(t *testing.T) {
	empty, err := parseContactProfileTagIDs(json.RawMessage(`[]`))
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatal("explicit empty lost")
	}
	if _, err := parseContactProfileTagIDs(json.RawMessage(`null`)); err == nil {
		t.Fatal("null accepted")
	}
}

func TestAutomationTagConfigurationDraftAndActive(t *testing.T) {
	id := uuid.New()
	a := &domain.Automation{Config: domain.AutomationGraph{Nodes: []domain.AutomationNode{{Type: domain.AutoNodeAssignTag, Data: map[string]interface{}{"tag_id": ""}}}}}
	if ids, err := automationTagActionIDs(a); err != nil || len(ids) != 0 {
		t.Fatal("empty inactive draft rejected")
	}
	a.IsActive = true
	if _, err := automationTagActionIDs(a); err == nil {
		t.Fatal("active empty action accepted")
	}
	a.Config.Nodes[0].Data["tag_id"] = id.String()
	a.Config.Nodes = append(a.Config.Nodes, a.Config.Nodes[0])
	if ids, err := automationTagActionIDs(a); err != nil || len(ids) != 1 || ids[0] != id {
		t.Fatal("valid actions rejected/doubled")
	}
	a.Config.Nodes[0].Data["tag_id"] = "not-a-uuid"
	if _, err := automationTagActionIDs(a); err == nil {
		t.Fatal("malformed tag accepted")
	}
}

func TestSelectedImportTagPreservesCatalogName(t *testing.T) {
	name := "\"Campaña `especial`\""
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("import_tag", "  "+name+"  "); err != nil {
		t.Fatal(err)
	}
	file, err := writer.CreateFormFile("file", "synthetic.csv")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.Write([]byte("telefono\n51999777000\n")); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	var selected string
	app := fiber.New()
	app.Post("/upload", func(c *fiber.Ctx) error {
		_, value, _, _, status, message := readCSVImportUpload(c)
		selected = value
		if message != "" {
			return fiber.NewError(status, message)
		}
		return c.SendStatus(204)
	})
	request := httptest.NewRequest("POST", "/upload", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := app.Test(request, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 204 || selected != name {
		t.Fatalf("selected catalog name changed: status=%d name=%q", response.StatusCode, selected)
	}
}
