package service

import (
	"context"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

// A group must fail before repository or privacy calls: it is never a campaign
// recipient, even if an old or manipulated recipient row reaches execution.
func TestCampaignGroupRejectedBeforeAnyRepositoryAccess(t *testing.T) {
	s := &CampaignService{}
	for _, jid := range []string{"12000000001@g.us", " 12000000001@G.US "} {
		if _, err := s.validateRecipientPrivacy(context.Background(), &domain.Campaign{}, &domain.CampaignRecipient{JID: jid}); err == nil {
			t.Fatal("group recipient accepted")
		}
	}
}
