// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { offlineV5TaskAttachmentDescriptors } from './manifest'
import { preparedTaskAttachments, readPreparedTaskAttachment } from './taskAttachmentReads'
import { OfflineV5OnlineClient } from './onlineClient'
import type { OfflineV5PrepareBundle, OfflineV5Snapshot } from './types'

const digest = 'a'.repeat(64)
function snapshot(): OfflineV5Snapshot {
  return { module: 'tasks', root_resource_id: 'list-one', root_selection_id: 'selection-one', payload: {
    tasks: [{ id: 'task-one', list_id: 'list-one' }], attachments: [{ id: 'file-one', task_id: 'task-one', filename: 'Notas.txt',
      content_type: 'text/plain', content_hash: digest, size_bytes: 4, available_offline: true }],
  } } as unknown as OfflineV5Snapshot
}

describe('verified existing task attachments', () => {
  it('binds the descriptor to the prepared list and exact task without persisting storage URLs', () => {
    expect(offlineV5TaskAttachmentDescriptors(snapshot())).toEqual([{ kind: 'task_attachment', id: 'file-one', file_id: 'file-one',
      task_id: 'task-one', root_resource_id: 'list-one', content_hash: digest, content_type: 'text/plain', size_bytes: 4 }])
    expect(preparedTaskAttachments(snapshot(), 'task-one')[0].url).toBe('/api/tasks/task-one/attachments/file-one/download')
    expect(preparedTaskAttachments(snapshot(), 'foreign-task')).toEqual([])
  })

  it('rejects an attachment outside the prepared task or with unverified/active content', () => {
    for (const change of [{ task_id: 'foreign-task' }, { content_hash: 'missing' }, { content_type: 'text/html' }, { object_key: 'account/private' }, { size_bytes: -1 }]) {
      const value = snapshot(); Object.assign((value.payload.attachments as any[])[0], change)
      expect(() => offlineV5TaskAttachmentDescriptors(value)).toThrow()
    }
  })

  it('serves the same viewer preview and reads only the exact prepared binary', async () => {
    const getBlob = vi.fn(async () => new Blob(['hola'], { type: 'text/plain' }))
    const preview = await readPreparedTaskAttachment(snapshot(), 'task-one', 'attachments/file-one/preview', getBlob)
    expect(JSON.parse(preview!.body!)).toMatchObject({ preview: { kind: 'text', status: 'ready', url: '/api/tasks/task-one/attachments/file-one/download', can_comment: false } })
    const file = await readPreparedTaskAttachment(snapshot(), 'task-one', 'attachments/file-one/download', getBlob)
    expect(await file!.binary!.text()).toBe('hola')
    expect(getBlob).toHaveBeenCalledExactlyOnceWith('file-one')
    expect((await readPreparedTaskAttachment(snapshot(), 'foreign-task', 'attachments/file-one/download', getBlob))!.status).toBe(404)
    expect(getBlob).toHaveBeenCalledTimes(1)
  })

  it('keeps unprepared metadata honest and rejects a truncated local file', async () => {
    const value = snapshot(); (value.payload.attachments as any[])[0].available_offline = false
    const read = vi.fn()
    expect((await readPreparedTaskAttachment(value, 'task-one', 'attachments/file-one/download', read))!.status).toBe(503)
    expect(read).not.toHaveBeenCalled()
    expect((await readPreparedTaskAttachment(snapshot(), 'task-one', 'attachments/file-one/download', async () => new Blob(['x'], { type: 'text/plain' })))!.status).toBe(422)
  })

  it('downloads originals through the task-authorized path and verifies hash before retaining bytes', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('hola', { headers: { 'Content-Type': 'text/plain', 'X-Clarin-Response': '1' } }))
    const client = new OfflineV5OnlineClient('http://localhost:19445', fetcher as typeof fetch)
    await expect(client.downloadPreparedAssets({ snapshots: [snapshot()] } as OfflineV5PrepareBundle)).rejects.toMatchObject({ code: 'offline_asset_integrity_failed' })
    expect(String(fetcher.mock.calls[0][0])).toBe('http://localhost:19445/api/tasks/task-one/attachments/file-one/download')
  })
})
