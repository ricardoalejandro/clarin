package api

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestBuildAdminUserAccountAssignmentsNormalizesDefault(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	assignments, defaultIndex, err := buildAdminUserAccountAssignments([]adminUserAccountAssignmentRequest{
		{AccountID: first.String(), Role: domain.RoleAgent},
		{AccountID: second.String(), Role: domain.RoleAdmin, IsDefault: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if defaultIndex != 1 || assignments[0].IsDefault || !assignments[1].IsDefault {
		t.Fatalf("unexpected default normalization: index=%d assignments=%#v", defaultIndex, assignments)
	}
}

func TestBuildAdminUserAccountAssignmentsUsesFirstWhenMissingDefault(t *testing.T) {
	assignments, defaultIndex, err := buildAdminUserAccountAssignments([]adminUserAccountAssignmentRequest{{
		AccountID: uuid.NewString(),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if defaultIndex != 0 || !assignments[0].IsDefault || assignments[0].Role != domain.RoleAgent {
		t.Fatalf("unexpected assignment: %#v", assignments[0])
	}
}

func TestBuildAdminUserAccountAssignmentsRejectsDuplicateAndInvalidIDs(t *testing.T) {
	accountID := uuid.NewString()
	tests := []struct {
		name     string
		requests []adminUserAccountAssignmentRequest
	}{
		{name: "duplicate account", requests: []adminUserAccountAssignmentRequest{{AccountID: accountID}, {AccountID: accountID}}},
		{name: "invalid account", requests: []adminUserAccountAssignmentRequest{{AccountID: "not-an-id"}}},
		{name: "invalid role", requests: []adminUserAccountAssignmentRequest{{AccountID: accountID, Role: "owner"}}},
		{name: "invalid custom role", requests: []adminUserAccountAssignmentRequest{{AccountID: accountID, RoleID: stringPointer("not-an-id")}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := buildAdminUserAccountAssignments(test.requests); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func stringPointer(value string) *string { return &value }
