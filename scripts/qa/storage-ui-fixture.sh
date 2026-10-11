#!/usr/bin/env bash
# Explicit local-only browser data. Source the reusable cloud activate.sh first.
set -euo pipefail
umask 077
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if [ "${CLARIN_STORAGE_UI_QA:-}" != 1 ]; then
  echo 'Set CLARIN_STORAGE_UI_QA=1 after selecting the local cloud environment.' >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo 'Usage: storage-ui-fixture.sh create|age-trash|verify|cleanup [--label purge] [--expect restore=active,purge=purged]' >&2
  exit 1
fi
qa_action="$1"
shift
qa_manifest="${CLARIN_STORAGE_UI_QA_MANIFEST:-$repo_root/work/storage-ui-qa/fixture.private.json}"
cd "$repo_root/backend"
go run ./cmd/storage-ui-qa --action "$qa_action" --manifest "$qa_manifest" --assets "$repo_root/tests/fixtures/storage" "$@"
