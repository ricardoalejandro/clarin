#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
candidate_root="$project_root/.runtime/offline/v3-candidate"
candidate_version="3.0.0"
candidate_origin="https://clarin.naperu.cloud"
candidate_build="$(mktemp -d /tmp/clarin-offline-v3-build.XXXXXXXX)"
cleanup_candidate_build() {
  if [[ "$candidate_build" == /tmp/clarin-offline-v3-build.* && -d "$candidate_build" ]]; then
    rm -rf -- "$candidate_build"
  fi
}
trap cleanup_candidate_build EXIT
mkdir -p "$candidate_build/bin" "$candidate_root"

(
  cd "$project_root/desktop/agent"
  GOCACHE=/tmp/go-build-agent GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w -X main.serviceVersion=$candidate_version -X main.configuredOrigin=$candidate_origin" \
    -o "$candidate_build/bin/clarin-offline-service.exe" ./cmd/clarin-offline-service
  GOCACHE=/tmp/go-build-agent GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w -H=windowsgui" \
    -o "$candidate_build/bin/clarin-offline-principal.exe" ./cmd/clarin-offline-principal
)

docker build -t clarin-offline-nsis:bookworm -f "$project_root/infra/offline/Dockerfile.nsis" "$project_root/infra/offline"
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$project_root/infra/offline,dst=/source,readonly" \
  --mount "type=bind,src=$candidate_build,dst=/build" \
  clarin-offline-nsis:bookworm -V3 -DINPUT_DIR=/build/bin \
  -DOUTPUT_FILE=/build/Clarin-Offline-Setup.exe -DVERSION="$candidate_version" /source/offline-v3.nsi

# A candidate is deliberately separate from the public/downloaded installer.
# Only the release gate may promote these exact bytes after real Windows QA.
cp "$candidate_build/Clarin-Offline-Setup.exe" "$candidate_root/Clarin-Offline-Setup.exe"
cp "$project_root/infra/offline/Test-OfflineV3.ps1" "$candidate_root/Test-OfflineV3.ps1"
node "$project_root/scripts/offline/candidate-manifest.mjs" "$candidate_root" "$candidate_version" "$candidate_build/bin"
echo "Candidato generado (NO publicado ni aprobado para Windows): $candidate_root"
