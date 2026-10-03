#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd -- "$script_directory/../.." && pwd)
cd -- "$repository_root"
for command in git node docker tar sha256sum mktemp; do
  command -v "$command" > /dev/null || { printf 'Missing build command: %s\n' "$command" >&2; exit 1; }
done
[[ $# -le 2 ]] || { echo 'Usage: prepare-release.sh [commit-sha] [output-directory]' >&2; exit 1; }
commit=${1:-$(git rev-parse HEAD)}
[[ $commit =~ ^[0-9a-f]{40}$ && $(git rev-parse HEAD) == "$commit" ]] || { echo 'Prepare the full SHA currently checked out at HEAD.' >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=all) ]] || { echo 'Release preparation requires a clean checkout, including untracked source files.' >&2; exit 1; }
[[ ${OFFLINE_V3_ENABLED:-false} != true ]] || { echo 'The offline V3 pilot requires separate artifact preparation; this release builder will not omit that preparation.' >&2; exit 1; }
output=${2:-"$repository_root/../work/clarin-releases/$commit"}
output=$(node --input-type=module -e 'import { resolve } from "node:path"; process.stdout.write(resolve(process.argv[1]));' "$output")
[[ ! -e $output ]] || { echo 'Release output already exists; preserve it or choose another output directory.' >&2; exit 1; }
# Buildx metadata needs a writable location; preserve Docker registry settings.
export BUILDX_CONFIG=${BUILDX_CONFIG:-"$repository_root/../work/clarin-qa/buildx"}
mkdir -p -- "$BUILDX_CONFIG" "$(dirname -- "$output")"
temporary=$(mktemp -d "$(dirname -- "$output")/.clarin-release-$commit.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
mkdir -p "$temporary/source" "$temporary/release"
# Build only committed source. Ignored .env files, credentials, caches and local
# generated assets never enter the Docker contexts or alter the release SHA.
git archive "$commit" | tar -x -C "$temporary/source"
cp "$temporary/source/CHANGELOG.md" "$temporary/source/backend/CHANGELOG.md"
version=$(bash "$repository_root/version.sh")
[[ $version == *"-${commit:0:12}" ]] || { echo 'Generated build version does not identify this commit.' >&2; exit 1; }
common=(--platform linux/amd64 --label "org.opencontainers.image.revision=$commit" --label "org.opencontainers.image.version=$version")
# Keep Docker's configured build proxies. The outer environment's proxy host
# may not resolve inside containers and must not override Docker's defaults.
build_ca=${CODEX_PROXY_CERT:-${CLARIN_BUILD_CA_FILE:-}}
if [[ -n $build_ca ]]; then
  [[ -f $build_ca && -f /etc/ssl/certs/ca-certificates.crt ]] || { echo 'The configured Docker build CA files do not exist.' >&2; exit 1; }
  common+=(--secret "id=proxy_ca,src=$build_ca" --secret id=system_ca,src=/etc/ssl/certs/ca-certificates.crt)
fi
declare -A tags
for name in backend frontend offline-signer codex-bridge; do tags[$name]="clarin-release/$name:$commit"; done
printf 'Preparing immutable application images for %s.\n' "$commit"
docker build "${common[@]}" --build-arg "BUILD_VERSION=$version" -t "${tags[backend]}" -f "$temporary/source/deploy/Dockerfile.backend" "$temporary/source/backend"
docker build "${common[@]}" --build-arg "BUILD_VERSION=$version" \
  --build-arg NEXT_PUBLIC_API_URL=https://clarin.naperu.cloud \
  --build-arg NEXT_PUBLIC_WS_URL=wss://clarin.naperu.cloud \
  --build-arg NEXT_PUBLIC_APP_URL=https://clarin.naperu.cloud \
  --build-arg NEXT_PUBLIC_MARKETING_URL=https://landing.clarin.naperu.cloud \
  -t "${tags[frontend]}" -f "$temporary/source/deploy/Dockerfile.frontend" "$temporary/source/frontend"
docker build "${common[@]}" -t "${tags[offline-signer]}" -f "$temporary/source/deploy/Dockerfile.offline-signer" "$temporary/source/offline-signer"
docker build "${common[@]}" -t "${tags[codex-bridge]}" -f "$temporary/source/deploy/Dockerfile.codex-bridge" "$temporary/source/codex-bridge"
docker image inspect "${tags[backend]}" "${tags[frontend]}" "${tags[offline-signer]}" "${tags[codex-bridge]}" > "$temporary/images.json"
docker image save -o "$temporary/release/images.tar" "${tags[backend]}" "${tags[frontend]}" "${tags[offline-signer]}" "${tags[codex-bridge]}"
checksum=$(sha256sum "$temporary/release/images.tar")
checksum=${checksum%% *}
node --input-type=module - "$script_directory/release-manifest.mjs" "$temporary/images.json" "$temporary/release/manifest.json" "$commit" "$version" "$checksum" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [helperPath, inspectionsPath, outputPath, commit, version, archiveSha256] = process.argv.slice(2);
const { imageNames, validateManifest, verifyImageInspections } = await import(pathToFileURL(helperPath).href);
const inspections = JSON.parse(readFileSync(inspectionsPath, 'utf8'));
const manifest = {
  format: 1, commit, version, platform: 'linux/amd64', archiveSha256,
  images: Object.fromEntries(imageNames.map((name, index) => [name, { tag: `clarin-release/${name}:${commit}`, id: inspections[index]?.Id }])),
};
validateManifest(manifest, commit);
verifyImageInspections(manifest, inspections);
writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
NODE
# Reject source edits made while the build ran. The isolated contexts still
# identify the original commit, but a changed checkout must be reviewed first.
[[ $(git rev-parse HEAD) == "$commit" && -z $(git status --porcelain --untracked-files=all) ]] || { echo 'Checkout changed during release preparation; no release bundle was published.' >&2; exit 1; }
mv -- "$temporary/release" "$output"
printf 'Release prepared: %s\nNo containers were started or uploaded.\n' "$output"
