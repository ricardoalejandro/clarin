export function eventListQuery({ search, status, includeCancelled, folderID, limit, offset }: {
  search: string
  status: string
  includeCancelled: boolean
  folderID: string | null
  limit: number
  offset: number
}) {
  const params = new URLSearchParams()
  if (search) params.set('search', search)
  if (status) params.set('status', status)
  else if (!includeCancelled) params.set('exclude_cancelled', 'true')
  params.set('folder', folderID ?? 'root')
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  return params
}
