import type { DocumentTemplate } from '@/types/document'
export interface DocumentLibraryPage { templates: DocumentTemplate[]; total: number; has_more: boolean; next_cursor: string }
export function documentLibraryPath(query = '', cursor = '') { const params = new URLSearchParams({ limit: '50' }); if (query.trim()) params.set('q', query.trim()); if (cursor) params.set('cursor', cursor); return `/api/document-templates?${params}` }
export function mergeDocumentPage(previous: DocumentTemplate[], incoming: DocumentTemplate[]) { const merged = new Map(previous.map(item => [item.id, item])); for (const item of incoming) merged.set(item.id, item); return [...merged.values()] }
export function safeDocumentFilename(name: string) { return (name.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'plantilla') }
