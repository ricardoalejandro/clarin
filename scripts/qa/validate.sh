#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workspace_root="$(cd "$repo_root/.." && pwd)"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$workspace_root/work/clarin-qa/browsers}"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/qa/validate.sh check
  bash scripts/qa/validate.sh baseline
  bash scripts/qa/validate.sh browser tests/chat-attention.spec.ts --project=chromium [--grep=pattern] [--list]

check     Inspect baseline prerequisites and optional Playwright browsers; change nothing.
baseline  Run backend, signer, bridge, deployment, frontend unit, type and build checks.
browser   Run only explicitly selected local specs and projects, with bounded defaults.
          Accepts repeated files/projects, --grep=, --grep-invert= and --list.
          Live, laboratory and example specs require their separate workflows.
USAGE
}

fail() { printf 'QA: %s\n' "$*" >&2; exit 1; }

check_node_dependencies() {
  command -v node >/dev/null || fail 'Node.js >= 24 is required.'
  node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' \
    || fail 'Node.js >= 24 is required.'
  command -v npm >/dev/null || fail 'npm is required.'
  for binary in next tsc vitest; do
    [[ -x "$repo_root/frontend/node_modules/.bin/$binary" ]] \
      || fail "Missing frontend dependency: $binary. Run npm --prefix frontend ci first."
  done
  [[ -x "$repo_root/node_modules/.bin/playwright" ]] \
    || fail 'Missing root Playwright dependency. Run npm ci first.'
  printf 'Node: %s\n' "$(node --version)"
  printf 'Root and frontend dependency executables: available\n'
}

check_go() {
  # Managed environments may have a placeholder /usr/bin/go. Prefer their real toolchain.
  if [[ -x "$workspace_root/.tools/go/bin/go" ]]; then
    export PATH="$workspace_root/.tools/go/bin:$PATH"
  elif [[ -x "$repo_root/.tools/go/bin/go" ]]; then
    export PATH="$repo_root/.tools/go/bin:$PATH"
  fi
  command -v go >/dev/null || fail 'Install the Go toolchain declared in backend/go.mod first.'
  export GOTOOLCHAIN=local
  local actual required version_output
  version_output="$(go version)" || fail 'Cannot execute the Go toolchain.'
  [[ "$version_output" =~ ^go\ version\ go([0-9]+\.[0-9]+(\.[0-9]+)?)\  ]] \
    || fail 'go version did not identify a real Go toolchain.'
  actual="${BASH_REMATCH[1]}"
  required="$(awk '$1 == "toolchain" { sub(/^go/, "", $2); print $2; exit }' "$repo_root/backend/go.mod")"
  if [[ -z "$required" ]]; then
    required="$(awk '$1 == "go" { print $2; exit }' "$repo_root/backend/go.mod")"
  fi
  node - "$actual" "$required" <<'NODE' || fail "Go $required or newer is required; found $actual."
const [actual, required] = process.argv.slice(2).map(value => value.split('.').map(Number));
if (!required.length || required.some(Number.isNaN)) process.exit(1);
for (let i = 0; i < 3; i++) {
  if ((actual[i] || 0) > (required[i] || 0)) process.exit(0);
  if ((actual[i] || 0) < (required[i] || 0)) process.exit(1);
}
NODE
  printf 'Go: %s (%s)\n' "$actual" "$(command -v go)"
}

check_browsers() {
  # Informational only: baseline never needs or installs browser binaries.
  (cd "$repo_root" && node --input-type=module <<'NODE'
import { accessSync, constants } from 'node:fs';
import { chromium, firefox, webkit } from '@playwright/test';
for (const [name, browser] of Object.entries({ chromium, firefox, webkit })) {
  try { accessSync(browser.executablePath(), constants.X_OK); console.log(`Playwright ${name}: installed`); }
  catch { console.log(`Playwright ${name}: not installed (optional for baseline)`); }
}
NODE
  ) || fail 'Cannot load the installed root @playwright/test package.'
  if [[ -x /usr/bin/chromium ]]; then
    printf 'System Chromium: available at /usr/bin/chromium (used by the browser runner)\n'
  fi
}

mode="${1:-check}"
if (( $# )); then shift; fi
case "$mode" in
  -h|--help|help) usage; exit 0 ;;
  check|baseline)
    (( $# == 0 )) || fail "$mode does not accept additional arguments."
    check_node_dependencies
    check_go
    if [[ "$mode" == check ]]; then check_browsers; exit 0; fi

    cache_root="$workspace_root/work/clarin-qa"
    export GOCACHE="$cache_root/go-build" GOMODCACHE="$cache_root/go-mod" GOPATH="$cache_root/gopath"
    mkdir -p "$GOCACHE" "$GOMODCACHE" "$GOPATH"
    # A persistent environment must not silently opt into live/database suites absent in CI.
    while IFS= read -r variable_name; do
      unset "$variable_name"
    done < <(compgen -A variable CLARIN_RUN_)
    unset CLARIN_LIVE_REPORT_TEST CLARIN_TEST_OFFICIAL_EXCALIDRAW_LIBRARY
    unset OFFLINE_V3_TEST_DATABASE_URL OFFLINE_V4_TEST_DATABASE_URL OFFLINE_V5_TEST_DATABASE_URL
    cd "$repo_root"
    printf 'Running QA baseline for the current checkout. Validate the final commit before pushing.\n'
    (cd backend && go test ./...)
    (cd offline-signer && go test ./...)
    npm --prefix codex-bridge test
    node --test scripts/deploy/*.test.mjs scripts/qa/validate.test.mjs
    npm --prefix frontend run prepare:excalidraw
    # Unit fixtures expect same-origin API paths, matching the clean CI environment.
    NEXT_PUBLIC_API_URL='' npm --prefix frontend run test:unit
    npm --prefix frontend run typecheck
    npm --prefix frontend run build
    git diff --check
    printf 'QA baseline passed. Browser coverage must be selected separately for the affected modules.\n'
    ;;
  browser)
    specs=() projects=() options=()
    for arg in "$@"; do
      case "$arg" in
        --project=*)
          case "${arg#--project=}" in
            chromium|firefox|webkit|responsive-desktop|responsive-firefox|responsive-webkit|responsive-mobile-chrome|responsive-mobile-safari)
              projects+=("$arg") ;;
            *) fail "Select a concrete configured project: $arg" ;;
          esac
          ;;
        --list|--grep=?*|--grep-invert=?*) options+=("$arg") ;;
        tests/*.spec.ts)
          [[ "$arg" =~ ^tests/[A-Za-z0-9_-]+\.spec\.ts$ && -f "$repo_root/$arg" ]] \
            || fail "Select an existing spec directly under tests/: $arg"
          case "$arg" in
            *live*|tests/reaction-*.spec.ts|tests/example.spec.ts|tests/offline-*.spec.ts|tests/pwa-runtime-recovery.spec.ts)
              fail "This spec requires a separate live/laboratory workflow: $arg" ;;
          esac
          # Playwright treats positional paths as regular expressions. Anchor the exact file.
          specs+=("${arg//./\\.}\$")
          ;;
        *) fail "Unsupported browser argument: $arg. See --help." ;;
      esac
    done
    (( ${#specs[@]} > 0 && ${#projects[@]} > 0 )) \
      || fail 'browser requires explicit spec files AND at least one --project=name.'
    check_node_dependencies
    cd "$repo_root"
    export CI=1 PLAYWRIGHT_LOCAL_SERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3011
    export CLARIN_E2E_BASE_URL=http://127.0.0.1:3011 CLARIN_E2E_MOCK_AUTH=1
    # Same-origin API requests remain interceptable by mocks; Next's rewrite fallback is local.
    export NEXT_PUBLIC_API_URL=''
    export CLARIN_E2E_LIVE=0 CLARIN_E2E_LIVE_OFFLINE=0 CLARIN_E2E_LIVE_WHITEBOARDS=0
    unset CLARIN_E2E_USERNAME CLARIN_E2E_PASSWORD CLARIN_E2E_ACCOUNT
    if [[ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" && -x /usr/bin/chromium ]]; then
      export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
    fi
    exec "$repo_root/node_modules/.bin/playwright" test "${specs[@]}" "${projects[@]}" "${options[@]}" \
      --retries=0 --workers=2 --max-failures=1 --reporter=list
    ;;
  *) usage >&2; fail "Unknown mode: $mode" ;;
esac
