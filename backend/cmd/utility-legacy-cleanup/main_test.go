package main

import (
	"flag"
	"io"
	"os"
	"strings"
	"testing"
)

// These serial tests exercise argument rejection before run can create a pool
// or inspect a manifest. No database environment or fixture file is required.
func invokeCleanupArguments(t *testing.T, args ...string) (*flag.FlagSet, error) {
	t.Helper()
	previousArgs, previousFlags := os.Args, flag.CommandLine
	defer func() { os.Args, flag.CommandLine = previousArgs, previousFlags }()
	flags := flag.NewFlagSet("utility-legacy-cleanup-test", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flag.CommandLine = flags
	os.Args = append([]string{"utility-legacy-cleanup-test"}, args...)
	return flags, run()
}

func TestCleanupCommandDefaultsToDryRun(t *testing.T) {
	flags, err := invokeCleanupArguments(t)
	if err == nil || err.Error() != "owner, expected-username and manifest are required" {
		t.Fatalf("missing identity did not stop before database setup: %v", err)
	}
	apply := flags.Lookup("apply")
	if apply == nil || apply.DefValue != "false" || apply.Value.String() != "false" {
		t.Fatal("cleanup requires explicit opt-in to apply")
	}
}

func TestCleanupCommandRequiresExactOwnerUsernameAndManifestBeforeDatabase(t *testing.T) {
	const owner = "11111111-1111-4111-8111-111111111111"
	for _, test := range []struct {
		name string
		args []string
	}{
		{"owner_missing", []string{"--expected-username", "synthetic-owner", "--manifest", "unused.fixture"}},
		{"owner_not_uuid", []string{"--owner", "synthetic-owner", "--expected-username", "synthetic-owner", "--manifest", "unused.fixture"}},
		{"owner_nil_uuid", []string{"--owner", "00000000-0000-0000-0000-000000000000", "--expected-username", "synthetic-owner", "--manifest", "unused.fixture"}},
		{"username_missing", []string{"--owner", owner, "--manifest", "unused.fixture"}},
		{"manifest_missing", []string{"--owner", owner, "--expected-username", "synthetic-owner"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := invokeCleanupArguments(t, test.args...)
			if err == nil || err.Error() != "owner, expected-username and manifest are required" {
				t.Fatalf("invalid arguments reached a later stage: %v", err)
			}
		})
	}
}

func TestCleanupCommandRejectsApplyWithoutMatchingConfirmationAndDigestBeforeDatabase(t *testing.T) {
	const owner = "11111111-1111-4111-8111-111111111111"
	base := []string{"--owner", owner, "--expected-username", "synthetic-owner", "--manifest", "unused.fixture", "--apply"}
	for _, test := range []struct {
		name string
		args []string
	}{
		{"confirm_and_digest_missing", nil},
		{"different_owner", []string{"--confirm-owner", "22222222-2222-4222-8222-222222222222", "--expected-digest", strings.Repeat("a", 64)}},
		{"confirm_missing", []string{"--expected-digest", strings.Repeat("a", 64)}},
		{"digest_missing", []string{"--confirm-owner", owner}},
		{"digest_too_short", []string{"--confirm-owner", owner, "--expected-digest", strings.Repeat("a", 63)}},
		{"digest_too_long", []string{"--confirm-owner", owner, "--expected-digest", strings.Repeat("a", 65)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			args := append(append([]string(nil), base...), test.args...)
			flags, err := invokeCleanupArguments(t, args...)
			if err == nil || err.Error() != "apply requires exact confirm-owner and expected-digest" {
				t.Fatalf("unconfirmed apply reached a later stage: %v", err)
			}
			if flags.Lookup("apply").Value.String() != "true" {
				t.Fatal("apply validation was not exercised")
			}
		})
	}
}
