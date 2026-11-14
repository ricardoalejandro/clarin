import { randomUUID } from 'node:crypto'
import type { Route } from '@playwright/test'

export type MockUtilityDocument = { id: string; type: string; title: string; folder_id: string | null; favorite: boolean; version: number; config: Record<string, unknown>; slots: { slot: string; version: number; bytes: number; content_type: string }[]; created_at: string; updated_at: string; snippet?: string }

/** Stateful test server: browser tests exercise real saves/reloads, not constant fixtures. */
export function createUtilitiesLibraryMock() {
  const documents = new Map<string, MockUtilityDocument>()
  const contents = new Map<string, Buffer>()
  const folders: { id: string; name: string; version: number }[] = []
  let workspace = { open_ids: [] as string[], active_id: null as string | null, version: 0 }
  let failNextSave = 0
  const operations = new Map<string, unknown>()
  const writes: string[] = []

  async function handle(route: Route) {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/api\/utilities/, ''), method = request.method()
    if (!url.pathname.startsWith('/api/utilities/') || path === '/access') return false
    const reply = (data: unknown, status = 200) => route.fulfill({ status, json: { success: status < 400, ...(status < 400 ? { data } : { error: 'La versión cambió en otra sesión.' }) } })
    const body = () => request.postDataJSON() as Record<string, any>
    if (path === '/workspace') {
      if (method === 'PUT') { const input = body(); workspace = { open_ids: input.open_ids, active_id: input.active_id, version: workspace.version + 1 } }
      await reply({ workspace }); return true
    }
    if (path === '/folders') {
      if (method === 'POST') { const folder = { id: randomUUID(), name: body().name, version: 1 }; folders.push(folder); await reply({ folder }) }
      else await reply({ folders })
      return true
    }
    if (path === '/vault') { await reply({ entries: [], available: true }); return true }
    if (path === '/documents' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const items = [...documents.values()].filter(document => (!url.searchParams.get('type') || document.type === url.searchParams.get('type')) && (!url.searchParams.has('folder_id') || document.folder_id === (url.searchParams.get('folder_id') || null)) && (url.searchParams.get('favorite') !== 'true' || document.favorite) && (!q || document.title.toLowerCase().includes(q) || document.type !== 'criptografia' && document.slots.some(slot => contents.get(`${document.id}/${slot.slot}`)?.toString('utf8').toLowerCase().includes(q))))
      await reply({ documents: items.map(document => ({ ...document, slots: [], ...(q ? { snippet: 'Coincidencia en el documento guardado' } : {}) })), has_more: false, next_cursor: '' }); return true
    }
    if (path === '/documents' && method === 'POST') {
      const input = body(), id = randomUUID(), timestamp = new Date().toISOString()
      const document: MockUtilityDocument = { id, type: input.type, title: input.title, folder_id: input.folder_id ?? null, favorite: false, config: input.config ?? {}, slots: [], version: 1, created_at: timestamp, updated_at: timestamp }
      documents.set(id, document); writes.push(`create:${id}`); await reply({ document }); return true
    }
    const match = /^\/documents\/([^/]+)(?:\/(content\/([^/]+)|changes))?$/.exec(path)
    if (!match) { await reply({}); return true }
    const document = documents.get(match[1])
    if (!document) { await reply({}, 404); return true }
    const operation = request.headers()['x-operation-id'] || (method === 'PATCH' ? body().operation_id : undefined)
    if (operation && operations.has(operation)) { await reply(operations.get(operation)); return true }
    if (failNextSave && (method === 'PUT' || method === 'PATCH')) { const status = failNextSave; failNextSave = 0; await reply({}, status); return true }
    if (match[2] === undefined) {
      if (method === 'GET') { await reply({ document }); return true }
      if (method === 'DELETE') {
        documents.delete(document.id); document.slots.forEach(slot => contents.delete(`${document.id}/${slot.slot}`)); writes.push(`delete:${document.id}`)
        if (workspace.open_ids.includes(document.id)) workspace = { ...workspace, open_ids: workspace.open_ids.filter(id => id !== document.id), active_id: workspace.active_id === document.id ? null : workspace.active_id, version: workspace.version + 1 }
        await reply({ deleted: true, cleanup_pending: true, workspace }); return true
      }
      const input = body()
      if (input.base_version !== document.version) { await reply({}, 409); return true }
      for (const key of ['title', 'folder_id', 'favorite', 'config']) if (Object.hasOwn(input, key)) (document as any)[key] = input[key]
      document.version++; document.updated_at = new Date().toISOString(); const data = { document: { ...document } }; if (operation) operations.set(operation, data)
      writes.push(`metadata:${document.id}`); await reply(data); return true
    }
    const slotName = match[3] ? decodeURIComponent(match[3]) : body().slot
    const key = `${document.id}/${slotName}`, slot = document.slots.find(slot => slot.slot === slotName)
    if (method === 'GET') {
      await route.fulfill({ status: contents.has(key) ? 200 : 404, body: contents.get(key) ?? Buffer.alloc(0), contentType: slot?.content_type || 'text/plain;charset=utf-8', headers: { 'cache-control': 'no-store', 'X-Content-Version': String(slot?.version ?? 0) } }); return true
    }
    const input = match[2] === 'changes' ? body() : null
    if ((input?.base_version ?? Number(request.headers()['if-match'])) !== (slot?.version ?? 0)) { await reply({}, 409); return true }
    let bytes: Buffer
    if (input) {
      let text = contents.get(key)?.toString('utf8') ?? ''
      for (const edit of [...input.edits].reverse()) text = text.slice(0, edit.offset) + edit.text + text.slice(edit.offset + edit.delete_count)
      bytes = Buffer.from(text)
    } else bytes = request.postDataBuffer() ?? Buffer.alloc(0)
    contents.set(key, bytes)
    const content = { slot: slotName, version: (slot?.version ?? 0) + 1, bytes: bytes.length, content_type: input ? slot?.content_type ?? 'text/plain;charset=utf-8' : request.headers()['content-type'] ?? 'application/octet-stream' }
    document.slots = [...document.slots.filter(item => item.slot !== slotName), content]; document.version++; document.updated_at = new Date().toISOString()
    const data = { document: { ...document }, content }; if (operation) operations.set(operation, data)
    writes.push(`content:${document.id}/${slotName}`); await reply(data); return true
  }
  return { handle, documents, contents, writes, getWorkspace() { return { ...workspace, open_ids: [...workspace.open_ids] } }, failSave(status = 409) { failNextSave = status } }
}
