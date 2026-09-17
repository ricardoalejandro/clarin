package config

import "testing"

func TestOfflineV5FlagsAreExplicitAndInheritOnlyTrustedOrigin(t *testing.T) {
	t.Setenv("OFFLINE_V4_SERVER_ORIGIN", "https://clarin.example.invalid/")
	t.Setenv("OFFLINE_V5_SERVER_ORIGIN", "")
	t.Setenv("OFFLINE_V5_ENABLED", "true")
	t.Setenv("OFFLINE_V5_PREPARE_ENABLED", "true")
	t.Setenv("OFFLINE_V5_WRITES_ENABLED", "false")
	t.Setenv("OFFLINE_V5_BLOB_SYNC_ENABLED", "false")
	config := Load()
	if !config.OfflineV5Enabled || !config.OfflineV5PrepareEnabled || config.OfflineV5WritesEnabled || config.OfflineV5BlobSyncEnabled {
		t.Fatalf("v5 staged flags loaded incorrectly: %+v", config)
	}
	if config.OfflineV5ServerOrigin != "https://clarin.example.invalid" {
		t.Fatalf("v5 origin did not inherit normalized v4 origin: %q", config.OfflineV5ServerOrigin)
	}
}

func TestOfflineV5BlobSyncCannotBeEnabledBeforeTransportExists(t *testing.T) {
	t.Setenv("OFFLINE_V5_BLOB_SYNC_ENABLED", "true")
	config := Load()
	if config.OfflineV5BlobSyncEnabled {
		t.Fatal("v5 advertised unsupported blob synchronization")
	}
}
