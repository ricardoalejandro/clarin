package database

import (
	"os"
	"strings"
	"testing"
)

func TestOfflineTerminalMigrationIsInRuntimePathAndAccountScoped(t *testing.T) {
	databaseSource, err := os.ReadFile("database.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(databaseSource), "migrateOfflineTerminals(ctx, db)") {
		t.Fatal("offline migration is not in Migrate runtime path")
	}
	if !strings.Contains(string(databaseSource), "migrateOfflineSyncV2(ctx, db)") {
		t.Fatal("offline v2 migration is not in Migrate runtime path")
	}
	if !strings.Contains(string(databaseSource), "migrateOfflineEnrollmentRequests(ctx, db)") {
		t.Fatal("offline request migration is not in Migrate runtime path")
	}
	if !strings.Contains(string(databaseSource), "migrateOfflineCertificateFree(ctx, db)") {
		t.Fatal("offline certificate-free cleanup is not in Migrate runtime path")
	}
	if !strings.Contains(string(databaseSource), "migrateOfflineDevicePosture(ctx, db)") {
		t.Fatal("offline device posture migration is not in Migrate runtime path")
	}
	source, err := os.ReadFile("offline_terminal_migration.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{"offline_terminal_grants", "FOREIGN KEY (user_id, account_id)", "FOREIGN KEY (grant_id, account_id)", "offline_sync_receipts", "offline_sync_conflicts", "offline_terminal_audit", "max_offline_seconds <= 86400", "quota_bytes <= 5368709120", "uq_offline_terminal_user_sid_active"} {
		if !strings.Contains(text, required) {
			t.Fatalf("offline migration lost invariant %q", required)
		}
	}
}

func TestOfflineDevicePostureMigrationUsesClosedAdvisoryStates(t *testing.T) {
	source, err := os.ReadFile("offline_device_posture_migration.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS bitlocker_status",
		"ADD COLUMN IF NOT EXISTS windows_hello_status",
		"ADD COLUMN IF NOT EXISTS posture_reported_at",
		"bitlocker_status IN ('enabled','disabled','unknown')",
		"windows_hello_status IN ('configured','not_configured','unknown')",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("offline posture migration lost invariant %q", required)
		}
	}
}

func TestOfflineEnrollmentRequestMigrationUsesClosedStatesAndUniqueDeviceIdentity(t *testing.T) {
	source, err := os.ReadFile("offline_enrollment_request_migration.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{"requested", "approved", "rejected", "uq_offline_terminal_install_instance_live", "uq_offline_terminal_user_sid_live"} {
		if !strings.Contains(text, required) {
			t.Fatalf("offline enrollment migration lost invariant %q", required)
		}
	}
	if strings.Contains(text, "csr_pem") {
		t.Fatal("certificate request storage remains in the enrollment migration")
	}
}

func TestOfflineSyncV2MigrationKeepsControlAndDataPlaneDurable(t *testing.T) {
	source, err := os.ReadFile("offline_sync_v2_migration.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"offline_resource_heads",
		"resource_type IN ('whiteboard','task_list','contact','program')",
		"offline_control_directives",
		"payload_hash BYTEA NOT NULL",
		"dependency_failed",
		"base_value JSONB",
		"conflict_paths TEXT[]",
		"trg_offline_task_list_metadata_head",
		"trg_offline_program_session_observation_head",
		"trg_offline_tag_definition_head",
		"trg_offline_contact_phone_head",
		"trg_offline_contact_custom_value_head",
		"migrateOfflineSyncV2",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("offline v2 migration lost invariant %q", required)
		}
	}
	for _, retired := range []string{"offline_terminal_certificates", "offline_pairing_sessions", "certificate_pem"} {
		if strings.Contains(text, retired) {
			t.Fatalf("certificate prototype object remains in fresh v2 migration: %q", retired)
		}
	}
}

func TestOfflineCertificateFreeMigrationPreservesHistoryAndRemovesOnlyEmptyPrototypeObjects(t *testing.T) {
	source, err := os.ReadFile("offline_certificate_free_migration.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{"SELECT EXISTS(SELECT 1 FROM offline_terminal_certificates)", "IF NOT has_rows", "IF NOT has_identity", "DROP TABLE offline_terminal_certificates", "DROP COLUMN IF EXISTS certificate_pem"} {
		if !strings.Contains(text, required) {
			t.Fatalf("guarded prototype cleanup lost invariant %q", required)
		}
	}
}
