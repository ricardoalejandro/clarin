package api

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	googleclient "github.com/naperu/clarin/internal/google"
)

// --- Google Contacts Integration Handlers ---

// handleGoogleAuthURL returns the Google OAuth URL for connecting Google Contacts
func (s *Server) handleGoogleAuthURL(c *fiber.Ctx) error {
	if s.googleClient == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google integration not configured"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	state := accountID.String()
	url := s.googleClient.GetAuthURL(state)
	return c.JSON(fiber.Map{"success": true, "url": url})
}

// handleGoogleCallback handles the OAuth callback from Google
func (s *Server) handleGoogleCallback(c *fiber.Ctx) error {
	redirectErr := func(msg string) error {
		return c.Redirect("/dashboard/settings?tab=integrations&google=error&msg=" + url.QueryEscape(msg))
	}

	if s.googleClient == nil {
		return redirectErr("Google integration not configured")
	}

	code := c.Query("code")
	state := c.Query("state")
	if code == "" || state == "" {
		return redirectErr("missing code or state")
	}

	accountID, err := uuid.Parse(state)
	if err != nil {
		return redirectErr("invalid state")
	}

	// Exchange code for tokens
	token, err := s.googleClient.ExchangeCode(c.Context(), code)
	if err != nil {
		log.Printf("[GOOGLE] Token exchange error: %v", err)
		return redirectErr("No se pudo intercambiar el código de autorización")
	}

	// Get user email
	email, err := s.googleClient.GetUserEmail(c.Context(), token.AccessToken)
	if err != nil {
		log.Printf("[GOOGLE] Get email error: %v", err)
		return redirectErr("No se pudo obtener el email de la cuenta de Google")
	}

	// Check if this Google account is already connected elsewhere
	existing, err := s.repos.Account.FindAccountByGoogleEmail(c.Context(), email)
	if err != nil {
		return redirectErr("Error de base de datos")
	}
	if existing != nil && existing.ID != accountID {
		return redirectErr(fmt.Sprintf("Esta cuenta de Google ya está conectada a \"%s\"", existing.Name))
	}

	// Get account name for group
	account, err := s.repos.Account.GetByID(c.Context(), accountID)
	if err != nil || account == nil {
		return redirectErr("Cuenta no encontrada")
	}

	// Create or find contact group
	groupName := "Clarin - " + account.Name
	groupResourceName := ""

	// Check if group already exists
	groups, err := s.googleClient.ListContactGroups(c.Context(), token.AccessToken)
	if err == nil {
		for _, g := range groups {
			if g.Name == groupName {
				groupResourceName = g.ResourceName
				break
			}
		}
	}

	if groupResourceName == "" {
		group, err := s.googleClient.CreateContactGroup(c.Context(), token.AccessToken, groupName)
		if err != nil {
			log.Printf("[GOOGLE] Create group error: %v", err)
			return redirectErr("No se pudo crear el grupo de contactos en Google")
		}
		groupResourceName = group.ResourceName
	}

	// Save tokens to account
	if err := s.repos.Account.SaveGoogleTokens(c.Context(), accountID, email, token.AccessToken, token.RefreshToken, groupResourceName); err != nil {
		return redirectErr("No se pudieron guardar los tokens")
	}

	log.Printf("[GOOGLE] Account %s connected Google: %s, group: %s", accountID, email, groupResourceName)

	// Redirect back to settings page
	return c.Redirect("/dashboard/settings?tab=integrations&google=connected")
}

// handleGoogleDisconnect disconnects Google Contacts from the account
func (s *Server) handleGoogleDisconnect(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	if err := s.repos.Account.DisconnectGoogle(c.Context(), accountID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	log.Printf("[GOOGLE] Account %s disconnected Google", accountID)
	return c.JSON(fiber.Map{"success": true})
}

// handleGoogleStatus returns the current Google Contacts connection status
func (s *Server) handleGoogleStatus(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	account, err := s.repos.Account.GetByID(c.Context(), accountID)
	if err != nil || account == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "account not found"})
	}

	connected := account.GoogleEmail != nil && *account.GoogleEmail != ""
	syncCount := 0
	if connected {
		syncCount, _ = s.repos.Account.GetGoogleSyncCount(c.Context(), accountID)
	}

	return c.JSON(fiber.Map{
		"success":        true,
		"connected":      connected,
		"email":          account.GoogleEmail,
		"group_id":       account.GoogleContactGroupID,
		"connected_at":   account.GoogleConnectedAt,
		"sync_limit":     account.GoogleSyncLimit,
		"sync_count":     syncCount,
		"configured":     s.googleClient != nil,
	})
}

// handleGoogleSyncContact syncs a single contact to Google Contacts (async)
func (s *Server) handleGoogleSyncContact(c *fiber.Ctx) error {
	if s.googleClient == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google integration not configured"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)
	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid contact id"})
	}

	// Validate contact exists and belongs to account
	contact, err := s.repos.Contact.GetByID(c.Context(), contactID)
	if err != nil || contact == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "contact not found"})
	}
	if contact.AccountID != accountID {
		return c.Status(403).JSON(fiber.Map{"success": false, "error": "forbidden"})
	}

	// Mark as synced immediately so UI reflects the change
	_ = s.repos.Contact.SetGoogleSyncPending(c.Context(), contactID)

	// Run actual Google sync in background
	go func() {
		if _, err := s.syncContactToGoogle(context.Background(), accountID, contactID); err != nil {
			log.Printf("[GOOGLE] Background sync failed for contact %s: %v", contactID, err)
		}
	}()

	return c.JSON(fiber.Map{"success": true})
}

// handleGoogleDesyncContact removes a contact from Google Contacts sync
func (s *Server) handleGoogleDesyncContact(c *fiber.Ctx) error {
	if s.googleClient == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google integration not configured"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)
	contactID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid contact id"})
	}

	contact, err := s.repos.Contact.GetByID(c.Context(), contactID)
	if err != nil || contact == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "contact not found"})
	}
	if contact.AccountID != accountID {
		return c.Status(403).JSON(fiber.Map{"success": false, "error": "forbidden"})
	}

	// Delete from Google if resource name exists
	if contact.GoogleResourceName != nil && *contact.GoogleResourceName != "" {
		email, accessToken, refreshToken, _, err := s.repos.Account.GetGoogleTokens(c.Context(), accountID)
		if err == nil && email != "" {
			accessToken, _ = s.ensureValidToken(c.Context(), accountID, accessToken, refreshToken)
			if err := s.googleClient.DeleteContact(c.Context(), accessToken, *contact.GoogleResourceName); err != nil {
				log.Printf("[GOOGLE] Error deleting contact from Google: %v", err)
				// Don't fail — still clear local sync
			}
		}
	}

	if err := s.repos.Contact.ClearGoogleSync(c.Context(), contactID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}

// handleGoogleBatchSync syncs multiple contacts to Google (max 30, async)
func (s *Server) handleGoogleBatchSync(c *fiber.Ctx) error {
	if s.googleClient == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google integration not configured"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		ContactIDs []uuid.UUID `json:"contact_ids"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}

	if len(body.ContactIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "no contacts specified"})
	}
	if len(body.ContactIDs) > 30 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "maximum 30 contacts per batch"})
	}

	// Check quota
	syncCount, err := s.repos.Account.GetGoogleSyncCount(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "database error"})
	}

	account, err := s.repos.Account.GetByID(c.Context(), accountID)
	if err != nil || account == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "account not found"})
	}

	remaining := account.GoogleSyncLimit - syncCount
	if remaining < len(body.ContactIDs) {
		return c.Status(400).JSON(fiber.Map{
			"success": false,
			"error":   fmt.Sprintf("Quota exceeded: %d remaining, %d requested", remaining, len(body.ContactIDs)),
		})
	}

	// Mark all contacts as synced immediately
	for _, cid := range body.ContactIDs {
		_ = s.repos.Contact.SetGoogleSyncPending(c.Context(), cid)
	}

	// Run actual Google sync in background
	contactIDs := make([]uuid.UUID, len(body.ContactIDs))
	copy(contactIDs, body.ContactIDs)
	go func() {
		for _, cid := range contactIDs {
			if _, err := s.syncContactToGoogle(context.Background(), accountID, cid); err != nil {
				log.Printf("[GOOGLE] Background batch sync failed for contact %s: %v", cid, err)
			}
		}
	}()

	return c.JSON(fiber.Map{"success": true, "count": len(body.ContactIDs)})
}

// handleGoogleBatchDesync removes multiple contacts from Google sync (max 30)
func (s *Server) handleGoogleBatchDesync(c *fiber.Ctx) error {
	if s.googleClient == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google integration not configured"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		ContactIDs []uuid.UUID `json:"contact_ids"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if len(body.ContactIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "no contacts specified"})
	}
	if len(body.ContactIDs) > 30 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "maximum 30 contacts per batch"})
	}

	email, accessToken, refreshToken, _, err := s.repos.Account.GetGoogleTokens(c.Context(), accountID)
	if err != nil || email == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google not connected"})
	}

	accessToken, _ = s.ensureValidToken(c.Context(), accountID, accessToken, refreshToken)

	contacts, err := s.repos.Contact.GetContactsByIDs(c.Context(), accountID, body.ContactIDs)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "database error"})
	}

	results := make([]map[string]interface{}, 0, len(contacts))
	for _, contact := range contacts {
		// Delete from Google
		if contact.GoogleResourceName != nil && *contact.GoogleResourceName != "" {
			if err := s.googleClient.DeleteContact(c.Context(), accessToken, *contact.GoogleResourceName); err != nil {
				log.Printf("[GOOGLE] Error deleting contact %s: %v", contact.ID, err)
			}
		}

		if err := s.repos.Contact.ClearGoogleSync(c.Context(), contact.ID); err != nil {
			results = append(results, map[string]interface{}{
				"contact_id": contact.ID.String(),
				"success":    false,
				"error":      err.Error(),
			})
		} else {
			results = append(results, map[string]interface{}{
				"contact_id": contact.ID.String(),
				"success":    true,
			})
		}
	}

	return c.JSON(fiber.Map{"success": true, "results": results})
}

// handleGoogleBatchSyncFromLeads syncs contacts from selected leads (resolves contact_ids, async)
func (s *Server) handleGoogleBatchSyncFromLeads(c *fiber.Ctx) error {
	if s.googleClient == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google integration not configured"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		LeadIDs []uuid.UUID `json:"lead_ids"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if len(body.LeadIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "no leads specified"})
	}
	if len(body.LeadIDs) > 30 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "maximum 30 leads per batch"})
	}

	// Resolve to contact IDs
	contactIDs, err := s.repos.Contact.GetContactIDsFromLeadIDs(c.Context(), accountID, body.LeadIDs)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "database error"})
	}
	if len(contactIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "no contacts found for selected leads"})
	}

	// Check quota
	syncCount, _ := s.repos.Account.GetGoogleSyncCount(c.Context(), accountID)
	account, _ := s.repos.Account.GetByID(c.Context(), accountID)
	if account == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "account not found"})
	}
	remaining := account.GoogleSyncLimit - syncCount
	if remaining < len(contactIDs) {
		return c.Status(400).JSON(fiber.Map{
			"success": false,
			"error":   fmt.Sprintf("Quota exceeded: %d remaining, %d requested", remaining, len(contactIDs)),
		})
	}

	// Mark all contacts as synced immediately
	for _, cid := range contactIDs {
		_ = s.repos.Contact.SetGoogleSyncPending(c.Context(), cid)
	}

	// Run actual Google sync in background
	cids := make([]uuid.UUID, len(contactIDs))
	copy(cids, contactIDs)
	go func() {
		for _, cid := range cids {
			if _, err := s.syncContactToGoogle(context.Background(), accountID, cid); err != nil {
				log.Printf("[GOOGLE] Background batch sync from leads failed for contact %s: %v", cid, err)
			}
		}
	}()

	return c.JSON(fiber.Map{"success": true, "count": len(contactIDs)})
}

// handleGoogleBatchDesyncFromLeads desyncs contacts from selected leads (resolves contact_ids)
func (s *Server) handleGoogleBatchDesyncFromLeads(c *fiber.Ctx) error {
	if s.googleClient == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google integration not configured"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		LeadIDs []uuid.UUID `json:"lead_ids"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if len(body.LeadIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "no leads specified"})
	}
	if len(body.LeadIDs) > 30 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "maximum 30 leads per batch"})
	}

	// Resolve to contact IDs
	contactIDs, err := s.repos.Contact.GetContactIDsFromLeadIDs(c.Context(), accountID, body.LeadIDs)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "database error"})
	}
	if len(contactIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "no contacts found for selected leads"})
	}

	_, accessToken, refreshToken, _, err := s.repos.Account.GetGoogleTokens(c.Context(), accountID)
	if err != nil || accessToken == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google not connected"})
	}

	accessToken, _ = s.ensureValidToken(c.Context(), accountID, accessToken, refreshToken)

	results := make([]map[string]interface{}, 0, len(contactIDs))
	for _, cid := range contactIDs {
		contact, cErr := s.repos.Contact.GetByID(c.Context(), cid)
		if cErr != nil || contact == nil {
			continue
		}
		if contact.GoogleResourceName != nil && *contact.GoogleResourceName != "" {
			deleteErr := s.googleClient.DeleteContact(c.Context(), accessToken, *contact.GoogleResourceName)
			if deleteErr != nil {
				log.Printf("[GOOGLE] Failed to delete contact %s from Google: %v", cid, deleteErr)
			}
		}
		if clearErr := s.repos.Contact.ClearGoogleSync(c.Context(), contact.ID); clearErr != nil {
			results = append(results, map[string]interface{}{"contact_id": cid.String(), "success": false, "error": clearErr.Error()})
		} else {
			results = append(results, map[string]interface{}{"contact_id": cid.String(), "success": true})
		}
	}

	return c.JSON(fiber.Map{"success": true, "results": results})
}

// --- Core Sync Logic ---

// syncContactToGoogle creates or updates a contact in Google Contacts
func (s *Server) syncContactToGoogle(ctx context.Context, accountID, contactID uuid.UUID) (*domain.Contact, error) {
	contact, err := s.repos.Contact.GetByID(ctx, contactID)
	if err != nil || contact == nil {
		return nil, fmt.Errorf("contact not found")
	}
	if contact.AccountID != accountID {
		return nil, fmt.Errorf("forbidden")
	}

	email, accessToken, refreshToken, groupID, err := s.repos.Account.GetGoogleTokens(ctx, accountID)
	if err != nil || email == "" {
		return nil, fmt.Errorf("Google not connected")
	}

	// Build Google Person
	person := s.buildGooglePerson(contact, groupID)

	// Debug: log what we're sending
	nameToSend := ""
	if len(person.Names) > 0 {
		nameToSend = person.Names[0].GivenName
		if person.Names[0].FamilyName != "" {
			nameToSend += " / " + person.Names[0].FamilyName
		}
	}
	customName, contactName, phone := "<nil>", "<nil>", "<nil>"
	if contact.CustomName != nil { customName = *contact.CustomName }
	if contact.Name != nil { contactName = *contact.Name }
	if contact.Phone != nil { phone = *contact.Phone }
	resName := "<nil>"
	if contact.GoogleResourceName != nil { resName = *contact.GoogleResourceName }
	log.Printf("[GOOGLE] Syncing contact %s (custom_name=%q, name=%q, phone=%s) → sending name=%q to Google resource=%s",
		contactID, customName, contactName, phone, nameToSend, resName)

	// Try the operation, refresh token on 401 and retry once
	result, err := s.doGoogleSync(ctx, accessToken, contact, person, groupID)
	if err != nil && strings.Contains(err.Error(), "status 401") && refreshToken != "" {
		newToken, refreshErr := s.googleClient.RefreshAccessToken(ctx, refreshToken)
		if refreshErr == nil {
			_ = s.repos.Account.UpdateGoogleAccessToken(ctx, accountID, newToken.AccessToken)
			result, err = s.doGoogleSync(ctx, newToken.AccessToken, contact, person, groupID)
		}
	}

	if err != nil {
		syncErr := err.Error()
		_ = s.repos.Contact.SetGoogleSyncError(ctx, contactID, syncErr)
		return nil, fmt.Errorf("Google API error: %w", err)
	}

	// Log sync result
	resultName := ""
	if len(result.Names) > 0 {
		resultName = result.Names[0].GivenName
		if result.Names[0].FamilyName != "" {
			resultName += " " + result.Names[0].FamilyName
		}
	}
	log.Printf("[GOOGLE] Sync result for %s: resource=%s, google_name=%q", contactID, result.ResourceName, resultName)

	// Add to group if needed
	if groupID != "" && result.ResourceName != "" {
		hasMembership := false
		for _, m := range result.Memberships {
			if m.ContactGroupMembership != nil && m.ContactGroupMembership.ContactGroupResourceName == groupID {
				hasMembership = true
				break
			}
		}
		if !hasMembership {
			_ = s.googleClient.ModifyContactGroupMembers(ctx, accessToken, groupID, []string{result.ResourceName})
		}
	}

	// Save sync status
	if err := s.repos.Contact.SetGoogleSync(ctx, contactID, result.ResourceName); err != nil {
		return nil, err
	}

	// Reload contact
	contact, _ = s.repos.Contact.GetByID(ctx, contactID)
	return contact, nil
}

// buildGooglePerson converts a Clarin contact to a Google Person
func (s *Server) buildGooglePerson(contact *domain.Contact, groupID string) *googleclient.Person {
	person := &googleclient.Person{}

	// Name (priority: CustomName > Name > PushName, matching DisplayName())
	name := googleclient.PersonName{}
	if contact.CustomName != nil && *contact.CustomName != "" {
		name.GivenName = *contact.CustomName
	} else if contact.Name != nil && *contact.Name != "" {
		name.GivenName = *contact.Name
	} else if contact.PushName != nil && *contact.PushName != "" {
		name.GivenName = *contact.PushName
	}
	if contact.LastName != nil && *contact.LastName != "" {
		name.FamilyName = *contact.LastName
	}
	if name.GivenName != "" || name.FamilyName != "" {
		person.Names = []googleclient.PersonName{name}
	}

	// Phones
	phones := []googleclient.PhoneNumber{}
	if contact.Phone != nil && *contact.Phone != "" {
		phones = append(phones, googleclient.PhoneNumber{
			Value: "+" + *contact.Phone,
			Type:  "mobile",
		})
	}
	// Extra phones
	if len(contact.ExtraPhones) > 0 {
		for _, ep := range contact.ExtraPhones {
			phones = append(phones, googleclient.PhoneNumber{
				Value: "+" + ep.Phone,
				Type:  ep.Label,
			})
		}
	}
	if len(phones) > 0 {
		person.PhoneNumbers = phones
	}

	// Email
	if contact.Email != nil && *contact.Email != "" {
		person.EmailAddresses = []googleclient.EmailAddress{
			{Value: *contact.Email, Type: "work"},
		}
	}

	// Company
	if contact.Company != nil && *contact.Company != "" {
		person.Organizations = []googleclient.Organization{
			{Name: *contact.Company},
		}
	}

	// Notes
	if contact.Notes != nil && *contact.Notes != "" {
		person.Biographies = []googleclient.Biography{
			{Value: *contact.Notes, ContentType: "TEXT_PLAIN"},
		}
	}

	// Group membership
	if groupID != "" {
		person.Memberships = []googleclient.Membership{
			{
				ContactGroupMembership: &googleclient.ContactGroupMembership{
					ContactGroupResourceName: groupID,
				},
			},
		}
	}

	return person
}

// doGoogleSync performs the actual Google API call (create or update)
func (s *Server) doGoogleSync(ctx context.Context, accessToken string, contact *domain.Contact, person *googleclient.Person, groupID string) (*googleclient.Person, error) {
	var result *googleclient.Person
	var err error

	if contact.GoogleResourceName != nil && *contact.GoogleResourceName != "" {
		result, err = s.googleClient.UpdateContact(ctx, accessToken, *contact.GoogleResourceName, person, "")
		if err != nil && !strings.Contains(err.Error(), "status 401") {
			// Non-auth error (e.g. 404), try create
			result, err = s.googleClient.CreateContact(ctx, accessToken, person)
		}
	} else {
		result, err = s.googleClient.CreateContact(ctx, accessToken, person)
	}
	return result, err
}

// ensureValidToken refreshes the access token if needed
func (s *Server) ensureValidToken(ctx context.Context, accountID uuid.UUID, accessToken, refreshToken string) (string, error) {
	if refreshToken == "" {
		return accessToken, nil
	}

	// Always refresh for manual user-triggered operations (infrequent)
	newToken, err := s.googleClient.RefreshAccessToken(ctx, refreshToken)
	if err != nil {
		log.Printf("[GOOGLE] Token refresh FAILED for account %s: %v", accountID, err)
		return accessToken, nil
	}

	_ = s.repos.Account.UpdateGoogleAccessToken(ctx, accountID, newToken.AccessToken)
	return newToken.AccessToken, nil
}

// handleEventGoogleSyncStatus returns the Google Contacts sync status for an event's participants
func (s *Server) handleEventGoogleSyncStatus(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid event id"})
	}

	// Single query: count total, synced, pending (has contact but not synced), no_contact
	row := s.repos.DB().QueryRow(c.Context(), `
		SELECT
			COUNT(*) AS total,
			COUNT(CASE WHEN co.id IS NOT NULL AND co.google_sync = true THEN 1 END) AS synced,
			COUNT(CASE WHEN co.id IS NOT NULL AND co.google_sync = false THEN 1 END) AS pending,
			COUNT(CASE WHEN co.id IS NULL THEN 1 END) AS no_contact
		FROM event_participants ep
		LEFT JOIN leads l ON l.id = ep.lead_id AND l.account_id = $2
		LEFT JOIN contacts co ON co.id = l.contact_id AND co.account_id = $2
		WHERE ep.event_id = $1
	`, eventID, accountID)

	var total, synced, pending, noContact int
	if err := row.Scan(&total, &synced, &pending, &noContact); err != nil {
		log.Printf("[GOOGLE] Event sync status query error: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "database error"})
	}

	return c.JSON(fiber.Map{
		"success":    true,
		"total":      total,
		"synced":     synced,
		"pending":    pending,
		"no_contact": noContact,
	})
}

// handleEventGoogleSync syncs all unsynchronized event participants to Google Contacts
func (s *Server) handleEventGoogleSync(c *fiber.Ctx) error {
	if s.googleClient == nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Google integration not configured"})
	}

	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid event id"})
	}

	// Get all contact IDs for event participants that are NOT yet synced to Google
	rows, err := s.repos.DB().Query(c.Context(), `
		SELECT DISTINCT co.id
		FROM event_participants ep
		JOIN leads l ON l.id = ep.lead_id AND l.account_id = $2
		JOIN contacts co ON co.id = l.contact_id AND co.account_id = $2
		WHERE ep.event_id = $1 AND co.google_sync = false
	`, eventID, accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "database error"})
	}
	defer rows.Close()

	var contactIDs []uuid.UUID
	for rows.Next() {
		var cid uuid.UUID
		if err := rows.Scan(&cid); err != nil {
			continue
		}
		contactIDs = append(contactIDs, cid)
	}

	if len(contactIDs) == 0 {
		return c.JSON(fiber.Map{"success": true, "count": 0, "message": "all contacts already synced"})
	}

	// Check quota
	syncCount, _ := s.repos.Account.GetGoogleSyncCount(c.Context(), accountID)
	account, _ := s.repos.Account.GetByID(c.Context(), accountID)
	if account == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "account not found"})
	}
	remaining := account.GoogleSyncLimit - syncCount
	if remaining < len(contactIDs) {
		return c.Status(400).JSON(fiber.Map{
			"success": false,
			"error":   fmt.Sprintf("Cuota insuficiente: %d disponibles, %d necesarios", remaining, len(contactIDs)),
		})
	}

	// Mark all as pending immediately
	for _, cid := range contactIDs {
		_ = s.repos.Contact.SetGoogleSyncPending(c.Context(), cid)
	}

	// Process in background, batches of 30
	cids := make([]uuid.UUID, len(contactIDs))
	copy(cids, contactIDs)
	go func() {
		for i := 0; i < len(cids); i++ {
			if _, err := s.syncContactToGoogle(context.Background(), accountID, cids[i]); err != nil {
				log.Printf("[GOOGLE] Event batch sync failed for contact %s: %v", cids[i], err)
			}
		}
		log.Printf("[GOOGLE] Event sync completed: %d contacts for event %s", len(cids), eventID)
	}()

	return c.JSON(fiber.Map{"success": true, "count": len(contactIDs)})
}
