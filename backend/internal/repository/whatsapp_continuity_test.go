package repository

import (
	"github.com/naperu/clarin/internal/domain"
	"testing"
)

func TestGroupOwnershipProofRequiresEverySelfFact(t *testing.T) {
	pn, lid := "51900000001@s.whatsapp.net", "70001@lid"
	for _, tt := range []struct {
		name    string
		own     []string
		members []domain.GroupParticipant
		want    bool
	}{
		{"no proof", nil, nil, false},
		{"own lid message", []string{lid}, nil, true},
		{"normalized companion", []string{"51900000001:18@s.whatsapp.net", "70001:8@lid"}, nil, true},
		{"one matching cannot excuse foreign", []string{lid, "70002@lid"}, nil, false},
		{"missing sender is not proof", []string{lid, ""}, nil, false},
		{"self snapshot", nil, []domain.GroupParticipant{{JID: pn, LID: lid, IsSelf: true}}, true},
		{"contradictory snapshot", []string{pn}, []domain.GroupParticipant{{JID: "51900000002@s.whatsapp.net", IsSelf: true}}, false},
		{"peer is not own evidence", nil, []domain.GroupParticipant{{JID: pn}}, false},
		{"bare phone is not own evidence", []string{"51900000001"}, nil, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := groupOwnershipEvidenceMatches(pn, lid, tt.own, tt.members); got != tt.want {
				t.Fatalf("got %v want %v", got, tt.want)
			}
		})
	}
}

func TestNormalizeOwnJIDDoesNotUsePhoneLikeLIDs(t *testing.T) {
	for _, tt := range []struct{ in, want string }{{"70001:8@lid", "70001@lid"}, {" 51900000001:1@S.WHATSAPP.NET ", "51900000001@s.whatsapp.net"}, {"51900000001@c.us", ""}, {"51900000001", ""}, {"name@lid", ""}, {"1200@g.us", ""}} {
		if got := normalizeOwnJID(tt.in); got != tt.want {
			t.Fatalf("normalize %q got %q", tt.in, got)
		}
	}
}
