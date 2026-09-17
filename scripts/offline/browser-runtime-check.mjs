#!/usr/bin/env node
// Read-only production smoke checks. Never selects product rows, supplies
// credentials, modifies flags, prints JWKs, or follows an HTTP redirect.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const expectedTables = ['audit', 'browser_profiles', 'challenges', 'enrollment_requests', 'event_outbox', 'grant_keys', 'grants', 'receipts', 'selections'].map(name => `offline_v4_${name}`);
export const expectedIndexes = ['uq_offline_v4_pending', 'uq_offline_v4_live_grant', 'idx_offline_v4_grant_user', 'idx_offline_v4_grant_account', 'idx_offline_v4_challenge_expiry', 'idx_offline_v4_pending_effect'];
export const expectedTriggers = ['trg_offline_v3_user_epochs', 'trg_offline_v3_membership_epoch_insert_delete', 'trg_offline_v3_membership_epoch_update', 'trg_offline_v3_role_epoch', 'trg_offline_v3_account_epoch'];

export const schemaSQL = `SELECT jsonb_build_object(
 'tables',(SELECT COALESCE(jsonb_agg(tablename),'[]'::jsonb) FROM pg_tables WHERE schemaname='public' AND tablename ~ '^offline_v4_'),
 'indexes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef)),'[]'::jsonb) FROM pg_indexes WHERE schemaname='public' AND tablename ~ '^offline_v4_'),
 'constraints',(SELECT COALESCE(jsonb_agg(jsonb_build_object('table',rel.relname,'validated',con.convalidated,'definition',pg_get_constraintdef(con.oid))),'[]'::jsonb) FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace WHERE ns.nspname='public' AND rel.relname ~ '^offline_v4_'),
 'triggers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled)),'[]'::jsonb) FROM pg_trigger WHERE NOT tgisinternal AND tgname ~ '^trg_offline_v3_'),
 'selection_columns',(SELECT COALESCE(jsonb_agg(column_name),'[]'::jsonb) FROM information_schema.columns WHERE table_schema='public' AND table_name='offline_v4_selections'))`;

export function verifySchema(schema) {
  const checks = [];
  const add = (name, pass) => checks.push({ name, pass: Boolean(pass) });
  for (const name of expectedTables) add(`table:${name}`, schema.tables?.includes(name));
  for (const name of expectedIndexes) add(`index:${name}`, schema.indexes?.some(item => item.name === name));
  const live = schema.indexes?.find(item => item.name === 'uq_offline_v4_live_grant');
  add('unique_active_profile_user_account', /CREATE UNIQUE INDEX/.test(live?.definition || '') && /\(browser_profile_id, user_id, account_id\)/.test(live?.definition || '') && /WHERE.*state.*'active'/.test(live?.definition || ''));
  for (const table of ['grant_keys', 'selections', 'receipts', 'event_outbox']) {
    add(`account_composite_fk:${table}`, schema.constraints?.some(item => item.table === `offline_v4_${table}` && item.validated === true && /FOREIGN KEY \(grant_id, account_id\) REFERENCES offline_v4_grants\(id, account_id\)/.test(item.definition)));
  }
  add('receipt_idempotency', schema.constraints?.some(item => item.table === 'offline_v4_receipts' && /PRIMARY KEY \(grant_id, operation_id\)/.test(item.definition)));
  add('storage_byte_size_column', schema.selection_columns?.includes('byte_size'));
  add('storage_byte_size_constraint', schema.constraints?.some(item => item.table === 'offline_v4_selections' && item.validated === true && /CHECK.*byte_size >= 0/.test(item.definition)));
  for (const name of expectedTriggers) add(`epoch_trigger:${name}`, schema.triggers?.some(item => item.name === name && ['O', 'A'].includes(item.enabled)));
  return checks;
}

// This executes inside the frontend container (Node is part of its runtime).
// The protected endpoints have mode=status: their body is NEVER read, even
// when a broken authorization boundary unexpectedly returns HTTP 200.
export const probeSource = `
const input = JSON.parse(process.argv[1]);
try {
 const response = await fetch(input.url,{redirect:'manual',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(12000),headers:{Accept:'application/json'}});
 const out = {status:response.status,marker:response.headers.get('x-clarin-response'),protocol:response.headers.get('x-clarin-offline-protocol'),cache:response.headers.get('cache-control')};
 if(input.mode!=='status' && response.status===200){
  const data=await response.json();
  if(input.mode==='health') out.data={status:data.status};
  if(input.mode==='version') out.data={version:data.version};
  if(input.mode==='availability') out.data={enabled:data.enabled,task_writes_enabled:data.task_writes_enabled,protocol_version:data.protocol_version,max_offline_seconds:data.max_offline_seconds};
  if(input.mode==='keys') out.data={count:Array.isArray(data.keys)?data.keys.length:0,public_only:Array.isArray(data.keys)&&data.keys.length>0&&data.keys.every(key=>key&&typeof key==='object'&&!Object.hasOwn(key,'d')&&key.kty==='EC'&&key.crv==='P-256'&&key.alg==='ES256'&&key.use==='sig'&&typeof key.kid==='string'&&typeof key.x==='string'&&typeof key.y==='string')};
 }
 await response.body?.cancel().catch(()=>{});
 process.stdout.write(JSON.stringify(out));
}catch{process.stdout.write(JSON.stringify({status:0,probe_error:true}));}
`;

export function parseOptions(args) {
  const options = {};
  for (const arg of args) {
    const match = /^--expected-(enabled|task-writes|version)=(.+)$/.exec(arg);
    if (!match) throw new Error('invalid_option');
    const [, name, value] = match;
    if (name !== 'version' && !['true', 'false'].includes(value)) throw new Error('invalid_boolean');
    options[name] = name === 'version' ? value : value === 'true';
  }
  return options;
}

export function runtimeCheck(options = {}, docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, maxBuffer: 2 * 1024 * 1024 })) {
  const checks = [];
  const add = (name, pass) => checks.push({ name, pass: Boolean(pass) });
  const probe = (path, mode = 'status', host = 'backend:8080') => {
    try { return JSON.parse(docker(['exec', 'clarin-frontend', 'node', '--input-type=module', '-e', probeSource, JSON.stringify({ url: `http://${host}${path}`, mode })])); }
    catch { return { status: 0, probe_error: true }; }
  };
  const health = probe('/health', 'health');
  add('backend_health', health.status === 200 && health.data?.status === 'healthy');
  const version = probe('/api/version', 'version');
  add('backend_version', version.status === 200 && typeof version.data?.version === 'string' && (!options.version || version.data.version === options.version));
  const availability = probe('/api/offline/v4/runtime/availability', 'availability');
  const flags = availability.data || {};
  add('availability', availability.status === 200 && availability.marker === '1' && availability.protocol === '4' && /no-store/.test(availability.cache || '') && flags.protocol_version === 4 && flags.max_offline_seconds === 86400 && typeof flags.enabled === 'boolean' && typeof flags.task_writes_enabled === 'boolean' && (!flags.task_writes_enabled || flags.enabled));
  for (const [option, property] of [['enabled', 'enabled'], ['task-writes', 'task_writes_enabled']]) if (option in options) add(`expected_${property}`, flags[property] === options[option]);
  const admin = probe('/api/admin/offline-v4/grants');
  add('admin_requires_authentication', admin.status === 401 && admin.marker === '1');
  const grants = probe('/api/offline/v4/grants');
  add('grants_requires_authentication_or_disabled', grants.status === (flags.enabled === true ? 401 : 404) && grants.marker === '1');
  const keys = probe('/api/offline/v4/lease-keys', 'keys');
  add('lease_public_keys_or_disabled', flags.enabled === true ? keys.status === 200 && keys.marker === '1' && keys.data?.public_only === true : keys.status === 404);
  const signer = probe('/v4/public-keys', 'status', 'offline-signer:8200');
  add('signer_requires_authentication', signer.status === 401);
  try { docker(['exec', 'clarin-offline-signer', '/offline-signer', 'healthcheck']); add('signer_health', true); }
  catch { add('signer_health', false); }
  try { checks.push(...verifySchema(JSON.parse(docker(['exec', 'clarin-postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'clarin', '-d', 'clarin', '-c', schemaSQL])))); }
  catch { add('schema_inspection', false); }
  return { read_only: true, checked_at: new Date().toISOString(), backend_version: version.data?.version || null, flags, passed: checks.every(check => check.pass), checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = runtimeCheck(parseOptions(process.argv.slice(2))); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1; }
  catch { console.error('No se pudo completar la verificación read-only. Usa --expected-enabled=true|false, --expected-task-writes=true|false y --expected-version=VERSION. No se modificó producción.'); process.exitCode = 1; }
}
