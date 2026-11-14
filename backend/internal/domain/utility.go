package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type UtilityContent struct {
	Slot            string `json:"slot"`
	Version         int64  `json:"version"`
	Bytes           int64  `json:"bytes"`
	ContentType     string `json:"content_type"`
	Indexing        bool   `json:"indexing"`
	ObjectKey       string `json:"-"`
	SnapshotVersion int64  `json:"-"`
}

type UtilityDocument struct {
	ID        uuid.UUID        `json:"id"`
	Type      string           `json:"type"`
	Title     string           `json:"title"`
	FolderID  *uuid.UUID       `json:"folder_id"`
	Favorite  bool             `json:"favorite"`
	Version   int64            `json:"version"`
	Config    json.RawMessage  `json:"config"`
	Slots     []UtilityContent `json:"slots"`
	Snippet   string           `json:"snippet,omitempty"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
}

type UtilityFolder struct {
	ID      uuid.UUID `json:"id"`
	Name    string    `json:"name"`
	Version int64     `json:"version"`
}

type UtilityWorkspace struct {
	OpenIDs  []uuid.UUID `json:"open_ids"`
	ActiveID *uuid.UUID  `json:"active_id"`
	Version  int64       `json:"version"`
}

type UtilityVaultItem struct {
	ID          uuid.UUID       `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Kind        string          `json:"kind"`
	Algorithm   string          `json:"algorithm"`
	Bits        *int            `json:"bits,omitempty"`
	PublicData  string          `json:"public_data"`
	Metadata    json.RawMessage `json:"metadata"`
	Version     int64           `json:"version"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}
