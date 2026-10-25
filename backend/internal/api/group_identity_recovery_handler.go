package api

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func groupIdentityRecoveryCanRead(claims *service.JWTClaims) bool {
	if claims == nil {
		return false
	}
	if domain.HasAccountAdminAuthority(claims.Role, claims.IsSuperAdmin) {
		return true
	}
	for _, permission := range claims.Permissions {
		if permission == domain.PermAll || permission == domain.PermChats || permission == domain.PermReports {
			return true
		}
	}
	return false
}

// This endpoint exposes only progress and revisions, never candidate identities.
func (s *Server) handleGetGroupIdentityRecovery(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	claims, _ := c.Locals("claims").(*service.JWTClaims)
	if !groupIdentityRecoveryCanRead(claims) {
		return fiber.ErrForbidden
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	deviceID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	if err != nil {
		return fiber.ErrBadRequest
	}
	device, err := s.services.Device.GetByID(c.Context(), deviceID)
	if err != nil {
		return fiber.ErrInternalServerError
	}
	if device == nil || device.AccountID != accountID || device.Deletion != nil || getDeviceProvider(device) != domain.DeviceProviderWhatsAppWeb || !s.pool.GroupsEnabledForAccount(accountID) {
		return fiber.ErrNotFound
	}
	recovery, err := s.repos.Chat.IdentityRecoveryStatus(c.Context(), accountID, deviceID)
	if err != nil {
		return fiber.ErrInternalServerError
	}
	revision, err := s.repos.Chat.WhatsAppIdentityRevision(c.Context(), accountID, deviceID)
	if err != nil {
		return fiber.ErrInternalServerError
	}
	return c.JSON(fiber.Map{"success": true, "recovery": recovery, "identity_revision": revision})
}

type coverageSnapshotValidationRequest struct {
	DeviceID            string `json:"device_id"`
	GroupID             string `json:"group_id"`
	IdentityRevision    *int64 `json:"identity_revision"`
	GroupRevision       *int64 `json:"group_revision"`
	CRMIdentityRevision *int64 `json:"crm_identity_revision"`
	LeadsPolicyVersion  *int64 `json:"leads_policy_version"`
	LeadsEnabled        *bool  `json:"leads_enabled"`
}

func (req coverageSnapshotValidationRequest) complete() bool {
	return req.IdentityRevision != nil && *req.IdentityRevision >= 0 && req.GroupRevision != nil && *req.GroupRevision >= 0 && req.CRMIdentityRevision != nil && *req.CRMIdentityRevision >= 0 && req.LeadsPolicyVersion != nil && *req.LeadsPolicyVersion >= 0 && req.LeadsEnabled != nil
}

func (s *Server) handleValidateWhatsAppCoverageSnapshot(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	var req coverageSnapshotValidationRequest
	if c.BodyParser(&req) != nil {
		return fiber.ErrBadRequest
	}
	if !req.complete() {
		return writeWhatsAppReportError(c, service.ErrReportSnapshotChanged)
	}
	deviceID, err := uuid.Parse(strings.TrimSpace(req.DeviceID))
	if err != nil {
		return fiber.ErrBadRequest
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	expected := service.WhatsAppCoverageSnapshotCheck{DeviceID: deviceID, GroupID: req.GroupID, IdentityRevision: *req.IdentityRevision, GroupRevision: *req.GroupRevision, CRMIdentityRevision: *req.CRMIdentityRevision, LeadsPolicyVersion: *req.LeadsPolicyVersion, LeadsEnabled: *req.LeadsEnabled}
	if err = s.services.Report.ValidateWhatsAppCoverageSnapshot(c.Context(), accountID, expected); err != nil {
		return writeWhatsAppReportError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}
