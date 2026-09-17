import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const REQUIRED_INTERACTION_RULES = [
  ['group-hover:opacity-100', 'opacity:1'],
  ['group-hover:pointer-events-auto', 'pointer-events:auto'],
  ['group-focus-within:opacity-100', 'opacity:1'],
  ['group-focus-within:pointer-events-auto', 'pointer-events:auto'],
  ['focus-visible:pointer-events-auto', 'pointer-events:auto'],
  ['[@media(pointer:coarse)]:pointer-events-auto', 'pointer-events:auto'],
]

function normalizeCSS(css) {
  return css.replaceAll('\\', '').replace(/\s+/gu, '')
}

export function verifyTailwindInteractionCSS(css) {
  const normalized = normalizeCSS(css)
  const missing = []
  for (const [selector, declaration] of REQUIRED_INTERACTION_RULES) {
    let cursor = 0
    let found = false
    while ((cursor = normalized.indexOf(selector, cursor)) !== -1) {
      const open = normalized.indexOf('{', cursor)
      const close = open === -1 ? -1 : normalized.indexOf('}', open)
      if (open !== -1 && close !== -1 && open - cursor < 800 && normalized.slice(open + 1, close).includes(declaration)) {
        found = true
        break
      }
      cursor += selector.length
    }
    if (!found) missing.push(`${selector} -> ${declaration}`)
  }
  if (missing.length) {
    throw new Error(`El CSS compilado perdió variantes interactivas críticas:\n- ${missing.join('\n- ')}`)
  }
}

async function cssFiles(root) {
  const result = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name.endsWith('.css')) result.push(path)
    }
  }
  await visit(root)
  return result
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = join(process.cwd(), '.next', 'static', 'css')
  const files = await cssFiles(root)
  if (!files.length) throw new Error(`No se encontró CSS de producción en ${root}`)
  verifyTailwindInteractionCSS((await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n'))
  console.log(`CSS interactivo verificado en ${files.length} artefacto(s) de producción.`)
}
