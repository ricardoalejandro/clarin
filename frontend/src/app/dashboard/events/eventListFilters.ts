export function eventListQuery({ search, status, includeCancelled, folderID, limit, offset, sort, direction }: {
  search: string
  status: string
  includeCancelled: boolean
  folderID: string | null
  limit: number
  sort?: string
  direction?: 'asc'|'desc'
  offset: number
}) {
  const params = new URLSearchParams()
  if (search) params.set('search', search)
  if (status) params.set('status', status)
  else if (!includeCancelled) params.set('exclude_cancelled', 'true')
  params.set('folder', folderID ?? 'root')
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (sort) params.set('sort', sort)
  if (direction) params.set('direction', direction)
  return params
}
