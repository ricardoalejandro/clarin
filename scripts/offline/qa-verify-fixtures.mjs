#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labRoot, labRequest, verifyLabIdentity } from './qa-environment.mjs';

export function assertFixtureIdentity(response, userID, accountID) {
  if (response?.user?.id !== userID || response.user.account_id !== accountID || response.user.is_super_admin !== false) throw new Error('QA identity/account mismatch');
}
export function assertDeniedSwitch(response) {
  if (response.status !== 403 || response.headers['set-cookie'] !== undefined) throw new Error('Cross-account switch did not fail without issuing cookies');
}

export async function verifyFixtures() {
  const lab = await verifyLabIdentity(); // Do not read/send credentials before TLS + lab marker.
  const ledger = JSON.parse(await readFile(join(labRoot, 'fixtures.json'), 'utf8'));
  if (ledger.run_id !== lab.run_id || ledger.state !== 'complete') throw new Error('Complete fixtures for this lab are required');
  const credentials = JSON.parse(await readFile(join(labRoot, 'credentials.json'), 'utf8'));
  const accountA = ledger.steps.account_0.value.id, accountB = ledger.steps.account_1.value.id;
  const checks = []; let cookie = '';
  const request = async (path, method = 'GET', body) => {
    const response = await labRequest(path, { method, body, cookie });
    if (response.status !== 200) throw new Error(`QA validation ${method} ${path} failed with HTTP ${response.status}`);
    if (response.headers['set-cookie']) cookie = response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
    return JSON.parse(response.text);
  };
  try {
    for (const index of [0, 1]) {
      cookie = '';
      const expected = ledger.steps[`user_${index}`].value.id;
      const login = await request('/api/auth/login', 'POST', { ...credentials.users[index], turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' });
      if (!cookie) throw new Error('QA login did not issue a session');
      assertFixtureIdentity(login, expected, accountA);
      assertFixtureIdentity(await request('/api/me'), expected, accountA);
      checks.push(`real_turnstile_login_user_${index + 1}`);
      if (index === 0) {
        const switched = await request('/api/auth/switch-account', 'POST', { account_id: accountB });
        assertFixtureIdentity(switched, expected, accountB);
        assertFixtureIdentity(await request('/api/me'), expected, accountB);
        checks.push('authorized_second_account_preserves_actor');
      } else {
        const denied = await labRequest('/api/auth/switch-account', { method: 'POST', body: { account_id: accountB }, cookie });
        assertDeniedSwitch(denied);
        assertFixtureIdentity(await request('/api/me'), expected, accountA);
        checks.push('foreign_account_denied_without_cookie_or_identity_change');
      }
      await request('/api/auth/logout', 'POST', {}); cookie = '';
    }
  } finally {
    if (cookie) { await labRequest('/api/auth/logout', { method: 'POST', body: {}, cookie }).catch(() => {}); cookie = ''; }
  }
  const report = { kind: 'isolated-qa-auth-verification', run_id: lab.run_id, capture_revision: lab.capture_revision, installer_sha256: lab.installer_sha256, images: lab.images, checked_at: new Date().toISOString(), checks: checks.map(id => ({ id, status: 'passed' })), provider: 'official-turnstile-test-keys', windows_validation: 'not_run' };
  const output = join(labRoot, `auth-verification-${Date.now()}.json`);
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`QA autenticación y aislamiento aprobados: ${checks.length} comprobaciones. Evidencia ${output}; Windows not_run.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyFixtures(); }
  catch (error) { console.error(`QA autenticación detenida: ${error.code ?? error.message}. No se imprimen credenciales ni cookies.`); process.exitCode = 1; }
}
