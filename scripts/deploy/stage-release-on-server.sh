#!/usr/bin/env bash
set -euo pipefail

directory=${1:?Deployment directory is required}
sha=${2:?Commit SHA is required}
repository=${3:?Repository is required}
incoming=${4:?Incoming release directory is required}
[[ $# == 4 && $directory == /* && $directory != *$'\n'* && $directory != *$'\r'* \
  && $sha =~ ^[0-9a-f]{40}$ && $repository =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || exit 1
for command in git node docker flock sha256sum cmp realpath; do
  command -v "$command" > /dev/null || { printf 'Missing server command: %s\n' "$command" >&2; exit 1; }
done
cd -P -- "$directory"
[[ $(git rev-parse --show-toplevel) == "$PWD" ]] || { echo 'Deployment directory is not the repository root.' >&2; exit 1; }
staging_root=$(realpath -- .runtime/deploy/staging)
incoming=$(realpath -e -- "$incoming")
[[ -d $incoming && ${incoming%/*} == "$staging_root" && ${incoming##*/} == .incoming.* ]] \
  || { echo 'Incoming release must be a temporary staging directory.' >&2; exit 1; }
trap 'rm -rf -- "$incoming"' EXIT
origin=$(git remote get-url origin)
case "$origin" in
  "https://github.com/$repository"|"https://github.com/$repository.git"|"git@github.com:$repository.git"|"ssh://git@github.com/$repository.git") ;;
  *) echo 'Server origin does not match the release repository.' >&2; exit 1 ;;
esac
for file in manifest.json images.tar release-manifest.mjs; do
  [[ -f $incoming/$file && ! -L $incoming/$file ]] || { printf 'Missing regular incoming file: %s\n' "$file" >&2; exit 1; }
done

# Share the activation lock without changing its checkout or running containers.
exec 9> "$(git rev-parse --git-path clarin-deploy.lock)"
flock -w 120 9 || { echo 'Another release operation holds the server lock.' >&2; exit 1; }
node "$incoming/release-manifest.mjs" validate "$incoming/manifest.json" "$sha"
expected_checksum=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).archiveSha256)' "$incoming/manifest.json")
actual_checksum=$(sha256sum "$incoming/images.tar")
[[ ${actual_checksum%% *} == "$expected_checksum" ]] || { echo 'Release archive checksum does not match the manifest.' >&2; exit 1; }

mkdir -p .runtime/deploy/releases
release="$PWD/.runtime/deploy/releases/$sha"
if [[ -e $release || -L $release ]]; then
  [[ -d $release && ! -L $release && -f $release/ready && ! -L $release/ready \
    && $(< "$release/ready") == "$sha" && -f $release/manifest.json && ! -L $release/manifest.json ]] \
    || { echo 'Existing release is incomplete or incompatible; it was preserved.' >&2; exit 1; }
  cmp -s "$incoming/manifest.json" "$release/manifest.json" \
    || { echo 'An incompatible manifest already exists for this commit; it was preserved.' >&2; exit 1; }
  if node "$incoming/release-manifest.mjs" check-images "$release/manifest.json" "$sha" > /dev/null 2>&1; then
    printf 'Release already staged: %s\n' "$sha"
    exit 0
  fi
fi

docker load -i "$incoming/images.tar" > /dev/null \
  || { echo 'Release image loading failed; no release was published.' >&2; exit 1; }
node "$incoming/release-manifest.mjs" check-images "$incoming/manifest.json" "$sha"
if [[ ! -e $release ]]; then
  # Build the complete directory first, then rename it on the same filesystem.
  # Readers cannot observe a ready marker before all four images are verified.
  rm -- "$incoming/images.tar" "$incoming/stage-release-on-server.sh"
  chmod 644 "$incoming/manifest.json" "$incoming/release-manifest.mjs"
  printf '%s\n' "$sha" > "$incoming/ready"
  mv -T -- "$incoming" "$release"
fi
printf 'Release staged without activation: %s\n' "$sha"
