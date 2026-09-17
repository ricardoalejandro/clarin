#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf -- "$build_dir"' EXIT

mkdir -p "$build_dir/app/resources/bin" "$project_root/.runtime/offline/artifacts"

(
  cd "$project_root/desktop/agent"
  GOCACHE=/tmp/go-build-agent GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "$build_dir/app/resources/bin/clarin-offline-agent.exe" ./cmd/clarin-offline-agent
)

docker run --rm \
  --mount "type=bind,src=$project_root/desktop/app,dst=/source,readonly" \
  --mount "type=bind,src=$build_dir/app,dst=/work" \
  --workdir /work \
  electronuserland/builder:wine \
  bash -lc 'cp -a /source/. /work/ && npm ci && npm run check && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:win'

installer="$(find "$build_dir/app/dist" -maxdepth 1 -type f -name 'Clarin-Offline-Setup-*.exe' -print -quit)"
if [[ -z "$installer" || ! -s "$installer" ]]; then
  echo "No se generó el instalador de Clarin Offline" >&2
  exit 1
fi

published="$project_root/.runtime/offline/artifacts/Clarin-Offline-Setup.exe"
cp "$installer" "$published"
sha256sum "$published" | awk '{print $1}' > "$published.sha256"
echo "Instalador publicado: $published"
echo "SHA-256: $(tr -d '\r\n' < "$published.sha256")"
