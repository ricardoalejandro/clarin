package api

import (
	"errors"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/service"
)

func offlineReauthRestrictions(userID, accountID *uuid.UUID) ([]service.OfflineReauthIdentity, error) {
	if userID == nil && accountID == nil {
		return nil, nil
	}
	if userID == nil || accountID == nil || *userID == uuid.Nil || *accountID == uuid.Nil {
		return nil, errors.New("invalid offline reauthentication context")
	}
	return []service.OfflineReauthIdentity{{UserID: *userID, AccountID: *accountID}}, nil
}
