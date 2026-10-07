#!/usr/bin/env bash
set -euo pipefail
qa_root=/root/clarin-integrity-qa-20261007
test "$(realpath "$qa_root")" = "$qa_root"
cd "$qa_root"
install -d -m 700 candidate
tar -xzf qa-candidate.tar.gz -C candidate
set -a
source .qa-test-env
set +a
export GOCACHE=/tmp/go-build GOMAXPROCS=2 GOTELEMETRY=off
cd candidate/backend
go test -p 2 ./internal/repository ./internal/api ./internal/whatsapp ./internal/service ./pkg/database -run 'TestProgramDeleteIntegrity|TestSurveyTemplateSnapshotIntegrity|TestContactHistoryIntegrity|TestObservationCursor|TestQuotes|TestQuote|TestContactFailure' -count=1
