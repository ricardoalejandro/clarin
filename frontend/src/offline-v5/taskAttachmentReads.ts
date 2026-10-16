import { offlineV5TaskAttachmentDescriptors } from './manifest'
import type { OfflineV5RouteResponse, OfflineV5Snapshot } from './types'

type Row = Record<string, unknown>
export function preparedTaskAttachments(snapshot: OfflineV5Snapshot, taskID: string): Row[] {
  const descriptors = new Map(offlineV5TaskAttachmentDescriptors(snapshot).filter(value => value.task_id === taskID).map(value => [value.id, value]))
  return (Array.isArray(snapshot.payload.attachments) ? snapshot.payload.attachments : []).filter(value => value && typeof value === 'object' && (value as Row).task_id === taskID).map(value => {
    const row = value as Row, available = descriptors.has(String(row.id))
    return { ...row, available_offline: available, url: `/api/tasks/${encodeURIComponent(taskID)}/attachments/${encodeURIComponent(String(row.id))}/download` }
  })
}

export async function readPreparedTaskAttachment(snapshot: OfflineV5Snapshot, taskID: string, suffix: string, getBlob: (id: string) => Promise<Blob>): Promise<OfflineV5RouteResponse | undefined> {
  const match = suffix.match(/^attachments\/([^/]+)\/(download|preview|preview\/download)$/)
  if (!match) return undefined
  const id = decodeURIComponent(match[1]), attachment = preparedTaskAttachments(snapshot, taskID).find(value => value.id === id)
  const json = (status: number, body: unknown): OfflineV5RouteResponse => ({ status, headers: [['Content-Type', 'application/json; charset=utf-8'], ['Cache-Control', 'no-store']], body: JSON.stringify(body) })
  if (!attachment) return json(404, { success: false, error: 'not_prepared', message: 'Este archivo no pertenece a la tarea preparada.' })
  if (!attachment.available_offline) return json(503, { success: false, error: 'not_prepared', message: 'Este archivo no tiene una copia offline verificada.' })
  const type = String(attachment.content_type)
  if (match[2] === 'preview') {
    const kind = type.startsWith('image/') ? 'image' : type === 'application/pdf' ? 'pdf' : type === 'text/plain' ? 'text' : 'unsupported'
    return json(200, { success: true, preview: { attachment_id: id, kind, status: kind === 'unsupported' ? 'unsupported' : 'ready',
      content_type: type, size_bytes: attachment.size_bytes, filename: attachment.filename, url: attachment.url,
      can_comment: false, error: kind === 'unsupported' ? 'El original está preparado; su conversión requiere conexión.' : undefined } })
  }
  const blob = await getBlob(id)
  if (blob.size !== attachment.size_bytes || blob.type !== type) return json(422, { success: false, error: 'blob_integrity', message: 'La copia del archivo está incompleta o alterada.' })
  return { status: 200, headers: [['Content-Type', type], ['Content-Length', String(blob.size)], ['Cache-Control', 'no-store'],
    ['Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(String(attachment.filename || 'archivo'))}`],
    ['X-Content-Type-Options', 'nosniff'], ['X-Clarin-Offline', '5']], binary: blob }
}
