import { parse } from 'acorn'

export function verifyStandaloneSubsetWorker(source) {
  if (/file:\/\/|import\.meta\.url/u.test(source)) throw new Error('Subset worker contains a filesystem-dependent URL')
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') throw new Error('Subset worker must embed every runtime dependency')
    if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee?.type === 'Identifier' && ['Function', 'eval'].includes(node.callee.name)) throw new Error('Subset worker must not compile JavaScript strings')
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(tree)
  if (!source.includes('onmessage') || !source.includes('WebAssembly')) throw new Error('Subset worker protocol or embedded WASM is missing')
}
