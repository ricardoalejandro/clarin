#!/usr/bin/env bash
# Disposable native PostgreSQL/MinIO integration. Never reads deployment .env.
set -euo pipefail

# QA starts separate disposable services on a different range from the
# reusable Clarín environment and never reuses its database or object data.
export CLARIN_STORAGE_QA_POSTGRES_PORT="${CLARIN_STORAGE_QA_POSTGRES_PORT:-25439}"
export CLARIN_STORAGE_QA_REDIS_PORT="${CLARIN_STORAGE_QA_REDIS_PORT:-26379}"
export CLARIN_STORAGE_QA_MINIO_PORT="${CLARIN_STORAGE_QA_MINIO_PORT:-29001}"
export CLARIN_STORAGE_QA_MINIO_CONSOLE_PORT="${CLARIN_STORAGE_QA_MINIO_CONSOLE_PORT:-29002}"
declare -A qa_seen_ports=()
for qa_port_variable in CLARIN_STORAGE_QA_POSTGRES_PORT CLARIN_STORAGE_QA_REDIS_PORT CLARIN_STORAGE_QA_MINIO_PORT CLARIN_STORAGE_QA_MINIO_CONSOLE_PORT; do
  qa_port="${!qa_port_variable}"
  if [[ ! "$qa_port" =~ ^[1-9][0-9]{3,4}$ ]] || (( qa_port < 1024 || qa_port > 65535 )); then
    printf '%s must be an unprivileged TCP port from 1024 to 65535.\n' "$qa_port_variable" >&2
    exit 1
  fi
  if [ -n "${qa_seen_ports[$qa_port]:-}" ]; then
    echo 'Storage QA requires four different local TCP ports.' >&2
    exit 1
  fi
  qa_seen_ports[$qa_port]=1
done

for qa_command in docker go curl openssl; do
  if ! command -v "$qa_command" >/dev/null 2>&1; then
    printf 'Storage QA requires %s in PATH. Prepare a Linux environment with Docker, Go 1.25+, curl and openssl.\n' "$qa_command" >&2
    exit 1
  fi
done
# The fixture connects to loopback, so a remote Docker context is never valid.
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST=unix:///var/run/docker.sock
if ! docker info >/dev/null 2>&1; then
  printf 'Storage QA requires an accessible Docker daemon; installing the Docker client alone is insufficient.\n' >&2
  exit 1
fi

# Prepared environments can reuse an official binary without downloading MinIO
# again. Require its independently verified checksum before creating resources.
qa_minio_binary="${CLARIN_QA_MINIO_BINARY:-}"
if [ -n "$qa_minio_binary" ]; then
  if [ ! -x "$qa_minio_binary" ] || ! command -v sha256sum >/dev/null 2>&1 \
    || [[ ! "${CLARIN_QA_MINIO_SHA256:-}" =~ ^[a-fA-F0-9]{64}$ ]] \
    || ! printf '%s  %s\n' "$CLARIN_QA_MINIO_SHA256" "$qa_minio_binary" | sha256sum --check --status; then
    echo 'Prepared MinIO requires an executable and its verified CLARIN_QA_MINIO_SHA256.' >&2
    exit 1
  fi
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
qa_id="clarin-storage-qa-$(date +%s)-$$"
qa_postgres="${qa_id}-postgres"
qa_redis="${qa_id}-redis"
qa_temp=$(mktemp -d -t clarin-storage-qa.XXXXXX)
qa_minio_pid=''
qa_password=$(openssl rand -hex 24)
qa_minio_password=$(openssl rand -hex 24)

cleanup() {
  if [ -n "$qa_minio_pid" ]; then
    kill "$qa_minio_pid" >/dev/null 2>&1 || true
    wait "$qa_minio_pid" 2>/dev/null || true
  fi
  docker rm -f "$qa_postgres" >/dev/null 2>&1 || true
  docker rm -f "$qa_redis" >/dev/null 2>&1 || true
  rm -rf "$qa_temp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Configured loopback-only ports are also asserted by the integration fixture.
# An occupied port fails startup; this script never stops unrelated services,
# shares persistent volumes or reads the deployment .env.
docker run --detach --rm --name "$qa_postgres" \
  --publish "127.0.0.1:$CLARIN_STORAGE_QA_POSTGRES_PORT:5432" \
  --env POSTGRES_USER=storageqa --env "POSTGRES_PASSWORD=$qa_password" \
  --env POSTGRES_DB=program_survey_integrity_test postgres:16-alpine >/dev/null
docker run --detach --rm --name "$qa_redis" \
  --publish "127.0.0.1:$CLARIN_STORAGE_QA_REDIS_PORT:6379" redis:7-alpine >/dev/null
# Build the exact official source revision; retired container tags are not a
# reliable test dependency. Go verifies the source using the public checksum DB.
if [ -z "$qa_minio_binary" ]; then
  GOBIN="$qa_temp" go install github.com/minio/minio@v0.0.0-20250422221226-0d7408fc9969
  qa_minio_binary="$qa_temp/minio"
fi
"$qa_minio_binary" --version
MINIO_ROOT_USER=storageqa MINIO_ROOT_PASSWORD="$qa_minio_password" MINIO_UPDATE=off \
  "$qa_minio_binary" server "$qa_temp/data" --address "127.0.0.1:$CLARIN_STORAGE_QA_MINIO_PORT" \
  --console-address "127.0.0.1:$CLARIN_STORAGE_QA_MINIO_CONSOLE_PORT" >"$qa_temp/minio.log" 2>&1 &
qa_minio_pid=$!

qa_ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$qa_minio_pid" 2>/dev/null; then
    echo 'Disposable MinIO process failed to start.' >&2
    exit 1
  fi
  if docker exec "$qa_postgres" pg_isready --username storageqa --dbname program_survey_integrity_test >/dev/null 2>&1 \
    && docker exec "$qa_redis" redis-cli ping | grep -q PONG \
    && curl --fail --silent "http://127.0.0.1:$CLARIN_STORAGE_QA_MINIO_PORT/minio/health/live" >/dev/null; then
    qa_ready=1
    break
  fi
  sleep 1
done
if [ "$qa_ready" -ne 1 ]; then
  echo 'Disposable storage QA services did not become ready.' >&2
  exit 1
fi
docker exec "$qa_postgres" postgres --version
docker exec "$qa_redis" redis-server --version

export DATABASE_URL="postgres://storageqa:$qa_password@127.0.0.1:$CLARIN_STORAGE_QA_POSTGRES_PORT/program_survey_integrity_test?sslmode=disable"
export MINIO_ENDPOINT="127.0.0.1:$CLARIN_STORAGE_QA_MINIO_PORT"
export MINIO_ACCESS_KEY=storageqa
export MINIO_SECRET_KEY="$qa_minio_password"
export MINIO_BUCKET="clarin-qa-$qa_id"
export MINIO_PUBLIC_URL="http://127.0.0.1:$CLARIN_STORAGE_QA_MINIO_PORT"
export MINIO_USE_SSL=false
export CLARIN_STORAGE_QA_REDIS_URL="redis://127.0.0.1:$CLARIN_STORAGE_QA_REDIS_PORT/0"
export CLARIN_RUN_STORAGE_SELF_SERVICE_INTEGRATION=1
unset CLARIN_STORAGE_QA_PGLITE
cd "$repo_root/backend"
go test -count=1 -timeout=15m -run '^TestStorageSelfService(Integration|MultiOriginIntegration|ResourceACLIntegration|OrphansIntegration|IndexIntegration)$' -v ./internal/api
# Exercise the real preview publication lock helper against PostgreSQL too;
# its temporary schema is isolated from the service fixtures below.
go test -count=1 -timeout=1m -run '^TestTaskPreviewPublicationConcurrencyIntegration$' -v ./internal/taskpreview
docker exec "$qa_postgres" createdb --username storageqa clarin_storage_qa
export DATABASE_URL="postgres://storageqa:$qa_password@127.0.0.1:$CLARIN_STORAGE_QA_POSTGRES_PORT/clarin_storage_qa?sslmode=disable"
CLARIN_RUN_STORAGE_SELF_SERVICE_SQL_INTEGRATION=1 go test -count=1 -timeout=5m -run '^TestStorageSelfServiceSQLIntegration$' -v ./internal/api
docker exec "$qa_postgres" createdb --username storageqa clarin_storage_guard_qa
export DATABASE_URL="postgres://storageqa:$qa_password@127.0.0.1:$CLARIN_STORAGE_QA_POSTGRES_PORT/clarin_storage_guard_qa?sslmode=disable"
export CLARIN_RUN_STORAGE_REFERENCE_GUARD_INTEGRATION=1
go test -count=1 -timeout=5m -run '^TestStorageReferenceGuardIntegration$' -v ./pkg/database
# Avatar GC shares the same media lifecycle. This database belongs only to
# this ephemeral PostgreSQL container; no reusable workspace database is read.
INTEGRITY_TEST_DATABASE_URL="postgres://storageqa:$qa_password@127.0.0.1:$CLARIN_STORAGE_QA_POSTGRES_PORT/program_survey_integrity_test?sslmode=disable" \
  CLARIN_RUN_CONTACT_MEDIA_INTEGRATION=1 go test -count=1 -timeout=5m -run '^TestContactAvatar' -v ./internal/repository
if [ "${CLARIN_RUN_STORAGE_SELF_SERVICE_PERFORMANCE:-}" = 1 ]; then
  export DATABASE_URL="postgres://storageqa:$qa_password@127.0.0.1:$CLARIN_STORAGE_QA_POSTGRES_PORT/program_survey_integrity_test?sslmode=disable"
  go test -count=1 -timeout=60m -run '^TestStorageSelfServicePerformance$' -v ./internal/api
fi
