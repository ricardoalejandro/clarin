import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { authenticateLab, failNext, labRequest, readIntegrityLab, type IntegrityLab } from './helpers/integrity-qa'

const lab = readIntegrityLab()
const execute = promisify(execFile)
const labDirectory = '/root/clarin-integrity-qa-20261007'
const labProject = 'clarin-integrity-qa-20261007'
const postgres = `${labProject}-postgres-1`
const database = 'program_survey_integrity_test'
const psql = `cd ${labDirectory} && docker exec -i ${postgres} psql -U qa -d ${database} -At -v ON_ERROR_STOP=1`
let databaseGuard: Promise<void> | undefined

function uuidSQL(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Expected a synthetic UUID.')
  return `'${id}'::uuid`
}

async function rawSQL(statement: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile('ssh', ['-T', 'vps', psql], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      // Do not include SSH/environment output or authentication material.
      if (error) reject(new Error('The guarded synthetic device PostgreSQL fixture command failed.'))
      else resolve(stdout.trim())
    })
    child.stdin!.end(statement)
  })
}

async function qaSQL(statement: string) {
  databaseGuard ||= (async () => {
    const project = await execute('ssh', ['-T', 'vps', `cd ${labDirectory} && docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' ${postgres}`], { timeout: 30_000, windowsHide: true, encoding: 'utf8' })
    expect(project.stdout.trim(), 'Only the exact disposable Compose project may receive fixtures').toBe(labProject)
    expect(await rawSQL('SELECT current_database();')).toBe(database)
  })()
  await databaseGuard
  return rawSQL(statement)
}

async function deviceUsage(page: Page, fixture: IntegrityLab) {
  const overview = await labRequest(page, fixture, '/api/subscription')
  expect(overview.success).toBe(true)
  expect(Number.isInteger(overview.subscription.usage.devices)).toBe(true)
  return overview.subscription.usage.devices as number
}

async function createUnlinkedDevice(page: Page, fixture: IntegrityLab) {
  const name = `Device integrity QA ${randomUUID()}`
  const created = await labRequest(page, fixture, '/api/devices', { method: 'POST', data: { name }, expectedStatus: 201 })
  expect(created.success).toBe(true)
  expect(created.device.account_id).toBe(fixture.account_id)
  expect(created.device.status).toBe('disconnected')
  expect(created.device.jid ?? null).toBeNull()
  return { id: created.device.id as string, name }
}

async function absentDevice(page: Page, fixture: IntegrityLab, id: string) {
  const response = await page.request.get(new URL(`/api/devices/${id}`, fixture.api_url || fixture.base_url).href)
  expect([200, 404]).toContain(response.status())
  return response.status() === 404
}

async function cleanUnlinkedDevice(page: Page, fixture: IntegrityLab, id: string) {
  if (!await absentDevice(page, fixture, id)) {
    await labRequest(page, fixture, `/api/devices/${id}`, { method: 'DELETE', expectedStatus: 202 })
    await expect.poll(() => absentDevice(page, fixture, id), { timeout: 30_000 }).toBe(true)
  }
}

test.describe('Durable device deletion on the disposable laboratory', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!lab, 'Requires explicitly synthetic, loopback-only .runtime/qa-lab-credentials.json.')
  test.setTimeout(240_000)
  test.beforeEach(async ({ page }) => { await authenticateLab(page, lab!) })

  test('Settings retains a device after DELETE 500 and the next delete completes through the real API', async ({ page }) => {
    const before = await deviceUsage(page, lab!)
    const device = await createUnlinkedDevice(page, lab!)
    let failure: Awaited<ReturnType<typeof failNext>> | undefined
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${lab!.base_url}/dashboard/settings?tab=devices`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await expect(page.getByRole('heading', { name: 'Dispositivos WhatsApp', exact: true })).toBeVisible({ timeout: 90_000 })
      const row = page.locator('article').filter({ has: page.getByText(device.name, { exact: true }) })
      await expect(row).toHaveCount(1)
      await expect(page.getByText(`${before + 1} disponibles · ${before + 1} en la cuenta. Las eliminaciones pendientes siguen ocupando su plaza.`, { exact: true })).toBeVisible()
      page.on('dialog', async dialog => {
        expect(dialog.type()).toBe('confirm')
        expect(dialog.message()).toBe('¿Estás seguro de eliminar este dispositivo?')
        await dialog.accept()
      })
      const path = `/api/devices/${device.id}`
      failure = await failNext(page, (url, method) => url.pathname === path && method === 'DELETE', 'QA device deletion unavailable')
      await row.getByTitle('Eliminar', { exact: true }).click()
      await expect(page.getByRole('alert').filter({ hasText: 'QA device deletion unavailable' })).toBeVisible()
      expect(failure.didFail()).toBe(true)
      await expect(row).toHaveCount(1)
      await expect(row.getByTitle('Eliminar', { exact: true })).toBeEnabled()
      expect((await labRequest(page, lab!, path)).device.deletion).toBeUndefined()
      expect(await deviceUsage(page, lab!)).toBe(before + 1)

      const accepted = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'DELETE')
      await row.getByTitle('Eliminar', { exact: true }).click()
      const response = await accepted
      expect(response.status()).toBe(202)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.device_id).toBe(device.id)
      expect(result.operation_id).toBeTruthy()
      expect(result.deletion_status).toBe('pending')
      await expect.poll(() => absentDevice(page, lab!, device.id), { timeout: 30_000 }).toBe(true)
      await expect(row).toHaveCount(0, { timeout: 15_000 })
      await expect.poll(() => deviceUsage(page, lab!)).toBe(before)
    } finally {
      await failure?.remove()
      await cleanUnlinkedDevice(page, lab!, device.id)
    }
  })

  test('pending repeats one operation, retains quota, and completion preserves account and detached history', async ({ page }) => {
    const before = await deviceUsage(page, lab!)
    const accountBefore = (await labRequest(page, lab!, '/api/settings')).account
    const device = await createUnlinkedDevice(page, lab!)
    const contact = randomUUID(), chat = randomUUID(), message = randomUUID()
    const accountSQL = uuidSQL(lab!.account_id), deviceSQL = uuidSQL(device.id)
    const contactSQL = uuidSQL(contact), chatSQL = uuidSQL(chat), messageSQL = uuidSQL(message)
    const barrier = `qa_device_pending_${device.id.replaceAll('-', '')}`
    const release = async () => {
      await qaSQL(`DROP TRIGGER IF EXISTS ${barrier} ON devices; DROP FUNCTION IF EXISTS ${barrier}(); UPDATE devices SET delete_next_attempt_at=NOW() WHERE account_id=${accountSQL} AND id=${deviceSQL} AND delete_operation_id IS NOT NULL;`)
    }
    const history = async () => JSON.parse(await qaSQL(`SELECT json_build_object(
      'contact',(SELECT json_build_object('id',id,'account_id',account_id,'device_id',device_id,'name',name) FROM contacts WHERE account_id=${accountSQL} AND id=${contactSQL}),
      'chat',(SELECT json_build_object('id',id,'account_id',account_id,'device_id',device_id,'contact_id',contact_id) FROM chats WHERE account_id=${accountSQL} AND id=${chatSQL}),
      'message',(SELECT json_build_object('id',id,'account_id',account_id,'device_id',device_id,'chat_id',chat_id,'body',body) FROM messages WHERE account_id=${accountSQL} AND id=${messageSQL}));`))
    try {
      // All rows are owned by this test, separate from the shared Contact graph.
      // The UUID-specific QA barrier postpones the first cleanup claim without
      // a provider connection or a scheduler race; it is always removed below.
      await qaSQL(`BEGIN;
        INSERT INTO contacts(id,account_id,device_id,jid,name) VALUES(${contactSQL},${accountSQL},${deviceSQL},'${contact}@test.invalid','Synthetic device history parent');
        INSERT INTO chats(id,account_id,device_id,contact_id,jid,name) VALUES(${chatSQL},${accountSQL},${deviceSQL},${contactSQL},'${contact}@test.invalid','Synthetic device history chat');
        INSERT INTO messages(id,account_id,device_id,chat_id,message_id,body,message_type,timestamp) VALUES(${messageSQL},${accountSQL},${deviceSQL},${chatSQL},'${message}','Synthetic retained device history','text',NOW());
        CREATE FUNCTION ${barrier}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.id=${deviceSQL} AND NEW.account_id=${accountSQL} AND OLD.delete_operation_id IS NULL AND NEW.delete_operation_id IS NOT NULL THEN NEW.delete_next_attempt_at=NOW()+INTERVAL '5 minutes'; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER ${barrier} BEFORE UPDATE OF delete_operation_id ON devices FOR EACH ROW EXECUTE FUNCTION ${barrier}();
        COMMIT;`)
      const retained = await history()
      const path = `/api/devices/${device.id}`
      const first = await labRequest(page, lab!, path, { method: 'DELETE', expectedStatus: 202 })
      expect(first.deletion_status).toBe('pending')
      expect(first.devices_total).toBe(before + 1)
      expect(first.devices_available).toBe(before)
      expect(first.contacts_detached).toBe(1)
      expect(first.chats_detached).toBe(1)
      const pending = (await labRequest(page, lab!, path)).device
      expect(pending.status).toBe('deleting')
      expect(pending.deletion.operation_id).toBe(first.operation_id)
      expect(pending.deletion.phase).toBe('remote_unlinked')
      expect(pending.deletion.attempts).toBe(0)
      expect(new Date(pending.deletion.next_retry_at).getTime()).toBeGreaterThan(Date.now())
      expect(await deviceUsage(page, lab!)).toBe(before + 1)
      const repeated = await labRequest(page, lab!, path, { method: 'DELETE', expectedStatus: 202 })
      expect(repeated.operation_id).toBe(first.operation_id)
      expect(repeated.deletion_status).toBe('pending')
      expect(repeated.devices_total).toBe(before + 1)
      expect(repeated.contacts_detached).toBe(0)
      expect(repeated.chats_detached).toBe(0)
      const detached = await history()
      expect(detached.contact).toEqual({ ...retained.contact, device_id: null })
      expect(detached.chat).toEqual({ ...retained.chat, device_id: null })
      expect(detached.message).toEqual(retained.message)

      await release()
      await expect.poll(() => absentDevice(page, lab!, device.id), { timeout: 30_000 }).toBe(true)
      await expect.poll(() => deviceUsage(page, lab!)).toBe(before)
      const completed = await history()
      expect(completed.contact).toEqual(detached.contact)
      expect(completed.chat).toEqual(detached.chat)
      expect(completed.message).toEqual({ ...retained.message, device_id: null })
      expect((await labRequest(page, lab!, '/api/settings')).account).toEqual(accountBefore)
      const messages = await labRequest(page, lab!, `/api/chats/${chat}/messages`)
      expect(messages.messages.some((row: { id: string; body: string }) => row.id === message && row.body === retained.message.body)).toBe(true)
      await labRequest(page, lab!, path, { method: 'DELETE', expectedStatus: 404 })
    } finally {
      await release()
      await cleanUnlinkedDevice(page, lab!, device.id)
      await qaSQL(`BEGIN; DELETE FROM messages WHERE account_id=${accountSQL} AND id=${messageSQL}; DELETE FROM chats WHERE account_id=${accountSQL} AND id=${chatSQL}; DELETE FROM contacts WHERE account_id=${accountSQL} AND id=${contactSQL}; COMMIT;`)
    }
  })
})
