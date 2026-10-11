import { DOCUMENT_EXPORT_PROFILES, type ExportOptions } from '@/lib/fabric/export'
export type ExportProfile = keyof typeof DOCUMENT_EXPORT_PROFILES | 'custom'
export interface ExportPreference { profile: ExportProfile; dpi: number; quality: number; transparent: boolean }
export function normalizeExportPreference(raw: unknown, format: ExportOptions['format'] = 'pdf'): ExportPreference {
 const value = raw && typeof raw === 'object' ? raw as Partial<ExportPreference> : {}
 const defaults = DOCUMENT_EXPORT_PROFILES[format === 'pdf' ? 'print' : 'balanced']
 const profile = value.profile && [...Object.keys(DOCUMENT_EXPORT_PROFILES), 'custom'].includes(value.profile) ? value.profile : format === 'pdf' ? 'print' : 'balanced'
 const preset = profile === 'custom' ? null : DOCUMENT_EXPORT_PROFILES[profile]
 return { profile, dpi: preset?.dpi ?? (Number.isFinite(value.dpi) ? Math.min(600, Math.max(72, Number(value.dpi))) : defaults.dpi), quality: preset?.quality ?? (Number.isFinite(value.quality) ? Math.min(1, Math.max(.1, Number(value.quality))) : defaults.quality), transparent: value.transparent === true }
}
function preferenceKey(identity: string, format: ExportOptions['format']) { return `clarin:document-export:v1:${identity}:${format}` }
export function readExportPreference(identity: string, format: ExportOptions['format']): ExportPreference { try { return normalizeExportPreference(JSON.parse(localStorage.getItem(preferenceKey(identity, format)) || 'null'), format) } catch { return normalizeExportPreference(null, format) } }
export function saveExportPreference(identity: string, format: ExportOptions['format'], value: ExportPreference) { try { localStorage.setItem(preferenceKey(identity, format), JSON.stringify(normalizeExportPreference(value, format))) } catch { /* export remains usable in private/read-only storage */ } }
