import { describe, expect, it } from 'vitest'
import type { Message, MessageLinkPreview } from '@/types/chat'
import { localPreviewThumbnail, updateEditedMessageProjection, updateLinkPreviewProjection, updateRevokedMessageProjection, visibleLinkPreview, type LinkPreviewUpdate } from './linkPreviewState'
import { mergeCanonicalMessageProjection } from './messageState'

const preview: MessageLinkPreview = { url: 'HTTPS://EXAMPLE.COM:8443/a_b', title: 'Título recibido', description: 'Descripción recibida', thumbnail_url: null }
const message: Message = { id: 'local', message_id: 'provider', device_id: 'device', body: 'Mira https://example.com:8443/a_b', is_from_me: false, is_read: true, status: 'read', timestamp: '2026-10-19T01:00:00Z', read_at: '2026-10-19T01:01:00Z' }
const update: LinkPreviewUpdate = { chat_id: 'chat', device_id: 'device', message_id: message.id, body_snapshot: message.body!, is_edited_snapshot: false, link_preview: preview, link_preview_version: 0 }
const thumbnail = `/api/media/file/00000000-0000-4000-8000-000000000000/link-previews/${'a'.repeat(64)}.jpg`

describe('received link preview projection', () => {
  it('changes only metadata, by local UUID, retaining read/reaction/mention state and other references', () => {
    const current = { ...message, reactions: [], mentions: [{ jid: 'member', name: 'Ana' }] }
    const unrelated = { ...message, id: 'other', body: 'Otro mensaje' }
    const result = updateLinkPreviewProjection([current, unrelated], update)
    expect(result[0]).toEqual({ ...current, link_preview: preview, link_preview_version: 0 })
    expect(result[1]).toBe(unrelated)
    expect(updateLinkPreviewProjection(result, update)).toBe(result)
    expect(updateLinkPreviewProjection(result, { ...update, link_preview: null, link_preview_version: 1 })[0].link_preview).toBeNull()
  })

  it('keeps detached thumbnails retired through delayed enrichment and accepts a later restoration', () => {
    const withImage = { ...preview, thumbnail_url: thumbnail }
    const enriched = updateLinkPreviewProjection([message], { ...update, link_preview: withImage, link_preview_version: 1 })
    const detached = mergeCanonicalMessageProjection(enriched, { ...message, link_preview: preview, link_preview_version: 2 })
    for (const version of [0, 1, 2]) {
      expect(updateLinkPreviewProjection(detached, { ...update, link_preview: withImage, link_preview_version: version })).toBe(detached)
    }
    expect(detached[0].link_preview?.thumbnail_url).toBeNull()
    const restored = updateLinkPreviewProjection(detached, { ...update, link_preview: withImage, link_preview_version: 3 })
    expect(restored[0]).toMatchObject({ link_preview: withImage, link_preview_version: 3, status: 'read', read_at: message.read_at })
    expect(updateLinkPreviewProjection(restored, { ...update, link_preview: withImage, link_preview_version: 3 })).toBe(restored)
  })

  it.each([undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2'])('rejects an invalid enrichment version %s without changing references', version => {
    const rows = [message]
    expect(updateLinkPreviewProjection(rows, { ...update, link_preview_version: version } as LinkPreviewUpdate)).toBe(rows)
  })

  it('preserves an authoritative zero revision against inconsistent same-version enrichment', () => {
    const rows = [{ ...message, link_preview: null, link_preview_version: 0 }]
    expect(updateLinkPreviewProjection(rows, update)).toBe(rows)
  })

  it('synchronizes edit and revocation versions without reviving metadata from older edits', () => {
    const rows = [{ ...message, link_preview: null, link_preview_version: 2 }]
    const stale = updateEditedMessageProjection(rows, { message_id: message.message_id, new_body: message.body!, link_preview: preview, link_preview_version: 1 })
    expect(stale[0]).toMatchObject({ link_preview: null, link_preview_version: 2, is_edited: true })
    const restored = updateEditedMessageProjection(stale, { message_id: message.message_id, new_body: message.body!, link_preview: preview, link_preview_version: 3 })
    expect(restored[0]).toMatchObject({ link_preview: preview, link_preview_version: 3 })
    expect(updateRevokedMessageProjection(restored, { message_id: message.message_id, link_preview_version: 4 })[0]).toMatchObject({ link_preview: null, link_preview_version: 4, is_revoked: true })
    expect(updateRevokedMessageProjection(restored, { message_id: message.message_id, link_preview_version: 1 })[0]).toMatchObject({ link_preview: null, link_preview_version: 3, is_revoked: true })
    const legacyEdit = updateEditedMessageProjection(restored, { message_id: message.message_id, new_body: 'Sin enlace', link_preview: null })
    expect(legacyEdit[0]).toMatchObject({ link_preview: null, link_preview_version: 3 })
  })

  it.each([{ id: 'other' }, { chat_id: 'other-chat' }, { body: 'Editado' }, { is_edited: true }, { is_revoked: true }, { is_view_once: true }, { device_id: 'other-device' }])('rejects stale enrichment against %j', change => {
    const rows = [{ ...message, ...change }]
    expect(updateLinkPreviewProjection(rows, update)).toBe(rows)
  })

  it('requires the visible body URL, uses its real host, and rejects metadata HTML as a destination', () => {
    expect(visibleLinkPreview({ ...message, link_preview: preview })).toMatchObject({ domain: 'example.com:8443', title: preview.title })
    expect(visibleLinkPreview({ ...message, link_preview: { ...preview, url: 'https://unrelated.example' } })).toBeNull()
    expect(visibleLinkPreview({ ...message, is_revoked: true, link_preview: preview })).toBeNull()
    expect(visibleLinkPreview({ ...message, is_view_once: true, link_preview: preview })).toBeNull()
    expect(visibleLinkPreview({ ...message, link_preview: { ...preview, url: 'javascript:alert(1)' } })).toBeNull()
  })

  it('does not render a redundant domain-only card and accepts an origin URL with canonical trailing slash', () => {
    const empty = { ...preview, title: ' ', description: '', thumbnail_url: 'https://external.example/photo.jpg' }
    expect(visibleLinkPreview({ ...message, link_preview: empty })).toBeNull()
    expect(visibleLinkPreview({ ...message, link_preview: { ...empty, thumbnail_url: thumbnail } })).toMatchObject({ thumbnail })
    expect(visibleLinkPreview({ ...message, body: 'https://example.com', link_preview: { ...preview, url: 'https://EXAMPLE.com/' } })).toMatchObject({ href: 'https://example.com/' })
  })

  it('accepts emphasis around the same visible URL and ignores URLs rendered as inline or fenced code', () => {
    for (const body of [`*${preview.url}*`, `_${preview.url}_`, `~${preview.url}~`]) {
      expect(visibleLinkPreview({ ...message, body, link_preview: preview })).toMatchObject({ href: 'https://example.com:8443/a_b' })
    }
    for (const body of ['`' + preview.url + '`', '```\n' + preview.url + '\n```']) {
      expect(visibleLinkPreview({ ...message, body, link_preview: preview })).toBeNull()
    }
    const changed = { ...message, body: `*${preview.url}*` }
    expect(updateLinkPreviewProjection([changed], update)[0]).toBe(changed)
  })

  it('only accepts the account-scoped local JPEG proxy, never external or ambiguous paths', () => {
    expect(localPreviewThumbnail(thumbnail)).toBe(thumbnail)
    const renewed = thumbnail.replace('.jpg', '-11111111-1111-4111-8111-111111111111.jpg')
    expect(localPreviewThumbnail(renewed)).toBe(renewed)
    for (const value of [`https://example.com${thumbnail}`, `//example.com${thumbnail}`, `${thumbnail}?redirect=https://example.com`, thumbnail.replace('.jpg', '.svg'), thumbnail.replace('.jpg', '-arbitrary.jpg'), thumbnail.replace('link-previews', '%6cink-previews'), thumbnail.replace('link-previews', '..'), '/api/media/file/a.jpg']) {
      expect(localPreviewThumbnail(value)).toBeNull()
    }
  })

  it('clears explicit edits, preserves omitted metadata, receipts and explicit empty mentions', () => {
    const rows = [{ ...message, link_preview: preview, mentions: [{ jid: 'member' }] }]
    const result = updateEditedMessageProjection(rows, { message_id: message.message_id, new_body: 'Texto nuevo', mentions: [], link_preview: null })
    expect(result[0]).toEqual({ ...rows[0], body: 'Texto nuevo', mentions: [], is_edited: true, link_preview: null })
    expect(updateEditedMessageProjection(rows, { message_id: message.message_id, new_body: 'Texto nuevo' })[0].link_preview).toBe(preview)
    const revoked = [{ ...rows[0], is_revoked: true }]
    expect(updateEditedMessageProjection(revoked, { message_id: message.message_id, new_body: 'Texto nuevo' })).toBe(revoked)
  })
})
