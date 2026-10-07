#!/usr/bin/env bash
set -euo pipefail
qa_root=/root/clarin-integrity-qa-20261007
test "$(realpath "$qa_root")" = "$qa_root"
cd "$qa_root"
umask 077
if [ ! -e .qa-env ]; then
  printf 'QA_POSTGRES_PASSWORD=%s\nQA_MINIO_PASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .qa-env
fi
if ! grep -q '^QA_JWT_SECRET=' .qa-env; then
  printf 'QA_JWT_SECRET=%s\nQA_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" >> .qa-env
fi
docker compose --env-file .qa-env -f docker-compose.integrity-qa.yml up -d --wait postgres redis minio
set -a
source .qa-env
set +a
printf 'INTEGRITY_TEST_DATABASE_URL=postgres://qa:%s@127.0.0.1:15439/program_survey_integrity_test?sslmode=disable\nDATABASE_URL=postgres://qa:%s@127.0.0.1:15439/program_survey_integrity_test?sslmode=disable\n' "$QA_POSTGRES_PASSWORD" "$QA_POSTGRES_PASSWORD" > .qa-test-env
printf 'REDIS_URL=redis://127.0.0.1:16389\nMINIO_ENDPOINT=127.0.0.1:19001\nMINIO_ACCESS_KEY=integrityqa\nMINIO_SECRET_KEY=%s\nMINIO_BUCKET=clarin-integrity-qa\nMINIO_USE_SSL=false\nMINIO_PUBLIC_URL=http://127.0.0.1:19001\n' "$QA_MINIO_PASSWORD" >> .qa-test-env
printf 'Isolated PostgreSQL 16, Redis and MinIO ready; private credentials saved.\n'
