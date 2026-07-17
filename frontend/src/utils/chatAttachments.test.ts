import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_CHAT_VIDEO_SIZE, validateChatAttachment } from './chatAttachments'

function attachment(name: string, type: string, size: number): File {
  return { name, type, size } as File
}

test('classifies GIF before generic image media', () => {
  assert.deepEqual(validateChatAttachment(attachment('saludo.gif', 'image/gif', 1024)), {
    ok: true,
    mediaType: 'gif',
  })
  assert.deepEqual(validateChatAttachment(attachment('saludo.gif', '', 1024)), {
    ok: true,
    mediaType: 'gif',
  })
})

test('applies the WhatsApp video limit to GIF files', () => {
  const result = validateChatAttachment(attachment('pesado.gif', 'image/gif', MAX_CHAT_VIDEO_SIZE + 1))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /GIF.*15 MB/)
})
