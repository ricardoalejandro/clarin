package domain

import (
	"time"

	"github.com/google/uuid"
)

const DeviceStatusDeleting = "deleting"

// DeviceDeletionStatus contains only safe operational metadata. Session
// identity and leases never leave the backend.
type DeviceDeletionStatus struct {
	OperationID uuid.UUID  `json:"operation_id"`
	Phase       string     `json:"phase"`
	Attempts    int        `json:"attempts"`
	NextRetryAt *time.Time `json:"next_retry_at,omitempty"`
	ErrorCode   *string    `json:"error_code,omitempty"`
}

type DeviceDeletionResult struct {
	DeviceID         uuid.UUID  `json:"device_id"`
	OperationID      uuid.UUID  `json:"operation_id"`
	DeletionStatus   string     `json:"deletion_status"`
	CleanupScope     string     `json:"cleanup_scope,omitempty"`
	NextRetryAt      *time.Time `json:"next_retry_at,omitempty"`
	ErrorCode        *string    `json:"error_code,omitempty"`
	DevicesTotal     int        `json:"devices_total"`
	DevicesAvailable int        `json:"devices_available"`
	ContactsDetached int64      `json:"contacts_detached"`
	ChatsDetached    int64      `json:"chats_detached"`
}

func (d *Device) HydrateDeletion() {
	if d.DeletionOperationID == nil {
		return
	}
	phase := "pending"
	if d.DeletionPhase != nil {
		phase = *d.DeletionPhase
	}
	d.Deletion = &DeviceDeletionStatus{OperationID: *d.DeletionOperationID, Phase: phase, Attempts: d.DeletionAttempts, NextRetryAt: d.DeletionNextRetryAt, ErrorCode: d.DeletionErrorCode}
	status := DeviceStatusDeleting
	d.Status = &status
	d.QRCode = nil
	d.RuntimeCapabilities = &DeviceRuntimeCapabilities{}
}
