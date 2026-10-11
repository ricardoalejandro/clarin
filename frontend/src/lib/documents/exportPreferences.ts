import { DOCUMENT_EXPORT_PROFILES, type ExportOptions } from '@/lib/fabric/export'
export type ExportProfile = keyof typeof DOCUMENT_EXPORT_PROFILES | 'custom'
export interface ExportPreference { profile: ExportProfile; dpi: number; quality: number; transparent: boolean }
export function normalizeExportPreference(raw: unknown): ExportPreference {
 const value = raw && typeof raw === 'object' ? raw as Partial<ExportPreference> : {}
 const profile = value.profile && [...Object.keys(DOCUMENT_EXPORT_PROFILES), 'custom'].includes(value.profile) ? value.profile : 'print'
 const preset = profile === 'custom' ? null : DOCUMENT_EXPORT_PROFILES[profile]
 return { profile, dpi: preset?.dpi ?? (Number.isFinite(value.dpi) ? Math.min(600, Math.max(72, Number(value.dpi))) : 300), quality: preset?.quality ?? (Number.isFinite(value.quality) ? Math.min(1, Math.max(.1, Number(value.quality))) : .95), transparent: value.transparent === true }
}
function preferenceKey(identity: string, format: ExportOptions['format']) { return `clarin:document-export:v1:${identity}:${format}` }
export function readExportPreference(identity: string, format: ExportOptions['format']): ExportPreference { try { return normalizeExportPreference(JSON.parse(localStorage.getItem(preferenceKey(identity, format)) || 'null')) } catch { return normalizeExportPreference(null) } }
export function saveExportPreference(identity: string, format: ExportOptions['format'], value: ExportPreference) { try { localStorage.setItem(preferenceKey(identity, format), JSON.stringify(normalizeExportPreference(value))) } catch { /* export remains usable in private/read-only storage */ } }
