import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeDefinition, labRoot, labProject, assertPrivateDirectory, labRequest, syntheticPassword, assertQAAvailability } from './qa-environment.mjs';
import { routeRequest } from '../../infra/offline/qa/gateway.mjs';
import { allowedConnect } from '../../infra/offline/qa/turnstile-proxy.mjs';
import { fixtureAccounts, fixtureUser } from './qa-seed.mjs';
import { assertFixtureIdentity, assertDeniedSwitch } from './qa-verify-fixtures.mjs';

const images = Object.fromEntries(['backend', 'frontend', 'signer', 'postgres', 'redis', 'minio'].map(name => [name, `sha256:${'a'.repeat(64)}`]));
test('QA cannot inherit production volumes, public ports, environment, or mutable images', () => {
  const compose = composeDefinition(images, labRoot);
  assert.equal(compose.name, labProject);
  assert.equal(compose.networks.isolated.internal, true);
  assert.deepEqual(compose.services['turnstile-proxy'].profiles, ['turnstile-test']);
  assert.deepEqual(Object.values(compose.services).flatMap(service => service.ports ?? []), [{ target: 8443, published: '19443', host_ip: '127.0.0.1', protocol: 'tcp' }]);
  for (const [name, service] of Object.entries(compose.services)) {
    assert.equal(service.labels['clarin.offline-v3.qa'], 'synthetic-only');
    assert.ok(!service.container_name && !service.network_mode && !service.privileged);
    if (!['turnstile-proxy', 'gateway', 'signer'].includes(name)) assert.deepEqual(service.networks, ['isolated']);
    if (name === 'signer') assert.deepEqual(service.networks, { isolated: { aliases: ['clarin-offline-signer'] } });
    if (name === 'gateway') assert.deepEqual(service.networks, ['isolated', 'loopback-edge']);
    for (const path of service.env_file ?? []) assert.ok(path.startsWith(labRoot + '/'));
    for (const mount of service.volumes ?? []) {
      if (typeof mount === 'object') { assert.ok(mount.source.startsWith(labRoot + '/')); assert.equal(mount.bind.create_host_path, false); assert.equal(mount.read_only, true); }
      else assert.ok(Object.hasOwn(compose.volumes, mount.split(':')[0]));
    }
  }
  assert.ok(!JSON.stringify(compose).includes('${'));
  assert.ok(!JSON.stringify(compose).includes('docker.sock'));
  assert.ok(!JSON.stringify(compose).includes('ca.key'));
  assert.throws(() => composeDefinition({ ...images, backend: 'clarin-backend:latest' }, labRoot), /immutable/);
  assert.throws(() => composeDefinition(images, '/tmp/other'), /dedicated/);
});

test('gateway preserves exact host and never becomes arbitrary proxy', () => {
  assert.deepEqual(routeRequest('clarin.naperu.cloud', '/api/offline/v3/runtime/availability'), { hostname: 'backend', port: 8080 });
  assert.deepEqual(routeRequest('clarin.naperu.cloud', '/dashboard/tasks'), { hostname: 'frontend', port: 3000 });
  for (const [host, path] of [['evil.test', '/'], ['clarin.naperu.cloud:19443', '/'], ['clarin.naperu.cloud', '//evil.test/'], ['clarin.naperu.cloud', 'http://evil.test/']]) assert.equal(routeRequest(host, path), null);
});

test('egress permits only official Turnstile TLS endpoint', () => {
  assert.equal(allowedConnect('challenges.cloudflare.com:443'), true);
  for (const value of ['clarin.naperu.cloud:443', '127.0.0.1:5432', 'challenges.cloudflare.com.evil:443', 'challenges.cloudflare.com:80', 'challenges.cloudflare.com:443@evil', undefined]) assert.equal(allowedConnect(value), false);
});

test('private laboratory path rejects shared and symlinked locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clarin-v3-qa-test-'));
  try {
    await chmod(root, 0o700); await assertPrivateDirectory(root);
    const direct = join(root, 'direct'), linked = join(root, 'linked');
    await mkdir(direct, { mode: 0o700 }); await symlink(direct, linked);
    await assert.rejects(() => assertPrivateDirectory(linked));
    await chmod(direct, 0o755); await assert.rejects(() => assertPrivateDirectory(direct), /0700/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fixture transport cannot accept an arbitrary URL or header injection', async () => {
  for (const path of ['https://clarin.naperu.cloud/api', '//example.test', '/api\r\nHost: evil.test']) await assert.rejects(() => labRequest(path), /local QA path/);
});

test('synthetic fixtures keep two accounts distinct and ten users below superadmin', () => {
  const accounts = fixtureAccounts('11111111-1111-4111-8111-111111111111');
  assert.equal(accounts.length, 2); assert.notEqual(accounts[0].slug, accounts[1].slug);
  for (const account of accounts) assert.equal(account.kommo_enabled, false);
  for (let index = 0; index < 10; index++) {
    const user = fixtureUser({ username: `offlineqa_user_${String(index + 1).padStart(2, '0')}`, password: 'synthetic-example-only' }, index, ['a', 'b']);
    assert.equal(user.accounts.length, index === 0 ? 2 : 1);
    assert.ok(user.accounts.every(account => account.role !== 'super_admin'));
    assert.ok(user.email.endsWith('@example.invalid'));
  }
  assert.throws(() => fixtureUser({ username: 'real_user' }, 0, ['a', 'b']), /synthetic/);
});

test('random fixture passwords satisfy the real account password policy', () => {
  const a = syntheticPassword(), b = syntheticPassword();
  assert.notEqual(a, b);
  assert.ok(a.length >= 10 && Buffer.byteLength(a) <= 72);
  for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/]) assert.match(a, pattern);
});

test('QA smoke requires an enabled and healthy actual v3 data plane', () => {
  const ready = { enabled: true, signer_ready: true, task_writes_enabled: true, protocol_version: 3, minimum_client_version: '3.0.0' };
  assertQAAvailability(ready);
  for (const field of ['enabled', 'signer_ready', 'task_writes_enabled', 'protocol_version', 'minimum_client_version']) assert.throws(() => assertQAAvailability({ ...ready, [field]: false }), /not ready/);
});

test('post-refresh auth verification rejects identity drift and cookie-bearing denials', () => {
  const response = { user: { id: 'user-a', account_id: 'account-a', is_super_admin: false } };
  assertFixtureIdentity(response, 'user-a', 'account-a');
  assert.throws(() => assertFixtureIdentity(response, 'user-b', 'account-a'), /mismatch/);
  assert.throws(() => assertFixtureIdentity(response, 'user-a', 'account-b'), /mismatch/);
  assert.throws(() => assertFixtureIdentity({ user: { ...response.user, is_super_admin: true } }, 'user-a', 'account-a'), /mismatch/);
  assertDeniedSwitch({ status: 403, headers: {} });
  assert.throws(() => assertDeniedSwitch({ status: 200, headers: {} }), /fail/);
  assert.throws(() => assertDeniedSwitch({ status: 403, headers: { 'set-cookie': ['any'] } }), /cookies/);
});
