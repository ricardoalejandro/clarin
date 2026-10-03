import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const serverScript = fileURLToPath(new URL('./activate-on-server.sh', import.meta.url))
const sshScript = fileURLToPath(new URL('./deploy-ssh.sh', import.meta.url))
const helperPath = fileURLToPath(new URL('./release-manifest.mjs', import.meta.url))
const knownHostsPath = fileURLToPath(new URL('./known_hosts', import.meta.url))
const sha = 'a'.repeat(40)
const repository = 'ricardoalejandro/clarin'
const version = `2026.10.03-1-123456-${sha.slice(0, 12)}`
const imageNames = ['backend', 'frontend', 'offline-signer', 'codex-bridge']

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clarin-activate-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const release = join(root, '.runtime/deploy/releases', sha)
  for (const directory of [bin, release, join(root, '.git'), join(root, 'backend'), join(root, 'scripts/offline')]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(root, 'CHANGELOG.md'), 'current changelog\n')
  writeFileSync(join(root, 'backend/CHANGELOG.md'), 'tracked build changelog\n')
  writeFileSync(join(release, 'ready'), `${sha}\n`)
  const manifest = {
    format: 1, commit: sha, version, platform: 'linux/amd64', archiveSha256: 'e'.repeat(64),
    images: Object.fromEntries(imageNames.map((name, index) => [name, {
      tag: `clarin-release/${name}:${sha}`, id: `sha256:${String(index + 1).repeat(64)}`,
    }])),
  }
  writeFileSync(join(release, 'manifest.json'), JSON.stringify(manifest))
  const inspections = {
    images: imageNames.map(name => ({ Id: manifest.images[name].id, Os: 'linux', Architecture: 'amd64', Config: { Labels: {
      'org.opencontainers.image.revision': sha, 'org.opencontainers.image.version': version,
    } } })),
    containers: [...imageNames, 'task-preview-worker'].map(name => ({
      Name: `/clarin-${name}`, State: { Running: true }, Image: manifest.images[name === 'task-preview-worker' ? 'backend' : name].id,
    })),
  }
  writeFileSync(join(root, 'docker-fixture.json'), JSON.stringify(inspections))
  writeFileSync(join(root, 'scripts/offline/install-browser-proxy.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.TEST_ROOT + '/calls', 'proxy\\n');\n`)
  // Advance the shell's monotonic deadline at its first retry. This executes the
  // original health/version loop without waiting 60 seconds on a deliberate failure.
  const clock = join(root, 'clock.sh')
  writeFileSync(clock, 'sleep() { printf "sleep %s\\n" "$*" >> "$TEST_ROOT/calls"; SECONDS=$health_deadline; }\n')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANG: 'C', BASH_ENV: clock,
    TEST_ROOT: root, TEST_SHA: sha, TEST_VERSION: version, TEST_MANIFEST_HELPER: helperPath, ...overrides }
  const executable = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 })
  executable('git', `
    printf 'git %s\\n' "$*" >> "$TEST_ROOT/calls"
    case "$*" in
      'rev-parse --show-toplevel') printf '%s\\n' "$TEST_ROOT" ;;
      'remote get-url origin') echo 'https://github.com/ricardoalejandro/clarin.git' ;;
      'branch --show-current') echo main ;;
      'rev-parse --git-path clarin-deploy.lock') echo "$TEST_ROOT/.git/clarin-deploy.lock" ;;
      'fetch --no-tags origin main') exit 0 ;;
      'rev-parse origin/main') echo "\${TEST_LATEST_SHA:-$TEST_SHA}" ;;
      'diff --quiet -- backend/CHANGELOG.md') exit 0 ;;
      'status --porcelain --untracked-files=no')
        if [[ \${TEST_DIRTY:-0} == 1 ]]; then echo ' M unrelated.go'; fi ;;
      "show $TEST_SHA:scripts/deploy/release-manifest.mjs") cat "$TEST_MANIFEST_HELPER" ;;
      "merge --ff-only $TEST_SHA") exit "\${TEST_MERGE_EXIT:-0}" ;;
      *) echo 'Unexpected git command' >&2; exit 1 ;;
    esac`)
  executable('flock', 'exit "${TEST_LOCK_EXIT:-0}"')
  executable('make', 'printf "make %s\\n" "$*" >> "$TEST_ROOT/calls"; exit 97')
  executable('timeout', `
    printf 'timeout %s\\n' "$*" >> "$TEST_ROOT/calls"
    [[ "$1" == --signal=TERM && "$2" == --kill-after=5s && "$3" == 120s ]] || exit 96
    shift 3
    exec "$@"`)
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const root = process.env.TEST_ROOT;
const args = process.argv.slice(2);
appendFileSync(root + '/calls', 'docker ' + args.join(' ') + '\\n');
const fixture = JSON.parse(readFileSync(root + '/docker-fixture.json', 'utf8'));
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') {
  const index = ${JSON.stringify(imageNames)}.indexOf(process.env.TEST_WRONG_LOCAL_IMAGE);
  if (index >= 0) fixture.images[index].Id = 'sha256:' + 'f'.repeat(64);
  output(fixture.images);
} else if (args[0] === 'container' && args[1] === 'inspect') {
  for (const item of fixture.containers) {
    if (item.Name === '/clarin-' + process.env.TEST_WRONG_RUNNING_IMAGE) item.Image = 'sha256:' + 'f'.repeat(64);
    if (item.Name === '/clarin-' + process.env.TEST_STOPPED_SERVICE) item.State.Running = false;
  }
  output(fixture.containers);
} else if (args[0] === 'compose' && args.includes('config')) {
  const services = { backend: { environment: { DATABASE_URL: 'test-only', JWT_SECRET: 'test-only', ADMIN_PASSWORD: 'test-only', MINIO_SECRET_KEY: 'test-only', OFFLINE_V3_ENABLED: process.env.TEST_NATIVE_V3 === '1' ? 'true' : 'false' } }, postgres: { environment: { POSTGRES_PASSWORD: 'test-only' } }, minio: { environment: { MINIO_ROOT_PASSWORD: 'test-only' } }, 'codex-bridge': { environment: { EROS_CODEX_BRIDGE_TOKEN: 'test-only' } } };
  if (process.env.TEST_MISSING_SECRETS === '1') delete services.backend.environment.JWT_SECRET;
  output({ services });
} else if (args[0] === 'compose' && args.includes('up')) {
  const files = args.flatMap((arg, index) => arg === '-f' ? [args[index + 1]] : []);
  writeFileSync(root + '/activated-compose.json', readFileSync(files[1]));
  process.exit(Number(process.env.TEST_UP_EXIT || 0));
} else if (args[0] === 'exec' && args.at(-1) === 'http://127.0.0.1:8080/health') {
  output({ status: 'ok' });
} else if (args[0] === 'exec' && args.at(-1) === 'http://127.0.0.1:8080/api/version') {
  output({ version: process.env.TEST_RUNNING_VERSION || process.env.TEST_VERSION });
} else if (args[0] === 'logs') {
  console.log(process.env.TEST_FATAL_LOG === args.at(-1) ? 'panic: simulated application failure' : 'application ready');
} else if (args[0] === 'ps') {
  console.log('clarin-backend Up (healthy)');
} else {
  console.error('Unexpected Docker command');
  process.exit(95);
}
`, { mode: 0o755 })
  executable('curl', 'printf "curl %s\\n" "$*" >> "$TEST_ROOT/calls"; exit 0')
  executable('ssh-keygen', 'exit 0')
  executable('ssh', `
    printf '%s\\n' "$@" > "$TEST_ROOT/ssh-arguments"
    while (( $# )); do
      if [[ $1 == -i ]]; then shift; printf '%s\\n' "$1" > "$TEST_ROOT/key-path"; fi
      if [[ $1 == UserKnownHostsFile=* ]]; then cat "\${1#UserKnownHostsFile=}" > "$TEST_ROOT/ssh-known-hosts"; fi
      shift
    done
    cat > "$TEST_ROOT/remote-script"`)
  return {
    root, release, env, manifest,
    run: () => spawnSync('bash', [serverScript, root, sha, repository], { cwd: root, env, encoding: 'utf8', timeout: 10_000 }),
    calls: () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : '',
    lastSuccess: () => existsSync(join(root, '.runtime/deploy/last-successful.sha')),
  }
}

test('preloaded immutable images activate all five services without building, downloading or loading images', t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.root, '.runtime/deploy/last-successful.sha'), 'utf8'), `${sha}\n`)
  const override = JSON.parse(readFileSync(join(f.root, 'activated-compose.json'), 'utf8'))
  assert.deepEqual(Object.keys(override.services).sort(), [...imageNames, 'task-preview-worker'].sort())
  for (const service of [...imageNames, 'task-preview-worker']) {
    const image = f.manifest.images[service === 'task-preview-worker' ? 'backend' : service].id
    assert.equal(override.services[service].image, image)
    assert.equal(override.services[service].pull_policy, 'never')
  }
  assert.match(f.calls(), /up -d --no-build --pull never offline-signer codex-bridge backend task-preview-worker frontend/)
  assert.match(f.calls(), /docker container inspect clarin-backend clarin-frontend clarin-offline-signer clarin-codex-bridge clarin-task-preview-worker/)
  assert.match(f.calls(), new RegExp(`git show ${sha}:scripts/deploy/release-manifest\\.mjs`))
  assert.doesNotMatch(f.calls(), /(?:^|\n)make |docker (?:build|pull|load|image (?:build|pull|load))\b/)
  assert.equal(readFileSync(join(f.root, 'backend/CHANGELOG.md'), 'utf8'), 'tracked build changelog\n')
})

test('an absent or mismatched ready marker stops activation before checkout or containers change', t => {
  for (const ready of [undefined, 'b'.repeat(40)]) {
    const f = fixture(t)
    if (ready === undefined) rmSync(join(f.release, 'ready'))
    else writeFileSync(join(f.release, 'ready'), ready)
    const result = f.run()
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /No prepared release/)
    assert.doesNotMatch(f.calls(), /git merge|docker |proxy/)
    assert.equal(f.lastSuccess(), false)
  }
})

test('a tag resolving to the wrong local image ID is rejected before updating main or starting services', t => {
  const f = fixture(t, { TEST_WRONG_LOCAL_IMAGE: 'frontend' })
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /image identity or platform mismatch: frontend/)
  assert.doesNotMatch(f.calls(), /git merge|docker compose|proxy/)
  assert.equal(f.lastSuccess(), false)
})

for (const service of ['frontend', 'task-preview-worker']) {
  test(`a healthy backend cannot certify ${service} running a different image`, t => {
    const f = fixture(t, { TEST_WRONG_RUNNING_IMAGE: service })
    const result = f.run()
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, new RegExp(`stopped or serving a different image: clarin-${service}`))
    assert.match(f.calls(), /docker container inspect/)
    assert.equal(f.lastSuccess(), false)
  })
}

test('a stopped signer prevents successful activation even when HTTP checks pass', t => {
  const f = fixture(t, { TEST_STOPPED_SERVICE: 'offline-signer' })
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /stopped or serving a different image: clarin-offline-signer/)
  assert.equal(f.lastSuccess(), false)
})

test('the complete runtime version must match the manifest even when its commit suffix matches', t => {
  const f = fixture(t, { TEST_RUNNING_VERSION: `2026.10.03-1-654321-${sha.slice(0, 12)}` })
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Activation failed health\/version verification/)
  assert.match(f.calls(), /\/api\/version/)
  assert.doesNotMatch(f.calls(), /docker container inspect|docker logs/)
  assert.equal(f.lastSuccess(), false)
})

test('a failed compose activation stops runtime verification and does not record success', t => {
  const f = fixture(t, { TEST_UP_EXIT: '23' })
  const result = f.run()
  assert.equal(result.status, 23, result.stderr)
  assert.doesNotMatch(f.calls(), /docker exec|docker container inspect|docker logs|curl /)
  assert.equal(f.lastSuccess(), false)
})

test('an outdated workflow skips release inspection, checkout changes and activation', t => {
  const f = fixture(t, { TEST_LATEST_SHA: 'b'.repeat(40) })
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Skipped: a newer main commit/)
  assert.doesNotMatch(f.calls(), /git show|git merge|docker |proxy/)
  assert.equal(f.lastSuccess(), false)
})

test('missing production configuration stops before proxy changes or compose activation', t => {
  const f = fixture(t, { TEST_MISSING_SECRETS: '1' })
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Missing production configuration: backend.JWT_SECRET/)
  assert.doesNotMatch(f.calls(), /proxy| up -d|docker exec/)
  assert.equal(f.lastSuccess(), false)
})

test('native offline v3 cannot silently bypass its signed artifact deployment through fast activation', t => {
  const f = fixture(t, { TEST_NATIVE_V3: '1' })
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Native offline v3 needs its separate artifact deployment/)
  assert.doesNotMatch(f.calls(), /proxy| up -d|docker exec/)
  assert.equal(f.lastSuccess(), false)
})

test('fatal recent application logs prevent recording a successful release', t => {
  const f = fixture(t, { TEST_FATAL_LOG: 'clarin-frontend' })
  const result = f.run()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Activation failed recent-log verification/)
  assert.equal(f.lastSuccess(), false)
})

test('prebuilt SSH transfers the activation script with its 210-second budget, pinned identity and key cleanup', t => {
  const f = fixture(t)
  const env = { ...f.env, DEPLOY_PREBUILT: '1', DEPLOY_HOST: '72.61.37.46', DEPLOY_USER: 'root',
    DEPLOY_PATH: f.root, DEPLOY_SSH_KEY: 'test-only-key', GITHUB_SHA: sha, GITHUB_REPOSITORY: repository }
  delete env.DEPLOY_KNOWN_HOSTS
  const result = spawnSync('bash', [sshScript], { env, encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
  const args = readFileSync(join(f.root, 'ssh-arguments'), 'utf8')
  assert.match(args, /timeout --signal=TERM --kill-after=5s 210s bash -s --/)
  assert.match(args, /StrictHostKeyChecking=yes/)
  assert.match(args, /BatchMode=yes/)
  assert.equal(readFileSync(join(f.root, 'remote-script'), 'utf8'), readFileSync(serverScript, 'utf8'))
  assert.equal(readFileSync(join(f.root, 'ssh-known-hosts'), 'utf8'), readFileSync(knownHostsPath, 'utf8'))
  assert.equal(existsSync(readFileSync(join(f.root, 'key-path'), 'utf8').trim()), false)
})
