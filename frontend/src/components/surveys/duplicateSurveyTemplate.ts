export function buildDuplicateTemplateName(sourceName: string, maxLength = 180): string {
  const normalized = sourceName.trim() || 'Plantilla';
  const prefix = 'Copia de ';
  return `${prefix}${normalized}`.slice(0, maxLength).trim();
}

