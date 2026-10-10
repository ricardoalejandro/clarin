#!/usr/bin/env bash
# Disposable native PostgreSQL/MinIO integration. Never reads deployment .env.
set -euo pipefail

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
trap cleanup EXIT INT TERM

# Fixed loopback-only ports are also asserted by the integration fixture.
# An occupied port fails startup; this script never stops unrelated services.
docker run --detach --rm --name "$qa_postgres" \
  --publish 127.0.0.1:15439:5432 \
  --env POSTGRES_USER=storageqa --env "POSTGRES_PASSWORD=$qa_password" \
  --env POSTGRES_DB=program_survey_integrity_test postgres:16-alpine >/dev/null
docker run --detach --rm --name "$qa_redis" \
  --publish 127.0.0.1:16379:6379 redis:7-alpine >/dev/null
# Build the exact official source revision; retired container tags are not a
# reliable test dependency. Go verifies the source using the public checksum DB.
if [ -z "$qa_minio_binary" ]; then
  GOBIN="$qa_temp" go install github.com/minio/minio@v0.0.0-20250422221226-0d7408fc9969
  qa_minio_binary="$qa_temp/minio"
fi
"$qa_minio_binary" --version
MINIO_ROOT_USER=storageqa MINIO_ROOT_PASSWORD="$qa_minio_password" MINIO_UPDATE=off \
  "$qa_minio_binary" server "$qa_temp/data" --address 127.0.0.1:19001 \
  --console-address 127.0.0.1:19002 >"$qa_temp/minio.log" 2>&1 &
qa_minio_pid=$!

qa_ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$qa_minio_pid" 2>/dev/null; then
    echo 'Disposable MinIO process failed to start.' >&2
    exit 1
  fi
  if docker exec "$qa_postgres" pg_isready --username storageqa --dbname program_survey_integrity_test >/dev/null 2>&1 \
    && docker exec "$qa_redis" redis-cli ping | grep -q PONG \
    && curl --fail --silent http://127.0.0.1:19001/minio/health/live >/dev/null; then
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

export DATABASE_URL="postgres://storageqa:$qa_password@127.0.0.1:15439/program_survey_integrity_test?sslmode=disable"
export MINIO_ENDPOINT=127.0.0.1:19001
export MINIO_ACCESS_KEY=storageqa
export MINIO_SECRET_KEY="$qa_minio_password"
export MINIO_BUCKET=clarin-qa-storage-self-service
export MINIO_PUBLIC_URL=http://127.0.0.1:19001
export MINIO_USE_SSL=false
export CLARIN_STORAGE_QA_REDIS_URL=redis://127.0.0.1:16379/0
export CLARIN_RUN_STORAGE_SELF_SERVICE_INTEGRATION=1
unset CLARIN_STORAGE_QA_PGLITE
cd "$repo_root/backend"
go test -count=1 -timeout=10m -run '^TestStorageSelfServiceIntegration$' -v ./internal/api
docker exec "$qa_postgres" createdb --username storageqa clarin_storage_qa
export DATABASE_URL="postgres://storageqa:$qa_password@127.0.0.1:15439/clarin_storage_qa?sslmode=disable"
CLARIN_RUN_STORAGE_SELF_SERVICE_SQL_INTEGRATION=1 go test -count=1 -timeout=5m -run '^TestStorageSelfServiceSQLIntegration$' -v ./internal/api
docker exec "$qa_postgres" createdb --username storageqa clarin_storage_guard_qa
export DATABASE_URL="postgres://storageqa:$qa_password@127.0.0.1:15439/clarin_storage_guard_qa?sslmode=disable"
export CLARIN_RUN_STORAGE_REFERENCE_GUARD_INTEGRATION=1
go test -count=1 -timeout=5m -run '^TestStorageReferenceGuardIntegration$' -v ./pkg/database
if [ "${CLARIN_RUN_STORAGE_SELF_SERVICE_PERFORMANCE:-}" = 1 ]; then
  export DATABASE_URL="postgres://storageqa:$qa_password@127.0.0.1:15439/program_survey_integrity_test?sslmode=disable"
  go test -count=1 -timeout=60m -run '^TestStorageSelfServicePerformance$' -v ./internal/api
fi
