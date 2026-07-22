package database

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// TestContactProfileCanonicalBackfill runs only against an explicitly enabled
// disposable PostgreSQL database. It proves unique historical values are
// promoted, conflicting values are never selected, compatibility snapshots are
// synchronized/cleared, and a second startup is idempotent.
func TestContactProfileCanonicalBackfill(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CONTACT_PROFILE_MIGRATION_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_CONTACT_PROFILE_MIGRATION_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	const databaseName = "clarin_contact_profile_migration_test"
	adminURL := *parsed
	adminURL.Path = "/postgres"
	testURL := *parsed
	testURL.Path = "/" + databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatalf("create disposable database: %v", err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()

	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatalf("connect disposable database: %v", err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}

	accountID := uuid.New()
	userID := uuid.New()
	contactID, conflictContactID, leadOnlyConflictContactID := uuid.New(), uuid.New(), uuid.New()
	deviceID, campaignID, recipientID := uuid.New(), uuid.New(), uuid.New()
	chatID, programID, programParticipantID := uuid.New(), uuid.New(), uuid.New()
	eventA, eventB, eventC, eventViaLead := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	participantA, participantB, participantC, participantViaLead := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	leadA, leadConflict, leadOnlyConflictA, leadOnlyConflictB := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	fixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO accounts (id,name) VALUES ($1,'Canonical profile test')`, []any{accountID}},
		{`INSERT INTO users (id,account_id,username,email,password_hash,display_name) VALUES ($1,$2,$3,$4,'test','Profile editor')`, []any{userID, accountID, "profile-" + userID.String(), userID.String() + "@example.test"}},
		{`INSERT INTO devices (id,account_id,name) VALUES ($1,$2,'Test device')`, []any{deviceID, accountID}},
		{`INSERT INTO contacts (id,account_id,jid,email) VALUES
			($1,$4,$5,'canonical@example.test'),($2,$4,$6,NULL),($3,$4,$7,NULL)`, []any{
			contactID, conflictContactID, leadOnlyConflictContactID, accountID,
			contactID.String() + "@test", conflictContactID.String() + "@test", leadOnlyConflictContactID.String() + "@test",
		}},
		{`INSERT INTO events (id,account_id,name) VALUES ($1,$4,'A'),($2,$4,'B'),($3,$4,'C')`, []any{eventA, eventB, eventC, accountID}},
		{`INSERT INTO event_participants (id,event_id,contact_id,name,phone,email,company,age,dni,birth_date,address,distrito,ocupacion) VALUES
			($1,$2,$3,'Alexis Histórico','51911111111','legacy@example.test','Plan único',33,'12345678','1993-04-05','Calle 1','Iquitos','Docente'),
			($4,$5,$6,'Persona en conflicto',NULL,NULL,NULL,20,NULL,NULL,NULL,NULL,NULL),
			($7,$8,$6,'Persona en conflicto',NULL,NULL,NULL,21,NULL,NULL,NULL,NULL,NULL)`, []any{participantA, eventA, contactID, participantB, eventB, conflictContactID, participantC, eventC}},
		{`INSERT INTO leads (id,account_id,contact_id,title,jid,name,phone,email,company,age,dni,birth_date,address,distrito,ocupacion) VALUES
			($1,$3,$4,'Plan','lead-a@test','Alexis Histórico','51911111111','legacy@example.test','Plan único',33,'12345678','1993-04-05','Calle 1','Iquitos','Docente'),
			($2,$3,$5,'Plan','lead-b@test','Persona en conflicto',NULL,NULL,NULL,22,NULL,NULL,NULL,NULL,NULL),
			($6,$3,$8,'Plan A','lead-only-a@test',NULL,NULL,NULL,NULL,20,NULL,NULL,NULL,NULL,NULL),
			($7,$3,$8,'Plan B','lead-only-b@test',NULL,NULL,NULL,NULL,21,NULL,NULL,NULL,NULL,NULL)`, []any{
			leadA, leadConflict, accountID, contactID, conflictContactID,
			leadOnlyConflictA, leadOnlyConflictB, leadOnlyConflictContactID,
		}},
		{`INSERT INTO events (id,account_id,name) VALUES ($1,$2,'Evento por Lead')`, []any{eventViaLead, accountID}},
		{`INSERT INTO campaigns (id,account_id,device_id,name,message_template) VALUES ($1,$2,$3,'Campaign','Hi')`, []any{campaignID, accountID, deviceID}},
		{`INSERT INTO campaign_recipients (id,campaign_id,contact_id,jid,name,phone) VALUES ($1,$2,$3,'old@test','Old name','000')`, []any{recipientID, campaignID, contactID}},
		{`INSERT INTO chats (id,account_id,device_id,contact_id,jid,name) VALUES ($1,$2,$3,$4,$5,'Chat canónico')`, []any{chatID, accountID, deviceID, contactID, "chat-" + contactID.String() + "@test"}},
		{`INSERT INTO programs (id,account_id,name,created_by) VALUES ($1,$2,'Programa canónico',$3)`, []any{programID, accountID, userID}},
		{`INSERT INTO program_participants (id,program_id,contact_id) VALUES ($1,$2,$3)`, []any{programParticipantID, programID, contactID}},
	}
	for _, fixture := range fixtures {
		if _, err := db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatalf("seed fixture: %v\n%s", err, fixture.query)
		}
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("canonical migrate: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("idempotent canonical migrate: %v", err)
	}
	// Model a rolling-compatibility row that still exposes its Contact through
	// Lead. Canonical APIs must honor that real same-account relation until the
	// legacy participant link is backfilled on the next full data migration.
	if _, err := db.Exec(ctx, `
		INSERT INTO event_participants (id,event_id,lead_id,contact_id,name)
		VALUES ($1,$2,$3,NULL,'Alexis Histórico')
	`, participantViaLead, eventViaLead, leadA); err != nil {
		t.Fatalf("seed Lead-linked event participant: %v", err)
	}

	var customName, phone, email, company, dni, address, distrito, ocupacion *string
	var age *int
	if err := db.QueryRow(ctx, `SELECT custom_name,phone,email,company,age,dni,address,distrito,ocupacion FROM contacts WHERE account_id=$1 AND id=$2`, accountID, contactID).
		Scan(&customName, &phone, &email, &company, &age, &dni, &address, &distrito, &ocupacion); err != nil {
		t.Fatal(err)
	}
	if customName == nil || *customName != "Alexis Histórico" || phone == nil || *phone != "51911111111" ||
		email == nil || *email != "canonical@example.test" || company == nil || *company != "Plan único" ||
		age == nil || *age != 33 || dni == nil || *dni != "12345678" || address == nil || *address != "Calle 1" ||
		distrito == nil || *distrito != "Iquitos" || ocupacion == nil || *ocupacion != "Docente" {
		t.Fatalf("unique historical profile was not promoted safely: name=%v phone=%v email=%v company=%v age=%v", customName, phone, email, company, age)
	}
	var conflictAge *int
	if err := db.QueryRow(ctx, `SELECT age FROM contacts WHERE account_id=$1 AND id=$2`, accountID, conflictContactID).Scan(&conflictAge); err != nil {
		t.Fatal(err)
	}
	if conflictAge != nil {
		t.Fatalf("conflicting ages must not be selected, got %d", *conflictAge)
	}
	var leadOnlyConflictAge *int
	if err := db.QueryRow(ctx, `SELECT age FROM contacts WHERE account_id=$1 AND id=$2`, accountID, leadOnlyConflictContactID).Scan(&leadOnlyConflictAge); err != nil {
		t.Fatal(err)
	}
	if leadOnlyConflictAge != nil {
		t.Fatalf("lead-only conflicting ages must not be selected, got %d", *leadOnlyConflictAge)
	}
	readConflictValues := func(contact uuid.UUID, field string) []string {
		t.Helper()
		var encoded []byte
		if err := db.QueryRow(ctx, `
			SELECT candidate_values FROM contact_profile_migration_conflicts
			WHERE account_id=$1 AND contact_id=$2 AND field_name=$3 AND resolved_at IS NULL
		`, accountID, contact, field).Scan(&encoded); err != nil {
			t.Fatalf("read %s conflict evidence: %v", field, err)
		}
		var values []string
		if err := json.Unmarshal(encoded, &values); err != nil {
			t.Fatalf("decode %s conflict evidence: %v", field, err)
		}
		return values
	}
	leadOnlyAgeCandidates := readConflictValues(leadOnlyConflictContactID, "age")
	if len(leadOnlyAgeCandidates) != 2 || leadOnlyAgeCandidates[0] != "20" || leadOnlyAgeCandidates[1] != "21" {
		t.Fatalf("lead-only conflict evidence was not preserved: %#v", leadOnlyAgeCandidates)
	}
	// Historical snapshots that agree with each other but differ from an
	// existing canonical value are also conflicts, not silent overwrites.
	emailCandidates := readConflictValues(contactID, "email")
	if len(emailCandidates) != 2 {
		t.Fatalf("canonical-vs-snapshot conflict evidence was not preserved: %#v", emailCandidates)
	}
	var clearedLeadConflictAge *int
	if err := db.QueryRow(ctx, `SELECT age FROM leads WHERE account_id=$1 AND id=$2`, accountID, leadConflict).Scan(&clearedLeadConflictAge); err != nil {
		t.Fatal(err)
	}
	if clearedLeadConflictAge != nil {
		t.Fatalf("ambiguous values must not survive in linked Lead snapshots: %#v", clearedLeadConflictAge)
	}
	var leadName, leadPhone *string
	if err := db.QueryRow(ctx, `SELECT name,phone FROM leads WHERE account_id=$1 AND id=$2`, accountID, leadA).Scan(&leadName, &leadPhone); err != nil {
		t.Fatal(err)
	}
	if leadName != nil || leadPhone != nil {
		t.Fatalf("promoted lead snapshots must be cleared: name=%v phone=%v", leadName, leadPhone)
	}
	var eventName, eventEmail string
	if err := db.QueryRow(ctx, `SELECT name,email FROM event_participants WHERE id=$1`, participantA).Scan(&eventName, &eventEmail); err != nil {
		t.Fatal(err)
	}
	if eventName != "Alexis Histórico" || eventEmail != "canonical@example.test" {
		t.Fatalf("event snapshot not synchronized: name=%q email=%q", eventName, eventEmail)
	}
	var campaignName, campaignPhone, campaignJID string
	if err := db.QueryRow(ctx, `SELECT name,phone,jid FROM campaign_recipients WHERE id=$1`, recipientID).Scan(&campaignName, &campaignPhone, &campaignJID); err != nil {
		t.Fatal(err)
	}
	if campaignName != "Alexis Histórico" || campaignPhone != "51911111111" || campaignJID != contactID.String()+"@test" {
		t.Fatalf("campaign snapshot not synchronized: %q %q %q", campaignName, campaignPhone, campaignJID)
	}

	// Reproduce the production drift: WhatsApp ContactSync writes through
	// ContactRepository.GetOrCreate after startup migrations have already
	// synchronized the projections. Every linked projection must follow that
	// direct Contact update in the same statement, including an Event row whose
	// Contact is still exposed only through its Lead.
	foreignProjectionAccountID := uuid.New()
	foreignProjectionDeviceID := uuid.New()
	foreignProjectionEventID := uuid.New()
	foreignProjectionParticipantID := uuid.New()
	foreignProjectionCampaignID := uuid.New()
	foreignProjectionRecipientID := uuid.New()
	projectionFixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO accounts (id,name) VALUES ($1,'Foreign projection account')`, []any{foreignProjectionAccountID}},
		{`INSERT INTO devices (id,account_id,name) VALUES ($1,$2,'Foreign projection device')`, []any{foreignProjectionDeviceID, foreignProjectionAccountID}},
		{`INSERT INTO events (id,account_id,name) VALUES ($1,$2,'Foreign projection event')`, []any{foreignProjectionEventID, foreignProjectionAccountID}},
		{`INSERT INTO event_participants (id,event_id,contact_id,name,phone) VALUES ($1,$2,$3,'Foreign snapshot','foreign-phone')`, []any{foreignProjectionParticipantID, foreignProjectionEventID, contactID}},
		{`INSERT INTO campaigns (id,account_id,device_id,name,message_template) VALUES ($1,$2,$3,'Foreign projection campaign','Hi')`, []any{foreignProjectionCampaignID, foreignProjectionAccountID, foreignProjectionDeviceID}},
		{`INSERT INTO campaign_recipients (id,campaign_id,contact_id,jid,name,phone) VALUES ($1,$2,$3,'foreign@test','Foreign recipient','foreign-phone')`, []any{foreignProjectionRecipientID, foreignProjectionCampaignID, contactID}},
	}
	for _, fixture := range projectionFixtures {
		if _, err := db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatalf("seed projection trigger fixture: %v\n%s", err, fixture.query)
		}
	}
	if _, err := db.Exec(ctx, `UPDATE contacts SET custom_name=NULL,name='Nombre anterior',push_name=NULL WHERE account_id=$1 AND id=$2`, accountID, contactID); err != nil {
		t.Fatalf("prepare canonical Contact for post-startup drift: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE event_participants SET name='Snapshot desactualizado' WHERE id=ANY($1::uuid[])`, []uuid.UUID{participantA, participantViaLead}); err != nil {
		t.Fatalf("prepare stale Event projections: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE campaign_recipients SET name='Snapshot desactualizado' WHERE id=$1`, recipientID); err != nil {
		t.Fatalf("prepare stale Campaign projection: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE leads SET name='Snapshot Lead',phone='000' WHERE account_id=$1 AND id=$2`, accountID, leadA); err != nil {
		t.Fatalf("prepare stale Lead snapshot: %v", err)
	}
	contactRepo := repository.NewRepositories(db).Contact
	contactAfterSync, err := contactRepo.GetOrCreate(
		ctx,
		accountID,
		&deviceID,
		contactID.String()+"@test",
		"51911111111",
		"Nombre desde WhatsApp",
		"Push desde WhatsApp",
		false,
	)
	if err != nil {
		t.Fatalf("simulate WhatsApp ContactSync upsert: %v", err)
	}
	if contactAfterSync == nil || contactAfterSync.DisplayName() != "Nombre desde WhatsApp" {
		t.Fatalf("WhatsApp ContactSync did not update the canonical Contact: %#v", contactAfterSync)
	}
	for _, projection := range []struct {
		name string
		id   uuid.UUID
	}{{name: "direct Event", id: participantA}, {name: "Lead-linked Event", id: participantViaLead}} {
		var got string
		if err := db.QueryRow(ctx, `SELECT name FROM event_participants WHERE id=$1`, projection.id).Scan(&got); err != nil {
			t.Fatalf("read %s projection: %v", projection.name, err)
		}
		if got != "Nombre desde WhatsApp" {
			t.Fatalf("%s projection drifted after ContactSync: %q", projection.name, got)
		}
	}
	if err := db.QueryRow(ctx, `SELECT name FROM campaign_recipients WHERE id=$1`, recipientID).Scan(&campaignName); err != nil {
		t.Fatal(err)
	}
	if campaignName != "Nombre desde WhatsApp" {
		t.Fatalf("Campaign projection drifted after ContactSync: %q", campaignName)
	}
	if err := db.QueryRow(ctx, `SELECT name,phone FROM leads WHERE account_id=$1 AND id=$2`, accountID, leadA).Scan(&leadName, &leadPhone); err != nil {
		t.Fatal(err)
	}
	if leadName != nil || leadPhone != nil {
		t.Fatalf("ContactSync did not clear linked Lead snapshots: name=%v phone=%v", leadName, leadPhone)
	}
	var foreignEventName, foreignCampaignName string
	if err := db.QueryRow(ctx, `SELECT name FROM event_participants WHERE id=$1`, foreignProjectionParticipantID).Scan(&foreignEventName); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT name FROM campaign_recipients WHERE id=$1`, foreignProjectionRecipientID).Scan(&foreignCampaignName); err != nil {
		t.Fatal(err)
	}
	if foreignEventName != "Foreign snapshot" || foreignCampaignName != "Foreign recipient" {
		t.Fatalf("Contact snapshot trigger crossed account boundary: event=%q campaign=%q", foreignEventName, foreignCampaignName)
	}

	// Explicit nulls must clear nullable projections. A no-op identity assignment
	// and an updated_at-only write must not touch Event timestamps again.
	if _, err := db.Exec(ctx, `
		UPDATE contacts SET custom_name=NULL,name=NULL,push_name='Nombre de respaldo',phone=NULL,email=NULL,company=NULL
		WHERE account_id=$1 AND id=$2
	`, accountID, contactID); err != nil {
		t.Fatalf("clear canonical fields through direct writer: %v", err)
	}
	var clearedEventName string
	var clearedEventPhone, clearedEventEmail, clearedEventCompany *string
	var projectionUpdatedAt time.Time
	if err := db.QueryRow(ctx, `
		SELECT name,phone,email,company,updated_at FROM event_participants WHERE id=$1
	`, participantViaLead).Scan(&clearedEventName, &clearedEventPhone, &clearedEventEmail, &clearedEventCompany, &projectionUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if clearedEventName != "Nombre de respaldo" || clearedEventPhone != nil || clearedEventEmail != nil || clearedEventCompany != nil {
		t.Fatalf("explicit Contact clear did not reach Lead-linked Event: name=%q phone=%v email=%v company=%v", clearedEventName, clearedEventPhone, clearedEventEmail, clearedEventCompany)
	}
	var clearedCampaignName string
	var clearedCampaignPhone *string
	if err := db.QueryRow(ctx, `SELECT name,phone FROM campaign_recipients WHERE id=$1`, recipientID).Scan(&clearedCampaignName, &clearedCampaignPhone); err != nil {
		t.Fatal(err)
	}
	if clearedCampaignName != "Nombre de respaldo" || clearedCampaignPhone != nil {
		t.Fatalf("explicit Contact clear did not reach Campaign: name=%q phone=%v", clearedCampaignName, clearedCampaignPhone)
	}
	if _, err := db.Exec(ctx, `UPDATE contacts SET name=name,updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2`, accountID, contactID); err != nil {
		t.Fatalf("run idempotent Contact update: %v", err)
	}
	var projectionUpdatedAtAfterNoop time.Time
	if err := db.QueryRow(ctx, `SELECT updated_at FROM event_participants WHERE id=$1`, participantViaLead).Scan(&projectionUpdatedAtAfterNoop); err != nil {
		t.Fatal(err)
	}
	if !projectionUpdatedAtAfterNoop.Equal(projectionUpdatedAt) {
		t.Fatalf("no-op Contact update rewrote Event projection timestamp: before=%s after=%s", projectionUpdatedAt, projectionUpdatedAtAfterNoop)
	}

	// Restore the original canonical fixture for the remaining profile contract
	// assertions in this integration test.
	if _, err := db.Exec(ctx, `
		UPDATE contacts SET custom_name='Alexis Histórico',name=NULL,push_name=NULL,
			phone='51911111111',email='canonical@example.test',company='Plan único'
		WHERE account_id=$1 AND id=$2
	`, accountID, contactID); err != nil {
		t.Fatalf("restore canonical profile fixture: %v", err)
	}

	profileRepo := repository.NewContactProfileRepository(db)
	updatedCompany := "Perfil actualizado"
	updated, err := profileRepo.Update(ctx, accountID, contactID, repository.ContactProfilePatch{
		CompanySet: true, Company: &updatedCompany,
		EmailSet: true, Email: nil,
	})
	if err != nil {
		t.Fatalf("transactional profile update: %v", err)
	}
	if updated.Company == nil || *updated.Company != updatedCompany || updated.Email != nil {
		t.Fatalf("canonical PATCH semantics were not preserved: company=%v email=%v", updated.Company, updated.Email)
	}
	var syncedCompany string
	var syncedEmail *string
	if err := db.QueryRow(ctx, `SELECT company,email FROM event_participants WHERE id=$1`, participantA).Scan(&syncedCompany, &syncedEmail); err != nil {
		t.Fatal(err)
	}
	if syncedCompany != updatedCompany || syncedEmail != nil {
		t.Fatalf("transaction did not synchronize explicit clear: company=%q email=%v", syncedCompany, syncedEmail)
	}
	var leadLinkedCompany *string
	var leadLinkedEmail *string
	if err := db.QueryRow(ctx, `SELECT company,email FROM event_participants WHERE id=$1`, participantViaLead).Scan(&leadLinkedCompany, &leadLinkedEmail); err != nil {
		t.Fatal(err)
	}
	if leadLinkedCompany == nil || *leadLinkedCompany != updatedCompany || leadLinkedEmail != nil {
		t.Fatalf("Lead-linked participant snapshot was not synchronized from Contact: company=%v email=%v", leadLinkedCompany, leadLinkedEmail)
	}

	foreignAccountID := uuid.New()
	tagID, foreignTagID := uuid.New(), uuid.New()
	fieldID, foreignFieldID := uuid.New(), uuid.New()
	collectionFixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO accounts (id,name) VALUES ($1,'Foreign profile account')`, []any{foreignAccountID}},
		{`INSERT INTO tags (id,account_id,name,color) VALUES ($1,$3,'Participante','#059669'),($2,$4,'Ajena','#dc2626')`, []any{tagID, foreignTagID, accountID, foreignAccountID}},
		{`INSERT INTO custom_field_definitions (id,account_id,name,slug,field_type,config) VALUES
			($1,$3,'Preferencia','preferencia','text','{"max_length":100}'::jsonb),
			($2,$4,'Campo ajeno','campo-ajeno','text','{}'::jsonb)`, []any{fieldID, foreignFieldID, accountID, foreignAccountID}},
	}
	for _, fixture := range collectionFixtures {
		if _, err := db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatalf("seed collection fixture: %v", err)
		}
	}
	profileContexts := []struct {
		name string
		id   uuid.UUID
	}{
		{name: "contact", id: contactID},
		{name: "lead", id: leadA},
		{name: "chat", id: chatID},
		{name: "event_participant", id: participantA},
		{name: "program_participant", id: programParticipantID},
	}
	for _, profileContext := range profileContexts {
		contextExists, err := profileRepo.ContextExists(ctx, accountID, contactID, profileContext.name, profileContext.id)
		if err != nil || !contextExists {
			t.Fatalf("same-account %s context was not authorized: exists=%v err=%v", profileContext.name, contextExists, err)
		}
		contextExists, err = profileRepo.ContextExists(ctx, foreignAccountID, contactID, profileContext.name, profileContext.id)
		if err != nil || contextExists {
			t.Fatalf("cross-account %s context leaked instead of resolving as missing: exists=%v err=%v", profileContext.name, contextExists, err)
		}
		contextExists, err = profileRepo.ContextExists(ctx, accountID, conflictContactID, profileContext.name, profileContext.id)
		if err != nil || contextExists {
			t.Fatalf("%s context accepted an unrelated Contact: exists=%v err=%v", profileContext.name, contextExists, err)
		}
	}
	contextExists, err := profileRepo.ContextExists(ctx, accountID, contactID, "event_participant", participantViaLead)
	if err != nil || !contextExists {
		t.Fatalf("event participant linked through Lead was not authorized: exists=%v err=%v", contextExists, err)
	}
	contextExists, err = profileRepo.ContextExists(ctx, foreignAccountID, contactID, "event_participant", participantViaLead)
	if err != nil || contextExists {
		t.Fatalf("cross-account event participant linked through Lead leaked: exists=%v err=%v", contextExists, err)
	}
	if _, err := profileRepo.Get(ctx, foreignAccountID, contactID); !errors.Is(err, repository.ErrContactProfileNotFound) {
		t.Fatalf("cross-account profile read must look missing, got %v", err)
	}
	customText := "Seguimiento preferente"
	updated, err = profileRepo.Update(ctx, accountID, contactID, repository.ContactProfilePatch{
		TagIDsSet: true, TagIDs: []uuid.UUID{tagID, tagID},
		ExtraPhonesSet: true, ExtraPhones: []repository.ContactProfileExtraPhonePatch{
			{Phone: "929 999 999", Label: "Casa"},
			{Phone: "+51 929 999 999", Label: "Duplicado"},
		},
		CustomFieldValuesSet: true,
		CustomFieldValues:    []repository.ContactProfileCustomFieldPatch{{FieldID: fieldID, ValueText: &customText}},
	})
	if err != nil {
		t.Fatalf("replace canonical collections: %v", err)
	}
	if len(updated.StructuredTags) != 1 || updated.StructuredTags[0].ID != tagID {
		t.Fatalf("tag collection was not replaced/deduplicated: %#v", updated.StructuredTags)
	}
	if len(updated.ExtraPhones) != 1 || updated.ExtraPhones[0].Phone != "51929999999" || updated.ExtraPhones[0].Label != "Casa" {
		t.Fatalf("extra phones were not normalized/deduplicated: %#v", updated.ExtraPhones)
	}
	if len(updated.CustomFieldValues) != 1 || updated.CustomFieldValues[0].FieldID != fieldID || updated.CustomFieldValues[0].ValueText == nil || *updated.CustomFieldValues[0].ValueText != customText {
		t.Fatalf("custom fields were not replaced: %#v", updated.CustomFieldValues)
	}

	// Omitted collections remain byte-for-byte present while another scalar is
	// changed. This is distinct from explicitly sending an empty list.
	preservedNotes := "Cambio escalar sin tocar colecciones"
	updated, err = profileRepo.Update(ctx, accountID, contactID, repository.ContactProfilePatch{NotesSet: true, Notes: &preservedNotes})
	if err != nil {
		t.Fatalf("update with omitted collections: %v", err)
	}
	if len(updated.StructuredTags) != 1 || len(updated.ExtraPhones) != 1 || len(updated.CustomFieldValues) != 1 {
		t.Fatalf("omitted collections were modified: tags=%d phones=%d fields=%d", len(updated.StructuredTags), len(updated.ExtraPhones), len(updated.CustomFieldValues))
	}
	updated, err = profileRepo.Update(ctx, accountID, contactID, repository.ContactProfilePatch{
		CustomFieldValuesSet: true,
		CustomFieldValues:    []repository.ContactProfileCustomFieldPatch{{FieldID: fieldID}},
	})
	if err != nil {
		t.Fatalf("clear custom value with an all-null item: %v", err)
	}
	if len(updated.StructuredTags) != 1 || len(updated.ExtraPhones) != 1 || len(updated.CustomFieldValues) != 0 {
		t.Fatalf("all-null custom item must remove only the custom value replacement: tags=%d phones=%d fields=%d", len(updated.StructuredTags), len(updated.ExtraPhones), len(updated.CustomFieldValues))
	}

	updated, err = profileRepo.Update(ctx, accountID, contactID, repository.ContactProfilePatch{
		TagIDsSet: true, TagIDs: []uuid.UUID{},
		ExtraPhonesSet: true, ExtraPhones: []repository.ContactProfileExtraPhonePatch{},
		CustomFieldValuesSet: true, CustomFieldValues: []repository.ContactProfileCustomFieldPatch{},
	})
	if err != nil {
		t.Fatalf("clear canonical collections: %v", err)
	}
	if len(updated.StructuredTags) != 0 || len(updated.ExtraPhones) != 0 || len(updated.CustomFieldValues) != 0 {
		t.Fatalf("empty collections did not clear values: tags=%d phones=%d fields=%d", len(updated.StructuredTags), len(updated.ExtraPhones), len(updated.CustomFieldValues))
	}
	var historicalAliasOwner uuid.UUID
	if err := db.QueryRow(ctx, `
		SELECT contact_id FROM contact_aliases
		WHERE account_id=$1 AND alias_type='phone' AND normalized_value='51929999999'
	`, accountID).Scan(&historicalAliasOwner); err != nil || historicalAliasOwner != contactID {
		t.Fatalf("removed extra phone must retain its historical identity alias: owner=%s err=%v", historicalAliasOwner, err)
	}

	rolledBackCompany := "No debe persistir"
	_, err = profileRepo.Update(ctx, accountID, contactID, repository.ContactProfilePatch{
		CompanySet: true, Company: &rolledBackCompany,
		TagIDsSet: true, TagIDs: []uuid.UUID{foreignTagID},
	})
	if !errors.Is(err, repository.ErrContactProfileCollectionInvalid) {
		t.Fatalf("foreign-account tag must be rejected, got %v", err)
	}
	afterRollback, err := profileRepo.Get(ctx, accountID, contactID)
	if err != nil {
		t.Fatalf("read after tag rollback: %v", err)
	}
	if afterRollback.Company == nil || *afterRollback.Company != updatedCompany || len(afterRollback.StructuredTags) != 0 {
		t.Fatalf("foreign tag did not roll back the complete transaction: company=%v tags=%d", afterRollback.Company, len(afterRollback.StructuredTags))
	}

	foreignValue := "No permitido"
	_, err = profileRepo.Update(ctx, accountID, contactID, repository.ContactProfilePatch{
		CompanySet: true, Company: &rolledBackCompany,
		TagIDsSet: true, TagIDs: []uuid.UUID{tagID},
		CustomFieldValuesSet: true,
		CustomFieldValues:    []repository.ContactProfileCustomFieldPatch{{FieldID: foreignFieldID, ValueText: &foreignValue}},
	})
	if !errors.Is(err, repository.ErrContactProfileCollectionInvalid) {
		t.Fatalf("foreign-account custom field must be rejected, got %v", err)
	}
	afterRollback, err = profileRepo.Get(ctx, accountID, contactID)
	if err != nil {
		t.Fatalf("read after custom-field rollback: %v", err)
	}
	if afterRollback.Company == nil || *afterRollback.Company != updatedCompany || len(afterRollback.StructuredTags) != 0 || len(afterRollback.CustomFieldValues) != 0 {
		t.Fatalf("foreign custom field did not roll back every collection/scalar: company=%v tags=%d fields=%d", afterRollback.Company, len(afterRollback.StructuredTags), len(afterRollback.CustomFieldValues))
	}
	conflictingPhone := "51988877766"
	if _, err := db.Exec(ctx, `UPDATE contacts SET phone=$3 WHERE account_id=$1 AND id=$2`, accountID, conflictContactID, conflictingPhone); err != nil {
		t.Fatalf("seed phone identity conflict: %v", err)
	}
	_, err = profileRepo.Update(ctx, accountID, contactID, repository.ContactProfilePatch{PhoneSet: true, Phone: &conflictingPhone})
	if !errors.Is(err, repository.ErrContactIdentityConflict) {
		t.Fatalf("phone owned by another Contact must be rejected, got %v", err)
	}
	afterRollback, err = profileRepo.Get(ctx, accountID, contactID)
	if err != nil {
		t.Fatalf("read after phone conflict rollback: %v", err)
	}
	if afterRollback.Phone == nil || *afterRollback.Phone != "51911111111" {
		t.Fatalf("phone conflict changed canonical identity despite rollback: %v", afterRollback.Phone)
	}

	// A stale compatibility snapshot must never resurrect a field explicitly
	// cleared on a linked Contact. Exercise every Event participant read path
	// used by list/detail/subroutes, not only the raw synchronization result.
	if _, err := db.Exec(ctx, `UPDATE event_participants SET email='stale-snapshot@example.test' WHERE id=$1`, participantA); err != nil {
		t.Fatalf("poison compatibility snapshot: %v", err)
	}
	repos := repository.NewRepositories(db)
	participantReads := make([]*domain.EventParticipant, 0, 3)
	byID, err := repos.Participant.GetByID(ctx, participantA)
	if err != nil || byID == nil {
		t.Fatalf("read participant by id: participant=%v err=%v", byID, err)
	}
	participantReads = append(participantReads, byID)
	forEvent, err := repos.Participant.GetForEvent(ctx, accountID, eventA, participantA)
	if err != nil || forEvent == nil {
		t.Fatalf("read participant for event: participant=%v err=%v", forEvent, err)
	}
	participantReads = append(participantReads, forEvent)
	byEvent, err := repos.Participant.GetByEventID(ctx, eventA, "", "", nil, nil)
	if err != nil || len(byEvent) != 1 {
		t.Fatalf("read participants by event: len=%d err=%v", len(byEvent), err)
	}
	participantReads = append(participantReads, byEvent[0])
	for index, participant := range participantReads {
		if participant.Email != nil {
			t.Fatalf("participant read path %d resurrected stale email %q", index, *participant.Email)
		}
	}

	observations, err := profileRepo.ListObservations(ctx, accountID, contactID, 50, 0)
	if err != nil || len(observations) != 0 {
		t.Fatalf("empty observation history must be []: len=%d err=%v", len(observations), err)
	}
	type observationExpectation struct {
		contextType          string
		contextID            uuid.UUID
		sourceLabel          string
		leadID               *uuid.UUID
		eventID              *uuid.UUID
		participantID        *uuid.UUID
		programID            *uuid.UUID
		programParticipantID *uuid.UUID
	}
	ptr := func(value uuid.UUID) *uuid.UUID { return &value }
	expectations := []observationExpectation{
		{contextType: "contact", contextID: contactID, sourceLabel: "Contacto"},
		{contextType: "lead", contextID: leadA, sourceLabel: "Oportunidad · Plan", leadID: ptr(leadA)},
		{contextType: "chat", contextID: chatID, sourceLabel: "Chat"},
		{contextType: "event_participant", contextID: participantA, sourceLabel: "Evento · A", eventID: ptr(eventA), participantID: ptr(participantA)},
		{contextType: "event_participant", contextID: participantViaLead, sourceLabel: "Evento · Evento por Lead", eventID: ptr(eventViaLead), participantID: ptr(participantViaLead)},
		{contextType: "program_participant", contextID: programParticipantID, sourceLabel: "Programa · Programa canónico", programID: ptr(programID), programParticipantID: ptr(programParticipantID)},
	}
	createdObservations := make([]*domain.Interaction, 0, len(expectations))
	for _, expectation := range expectations {
		observation, err := profileRepo.CreateObservation(
			ctx, accountID, userID, contactID, expectation.contextType, expectation.contextID,
			"Observación desde "+expectation.contextType,
		)
		if err != nil {
			t.Fatalf("create %s observation: %v", expectation.contextType, err)
		}
		if observation.ContactID == nil || *observation.ContactID != contactID || observation.SourceLabel != expectation.sourceLabel {
			t.Fatalf("%s observation lost canonical source: contact=%v source=%q", expectation.contextType, observation.ContactID, observation.SourceLabel)
		}
		assertOptionalID := func(field string, got, want *uuid.UUID) {
			t.Helper()
			if (got == nil) != (want == nil) || (got != nil && *got != *want) {
				t.Fatalf("%s observation has incorrect %s: got=%v want=%v", expectation.contextType, field, got, want)
			}
		}
		assertOptionalID("lead_id", observation.LeadID, expectation.leadID)
		assertOptionalID("event_id", observation.EventID, expectation.eventID)
		assertOptionalID("participant_id", observation.ParticipantID, expectation.participantID)
		assertOptionalID("program_id", observation.ProgramID, expectation.programID)
		assertOptionalID("program_participant_id", observation.ProgramParticipantID, expectation.programParticipantID)
		createdObservations = append(createdObservations, observation)

		if _, err := profileRepo.CreateObservation(
			ctx, foreignAccountID, userID, contactID, expectation.contextType, expectation.contextID, "No permitida",
		); !errors.Is(err, repository.ErrContactProfileContextNotFound) {
			t.Fatalf("cross-account %s observation must resolve as missing, got %v", expectation.contextType, err)
		}
	}
	observations, err = profileRepo.ListObservations(ctx, accountID, contactID, 50, 0)
	if err != nil || len(observations) != len(createdObservations) {
		t.Fatalf("canonical contextual observations were not listed exactly once: len=%d err=%v", len(observations), err)
	}
	listedIDs := make(map[uuid.UUID]struct{}, len(observations))
	for _, observation := range observations {
		listedIDs[observation.ID] = struct{}{}
	}
	for _, observation := range createdObservations {
		if _, found := listedIDs[observation.ID]; !found {
			t.Fatalf("contextual observation %s missing from canonical history", observation.ID)
		}
	}
	attendanceID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO interactions (id,account_id,contact_id,type,notes,created_by) VALUES ($1,$2,$3,$4,'Protegida',$5)`, attendanceID, accountID, contactID, domain.InteractionTypeAttendance, userID); err != nil {
		t.Fatalf("seed protected attendance observation: %v", err)
	}
	if err := profileRepo.DeleteObservation(ctx, accountID, contactID, attendanceID); !errors.Is(err, repository.ErrAttendanceObservationProtected) {
		t.Fatalf("attendance observation must be protected, got %v", err)
	}
	callID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO interactions (id,account_id,contact_id,type,notes,created_by) VALUES ($1,$2,$3,$4,'Llamada histórica',$5)`, callID, accountID, contactID, domain.InteractionTypeCall, userID); err != nil {
		t.Fatalf("seed protected call history: %v", err)
	}
	if err := profileRepo.DeleteObservation(ctx, accountID, contactID, callID); !errors.Is(err, repository.ErrContactProfileObservationLocked) {
		t.Fatalf("non-note history must be protected, got %v", err)
	}
	var callStillExists bool
	if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM interactions WHERE account_id=$1 AND id=$2)`, accountID, callID).Scan(&callStillExists); err != nil || !callStillExists {
		t.Fatalf("protected call history was removed: exists=%v err=%v", callStillExists, err)
	}
	for _, observation := range createdObservations {
		if err := profileRepo.DeleteObservation(ctx, accountID, contactID, observation.ID); err != nil {
			t.Fatalf("delete regular observation %s: %v", observation.ID, err)
		}
	}
}
