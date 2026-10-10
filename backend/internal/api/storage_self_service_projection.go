package api

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
)

func storageSelfServiceHasAuthorizedPrivateUse(accountID uuid.UUID, key string, uses []storageSelfServiceUse) bool {
	for _, use := range uses {
		if use.AccountID != accountID || use.ObjectKey != key {
			continue
		}
		if use.Adapter == "private_work" || use.Adapter == "private_whiteboards" {
			return true
		}
		if use.Type == "contacts" && use.Adapter == "ordinary" && storage.IsAccountPrivateAvatarObjectKey(accountID, key) {
			return true
		}
	}
	return false
}

// GET pages are projected from already authorized, current index rows. Opening
// details and preparing/confirming removal re-read canonical use adapters. Do
// not call those adapters here: that would scan every source once per card.
func (s *Server) decorateStorageSelfServiceIndexedFiles(ctx context.Context, q storageSelfServiceQuerier, accountID, actorID uuid.UUID, claims *service.JWTClaims, files []storageSelfServiceFile) error {
	for i := range files {
		f := &files[i]
		f.ActiveUsesVisibleCount = f.ReferencesCount
		f.OwnershipVerified = f.IsOwnUpload
		for j := range f.Origins {
			switch f.Origins[j].Origin {
			case "private_work":
				f.Origins[j].Origin = "tasks"
			case "private_whiteboards":
				f.Origins[j].Origin = "whiteboards"
			case "chats":
				if f.Status == "active" && storageSelfServiceHasPermission(claims, domain.PermSettings) {
					f.CanRemoveUses = true
				}
			}
		}
		if f.RecoveryID != "" {
			f.RemovedUsesCount = 1
			f.ObjectRetained = f.ReferencesCount > 0 || f.RetainedElsewhere
		}
	}
	return nil
}

func storageApplyUseProjection(file *storageSelfServiceFile, uses []storageSelfServiceUse) {
	file.CanRemove = false
	file.CanRemoveUses = false
	file.Origins = make([]storageSelfServiceReference, 0, len(uses))
	covered := map[string]bool{}
	allRemovable := len(uses) > 0
	for _, use := range uses {
		for _, id := range use.ReferenceIDs {
			covered[id] = true
		}
		covered[use.Type+"|"+use.SourceID.String()] = true
		file.Origins = append(file.Origins, storageSelfServiceReference{Origin: use.Type, ID: use.SourceID.String(), Label: use.Label, Href: use.Href})
		file.CanRemoveUses = file.CanRemoveUses || use.CanRemove
		allRemovable = allRemovable && use.CanRemove
		if use.Adapter == "own_upload" {
			file.IsOwnUpload = true
			file.OwnershipVerified = true
		}
	}
	file.ReferencesCount = len(uses)
	file.ActiveUsesVisibleCount = len(uses)
	for _, ref := range file.refs {
		if !covered[ref.Origin+"|"+ref.ID] {
			file.RetainedElsewhere = true
			allRemovable = false
		}
	}
	if file.Status == "active" {
		file.CanRemove = allRemovable
		if file.CanRemove {
			file.BlockedReason = ""
		} else if file.CanRemoveUses {
			file.BlockedReason = "Puedes retirar usos concretos. El archivo se conservará donde siga siendo necesario."
		}
	}
}
