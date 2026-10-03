import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const serverScript = fileURLToPath(new URL('./deploy-on-server.sh', import.meta.url))
const sshScript = fileURLToPath(new URL('./deploy-ssh.sh', import.meta.url))
const sha = 'a'.repeat(40)
const repository = 'ricardoalejandro/clarin'

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clarin-deploy-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'backend'))
  writeFileSync(join(root, 'CHANGELOG.md'), 'current changelog\n')
  writeFileSync(join(root, 'backend', 'CHANGELOG.md'), 'tracked build changelog\n')
  const executable = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 })
  const env = { PATH: `${bin}:${process.env.PATH}`, LANG: 'C', TEST_ROOT: root, TEST_SHA: sha, ...overrides }
  executable('git', `
    printf 'git %s\\n' "$*" >> "$TEST_ROOT/calls"
    case "$*" in
      'rev-parse --show-toplevel') printf '%s\\n' "$TEST_ROOT" ;;
      'remote get-url origin') echo 'https://github.com/ricardoalejandro/clarin.git' ;;
      'branch --show-current') echo main ;;
      'rev-parse --git-path clarin-deploy.lock') echo "$TEST_ROOT/.git/clarin-deploy.lock" ;;
      'rev-parse origin/main') echo "\${TEST_LATEST_SHA:-$TEST_SHA}" ;;
      'status --porcelain --untracked-files=no')
        if [[ \${TEST_DIRTY:-0} == 1 ]]; then echo ' M unrelated.go'; fi
        if [[ \${TEST_GENERATED:-0} == 1 && ! -e "$TEST_ROOT/restored" ]]; then echo ' M backend/CHANGELOG.md'; fi ;;
      'rev-parse --short=12 '*) echo "\${TEST_SHA:0:12}" ;;
      'diff --quiet -- backend/CHANGELOG.md')
        if [[ \${TEST_GENERATED:-0} == 1 && ! -e "$TEST_ROOT/restored" ]]; then exit 1; fi ;;
      'restore --source=HEAD -- backend/CHANGELOG.md')
        printf 'tracked build changelog\\n' > backend/CHANGELOG.md
        touch "$TEST_ROOT/restored" ;;
      'fetch --no-tags origin main') exit 0 ;;
      'merge --ff-only '*) exit "\${TEST_MERGE_EXIT:-0}" ;;
      *) echo 'Unexpected git command' >&2; exit 1 ;;
    esac`)
  executable('flock', 'exit "${TEST_LOCK_EXIT:-0}"')
  executable('make', `
    echo make >> "$TEST_ROOT/calls"
    cp CHANGELOG.md backend/CHANGELOG.md
    exit "\${TEST_MAKE_EXIT:-0}"`)
  executable('docker', `
    printf 'docker %s\\n' "$*" >> "$TEST_ROOT/calls"
    case "$*" in
      'compose config --format json')
        if [[ \${TEST_MISSING_SECRET:-0} == 1 ]]; then echo '{"services":{}}';
        else echo '{"services":{"backend":{"environment":{"DATABASE_URL":"test-only","JWT_SECRET":"test-only","ADMIN_PASSWORD":"test-only","MINIO_SECRET_KEY":"test-only"}},"postgres":{"environment":{"POSTGRES_PASSWORD":"test-only"}},"minio":{"environment":{"MINIO_ROOT_PASSWORD":"test-only"}},"codex-bridge":{"environment":{"EROS_CODEX_BRIDGE_TOKEN":"test-only"}}}}'; fi ;;
      'exec clarin-backend wget -qO- http://127.0.0.1:8080/health') echo '{"status":"ok"}' ;;
      'exec clarin-backend wget -qO- http://127.0.0.1:8080/api/version')
        printf '{"version":"2026.10.02-1-123456-%s"}\\n' "\${TEST_VERSION_SHA:-\${TEST_SHA:0:12}}" ;;
      'logs --tail=80 '*) echo 'application ready' ;;
      'ps --filter name=clarin '*) echo 'clarin-backend Up (healthy)' ;;
      *) echo 'Unexpected docker command' >&2; exit 1 ;;
    esac`)
  executable('curl', 'exit 0')
  executable('sleep', 'exit 0')
  executable('ssh-keygen', 'exit 0')
  executable('ssh', `
    printf '%s\\n' "$@" > "$TEST_ROOT/ssh-arguments"
    while (( $# )); do
      if [[ $1 == -i ]]; then shift; printf '%s\\n' "$1" > "$TEST_ROOT/key-path"; fi
      shift
    done
    cat > "$TEST_ROOT/remote-script"`)
  return {
    root, env,
    run: () => spawnSync('bash', [serverScript, root, sha, repository], { env, encoding: 'utf8' }),
    calls: () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : '',
  }
}

test('a successful deployment verifies the exact commit and restores generated changelog state', t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.root, '.runtime/deploy/last-successful.sha'), 'utf8'), `${sha}\n`)
  assert.equal(readFileSync(join(f.root, 'backend/CHANGELOG.md'), 'utf8'), 'tracked build changelog\n')
  assert.match(f.calls(), /git merge --ff-only a{40}/)
  assert.match(f.calls(), /docker logs --tail=80 clarin-frontend/)
})

test('an outdated workflow never deploys or changes the checkout', t => {
  const f = fixture(t, { TEST_LATEST_SHA: 'b'.repeat(40) })
  assert.equal(f.run().status, 0)
  assert.doesNotMatch(f.calls(), /make|git merge/)
})

test('tracked server edits are preserved and stop the deployment', t => {
  const f = fixture(t, { TEST_DIRTY: '1' })
  assert.equal(f.run().status, 1)
  assert.doesNotMatch(f.calls(), /make|git merge|git restore/)
})

test('only an exact generated changelog copy is recovered before updating the checkout', t => {
  const f = fixture(t, { TEST_GENERATED: '1' })
  writeFileSync(join(f.root, 'backend/CHANGELOG.md'), 'current changelog\n')
  assert.equal(f.run().status, 0)
  assert.match(f.calls(), /git restore --source=HEAD -- backend\/CHANGELOG.md/)
  assert.equal(readFileSync(join(f.root, 'backend/CHANGELOG.md'), 'utf8'), 'tracked build changelog\n')
})

test('a changelog containing different local edits is not discarded', t => {
  const f = fixture(t, { TEST_GENERATED: '1' })
  writeFileSync(join(f.root, 'backend/CHANGELOG.md'), 'user change\n')
  assert.equal(f.run().status, 1)
  assert.doesNotMatch(f.calls(), /git restore|make/)
  assert.equal(readFileSync(join(f.root, 'backend/CHANGELOG.md'), 'utf8'), 'user change\n')
})

test('a server branch that cannot fast-forward is never rebuilt', t => {
  const f = fixture(t, { TEST_MERGE_EXIT: '1' })
  assert.equal(f.run().status, 1)
  assert.doesNotMatch(f.calls(), /make/)
})

test('the server lock prevents a concurrent deployment', t => {
  const f = fixture(t, { TEST_LOCK_EXIT: '1' })
  assert.equal(f.run().status, 1)
  assert.doesNotMatch(f.calls(), /make|git merge/)
})

test('missing production credentials fail before make deploy', t => {
  const f = fixture(t, { TEST_MISSING_SECRET: '1' })
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing production configuration: backend.JWT_SECRET/)
  assert.doesNotMatch(f.calls(), /\nmake\n/)
})

test('a failed build stops health verification and restores only the generated file', t => {
  const f = fixture(t, { TEST_MAKE_EXIT: '23' })
  assert.equal(f.run().status, 23)
  assert.doesNotMatch(f.calls(), /docker exec/)
  assert.equal(readFileSync(join(f.root, 'backend/CHANGELOG.md'), 'utf8'), 'tracked build changelog\n')
  assert.equal(existsSync(join(f.root, '.runtime/deploy/last-successful.sha')), false)
})

test('a healthy endpoint serving the wrong revision is not a successful deployment', t => {
  const f = fixture(t, { TEST_VERSION_SHA: 'b'.repeat(12) })
  assert.equal(f.run().status, 1)
  assert.equal(existsSync(join(f.root, '.runtime/deploy/last-successful.sha')), false)
})

test('missing SSH private key fails before attempting a connection', t => {
  const f = fixture(t)
  const result = spawnSync('bash', [sshScript], { env: { ...f.env, DEPLOY_HOST: '72.61.37.46', DEPLOY_USER: 'root' }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /DEPLOY_SSH_KEY/)
  assert.equal(existsSync(join(f.root, 'ssh-arguments')), false)
})

test('unsafe SSH destinations, ports and commit arguments are rejected before connecting', t => {
  const f = fixture(t)
  const base = { ...f.env, DEPLOY_HOST: '72.61.37.46', DEPLOY_USER: 'root', DEPLOY_SSH_KEY: 'test-only-key', GITHUB_SHA: sha, GITHUB_REPOSITORY: repository }
  for (const override of [{ DEPLOY_HOST: '-oProxyCommand=bad' }, { DEPLOY_USER: 'root;bad' }, { DEPLOY_PORT: '70000' }, { GITHUB_SHA: 'main;bad' }, { DEPLOY_PATH: 'relative/path' }]) {
    const result = spawnSync('bash', [sshScript], { env: { ...base, ...override }, encoding: 'utf8' })
    assert.equal(result.status, 1, JSON.stringify(override))
    assert.equal(existsSync(join(f.root, 'ssh-arguments')), false)
  }
})

test('SSH bounds remote deployment, pins host identity and deletes its temporary key', t => {
  const f = fixture(t)
  const env = { ...f.env, DEPLOY_HOST: '72.61.37.46', DEPLOY_USER: 'root', DEPLOY_SSH_KEY: 'test-only-key', GITHUB_SHA: sha, GITHUB_REPOSITORY: repository }
  const result = spawnSync('bash', [sshScript], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const args = readFileSync(join(f.root, 'ssh-arguments'), 'utf8')
  assert.match(args, /StrictHostKeyChecking=yes/)
  assert.match(args, /BatchMode=yes/)
  assert.match(args, /timeout --signal=TERM --kill-after=5s 900s bash -s --/)
  assert.match(args, /root@72\.61\.37\.46/)
  assert.equal(readFileSync(join(f.root, 'remote-script'), 'utf8'), readFileSync(serverScript, 'utf8'))
  const keyPath = readFileSync(join(f.root, 'key-path'), 'utf8').trim()
  assert.equal(existsSync(keyPath), false)
})
