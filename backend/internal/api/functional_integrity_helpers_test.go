package api

import (
	"strings"
	"testing"
	"time"

	"github.com/naperu/clarin/internal/domain"
)

func TestDeviceNameDatabaseBoundary(t *testing.T) {
	if deviceNameTooLong(strings.Repeat("ñ", 255)) {
		t.Fatal("255 Unicode characters should be accepted")
	}
	if !deviceNameTooLong(strings.Repeat("ñ", 256)) {
		t.Fatal("256 Unicode characters should be rejected before persistence")
	}
}

func TestContactsCacheCannotReuseDefaultForVariants(t *testing.T) {
	if !defaultContactsCacheEligible(domain.ContactFilter{Limit: 50}, false) {
		t.Fatal("default page must remain cacheable")
	}
	variants := []domain.ContactFilter{
		{IsGroup: true}, {SortBy: "name"}, {SortOrder: "desc"}, {ExcludeTagNames: []string{"hidden"}},
		{DateFrom: "2026-01-01"}, {DateTo: "2026-12-01"}, {TagNames: []string{"one"}},
	}
	for _, v := range variants {
		if defaultContactsCacheEligible(v, false) {
			t.Errorf("variant reused default cache: %+v", v)
		}
	}
	if defaultContactsCacheEligible(domain.ContactFilter{}, true) {
		t.Fatal("custom fields response cannot reuse lean page")
	}
}

func TestEventDateRange(t *testing.T) {
	start := time.Date(2026, 10, 9, 10, 0, 0, 0, time.FixedZone("Lima", -5*3600))
	equal := start.In(time.UTC)
	earlier := start.Add(-time.Minute)
	later := start.Add(time.Minute)
	for _, end := range []*time.Time{nil, &equal, &later} {
		if !validEventDateRange(&start, end) {
			t.Fatal("valid range rejected")
		}
	}
	if validEventDateRange(&start, &earlier) {
		t.Fatal("end before start accepted")
	}
}

func TestManualContactRejectsInvalidMetadataBeforeCreation(t *testing.T) {
	cases := []manualContactRequest{
		{Name: strings.Repeat("á", 256)}, {LastName: strings.Repeat("a", 256)},
		{Email: strings.Repeat("a", 256)}, {Company: strings.Repeat("a", 256)},
		{DNI: strings.Repeat("a", 51)}, {Phone: strings.Repeat("9", 51)},
		{Distrito: strings.Repeat("a", 256)}, {Ocupacion: strings.Repeat("a", 256)}, {BirthDate: "2026-02-30"}, {Tags: []string{strings.Repeat("a", 101)}},
	}
	for i, b := range cases {
		if _, err := b.profilePatch(); err == nil {
			t.Errorf("invalid case %d accepted", i)
		}
	}
	p, err := (manualContactRequest{Name: strings.Repeat("á", 255), BirthDate: "2000-02-29"}).profilePatch()
	if err != nil || !p.CustomNameSet || !p.BirthDateSet {
		t.Fatalf("valid boundary: %v", err)
	}
}
