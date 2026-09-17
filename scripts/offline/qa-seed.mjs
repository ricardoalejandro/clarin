#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labRoot, labRequest, verifyLabIdentity } from './qa-environment.mjs';

export function fixtureAccounts(runID) {
  if (!/^[a-f0-9-]{36}$/.test(runID)) throw new Error('Invalid QA run ID');
  return ['A', 'B'].map(letter => ({ name: `OFFLINE QA ${letter} — datos ficticios`, slug: `offline-qa-${letter.toLowerCase()}-${runID.slice(0, 8)}`, plan: 'enterprise', max_devices: 1, max_users_override: 20, storage_limit_bytes: 5 * 1024 ** 3, kommo_enabled: false }));
}
export function fixtureUser(credential, index, accountIDs) {
  if (!/^offlineqa_user_\d{2}$/.test(credential.username) || index < 0 || index > 9 || accountIDs.length !== 2) throw new Error('Invalid synthetic user fixture');
  return { username: credential.username, display_name: `Usuario QA ${String(index + 1).padStart(2, '0')}`, email: `${credential.username}@example.invalid`, password: credential.password, password_confirm: credential.password,
    accounts: [{ account_id: accountIDs[0], role: 'admin', is_default: true }, ...(index === 0 ? [{ account_id: accountIDs[1], role: 'admin', is_default: false }] : [])] };
}

export async function seedLab() {
  const lab = await verifyLabIdentity(); // Mandatory before credentials or any mutation.
  const credentials = JSON.parse(await readFile(join(labRoot, 'credentials.json'), 'utf8'));
  const ledgerPath = join(labRoot, 'fixtures.json');
  let ledger;
  try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ledger = { run_id: lab.run_id, state: 'preparing', steps: {} }; }
  if (ledger.run_id !== lab.run_id) throw new Error('Fixture ledger belongs to another lab');
  if (ledger.state === 'complete') { console.log('Fixtures ya preparados; no se duplicó ninguna escritura.'); return; }
  const save = () => writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  let cookie = '';
  const request = async (path, method = 'GET', body) => {
    const response = await labRequest(path, { method, body, cookie });
    if (response.headers['set-cookie']) cookie = response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`Synthetic fixture request failed: ${method} ${path} HTTP ${response.status}`);
      error.status = response.status; throw error;
    }
    return JSON.parse(response.text);
  };
  const login = async credential => {
    cookie = '';
    const user = await request('/api/auth/login', 'POST', { ...credential, turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' });
    if (!cookie || user.user?.username !== credential.username) throw new Error('Unexpected QA login identity');
    return user.user;
  };
  // Stop on an uncertain write. Do not replay a non-idempotent request after
  // losing its response; inspect the isolated account and reconcile explicitly.
  const step = async (name, action) => {
    if (ledger.steps[name]?.state === 'done') return ledger.steps[name].value;
    if (ledger.steps[name]?.state === 'in_flight') throw new Error(`Uncertain fixture step ${name}; inspect QA before retrying`);
    ledger.steps[name] = { state: 'in_flight' }; await save();
    try {
      const value = await action(); ledger.steps[name] = { state: 'done', value }; await save(); return value;
    } catch (error) {
      if ([400, 401, 403, 404, 422].includes(error.status)) { ledger.steps[name] = { state: 'rejected', status: error.status }; await save(); }
      throw error;
    }
  };
  const admin = await login(credentials.admin);
  if (!admin.is_super_admin) throw new Error('Expected isolated QA superadmin');
  const accounts = [];
  for (const [index, body] of fixtureAccounts(lab.run_id).entries()) {
    accounts.push(await step(`account_${index}`, async () => (await request('/api/admin/accounts/', 'POST', body)).account));
  }
  const accountIDs = accounts.map(account => account.id);
  for (const [index, credential] of credentials.users.entries()) {
    await step(`user_${index}`, async () => {
      const user = (await request('/api/admin/users/', 'POST', fixtureUser(credential, index, accountIDs))).user;
      if (user.is_super_admin) throw new Error('Fixture users must never be superadmin');
      return { id: user.id, username: user.username, is_super_admin: false };
    });
  }
  await login(credentials.users[0]);
  for (const [index, account] of accounts.entries()) {
    if (index > 0) await request('/api/auth/switch-account', 'POST', { account_id: account.id });
    const environment = await step(`environment_${index}`, async () => (await request('/api/tasks/environments', 'POST', { name: `Entorno QA ${index + 1}`, operation_id: randomUUID() })).environment);
    for (let listIndex = 0; listIndex < 2; listIndex++) {
      const list = await step(`list_${index}_${listIndex}`, async () => (await request('/api/tasks/lists', 'POST', { environment_id: environment.id, name: `Lista QA ${listIndex + 1}` })).list);
      await step(`task_${index}_${listIndex}`, async () => {
        const response = await request('/api/tasks/', 'POST', { list_id: list.id, title: `Tarea ficticia cuenta ${index + 1} lista ${listIndex + 1}`, description: 'Sólo laboratorio. No corresponde a una persona ni actividad real.', operation_id: randomUUID() });
        return { id: response.task?.id ?? response.id, list_id: list.id };
      });
    }
    for (let contactIndex = 0; contactIndex < 3; contactIndex++) await step(`contact_${index}_${contactIndex}`, async () => {
      const response = await request('/api/contacts/', 'POST', { name: `CONTACTO FICTICIO ${index + 1}-${contactIndex + 1}`, email: `qa-${index}-${contactIndex}@example.invalid`, notes: 'Dato sintético exclusivo de QA, sin teléfono.' });
      return { id: response.contact?.id ?? response.id };
    });
    await step(`program_${index}`, async () => {
      const response = await request('/api/programs/', 'POST', { name: `Programa ficticio cuenta ${index + 1}`, type: 'course', description: 'Sólo laboratorio offline' });
      return { id: response.program?.id ?? response.id };
    });
    await step(`whiteboard_${index}`, async () => {
      const response = await request('/api/whiteboards/', 'POST', { name: `Pizarra ficticia cuenta ${index + 1}`, access_mode: 'account', operation_id: randomUUID() });
      return { id: response.whiteboard?.id ?? response.id };
    });
  }
  // Prove the second user cannot select account B through ordinary auth.
  await login(credentials.users[1]);
  const denied = await labRequest('/api/auth/switch-account', { method: 'POST', cookie, body: { account_id: accountIDs[1] } });
  if (denied.status !== 403 || denied.headers['set-cookie']) throw new Error('Cross-account fixture guard failed');
  cookie = '';
  ledger.state = 'complete'; ledger.completed_at = new Date().toISOString(); ledger.online_cross_account_denied = true; ledger.windows_validation = 'not_run'; await save();
  console.log('Fixtures sintéticos preparados: 2 cuentas, 10 usuarios no superadmin, 2 listas/2 tareas/3 contactos/1 programa/1 pizarra por cuenta. Autorizaciones offline: ninguna.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await seedLab(); }
  catch (error) { console.error(`QA fixtures detenidos: ${error.code ?? error.message}. Cookies y contraseñas no se imprimen.`); process.exitCode = 1; }
}
