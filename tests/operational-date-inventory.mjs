import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const ts = require(path.join(root, 'frontend/node_modules/typescript'))
const native = [], shared = []

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) { walk(absolute); continue }
    if (!entry.name.endsWith('.tsx') || /\.(test|spec)\./.test(entry.name)) continue
    const source = fs.readFileSync(absolute, 'utf8')
    const tree = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(tree)
        const location = { file: path.relative(root, absolute).replaceAll('\\', '/'), line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 }
        if (tag === 'input') {
          const type = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === 'type')
          if (type?.initializer && /\b(date|datetime-local|month|week)\b/.test(type.initializer.getText(tree))) native.push({ ...location, type: type.initializer.getText(tree) })
        } else if (['OperationalDatePicker', 'TaskDateTimePicker', 'TaskDateRangePicker'].includes(tag)) shared.push({ ...location, component: tag })
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
}

walk(path.join(root, 'frontend/src'))
const report = { source: 'TypeScript JSX AST; source occurrences, not runtime screen counts', nativeDateInputs: native.length, sharedControlOccurrences: shared.length, native, shared }
fs.writeFileSync(path.join(root, 'docs/qa/fechas-editables-20261115/inventory.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ nativeDateInputs: native.length, sharedControlOccurrences: shared.length }))
if (native.length) process.exitCode = 1
