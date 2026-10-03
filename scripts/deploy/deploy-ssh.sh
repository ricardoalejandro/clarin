#!/usr/bin/env bash
set -euo pipefail

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
[[ $GITHUB_REPOSITORY =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid repository.' >&2; exit 1; }

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
remote_script="$script_directory/deploy-on-server.sh"
if [[ ${DEPLOY_PREBUILT:-0} == 1 ]]; then
  remote_script="$script_directory/activate-on-server.sh"
fi
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
printf -v remote_command 'bash -s -- %q %q %q' "$directory" "$GITHUB_SHA" "$GITHUB_REPOSITORY"
if [[ ${DEPLOY_PREBUILT:-0} == 1 ]]; then
  remote_command="timeout --signal=TERM --kill-after=5s 210s $remote_command"
fi
ssh -T -p "$port" -i "$key_directory/key" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$key_directory/known_hosts" \
  -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 \
  "$DEPLOY_USER@$DEPLOY_HOST" "$remote_command" < "$remote_script"
