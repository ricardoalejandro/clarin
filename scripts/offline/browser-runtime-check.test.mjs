import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { expectedTables, expectedIndexes, expectedTriggers, parseOptions, probeSource, runtimeCheck, schemaSQL, verifySchema } from './browser-runtime-check.mjs';

function schema() {
  return {
    tables: [...expectedTables],
    indexes: expectedIndexes.map(name => ({ name, definition: name === 'uq_offline_v4_live_grant' ? "CREATE UNIQUE INDEX uq_offline_v4_live_grant ON public.offline_v4_grants USING btree (browser_profile_id, user_id, account_id) WHERE ((state)::text = 'active'::text)" : 'index' })),
    constraints: [
      ...['grant_keys', 'selections', 'receipts', 'event_outbox'].map(name => ({ table: `offline_v4_${name}`, validated: true, definition: 'FOREIGN KEY (grant_id, account_id) REFERENCES offline_v4_grants(id, account_id) ON DELETE CASCADE' })),
      { table: 'offline_v4_receipts', validated: true, definition: 'PRIMARY KEY (grant_id, operation_id)' },
      { table: 'offline_v4_selections', validated: true, definition: 'CHECK ((byte_size >= 0))' },
    ],
    triggers: expectedTriggers.map(name => ({ name, enabled: 'O' })), selection_columns: ['byte_size'],
  };
}

function fakeDocker(enabled, calls, overrides = {}) {
  return args => {
    calls.push(args);
    if (args.includes('psql')) return JSON.stringify(schema());
    if (args.includes('healthcheck')) return '';
    const { url } = JSON.parse(args.at(-1));
    if (overrides[url]) return JSON.stringify(overrides[url]);
    const route = new URL(url).pathname;
    const base = { status: 200, marker: '1', protocol: '4', cache: 'no-store' };
    if (route === '/health') return JSON.stringify({ ...base, data: { status: 'healthy' } });
    if (route === '/api/version') return JSON.stringify({ ...base, data: { version: 'test-release' } });
    if (route.endsWith('/runtime/availability')) return JSON.stringify({ ...base, data: { enabled, task_writes_enabled: false, protocol_version: 4, max_offline_seconds: 86400 } });
    if (route === '/api/admin/offline-v4/grants' || route === '/v4/public-keys') return JSON.stringify({ ...base, status: 401 });
    if (route === '/api/offline/v4/grants') return JSON.stringify({ ...base, status: enabled ? 401 : 404 });
    if (route.endsWith('/lease-keys')) return JSON.stringify({ ...base, status: enabled ? 200 : 404, data: { public_only: true, count: 1 } });
    throw new Error('Unexpected command');
  };
}

test('schema validates all account boundaries and rejects missing or disabled guards', () => {
  assert.ok(verifySchema(schema()).every(check => check.pass));
  for (const mutate of [s => s.tables.pop(), s => s.indexes.splice(1, 1), s => { s.constraints[0].definition = 'FOREIGN KEY (grant_id) REFERENCES offline_v4_grants(id)'; }, s => { s.triggers[0].enabled = 'D'; }, s => { s.selection_columns = []; }]) {
    const changed = schema(); mutate(changed); assert.ok(verifySchema(changed).some(check => !check.pass));
  }
  assert.doesNotMatch(schemaSQL, /\b(?:UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(schemaSQL, /FROM\s+(?:public\.)?(?:offline_v4_grants|users|accounts)\b/i);
});

test('enabled and disabled deployments have distinct expected authentication results', () => {
  for (const enabled of [true, false]) {
    const calls = [];
    const result = runtimeCheck({ enabled, 'task-writes': false, version: 'test-release' }, fakeDocker(enabled, calls));
    assert.equal(result.passed, true);
    assert.equal(result.read_only, true);
    assert.ok(calls.every(args => args[0] === 'exec'));
    assert.ok(calls.every(args => ['clarin-frontend', 'clarin-offline-signer', 'clarin-postgres'].includes(args[1])));
  }
  assert.equal(runtimeCheck({ enabled: false }, fakeDocker(true, [])).passed, false);
  assert.equal(runtimeCheck({}, fakeDocker(true, [], { 'http://backend:8080/api/admin/offline-v4/grants': { status: 200, marker: '1' } })).passed, false);
  assert.equal(runtimeCheck({}, fakeDocker(true, [], { 'http://backend:8080/api/offline/v4/lease-keys': { status: 200, marker: '1', data: { public_only: false } } })).passed, false);
});

test('HTTP status probes never inspect protected bodies and cannot redirect or send credentials', () => {
  const mock = `globalThis.fetch=async (url,options)=>{if(options.redirect!=='manual'||options.credentials!=='omit'||options.headers.Authorization)throw Error('unsafe');return {status:200,headers:new Headers(),json:async()=>{throw Error('private body must not be read')},body:{cancel:async()=>{}}}};`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', mock + probeSource, JSON.stringify({ url: 'http://backend:8080/api/offline/v4/grants', mode: 'status' })], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).status, 200);
  assert.equal(JSON.parse(output).probe_error, undefined);
});

test('private key material is only reported as a failed boolean, never echoed', () => {
  const mock = `globalThis.fetch=async()=>new Response(JSON.stringify({keys:[{kty:'EC',crv:'P-256',alg:'ES256',use:'sig',kid:'test',x:'public-x',y:'public-y',d:'DO-NOT-PRINT-THIS'}]}),{status:200});`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', mock + probeSource, JSON.stringify({ url: 'http://backend:8080/api/offline/v4/lease-keys', mode: 'keys' })], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).data.public_only, false);
  assert.doesNotMatch(output, /DO-NOT-PRINT-THIS|public-x|public-y/);
});

test('CLI accepts expectations, never arbitrary containers, SQL, or flags to mutate', () => {
  assert.deepEqual(parseOptions(['--expected-enabled=true', '--expected-task-writes=false', '--expected-version=release']), { enabled: true, 'task-writes': false, version: 'release' });
  assert.throws(() => parseOptions(['--expected-enabled=yes']));
  assert.throws(() => parseOptions(['--container=other']));
  assert.throws(() => parseOptions(['--activate']));
});
