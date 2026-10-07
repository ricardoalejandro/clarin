#!/usr/bin/env bash
set -euo pipefail
qa_root=/root/clarin-integrity-qa-20261007
test "$(realpath "$qa_root")" = "$qa_root"
cd "$qa_root"
set -a
source .qa-env
source .qa-test-env
set +a
if ! docker exec clarin-integrity-qa-20261007-postgres-1 psql -U qa -d postgres -At -c "SELECT 1 FROM pg_database WHERE datname='clarin_device_deletion_test'" | grep -q '^1$'; then
  docker exec clarin-integrity-qa-20261007-postgres-1 createdb -U qa clarin_device_deletion_test
fi
export DEVICE_DELETION_TEST_DATABASE_URL="postgres://qa:${QA_POSTGRES_PASSWORD}@127.0.0.1:15439/clarin_device_deletion_test?sslmode=disable"
export CLARIN_RUN_DEVICE_DELETION_INTEGRATION=1 GOCACHE=/tmp/go-build GOMAXPROCS=2 GOTELEMETRY=off
cd candidate/backend
go test ./pkg/database -run TestDeviceDeletionDurableIsolationAndMigration -count=1
