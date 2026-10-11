export interface ContactWindowPage<T> { contacts: T[]; total: number }

/** Re-read the loaded window in bounded pages; never retain an unverified tail. */
export async function refreshContactWindow<T extends { id: string }>(loadedCount: number, pageSize: number, fetchPage: (offset: number, limit: number) => Promise<ContactWindowPage<T>>) {
  const target = Math.max(pageSize, loadedCount)
  const contacts: T[] = []
  const ids = new Set<string>()
  let offset = 0
  let total = 0
  do {
    const page = await fetchPage(offset, pageSize)
    total = Math.max(0, page.total)
    for (const contact of page.contacts) {
      if (!ids.has(contact.id)) { ids.add(contact.id); contacts.push(contact) }
    }
    offset += page.contacts.length
    if (!page.contacts.length) break
  } while (offset < target && offset < total)
  return { contacts, total, offset }
}

export interface ContactScrollAnchor { id: string; index: number; offset: number }

export function refreshedContactAnchor<T extends { id: string }>(contacts: T[], anchor: ContactScrollAnchor): ContactScrollAnchor | null {
  if (!contacts.length) return null
  const index = contacts.findIndex(contact => contact.id === anchor.id)
  const nextIndex = index < 0 ? Math.min(anchor.index, contacts.length - 1) : index
  return { ...anchor, id: contacts[nextIndex].id, index: nextIndex }
}
