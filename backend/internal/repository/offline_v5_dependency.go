package repository

import (
	"encoding/json"

	"github.com/naperu/clarin/internal/domain"
)

// The signed wire command stays immutable; only this in-transaction dispatch
// copy follows the acknowledged predecessor's canonical version.
func offlineV5DispatchAfterDependency(operation domain.OfflineV5Operation, version int64) (domain.OfflineV5Operation, error) {
	if version == operation.BaseVersion {
		return operation, nil
	}
	if operation.Action == domain.OfflineV5ActionBoardsScene {
		fields, err := decodeOfflineV5Object(operation.Payload, 2<<20)
		if err != nil {
			return operation, err
		}
		var expected int64
		if json.Unmarshal(fields["expected_sequence"], &expected) != nil || expected != operation.BaseVersion {
			return operation, ErrOfflineV3Invalid
		}
		encoded, _ := json.Marshal(version)
		fields["expected_sequence"] = encoded
		if raw, exists := fields["patch"]; exists && string(raw) != "null" {
			patch, err := decodeOfflineV5Object(raw, 2<<20)
			if err != nil {
				return operation, err
			}
			if rawBase, exists := patch["client_base_sequence"]; exists {
				var original int64
				if json.Unmarshal(rawBase, &original) != nil || (original != 0 && original != operation.BaseVersion) {
					return operation, ErrOfflineV3Invalid
				}
			}
			patch["base_sequence"], patch["client_base_sequence"] = encoded, encoded
			fields["patch"], _ = json.Marshal(patch)
		}
		operation.Payload, _ = json.Marshal(fields)
	}
	operation.BaseVersion = version
	return operation, nil
}
