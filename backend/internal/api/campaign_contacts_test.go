package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func TestParseContactFilterUsesContactsScreenContract(t *testing.T) {
	accountID := uuid.New()
	deviceID := uuid.New()
	tagID := uuid.New()
	server := &Server{}

	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		filter, noMatches, err := server.parseContactFilter(c, accountID)
		if err != nil {
			t.Fatal(err)
		}
		if noMatches {
			t.Fatal("plain contact filters must not be marked as an empty formula result")
		}
		if filter.Search != "ana" || filter.DeviceID == nil || *filter.DeviceID != deviceID {
			t.Fatalf("unexpected search/device filter: %#v", filter)
		}
		if filter.Limit != 50 || filter.Offset != 100 || filter.IsGroup || !filter.HasPhone {
			t.Fatalf("unexpected pagination/contact flags: %#v", filter)
		}
		if len(filter.TagIDs) != 1 || filter.TagIDs[0] != tagID {
			t.Fatalf("unexpected tag IDs: %#v", filter.TagIDs)
		}
		if len(filter.TagNames) != 2 || filter.TagNames[0] != "VIP" || filter.TagNames[1] != "Lima" {
			t.Fatalf("unexpected included tags: %#v", filter.TagNames)
		}
		if len(filter.ExcludeTagNames) != 1 || filter.ExcludeTagNames[0] != "Baja" || filter.TagMode != "AND" {
			t.Fatalf("unexpected excluded tags/mode: %#v / %s", filter.ExcludeTagNames, filter.TagMode)
		}
		if filter.DateField != "updated_at" || filter.DateFrom != "2026-07-01" || filter.DateTo != "2026-08-01" {
			t.Fatalf("unexpected date filter: %#v", filter)
		}
		return c.SendStatus(fiber.StatusNoContent)
	})

	request := httptest.NewRequest(http.MethodGet,
		"/?search=ana&device_id="+deviceID.String()+
			"&limit=50&offset=100&has_phone=true&tag_ids="+tagID.String()+
			"&tag_names=VIP,Lima&exclude_tag_names=Baja&tag_mode=and"+
			"&date_field=updated_at&date_from=2026-07-01&date_to=2026-08-01", nil)
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusNoContent {
		t.Fatalf("unexpected response status: %d", response.StatusCode)
	}
}

func TestParseCampaignContactFilterIgnoresLoadedPageAndCountsIneligibleContacts(t *testing.T) {
	accountID := uuid.New()
	server := &Server{}

	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		filter, noMatches, err := server.parseCampaignContactFilter(c, accountID)
		if err != nil {
			t.Fatal(err)
		}
		if noMatches {
			t.Fatal("plain filters must not be marked as empty")
		}
		if filter.Limit != 0 || filter.Offset != 0 {
			t.Fatalf("campaign filter must ignore client pagination: %#v", filter)
		}
		if filter.IsGroup {
			t.Fatal("campaign filter must exclude groups")
		}
		if filter.HasPhone {
			t.Fatal("phone eligibility must be evaluated after matching so exclusions can be reported")
		}
		if filter.Search != "segmento" {
			t.Fatalf("visible Contacts filters must be preserved: %#v", filter)
		}
		return c.SendStatus(fiber.StatusNoContent)
	})

	request := httptest.NewRequest(http.MethodGet,
		"/?search=segmento&limit=50&offset=150&is_group=true&has_phone=true", nil)
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusNoContent {
		t.Fatalf("unexpected response status: %d", response.StatusCode)
	}
}

func TestParseContactFilterFailsClosedForMalformedAdvancedFilters(t *testing.T) {
	server := &Server{}
	accountID := uuid.New()
	tests := []string{
		"/?tag_formula=%28",
		"/?cf_filter=%7Bnot-json",
	}

	for _, target := range tests {
		t.Run(target, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, target, nil)
			app := fiber.New()
			app.Get("/", func(c *fiber.Ctx) error {
				_, noMatches, err := server.parseCampaignContactFilter(c, accountID)
				if err == nil {
					t.Fatal("malformed filters must return an error instead of broadening to every contact")
				}
				if noMatches {
					t.Fatal("malformed filters are errors, not valid empty matches")
				}
				return c.SendStatus(fiber.StatusNoContent)
			})
			response, err := app.Test(request)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != fiber.StatusNoContent {
				t.Fatalf("unexpected response status: %d", response.StatusCode)
			}
		})
	}
}
