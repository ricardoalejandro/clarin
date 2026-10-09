package api

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func deviceNameTooLong(name string) bool { return utf8.RuneCountInString(name) > 255 }

func defaultContactsCacheEligible(f domain.ContactFilter, customFields bool) bool {
	return !customFields && !f.IsGroup && f.Search == "" && f.DeviceID == nil &&
		!f.HasPhone && !f.WithoutActiveLead && f.DateField == "" && f.DateFrom == "" && f.DateTo == "" &&
		f.SortBy == "" && f.SortOrder == "" && len(f.Tags) == 0 && len(f.TagIDs) == 0 &&
		len(f.TagNames) == 0 && len(f.ExcludeTagNames) == 0 && len(f.MatchingContactIDs) == 0 && len(f.CfFilterContactIDs) == 0
}

func validEventDateRange(start, end *time.Time) bool {
	return start == nil || end == nil || !end.Before(*start)
}

type manualContactRequest struct {
	Phone     string   `json:"phone"`
	Name      string   `json:"name"`
	LastName  string   `json:"last_name"`
	Email     string   `json:"email"`
	Company   string   `json:"company"`
	Notes     string   `json:"notes"`
	DNI       string   `json:"dni"`
	BirthDate string   `json:"birth_date"`
	Address   string   `json:"address"`
	Distrito  string   `json:"distrito"`
	Ocupacion string   `json:"ocupacion"`
	Tags      []string `json:"tags"`
}

func (b manualContactRequest) profilePatch() (repository.ContactProfilePatch, error) {
	for _, field := range []struct {
		name, value string
		max         int
	}{
		{"nombre", b.Name, 255}, {"apellido", b.LastName, 255}, {"correo", b.Email, 255},
		{"empresa", b.Company, 255}, {"teléfono", b.Phone, 50}, {"DNI", b.DNI, 50}, {"distrito", b.Distrito, 255}, {"ocupación", b.Ocupacion, 255},
	} {
		if utf8.RuneCountInString(strings.TrimSpace(field.value)) > field.max {
			return repository.ContactProfilePatch{}, fmt.Errorf("El campo %s admite como máximo %d caracteres", field.name, field.max)
		}
	}
	for _, tag := range b.Tags {
		if utf8.RuneCountInString(strings.TrimSpace(tag)) > 100 {
			return repository.ContactProfilePatch{}, fmt.Errorf("Una etiqueta admite como máximo 100 caracteres")
		}
	}
	p := repository.ContactProfilePatch{TagIDsSet: b.Tags != nil}
	for _, field := range []struct {
		value  string
		set    *bool
		target **string
	}{
		{b.Name, &p.NameSet, &p.Name}, {b.Name, &p.CustomNameSet, &p.CustomName},
		{b.LastName, &p.LastNameSet, &p.LastName}, {b.Email, &p.EmailSet, &p.Email},
		{b.Company, &p.CompanySet, &p.Company}, {b.Notes, &p.NotesSet, &p.Notes},
		{b.DNI, &p.DNISet, &p.DNI}, {b.Address, &p.AddressSet, &p.Address},
		{b.Distrito, &p.DistritoSet, &p.Distrito}, {b.Ocupacion, &p.OcupacionSet, &p.Ocupacion},
	} {
		if value := strings.TrimSpace(field.value); value != "" {
			*field.set = true
			*field.target = &value
		}
	}
	if b.BirthDate != "" {
		value, err := time.Parse("2006-01-02", strings.TrimSpace(b.BirthDate))
		if err != nil {
			return p, fmt.Errorf("Fecha de nacimiento inválida")
		}
		p.BirthDateSet = true
		p.BirthDate = &value
	}
	return p, nil
}
