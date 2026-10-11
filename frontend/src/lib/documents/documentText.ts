/** Decode existing rich-text values in an inert template. Its content is never
 * connected to the active document; images, handlers and scripts stay inert. */
export function documentPlainText(raw: string): string {
  if (!/<\/?[a-z][^>]*>/i.test(raw)) return raw
  if (typeof document === 'undefined') return raw.replace(/<[^>]*>/g, '')
  const template = document.createElement('template')
  template.innerHTML = raw
  return template.content.textContent || ''
}
