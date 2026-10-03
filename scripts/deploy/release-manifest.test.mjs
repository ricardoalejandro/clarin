import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { composeOverride, imageNames, validateManifest, verifyImageInspections, verifyRunningInspections } from './release-manifest.mjs';

const sha = 'a'.repeat(40);
const digest = character => `sha256:${character.repeat(64)}`;
const manifest = () => ({
  format: 1, commit: sha, version: `2026.10.03-1-123456789-${sha.slice(0, 12)}`,
  platform: 'linux/amd64', archiveSha256: 'f'.repeat(64),
  images: Object.fromEntries(imageNames.map((name, index) => [name, { tag: `clarin-release/${name}:${sha}`, id: digest(String(index + 1)) }])),
});
const imageInspections = release => imageNames.map(name => ({
  Id: release.images[name].id, Os: 'linux', Architecture: 'amd64',
  Config: { Labels: { 'org.opencontainers.image.revision': release.commit, 'org.opencontainers.image.version': release.version } },
}));
const containerInspections = release => [...imageNames, 'task-preview-worker'].map(name => ({
  Name: `/clarin-${name}`, State: { Running: true },
  Image: release.images[name === 'task-preview-worker' ? 'backend' : name].id,
}));

test('a release is bound to its exact SHA, version, image names, checksum and platform', () => {
  const release = manifest();
  assert.equal(validateManifest(release, sha), release);
  for (const mutate of [
    value => { value.commit = 'b'.repeat(40); },
    value => { value.format = 2; },
    value => { value.platform = 'linux/arm64'; },
    value => { value.version = `2026.10.03-1-123456789-${'b'.repeat(12)}`; },
    value => { value.version += '\n'; },
    value => { value.archiveSha256 = '../images.tar'; },
    value => { value.images.backend.tag = 'clarin-release/backend:latest'; },
    value => { value.images.frontend.id = 'sha256:short'; },
    value => { delete value.images['offline-signer']; },
    value => { value.images.postgres = value.images.backend; },
    value => { value.unexpected = 'extra'; },
  ]) {
    const invalid = manifest();
    mutate(invalid);
    assert.throws(() => validateManifest(invalid, sha));
  }
  assert.throws(() => validateManifest(release, 'main'));
});

test('Compose uses immutable local IDs without pulls and shares the backend image with the preview worker', () => {
  const release = manifest();
  const override = composeOverride(release);
  assert.deepEqual(Object.keys(override.services).sort(), [...imageNames, 'task-preview-worker'].sort());
  assert.deepEqual(override.services.backend, { image: release.images.backend.id, pull_policy: 'never' });
  assert.deepEqual(override.services['task-preview-worker'], override.services.backend);
  for (const service of Object.values(override.services)) assert.equal(service.pull_policy, 'never');
  assert.equal('postgres' in override.services, false);
});

test('loaded images must match IDs, revision, version and architecture before activation', () => {
  const release = manifest();
  verifyImageInspections(release, imageInspections(release));
  for (const mutate of [
    values => { values.pop(); },
    values => { values[0].Id = digest('9'); },
    values => { values[1].Architecture = 'arm64'; },
    values => { values[2].Os = 'windows'; },
    values => { delete values[3].Config.Labels['org.opencontainers.image.revision']; },
    values => { values[0].Config.Labels['org.opencontainers.image.version'] = 'old'; },
  ]) {
    const invalid = imageInspections(release);
    mutate(invalid);
    assert.throws(() => verifyImageInspections(release, invalid));
  }
});

test('all five running containers must serve the exact prepared images', () => {
  const release = manifest();
  verifyRunningInspections(release, containerInspections(release).reverse());
  for (const mutate of [
    values => { values.pop(); },
    values => { values[1].Image = digest('9'); },
    values => { values[2].State.Running = false; },
    values => { values[4].Name = '/other-worker'; },
  ]) {
    const invalid = containerInspections(release);
    mutate(invalid);
    assert.throws(() => verifyRunningInspections(release, invalid));
  }
});

function preparationFixture(t, overrides = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'clarin-release-test-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'clarin');
  const bin = join(workspace, 'bin');
  const callsPath = join(workspace, 'docker-calls.jsonl');
  const statePath = join(workspace, 'docker-images.json');
  const write = (path, contents, executable = false) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, { mode: executable ? 0o755 : 0o644 });
  };
  const scriptPath = join(root, 'scripts/deploy/prepare-release.sh');
  write(scriptPath, readFileSync(new URL('./prepare-release.sh', import.meta.url), 'utf8'));
  write(join(root, 'scripts/deploy/release-manifest.mjs'), readFileSync(new URL('./release-manifest.mjs', import.meta.url), 'utf8'));
  write(join(root, 'CHANGELOG.md'), 'release changelog\n');
  write(join(root, '.gitignore'), '.env\n.runtime/\n');
  write(join(root, 'backend/CHANGELOG.md'), 'old tracked backend changelog\n');
  for (const name of imageNames) {
    write(join(root, name, 'source.txt'), `source for ${name}\n`);
    write(join(root, `deploy/Dockerfile.${name}`), 'FROM scratch\n');
  }
  write(join(root, 'version.sh'), '#!/bin/bash\nset -eu\nprintf "2026.10.03-1-123456789-%s\\n" "$(git rev-parse --short=12 HEAD)"\n');
  const git = args => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'release fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  write(join(bin, 'docker'), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
const state = existsSync(process.env.TEST_STATE) ? JSON.parse(readFileSync(process.env.TEST_STATE, 'utf8')) : {};
if (args[0] === 'build') {
  const tag = args[args.indexOf('-t') + 1];
  const name = tag.split('/')[1].split(':')[0];
  if (name === process.env.TEST_FAIL_BUILD) process.exit(23);
  const context = args.at(-1);
  if (name === 'backend' && readFileSync(context + '/CHANGELOG.md', 'utf8') !== 'release changelog\\n') process.exit(24);
  if (existsSync(context + '/.env')) process.exit(25);
  const labels = {};
  args.forEach((argument, index) => {
    if (argument === '--label') {
      const label = args[index + 1];
      labels[label.slice(0, label.indexOf('='))] = label.slice(label.indexOf('=') + 1);
    }
  });
  state[tag] = { Id: 'sha256:' + String(Object.keys(state).length + 1).repeat(64), Os: 'linux', Architecture: 'amd64', Config: { Labels: labels } };
  writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
  if (name === process.env.TEST_EDIT_DURING_BUILD) writeFileSync(process.env.TEST_ROOT + '/backend/source.txt', 'concurrent user change\\n');
} else if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify(args.slice(2).map(tag => state[tag])));
} else if (args[0] === 'image' && args[1] === 'save') {
  writeFileSync(args[args.indexOf('-o') + 1], 'mock immutable image archive\\n');
} else process.exit(92);
`, true);
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_CALLS: callsPath, TEST_STATE: statePath, TEST_ROOT: root,
    OFFLINE_V3_ENABLED: 'false', CODEX_PROXY_CERT: '', CLARIN_BUILD_CA_FILE: '', BUILDX_CONFIG: '', ...overrides,
  };
  return {
    root, workspace, commit, git,
    output: join(workspace, 'work/clarin-releases', commit),
    run: args => spawnSync('bash', [scriptPath, ...(args || [commit])], { env, encoding: 'utf8' }),
    calls: () => existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}

test('preparation builds four exact-source images and publishes a checked archive without activating services', t => {
  const f = preparationFixture(t);
  // Git-ignored runtime credentials must not become Docker build inputs.
  writeFileSync(join(f.root, 'frontend/.env'), 'LOCAL_FIXTURE_SECRET=test-only\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const release = validateManifest(JSON.parse(readFileSync(join(f.output, 'manifest.json'), 'utf8')), f.commit);
  const archive = readFileSync(join(f.output, 'images.tar'));
  assert.equal(release.archiveSha256, createHash('sha256').update(archive).digest('hex'));
  const calls = f.calls();
  assert.equal(calls.filter(args => args[0] === 'build').length, 4);
  assert.equal(calls.filter(args => args[0] === 'build' && args.includes(`BUILD_VERSION=${release.version}`)).length, 2);
  assert.ok(calls.every(args => !args.includes('up') && !args.includes('push') && !args.includes('load')));
  assert.equal(readFileSync(join(f.root, 'backend/CHANGELOG.md'), 'utf8'), 'old tracked backend changelog\n');
  assert.equal(f.git(['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(existsSync(join(f.workspace, 'work/clarin-qa/buildx')), true);
  assert.match(result.stdout, /No containers were started or uploaded/);
});

test('dirty, untracked, mismatched and offline-pilot checkouts fail before any image build', t => {
  for (const scenario of ['dirty', 'untracked', 'sha', 'pilot']) {
    const f = preparationFixture(t, scenario === 'pilot' ? { OFFLINE_V3_ENABLED: 'true' } : {});
    if (scenario === 'dirty') writeFileSync(join(f.root, 'backend/source.txt'), 'user change\n');
    if (scenario === 'untracked') writeFileSync(join(f.root, 'new-source.txt'), 'untracked source\n');
    const result = f.run(scenario === 'sha' ? ['b'.repeat(40)] : undefined);
    assert.equal(result.status, 1, scenario);
    assert.deepEqual(f.calls(), []);
    assert.equal(existsSync(f.output), false);
    assert.equal(existsSync(join(f.workspace, 'work')), false);
  }
});

test('build failures leave no published bundle and preserve the tracked changelog', t => {
  const f = preparationFixture(t, { TEST_FAIL_BUILD: 'frontend' });
  assert.equal(f.run().status, 23);
  assert.equal(existsSync(f.output), false);
  assert.deepEqual(readdirSync(dirname(f.output)), []);
  assert.equal(readFileSync(join(f.root, 'backend/CHANGELOG.md'), 'utf8'), 'old tracked backend changelog\n');
  assert.equal(f.calls().filter(args => args[0] === 'build').length, 2);
});

test('concurrent source edits are preserved and prevent publishing the prepared release', t => {
  const f = preparationFixture(t, { TEST_EDIT_DURING_BUILD: 'frontend' });
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Checkout changed during release preparation/);
  assert.equal(existsSync(f.output), false);
  assert.equal(readFileSync(join(f.root, 'backend/source.txt'), 'utf8'), 'concurrent user change\n');
});

test('manifest CLI rejects unknown commands and mismatched releases without calling Docker', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clarin-manifest-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest()));
  const helper = fileURLToPath(new URL('./release-manifest.mjs', import.meta.url));
  for (const args of [['unknown', path, sha], ['check-images', path, 'b'.repeat(40)], ['compose', path, sha, 'unexpected']]) {
    const result = spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
  }
  const result = spawnSync(process.execPath, [helper, 'compose', path, sha], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), composeOverride(manifest()));
});
