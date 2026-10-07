const EXPORT_PAGE_SIZE = 200

export async function fetchContactExportPages<T extends { id: string }>(
  query: string,
  fetchPage: (query: string) => Promise<{ contacts: T[]; total: number }>,
  isCurrent: () => boolean,
): Promise<T[] | null> {
  const rows = new Map<string, T>()
  let offset = 0
  let expectedTotal: number | undefined
  const changed = () => new Error('La lista cambió durante la exportación. Inténtalo de nuevo.')
  do {
    if (!isCurrent()) return null
    const params = new URLSearchParams(query)
    params.set('limit', String(EXPORT_PAGE_SIZE))
    params.set('offset', String(offset))
    params.set('has_phone', 'false')
    const page = await fetchPage(params.toString())
    if (!isCurrent()) return null
    if (!Number.isSafeInteger(page.total) || page.total < 0 || page.contacts.length > EXPORT_PAGE_SIZE) throw changed()
    if (expectedTotal === undefined) expectedTotal = page.total
    else if (page.total !== expectedTotal) throw changed()
    for (const row of page.contacts) {
      if (rows.has(row.id)) throw changed()
      rows.set(row.id, row)
    }
    offset += page.contacts.length
    if (offset === expectedTotal) return [...rows.values()]
    if (offset > expectedTotal || !page.contacts.length) throw changed()
  } while (true)
}
