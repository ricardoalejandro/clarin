#!/usr/bin/env bash
set -euo pipefail

directory=${1:?Deployment directory is required}
sha=${2:?Commit SHA is required}
repository=${3:?Repository is required}
[[ $directory == /* && $sha =~ ^[0-9a-f]{40}$ && $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 1
cd -- "$directory"
for command in git make node docker curl flock cmp; do
  command -v "$command" > /dev/null || { printf 'Missing server command: %s\n' "$command" >&2; exit 1; }
done
[[ $(git rev-parse --show-toplevel) == "$PWD" ]] || { echo 'Deployment directory is not the repository root.' >&2; exit 1; }
origin=$(git remote get-url origin)
case "$origin" in
  "https://github.com/$repository"|"https://github.com/$repository.git"|"git@github.com:$repository.git"|"ssh://git@github.com/$repository.git") ;;
  *) echo 'Server origin does not match the workflow repository.' >&2; exit 1 ;;
esac
[[ $(git branch --show-current) == main ]] || { echo 'Server checkout must be on main.' >&2; exit 1; }
exec 9> "$(git rev-parse --git-path clarin-deploy.lock)"
flock -w 120 9 || { echo 'Another deployment holds the server lock.' >&2; exit 1; }

git fetch --no-tags origin main
if [[ $(git rev-parse origin/main) != "$sha" ]]; then
  echo 'Skipped: a newer main commit is available; only the latest tested revision may deploy.'
  exit 0
fi

# make deploy copies the root changelog into this tracked build-context file.
# Recover only that proven generated copy; never discard other server edits.
if ! git diff --quiet -- backend/CHANGELOG.md && cmp -s CHANGELOG.md backend/CHANGELOG.md; then
  git restore --source=HEAD -- backend/CHANGELOG.md
fi
if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  echo 'Deployment stopped: the server contains tracked local changes.' >&2
  exit 1
fi
git merge --ff-only "$sha"

# Validate without emitting rendered credentials or overwriting the server .env.
docker compose config --format json | node -e '
  let body = "";
  process.stdin.on("data", chunk => { body += chunk; });
  process.stdin.on("end", () => {
    const config = JSON.parse(body);
    const requirements = {
      backend: ["DATABASE_URL", "JWT_SECRET", "ADMIN_PASSWORD", "MINIO_SECRET_KEY"],
      postgres: ["POSTGRES_PASSWORD"], minio: ["MINIO_ROOT_PASSWORD"],
      "codex-bridge": ["EROS_CODEX_BRIDGE_TOKEN"],
    };
    let missing = false;
    for (const [service, names] of Object.entries(requirements)) {
      for (const name of names) {
        if (!config.services?.[service]?.environment?.[name]) {
          console.error(`Missing production configuration: ${service}.${name}`);
          missing = true;
        }
      }
    }
    if (missing) process.exitCode = 1;
  });
'

temporary=$(mktemp -d)
cp backend/CHANGELOG.md "$temporary/changelog"
cleanup() {
  if cmp -s CHANGELOG.md backend/CHANGELOG.md; then
    cp "$temporary/changelog" backend/CHANGELOG.md
  fi
  rm -rf "$temporary"
}
trap cleanup EXIT
make deploy

short_sha=$(git rev-parse --short=12 "$sha")
ready=false
for (( attempt=1; attempt<=30; attempt++ )); do
  if docker exec clarin-backend wget -qO- http://127.0.0.1:8080/health > /dev/null \
    && curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3001/login -o /dev/null; then
    version=$(docker exec clarin-backend wget -qO- http://127.0.0.1:8080/api/version | node -e '
      let body = "";
      process.stdin.on("data", chunk => { body += chunk; });
      process.stdin.on("end", () => { console.log(JSON.parse(body).version || ""); });
    ') || version=''
    if [[ $version == *"-$short_sha" ]]; then
      ready=true
      break
    fi
  fi
  sleep 2
done
docker ps --filter name=clarin --format '{{.Names}}\t{{.Status}}'

# Inspect logs locally and report counts; application logs may contain private data.
for container in clarin-backend clarin-frontend; do
  docker logs --tail=80 "$container" > "$temporary/logs" 2>&1
  failures=0
  while IFS= read -r line; do
    if [[ $line =~ (panic:|FATAL|fatal\ error) ]]; then failures=$((failures + 1)); fi
  done < "$temporary/logs"
  printf '%s: %s fatal entries in recent logs.\n' "$container" "$failures"
  if (( failures > 0 )); then ready=false; fi
done
if [[ $ready != true ]]; then
  echo 'Deployment failed health/version verification. Review the server; no database rollback was attempted.' >&2
  exit 1
fi
mkdir -p .runtime/deploy
printf '%s\n' "$sha" > .runtime/deploy/last-successful.sha
printf 'Deployment verified: %s\n' "$sha"
