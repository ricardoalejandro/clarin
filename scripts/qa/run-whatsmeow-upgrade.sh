#!/usr/bin/env bash
# Run against an EMPTY disposable PostgreSQL database named
# clarin_whatsmeow_upgrade_qa_<suffix>, never production or a live session clone.
# Pass its URL through CLARIN_WHATSMEOW_QA_DATABASE_URL (never a CLI argument).
# Requires Go with toolchain download available. Leaves the QA database intact.
# No WhatsApp client is instantiated; the fixture performs SQL operations only.
set -euo pipefail

: "${CLARIN_WHATSMEOW_QA_DATABASE_URL:?Set the dedicated QA database URL}"
qa_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/whatsmeow-upgrade/main.go"
qa_tmp="$(mktemp -d "${TMPDIR:-/tmp}/clarin-whatsmeow-upgrade.XXXXXX")"
trap 'rm -rf -- "$qa_tmp"' EXIT

mkdir "$qa_tmp/old" "$qa_tmp/new"
cat > "$qa_tmp/old/go.mod" <<'EOF'
module clarin-whatsmeow-upgrade-qa

go 1.25.0

require (
    github.com/jackc/pgx/v5 v5.7.2
    go.mau.fi/whatsmeow v0.0.0-20260709092057-73fe7355f59f
)
EOF
cat > "$qa_tmp/new/go.mod" <<'EOF'
module clarin-whatsmeow-upgrade-qa

go 1.26.0

require (
    github.com/jackc/pgx/v5 v5.7.2
    go.mau.fi/whatsmeow v0.0.0-20261017175727-b2b1e71d45e2
)
EOF

(cd "$qa_tmp/old" && GOTOOLCHAIN=go1.25.14 go run -mod=mod "$qa_source" seed-v14)
(cd "$qa_tmp/new" && GOTOOLCHAIN=go1.27.2 go run -mod=mod "$qa_source" upgrade-v16)
(cd "$qa_tmp/old" && GOTOOLCHAIN=go1.25.14 go run -mod=readonly "$qa_source" old-store-v16)

printf '%s\n' 'PASS: 14 -> 16 -> old store succeeded without restoring data or lowering the schema version.'
