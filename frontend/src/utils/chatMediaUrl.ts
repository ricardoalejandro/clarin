// Keep one stable identity for chat media regardless of whether legacy rows
// contain the public MinIO URL or the current authenticated proxy URL.
export function canonicalChatMediaUrl(url: string | undefined): string {
  if (!url) return ''
  if (url.startsWith('/api/media/')) return url
  if (url.startsWith('blob:')) return url

  const bucketMatch = url.match(/\/clarin-media\/(.+)$/)
  if (bucketMatch) return `/api/media/file/${bucketMatch[1]}`
  return ''
}

export function chatMediaIdentity(url: string): string {
  return canonicalChatMediaUrl(url) || url
}
