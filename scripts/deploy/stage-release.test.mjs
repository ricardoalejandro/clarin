import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const serverScript = fileURLToPath(new URL('./stage-release-on-server.sh', import.meta.url))
const sshScript = fileURLToPath(new URL('./stage-release.sh', import.meta.url))
const sha = 'a'.repeat(40)
const repository = 'ricardoalejandro/clarin'
const imageId = `sha256:${'b'.repeat(64)}`
const helperFixture = readFileSync(fileURLToPath(new URL('./release-manifest.mjs', import.meta.url)), 'utf8')

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clarin-stage-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const scriptDirectory = join(root, 'scripts')
  const bundle = join(root, 'bundle')
  const staging = join(root, '.runtime/deploy/staging')
  const incoming = join(staging, '.incoming.test')
  const release = join(root, '.runtime/deploy/releases', sha)
  for (const directory of [bin, scriptDirectory, bundle, incoming, join(root, '.git')]) mkdirSync(directory, { recursive: true })
  copyFileSync(sshScript, join(scriptDirectory, 'stage-release.sh'))
  copyFileSync(serverScript, join(scriptDirectory, 'stage-release-on-server.sh'))
  writeFileSync(join(scriptDirectory, 'release-manifest.mjs'), helperFixture)
  writeFileSync(join(scriptDirectory, 'known_hosts'), 'pinned-host-test-only\n')
  writeFileSync(join(bundle, 'images.tar'), 'mock image archive\n')
  const checksum = createHash('sha256').update(readFileSync(join(bundle, 'images.tar'))).digest('hex')
  const manifest = {
    format: 1, commit: sha, version: `2026.10.03-1-123456-${sha.slice(0, 12)}`, platform: 'linux/amd64', archiveSha256: checksum,
    images: Object.fromEntries(['backend', 'frontend', 'offline-signer', 'codex-bridge'].map(name => [name, { tag: `clarin-release/${name}:${sha}`, id: imageId }])),
  }
  writeFileSync(join(bundle, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  writeFileSync(join(root, 'inspections.json'), JSON.stringify(Object.values(manifest.images).map(image => ({
    Id: image.id, Os: 'linux', Architecture: 'amd64',
    Config: { Labels: { 'org.opencontainers.image.revision': sha, 'org.opencontainers.image.version': manifest.version } },
  }))))
  const prepareIncoming = () => {
    mkdirSync(incoming, { recursive: true })
    for (const file of ['manifest.json', 'images.tar']) copyFileSync(join(bundle, file), join(incoming, file))
    for (const file of ['release-manifest.mjs', 'stage-release-on-server.sh']) copyFileSync(join(scriptDirectory, file), join(incoming, file))
  }
  prepareIncoming()
  const executable = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANG: 'C', TEST_ROOT: root, TEST_IMAGE_ID: imageId, TEST_RELEASE: release, ...overrides }
  executable('git', `
    printf 'git %s\\n' "$*" >> "$TEST_ROOT/calls"
    case "$*" in
      'rev-parse --show-toplevel') printf '%s\\n' "$TEST_ROOT" ;;
      'remote get-url origin') printf '%s\\n' "\${TEST_ORIGIN:-https://github.com/ricardoalejandro/clarin.git}" ;;
      'rev-parse --git-path clarin-deploy.lock') printf '%s\\n' "$TEST_ROOT/.git/clarin-deploy.lock" ;;
      *) echo 'Unexpected repository mutation or query.' >&2; exit 1 ;;
    esac`)
  executable('flock', 'printf "flock %s\\n" "$*" >> "$TEST_ROOT/calls"; exit "${TEST_LOCK_EXIT:-0}"')
  executable('docker', `
    printf 'docker %s\\n' "$*" >> "$TEST_ROOT/calls"
    case "$*" in
      'load -i '*) touch "$TEST_ROOT/load-attempted"; exit "\${TEST_LOAD_EXIT:-0}" ;;
      'image inspect '*)
        if [[ ! -e "$TEST_RELEASE" ]]; then echo no-release-during-check >> "$TEST_ROOT/calls"; fi
        if [[ \${TEST_BAD_IMAGE:-0} == 1 || ( \${TEST_REQUIRE_LOAD:-0} == 1 && ! -e "$TEST_ROOT/load-attempted" ) ]]; then
          node -e 'const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); data[0].Id = "sha256:wrong"; console.log(JSON.stringify(data));' "$TEST_ROOT/inspections.json"
        else cat "$TEST_ROOT/inspections.json"; fi ;;
      *) echo 'Unexpected activation or build command.' >&2; exit 1 ;;
    esac`)
  executable('make', 'echo "Unexpected build or activation." >&2; exit 99')
  executable('ssh-keygen', 'exit 0')
  executable('ssh', `
    printf '%s\\n' "$@" > "$TEST_ROOT/ssh-arguments"
    remote_command="\${!#}"
    while (( $# )); do
      if [[ $1 == -i ]]; then shift; printf '%s\\n' "$1" > "$TEST_ROOT/key-path"; fi
      shift
    done
    if [[ \${TEST_SSH_EXECUTE:-0} == 1 ]]; then
      bash -c "$remote_command"
      exit 0
    fi
    cat > "$TEST_ROOT/transferred.tar"
    exit "\${TEST_SSH_EXIT:-0}"`)
  const sshEnv = { ...env, DEPLOY_HOST: '72.61.37.46', DEPLOY_USER: 'root', DEPLOY_SSH_KEY: 'test-only-key', DEPLOY_PATH: root, GITHUB_SHA: sha, GITHUB_REPOSITORY: repository }
  return {
    root, incoming, release, bundle, manifest, env, sshEnv, prepareIncoming,
    run: () => spawnSync('bash', [serverScript, root, sha, repository, incoming], { env, encoding: 'utf8' }),
    stage: overrides => spawnSync('bash', [join(scriptDirectory, 'stage-release.sh'), bundle], { env: { ...sshEnv, ...overrides }, encoding: 'utf8' }),
    calls: () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : '',
  }
}

test('staging verifies all four loaded image identities before publishing ready without activation', t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.release, 'ready'), 'utf8'), `${sha}\n`)
  assert.equal(readFileSync(join(f.release, 'manifest.json'), 'utf8'), `${JSON.stringify(f.manifest)}\n`)
  assert.equal(existsSync(join(f.release, 'release-manifest.mjs')), true)
  assert.equal(existsSync(join(f.release, 'images.tar')), false)
  assert.equal(existsSync(f.incoming), false)
  assert.equal((f.calls().match(/no-release-during-check/g) || []).length, 1)
  for (const name of Object.keys(f.manifest.images)) assert.ok(f.calls().includes(`clarin-release/${name}:${sha}`))
  assert.doesNotMatch(f.calls(), /git (fetch|merge|restore)|docker (compose|exec|build)|make/)
})

test('a corrupted archive stops before docker load and removes only the incoming directory', t => {
  const f = fixture(t)
  writeFileSync(join(f.incoming, 'images.tar'), 'corrupted archive\n')
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /checksum/)
  assert.equal(existsSync(join(f.root, 'load-attempted')), false)
  assert.equal(existsSync(f.incoming), false)
  assert.equal(existsSync(f.release), false)
})

test('a different server repository rejects the upload without loading or changing its checkout', t => {
  const f = fixture(t, { TEST_ORIGIN: 'https://github.com/someone/other.git' })
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /origin does not match/)
  assert.equal(existsSync(f.incoming), false)
  assert.doesNotMatch(f.calls(), /docker|git (fetch|merge|restore)/)
})

test('a partially failed docker load never publishes ready or activates any service', t => {
  const f = fixture(t, { TEST_LOAD_EXIT: '23' })
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /image loading failed/)
  assert.equal(existsSync(join(f.root, 'load-attempted')), true)
  assert.equal(existsSync(f.incoming), false)
  assert.equal(existsSync(f.release), false)
  assert.doesNotMatch(f.calls(), /image inspect|compose|exec|build|git (fetch|merge)/)
})

test('an image identity mismatch after loading leaves no staged release', t => {
  const f = fixture(t, { TEST_BAD_IMAGE: '1' })
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /image identity or platform mismatch/)
  assert.equal(existsSync(f.release), false)
  assert.equal(existsSync(f.incoming), false)
})

test('a conflicting existing manifest is preserved and rejected before loading images', t => {
  const f = fixture(t)
  mkdirSync(f.release, { recursive: true })
  writeFileSync(join(f.release, 'ready'), `${sha}\n`)
  const original = JSON.stringify({ ...f.manifest, version: 'another-version' })
  writeFileSync(join(f.release, 'manifest.json'), original)
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /incompatible manifest/)
  assert.equal(readFileSync(join(f.release, 'manifest.json'), 'utf8'), original)
  assert.equal(existsSync(join(f.root, 'load-attempted')), false)
  assert.equal(existsSync(f.incoming), false)
})

test('an identical already staged release is idempotent and does not reload images', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  rmSync(join(f.root, 'load-attempted'))
  f.prepareIncoming()
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /already staged/)
  assert.equal(existsSync(join(f.root, 'load-attempted')), false)
  assert.equal(existsSync(f.incoming), false)
})

test('missing cached images can be reloaded without rewriting the existing release artifacts', t => {
  const f = fixture(t, { TEST_REQUIRE_LOAD: '1' })
  assert.equal(f.run().status, 0)
  rmSync(join(f.root, 'load-attempted'))
  const originalHelper = `${helperFixture}\n// Preserve the already published helper.\n`
  writeFileSync(join(f.release, 'release-manifest.mjs'), originalHelper)
  f.prepareIncoming()
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(f.root, 'load-attempted')), true)
  assert.equal(readFileSync(join(f.release, 'release-manifest.mjs'), 'utf8'), originalHelper)
  assert.equal(readFileSync(join(f.release, 'manifest.json'), 'utf8'), `${JSON.stringify(f.manifest)}\n`)
  assert.equal(existsSync(f.incoming), false)
})

test('the shared activation lock rejects concurrent staging without loading an image', t => {
  const f = fixture(t, { TEST_LOCK_EXIT: '1' })
  assert.equal(f.run().status, 1)
  assert.match(f.calls(), /flock -w 120 9/)
  assert.doesNotMatch(f.calls(), /docker/)
  assert.equal(existsSync(f.incoming), false)
})

test('an incoming path outside the dedicated staging directory is never removed', t => {
  const f = fixture(t)
  const outside = join(f.root, 'important-directory')
  mkdirSync(outside)
  writeFileSync(join(outside, 'preserve'), 'keep')
  const result = spawnSync('bash', [serverScript, f.root, sha, repository, outside], { env: f.env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(readFileSync(join(outside, 'preserve'), 'utf8'), 'keep')
  assert.doesNotMatch(f.calls(), /docker/)
})

test('the wrapper rejects local checksum changes before connecting to SSH', t => {
  const f = fixture(t)
  writeFileSync(join(f.bundle, 'images.tar'), 'corrupted local archive')
  const result = f.stage()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /checksum/)
  assert.equal(existsSync(join(f.root, 'ssh-arguments')), false)
})

test('unsafe or missing SSH configuration never connects', t => {
  const f = fixture(t)
  for (const override of [
    { DEPLOY_SSH_KEY: '' }, { DEPLOY_HOST: '-oProxyCommand=bad' }, { DEPLOY_USER: 'root;bad' },
    { DEPLOY_PORT: '70000' }, { DEPLOY_PATH: 'relative/path' }, { GITHUB_SHA: 'main;bad' },
    { GITHUB_REPOSITORY: '../bad' },
  ]) {
    const result = f.stage(override)
    assert.equal(result.status, 1, JSON.stringify(override))
    assert.equal(existsSync(join(f.root, 'ssh-arguments')), false)
  }
})

test('SSH pins host identity, sends only release inputs and deletes its temporary key', t => {
  const f = fixture(t)
  const result = f.stage()
  assert.equal(result.status, 0, result.stderr)
  const args = readFileSync(join(f.root, 'ssh-arguments'), 'utf8')
  assert.match(args, /StrictHostKeyChecking=yes/)
  assert.match(args, /IdentitiesOnly=yes/)
  assert.match(args, /BatchMode=yes/)
  assert.match(args, /root@72\.61\.37\.46/)
  assert.doesNotMatch(args, /test-only-key/)
  const files = spawnSync('tar', ['-tf', join(f.root, 'transferred.tar')], { encoding: 'utf8' })
  assert.equal(files.status, 0, files.stderr)
  assert.deepEqual(files.stdout.trim().split('\n'), ['manifest.json', 'images.tar', 'release-manifest.mjs', 'stage-release-on-server.sh'])
  const keyPath = readFileSync(join(f.root, 'key-path'), 'utf8').trim()
  assert.equal(existsSync(keyPath), false)
})

test('the SSH bootstrap transfers, extracts and stages the bundle without touching running services', t => {
  const f = fixture(t)
  rmSync(f.incoming, { recursive: true })
  const result = f.stage({ TEST_SSH_EXECUTE: '1' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.release, 'ready'), 'utf8'), `${sha}\n`)
  assert.equal(readFileSync(join(f.release, 'manifest.json'), 'utf8'), `${JSON.stringify(f.manifest)}\n`)
  assert.doesNotMatch(f.calls(), /git (fetch|merge|restore)|docker (compose|exec|build)|make/)
  const keyPath = readFileSync(join(f.root, 'key-path'), 'utf8').trim()
  assert.equal(existsSync(keyPath), false)
})

test('a failed SSH transfer returns failure and deletes the temporary key', t => {
  const f = fixture(t)
  const result = f.stage({ TEST_SSH_EXIT: '31' })
  assert.equal(result.status, 31, result.stderr)
  const keyPath = readFileSync(join(f.root, 'key-path'), 'utf8').trim()
  assert.equal(existsSync(keyPath), false)
  assert.equal(existsSync(f.release), false)
})
