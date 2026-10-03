#!/usr/bin/env bash
set -euo pipefail

directory=${1:?Deployment directory is required}
sha=${2:?Commit SHA is required}
repository=${3:?Repository is required}
[[ $directory == /* && $sha =~ ^[0-9a-f]{40}$ && $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 1
cd -- "$directory"
for command in git node docker curl flock cmp timeout; do
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
flock -w 5 9 || { echo 'Another deployment holds the server lock.' >&2; exit 1; }

git fetch --no-tags origin main
if [[ $(git rev-parse origin/main) != "$sha" ]]; then
  echo 'Skipped: a newer main commit is available; only the latest requested revision may deploy.'
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

# Images are prepared and loaded before main is pushed. This path never builds
# or downloads images; reject an incomplete release before changing the checkout.
release="$PWD/.runtime/deploy/releases/$sha"
[[ -f "$release/ready" && $(< "$release/ready") == "$sha" ]] || {
  echo 'No prepared release for this commit. Run release-prepare and release-stage before pushing main.' >&2
  exit 1
}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
# Use the helper from the exact fetched main commit, not executable release data.
git show "$sha:scripts/deploy/release-manifest.mjs" > "$temporary/release-manifest.mjs"
node "$temporary/release-manifest.mjs" check-images "$release/manifest.json" "$sha"
node "$temporary/release-manifest.mjs" compose "$release/manifest.json" "$sha" > "$temporary/compose.json"
version=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$release/manifest.json")
git merge --ff-only "$sha"

# Check required values without printing the rendered configuration or secrets.
docker compose -f docker-compose.yml -f "$temporary/compose.json" config --format json | node -e '
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
    // The native installer has an independent signed-artifact release. Never
    // activate the fast path while it would silently bypass artifact preparation.
    if (String(config.services?.backend?.environment?.OFFLINE_V3_ENABLED) === "true") {
      console.error("Native offline v3 needs its separate artifact deployment; fast activation is unavailable.");
      missing = true;
    }
    if (missing) process.exitCode = 1;
  });
'

# Updating the existing proxy routes does not compile or restart application data.
node scripts/offline/install-browser-proxy.mjs
# Leave time for runtime verification within the remote 210-second budget.
timeout --signal=TERM --kill-after=5s 120s docker compose \
  -f docker-compose.yml -f "$temporary/compose.json" up -d --no-build --pull never \
  offline-signer codex-bridge backend task-preview-worker frontend

ready=false
health_deadline=$((SECONDS + 60))
while (( SECONDS < health_deadline )); do
  if docker exec clarin-backend wget -T 5 -qO- http://127.0.0.1:8080/health > /dev/null \
    && curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3001/login -o /dev/null; then
    running_version=$(docker exec clarin-backend wget -T 5 -qO- http://127.0.0.1:8080/api/version | node -e '
      let body = "";
      process.stdin.on("data", chunk => { body += chunk; });
      process.stdin.on("end", () => { console.log(JSON.parse(body).version || ""); });
    ') || running_version=''
    if [[ $running_version == "$version" ]]; then ready=true; break; fi
  fi
  sleep 2
done
[[ $ready == true ]] || {
  echo 'Activation failed health/version verification. No database rollback was attempted.' >&2
  exit 1
}
node "$temporary/release-manifest.mjs" check-running "$release/manifest.json" "$sha"
docker ps --filter name=clarin --format '{{.Names}}\t{{.Status}}'
for container in clarin-backend clarin-frontend; do
  docker logs --tail=80 "$container" > "$temporary/logs" 2>&1
  failures=0
  while IFS= read -r line; do
    if [[ $line =~ (panic:|FATAL|fatal\ error) ]]; then failures=$((failures + 1)); fi
  done < "$temporary/logs"
  printf '%s: %s fatal entries in recent logs.\n' "$container" "$failures"
  if (( failures > 0 )); then
    echo 'Activation failed recent-log verification.' >&2
    exit 1
  fi
done
printf '%s\n' "$sha" > .runtime/deploy/last-successful.sha
printf 'Prepared release activated and verified: %s\n' "$sha"
