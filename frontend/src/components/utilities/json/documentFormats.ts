/** Stable saved identifiers. The JSON utility route/configuration remain compatible. */
export const DOCUMENT_FORMATS = [
  { id: 'strict', label: 'JSON', shortLabel: 'JSON', extension: 'json', extensions: ['json'], language: 'json', mime: 'application/json', description: 'Datos JSON · Validación y formato' },
  { id: 'jsonc', label: 'JSON con comentarios (JSONC)', shortLabel: 'JSONC', extension: 'jsonc', extensions: ['jsonc'], language: 'json', mime: 'text/plain', description: 'JSON que admite comentarios y comas finales' },
  { id: 'xml', label: 'XML', shortLabel: 'XML', extension: 'xml', extensions: ['xml', 'xsd', 'xsl', 'xslt', 'svg'], language: 'xml', mime: 'application/xml', description: 'Datos XML · Validación y formato' },
  { id: 'plaintext', label: 'Texto plano (TXT)', shortLabel: 'TXT', extension: 'txt', extensions: ['txt', 'text'], language: 'plaintext', mime: 'text/plain', description: 'Texto sin reglas de sintaxis' },
  { id: 'markdown', label: 'Markdown (MD)', shortLabel: 'MD', extension: 'md', extensions: ['md', 'markdown'], language: 'markdown', mime: 'text/markdown', description: 'Texto y documentación · Resaltado local' },
  { id: 'csv', label: 'CSV', shortLabel: 'CSV', extension: 'csv', extensions: ['csv', 'tsv'], language: 'plaintext', mime: 'text/csv', description: 'Datos delimitados · Edición de texto' },
  { id: 'log', label: 'Registro (LOG)', shortLabel: 'LOG', extension: 'log', extensions: ['log'], language: 'plaintext', mime: 'text/plain', description: 'Registros · Edición de texto' },
  { id: 'yaml', label: 'YAML', shortLabel: 'YAML', extension: 'yaml', extensions: ['yaml', 'yml'], language: 'yaml', mime: 'text/yaml', description: 'Configuración · Resaltado local' },
  { id: 'ini', label: 'INI', shortLabel: 'INI', extension: 'ini', extensions: ['ini', 'conf', 'cfg'], language: 'ini', mime: 'text/plain', description: 'Configuración · Resaltado local' },
  { id: 'html', label: 'HTML', shortLabel: 'HTML', extension: 'html', extensions: ['html', 'htm'], language: 'html', mime: 'text/html', description: 'Código HTML · Sin ejecución ni vista previa' },
  { id: 'css', label: 'CSS', shortLabel: 'CSS', extension: 'css', extensions: ['css'], language: 'css', mime: 'text/css', description: 'Estilos · Resaltado local' },
  { id: 'javascript', label: 'JavaScript (JS)', shortLabel: 'JS', extension: 'js', extensions: ['js', 'mjs', 'cjs', 'jsx'], language: 'javascript', mime: 'text/javascript', description: 'Código JavaScript · Sin ejecución' },
  { id: 'typescript', label: 'TypeScript (TS)', shortLabel: 'TS', extension: 'ts', extensions: ['ts', 'tsx', 'mts', 'cts'], language: 'typescript', mime: 'text/plain', description: 'Código TypeScript · Sin ejecución' },
  { id: 'sql', label: 'SQL', shortLabel: 'SQL', extension: 'sql', extensions: ['sql'], language: 'sql', mime: 'text/plain', description: 'Consultas SQL · Sin ejecución' },
] as const

export type DocumentFormat = typeof DOCUMENT_FORMATS[number]['id']
export type StructuredDocumentFormat = 'strict' | 'jsonc' | 'xml'
export const documentFormat = (id: DocumentFormat) => DOCUMENT_FORMATS.find(format => format.id === id)!
export const isDocumentFormat = (value: unknown): value is DocumentFormat => DOCUMENT_FORMATS.some(format => format.id === value)
export const isStructuredFormat = (format: DocumentFormat): format is StructuredDocumentFormat => format === 'strict' || format === 'jsonc' || format === 'xml'

export function formatFromFileName(name: string): DocumentFormat {
  if (!name.includes('.')) return 'plaintext'
  const extension = name.toLowerCase().split('.').at(-1) ?? ''
  return DOCUMENT_FORMATS.find(format => (format.extensions as readonly string[]).includes(extension))?.id ?? 'plaintext'
}

/** Preserve familiar original suffixes (YML, TSV, JSX...) while their mode matches. */
export function documentExportExtension(format: DocumentFormat, originalName?: string, legacyPlainText = false) {
  if (legacyPlainText) return 'txt'
  const originalExtension = originalName?.includes('.') ? originalName.toLowerCase().split('.').at(-1) : undefined
  return originalName && formatFromFileName(originalName) === format && originalExtension && /^[a-z0-9]{1,12}$/.test(originalExtension)
    ? originalExtension : documentFormat(format).extension
}

export function filterDocumentFormats(query: string) {
  const value = query.trim().toLocaleLowerCase('es')
  return DOCUMENT_FORMATS.filter(format => !value || `${format.label} ${format.description} ${format.extensions.join(' ')}`.toLocaleLowerCase('es').includes(value))
}
