package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	jose "github.com/go-jose/go-jose/v4"

	"github.com/naperu/clarin-offline-agent/internal/v3/catalog"
	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/protocol"
	"github.com/naperu/clarin-offline-agent/internal/v3/vault"
)

const maxInboxPasses = 100

// processUnlockedInbox is the only path that opens server data envelopes. The
// background runner stores and forwards ciphertext only; no password, DEK or
// grant private key survives a browser lock or service restart.
func (e *Engine) processUnlockedInbox(ctx context.Context, grant *catalog.Grant, secrets *cryptokit.GrantSecrets) error {
	store, err := e.vaultFor(grant)
	if err != nil {
		return err
	}
	ring, err := decodeRing(grant.SignerPublicKeys)
	if err != nil {
		return err
	}
	var encryptionJWK jose.JSONWebKey
	if json.Unmarshal(grant.GrantEncryptionJWK, &encryptionJWK) != nil || encryptionJWK.KeyID == "" {
		return errors.New("grant decryption key metadata corrupt")
	}
	for pass := 0; pass < maxInboxPasses; pass++ {
		items, err := store.Inbox(ctx, 100)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			return nil
		}
		for _, item := range items {
			switch item.Kind {
			case "snapshot":
				if err := e.applySnapshotEnvelope(ctx, grant, secrets, store, ring, encryptionJWK.KeyID, item); err != nil {
					return err
				}
			case "receipt":
				if err := e.applyReceiptEnvelope(ctx, grant, secrets, store, ring, encryptionJWK.KeyID, item); err != nil {
					return err
				}
			case "control":
				// Controls are verified/applied by the sealed transport plane and
				// should already be marked processed before an unlock is possible.
				return errors.New("unprocessed control blocked vault unlock")
			default:
				return errors.New("unknown sealed inbox kind")
			}
		}
	}
	return errors.New("sealed inbox processing bound exceeded")
}

func (e *Engine) applySnapshotEnvelope(ctx context.Context, grant *catalog.Grant, secrets *cryptokit.GrantSecrets, store *vault.Store, ring *protocol.SigningKeys, encryptionKID string, item vault.InboxEnvelope) error {
	inner, err := cryptokit.DecryptNestedCompact(item.Envelope, secrets.EncryptionKey, encryptionKID, protocol.SnapshotJWEType, protocol.SnapshotJWSType)
	if err != nil {
		return err
	}
	defer zero(inner)
	claims, err := ring.VerifySnapshot(string(inner), e.now(), grant.Tuple)
	if err != nil {
		return err
	}
	if item.EnvelopeID != claims.SelectionID+":"+fmt.Sprintf("%d", claims.HeadVersion) || item.ClaimedHash != claims.ContentHash || claims.SelectionRevision != grant.SelectionRevision {
		return errors.New("snapshot transport metadata binding rejected")
	}
	selection, err := e.catalog.Selection(ctx, grant.Tuple.GrantID, claims.SelectionID)
	if err != nil || selection.Module != claims.Module || selection.ResourceType != claims.ResourceType || selection.ResourceID != claims.ResourceID {
		return errors.New("snapshot is outside current selection")
	}
	if claims.Tombstone {
		if err := store.DeleteResource(ctx, claims.Module, claims.ResourceType, claims.ResourceID); err != nil {
			return err
		}
		if err := e.catalog.MarkSelectionError(ctx, grant.Tuple.GrantID, claims.SelectionID, "resource_removed"); err != nil {
			return err
		}
		return store.MarkInboxProcessed(ctx, item.EnvelopeID, e.now().UTC())
	}
	itemCount, err := validateSnapshotClosure(claims.Module, claims.ResourceType, claims.ResourceID, claims.Payload)
	if err != nil {
		return err
	}
	now := e.now().UTC()
	if err := store.PutResource(ctx, secrets.DEK, vault.Resource{SelectionID: claims.SelectionID, Module: claims.Module, ResourceType: claims.ResourceType, ResourceID: claims.ResourceID, Revision: claims.HeadVersion, Payload: claims.Payload, UpdatedAt: now}); err != nil {
		return err
	}
	if err := e.catalog.ApplySelectionSnapshot(ctx, grant.Tuple.GrantID, claims.SelectionID, claims.Module, claims.ResourceType, claims.ResourceID, claims.SelectionRevision, claims.HeadVersion, claims.ContentHash, itemCount, int64(len(claims.Payload)), now); err != nil {
		return err
	}
	return store.MarkInboxProcessed(ctx, item.EnvelopeID, now)
}

func (e *Engine) applyReceiptEnvelope(ctx context.Context, grant *catalog.Grant, secrets *cryptokit.GrantSecrets, store *vault.Store, ring *protocol.SigningKeys, encryptionKID string, item vault.InboxEnvelope) error {
	inner, err := cryptokit.DecryptNestedCompact(item.Envelope, secrets.EncryptionKey, encryptionKID, protocol.ReceiptJWEType, protocol.ReceiptJWSType)
	if err != nil {
		return err
	}
	defer zero(inner)
	claims, err := ring.VerifyReceipt(string(inner), e.now(), grant.Tuple)
	if err != nil {
		return err
	}
	if item.EnvelopeID != claims.OperationID || item.ClaimedHash != claims.RequestHash {
		return errors.New("receipt transport metadata binding rejected")
	}
	expected, err := store.ExpectedOperationHash(ctx, claims.OperationID)
	if err != nil || expected != claims.RequestHash {
		return errors.New("receipt does not match local operation")
	}
	var local *vault.Resource
	if claims.ResourceID != "" {
		local, _ = store.Resource(ctx, secrets.DEK, "tasks", "task", claims.ResourceID)
	}
	canonicalTask, hasTask, err := receiptTask(claims.Result, claims.ResourceID)
	if err != nil {
		return err
	}
	if claims.Status == "conflict" || claims.Status == "rejected" {
		if local == nil || local.SelectionID == "" || len(local.Payload) == 0 {
			return errors.New("receipt lost its local conflict projection")
		}
		if err := store.StoreConflict(ctx, secrets.DEK, vault.ConflictRecord{
			OperationID:  claims.OperationID,
			SelectionID:  local.SelectionID,
			ResourceID:   claims.ResourceID,
			Status:       claims.Status,
			ErrorCode:    claims.ErrorCode,
			ClientChange: local.Payload,
			ServerResult: claims.Result,
			CreatedAt:    e.now().UTC(),
		}); err != nil {
			return err
		}
	}
	if hasTask {
		if local == nil || local.SelectionID == "" {
			return errors.New("receipt task is outside local selection")
		}
		if rawTaskVersion(canonicalTask) != claims.ServerVersion {
			return errors.New("receipt task version binding rejected")
		}
		canonicalTask, err = preserveDependentTaskOverlay(ctx, store, local.Payload, canonicalTask, claims.OperationID)
		if err != nil {
			return err
		}
		if err := store.PutResource(ctx, secrets.DEK, vault.Resource{SelectionID: local.SelectionID, Module: "tasks", ResourceType: "task", ResourceID: claims.ResourceID, Revision: claims.ServerVersion, Payload: canonicalTask, UpdatedAt: e.now().UTC()}); err != nil {
			return err
		}
	} else if local != nil {
		// A rejected command without a canonical task cannot safely retain its
		// optimistic projection. Mark the selection preparing so the next
		// ciphertext sync requests an authoritative closure.
		if err := store.DeleteResource(ctx, "tasks", "task", claims.ResourceID); err != nil {
			return err
		}
		if err := e.catalog.MarkSelectionPreparing(ctx, grant.Tuple.GrantID, local.SelectionID); err != nil {
			return err
		}
	}
	if err := store.CommitReceipt(ctx, claims.OperationID, item.Envelope, claims.RequestHash); err != nil {
		return err
	}
	return store.MarkInboxProcessed(ctx, item.EnvelopeID, e.now().UTC())
}

func preserveDependentTaskOverlay(ctx context.Context, store *vault.Store, local, canonical json.RawMessage, receiptOperationID string) (json.RawMessage, error) {
	var localTask, canonicalTask map[string]any
	if json.Unmarshal(local, &localTask) != nil || json.Unmarshal(canonical, &canonicalTask) != nil {
		return nil, errors.New("dependent task projection corrupt")
	}
	createID, _ := localTask["local_create_operation_id"].(string)
	completeID, _ := localTask["local_complete_operation_id"].(string)
	if createID != receiptOperationID || !canonicalUUID(completeID) || completeID == receiptOperationID {
		return canonical, nil
	}
	pending, err := store.HasPendingOperation(ctx, completeID)
	if err != nil {
		return nil, err
	}
	if !pending {
		return canonical, nil
	}
	for _, field := range []string{"status", "status_category", "completed_at", "updated_at", "local_confirmation"} {
		if value, exists := localTask[field]; exists {
			canonicalTask[field] = value
		}
	}
	canonicalTask["local_complete_operation_id"] = completeID
	delete(canonicalTask, "local_create_operation_id")
	return json.Marshal(canonicalTask)
}

func receiptTask(result json.RawMessage, resourceID string) (json.RawMessage, bool, error) {
	if len(result) == 0 || string(result) == "null" || string(result) == "{}" {
		return nil, false, nil
	}
	var value struct {
		Task json.RawMessage `json:"task"`
	}
	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil || ensureEOF(decoder) != nil || len(value.Task) == 0 || !json.Valid(value.Task) {
		return nil, false, errors.New("receipt task projection rejected")
	}
	var identity struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(value.Task, &identity) != nil || identity.ID != resourceID {
		return nil, false, errors.New("receipt task identity rejected")
	}
	return append(json.RawMessage(nil), value.Task...), true, nil
}

func validateSnapshotClosure(module, resourceType, resourceID string, payload json.RawMessage) (int64, error) {
	switch module + "/" + resourceType {
	case "tasks/task_list":
		var value struct {
			List     json.RawMessage   `json:"list"`
			Statuses []json.RawMessage `json:"statuses"`
			Tasks    []json.RawMessage `json:"tasks"`
		}
		if strictDecode(payload, &value) != nil || len(value.List) == 0 || len(value.Statuses) > 100 || len(value.Tasks) > 5000 || rawID(value.List) != resourceID {
			return 0, errors.New("task-list snapshot closure rejected")
		}
		for _, task := range value.Tasks {
			var identity struct {
				ID     string `json:"id"`
				ListID string `json:"list_id"`
			}
			if json.Unmarshal(task, &identity) != nil || !canonicalUUID(identity.ID) || identity.ListID != resourceID {
				return 0, errors.New("task snapshot row rejected")
			}
		}
		return int64(len(value.Tasks) + 1), nil
	case "contacts/contact":
		var value struct {
			Contact            json.RawMessage   `json:"contact"`
			Phones             []json.RawMessage `json:"phones"`
			Tags               []json.RawMessage `json:"tags"`
			DirectObservations []json.RawMessage `json:"direct_observations"`
			CustomFields       []json.RawMessage `json:"custom_fields"`
		}
		if strictDecode(payload, &value) != nil || rawID(value.Contact) != resourceID || len(value.Phones) > 100 || len(value.Tags) > 1000 || len(value.DirectObservations) > 1000 || len(value.CustomFields) > 1000 {
			return 0, errors.New("contact snapshot closure rejected")
		}
		return 1, nil
	case "programs/program":
		var value struct {
			Program                  json.RawMessage   `json:"program"`
			ActiveRoster             []json.RawMessage `json:"active_roster"`
			HistoricalParticipations []json.RawMessage `json:"historical_participations"`
			Sessions                 []json.RawMessage `json:"sessions"`
			EligibleAttendance       []json.RawMessage `json:"eligible_attendance"`
			OutOfWindowHistory       []json.RawMessage `json:"out_of_window_history"`
		}
		if strictDecode(payload, &value) != nil || rawID(value.Program) != resourceID || len(value.ActiveRoster)+len(value.HistoricalParticipations) > 5000 || len(value.Sessions) > 5000 || len(value.EligibleAttendance)+len(value.OutOfWindowHistory) > 5000 {
			return 0, errors.New("program snapshot closure rejected")
		}
		return int64(1 + len(value.ActiveRoster) + len(value.HistoricalParticipations) + len(value.Sessions) + len(value.EligibleAttendance) + len(value.OutOfWindowHistory)), nil
	case "whiteboards/whiteboard":
		return validateWhiteboardClosure(resourceID, payload)
	default:
		return 0, errors.New("snapshot closure type rejected")
	}
}

func validateWhiteboardClosure(resourceID string, payload json.RawMessage) (int64, error) {
	type asset struct {
		FileID      string `json:"file_id"`
		ContentHash string `json:"content_hash"`
		ContentType string `json:"content_type"`
		DataBase64  string `json:"data_base64"`
		SizeBytes   int64  `json:"size_bytes"`
	}
	var value struct {
		Whiteboard       json.RawMessage `json:"whiteboard"`
		ReferencedAssets []asset         `json:"referenced_assets"`
	}
	var board struct {
		ID    string          `json:"id"`
		Scene json.RawMessage `json:"scene"`
	}
	if strictDecode(payload, &value) != nil || json.Unmarshal(value.Whiteboard, &board) != nil || board.ID != resourceID || !json.Valid(board.Scene) || len(value.ReferencedAssets) > 256 {
		return 0, errors.New("whiteboard snapshot closure rejected")
	}
	assets := make(map[string]struct{}, len(value.ReferencedAssets))
	for _, item := range value.ReferencedAssets {
		if item.FileID == "" || len(item.FileID) > 200 || item.SizeBytes < 0 || item.SizeBytes > 8<<20 || !validSHA256Hex(item.ContentHash) {
			return 0, errors.New("whiteboard asset metadata rejected")
		}
		switch strings.ToLower(item.ContentType) {
		case "image/png", "image/jpeg", "image/webp", "image/gif":
		default:
			return 0, errors.New("whiteboard asset content type rejected")
		}
		decoded, err := base64.StdEncoding.DecodeString(item.DataBase64)
		if err != nil || int64(len(decoded)) != item.SizeBytes {
			return 0, errors.New("whiteboard asset bytes rejected")
		}
		digest := sha256.Sum256(decoded)
		for index := range decoded {
			decoded[index] = 0
		}
		if hex.EncodeToString(digest[:]) != item.ContentHash {
			return 0, errors.New("whiteboard asset hash rejected")
		}
		if _, duplicate := assets[item.FileID]; duplicate {
			return 0, errors.New("duplicate whiteboard asset rejected")
		}
		assets[item.FileID] = struct{}{}
	}
	var scene struct {
		Elements []struct {
			FileID    string `json:"fileId"`
			IsDeleted bool   `json:"isDeleted"`
		} `json:"elements"`
	}
	if json.Unmarshal(board.Scene, &scene) != nil {
		return 0, errors.New("whiteboard scene rejected")
	}
	for _, element := range scene.Elements {
		if !element.IsDeleted && element.FileID != "" {
			if _, found := assets[element.FileID]; !found {
				return 0, errors.New("whiteboard asset closure incomplete")
			}
		}
	}
	return int64(1 + len(value.ReferencedAssets)), nil
}

func strictDecode(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return ensureEOF(decoder)
}

func rawID(raw json.RawMessage) string {
	var value struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value.ID
}

func validSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
