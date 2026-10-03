#!/usr/bin/env bash
set -euo pipefail

bundle=${1:?Usage: stage-release.sh <release-bundle-directory>}
[[ $# == 1 ]] || { echo 'Expected one release bundle directory.' >&2; exit 1; }
for name in DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY GITHUB_SHA GITHUB_REPOSITORY; do
  if [[ -z ${!name:-} ]]; then
    printf 'Missing configuration: %s\n' "$name" >&2
    exit 1
  fi
done
port=${DEPLOY_PORT:-22}
directory=${DEPLOY_PATH:-/root/proyect/clarin}
[[ $DEPLOY_HOST =~ ^[A-Za-z0-9][A-Za-z0-9.:-]*$ ]] || { echo 'Invalid SSH host.' >&2; exit 1; }
[[ $DEPLOY_USER =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || { echo 'Invalid SSH user.' >&2; exit 1; }
[[ $port =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { echo 'Invalid SSH port.' >&2; exit 1; }
[[ $directory == /* && $directory != *$'\n'* && $directory != *$'\r'* ]] || { echo 'Deployment path must be absolute.' >&2; exit 1; }
[[ $GITHUB_SHA =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA.' >&2; exit 1; }
[[ $GITHUB_REPOSITORY =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || { echo 'Invalid repository.' >&2; exit 1; }
for command in node sha256sum tar ssh ssh-keygen; do
  command -v "$command" > /dev/null || { printf 'Missing staging command: %s\n' "$command" >&2; exit 1; }
done
bundle=$(cd -P -- "$bundle" && pwd)
for file in manifest.json images.tar; do
  [[ -f $bundle/$file && ! -L $bundle/$file ]] || { printf 'Missing regular bundle file: %s\n' "$file" >&2; exit 1; }
done
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node "$script_directory/release-manifest.mjs" validate "$bundle/manifest.json" "$GITHUB_SHA"
expected_checksum=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).archiveSha256)' "$bundle/manifest.json")
actual_checksum=$(sha256sum "$bundle/images.tar")
[[ ${actual_checksum%% *} == "$expected_checksum" ]] || { echo 'Release archive checksum does not match the manifest.' >&2; exit 1; }

key_directory=$(mktemp -d)
trap 'rm -rf "$key_directory"' EXIT
chmod 700 "$key_directory"
printf '%s\n' "$DEPLOY_SSH_KEY" > "$key_directory/key"
if [[ -n ${DEPLOY_KNOWN_HOSTS:-} ]]; then
  printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$key_directory/known_hosts"
else
  cp "$script_directory/known_hosts" "$key_directory/known_hosts"
fi
chmod 600 "$key_directory/key" "$key_directory/known_hosts"
ssh-keygen -y -P '' -f "$key_directory/key" > /dev/null

# Only these four files enter the remote staging directory. The receiving script
# loads immutable images and publishes their manifest; it never activates them.
bootstrap='set -euo pipefail
directory=$1
sha=$2
repository=$3
umask 077
mkdir -p -- "$directory/.runtime/deploy/staging"
incoming=$(mktemp -d "$directory/.runtime/deploy/staging/.incoming.XXXXXXXX")
trap '\''rm -rf -- "$incoming"'\'' EXIT
tar --no-same-owner --no-same-permissions -xf - -C "$incoming"
bash "$incoming/stage-release-on-server.sh" "$directory" "$sha" "$repository" "$incoming"'
printf -v remote_command 'bash -c %q -- %q %q %q' "$bootstrap" "$directory" "$GITHUB_SHA" "$GITHUB_REPOSITORY"
tar -C "$bundle" -cf - manifest.json images.tar \
  -C "$script_directory" release-manifest.mjs stage-release-on-server.sh \
  | ssh -T -p "$port" -i "$key_directory/key" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$key_directory/known_hosts" \
    -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 \
    "$DEPLOY_USER@$DEPLOY_HOST" "$remote_command"
