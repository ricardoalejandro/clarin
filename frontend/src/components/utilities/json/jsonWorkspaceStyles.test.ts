// @vitest-environment node
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { expect, it } from 'vitest'

it('emits scoped theme colors that override the global important input color', async () => {
  const global = readFileSync('src/app/globals.css', 'utf8')
  const local = readFileSync('src/components/utilities/json/jsonWorkspace.css', 'utf8')
  const result = await postcss([tailwindcss({
    content: [{ raw: '<input class="json-editor-field">', extension: 'html' }],
    corePlugins: { preflight: false },
  })]).process(`${global}\n${local}`, { from: undefined })
  const rules = new Map<string, Record<string, { value: string; important: boolean }>>()
  result.root.walkRules(rule => {
    if (!rule.selector.includes('json-editor-field')) return
    const declarations: Record<string, { value: string; important: boolean }> = {}
    rule.walkDecls(declaration => { declarations[declaration.prop] = { value: declaration.value, important: Boolean(declaration.important) } })
    rules.set(rule.selector, declarations)
  })
  expect(rules.get('[data-editor-theme] .json-editor-field')).toMatchObject({
    color: { value: 'var(--editor-ink)', important: true },
    'caret-color': { value: 'var(--editor-ink)' },
  })
  expect(rules.get('[data-editor-theme] .json-editor-field::placeholder')).toMatchObject({
    color: { value: 'var(--editor-muted)', important: true }, opacity: { value: '1' },
  })
  expect(rules.get('[data-editor-theme] .json-editor-field::selection')).toMatchObject({
    'background-color': { value: 'var(--editor-selection)' }, color: { value: 'var(--editor-ink)' },
  })
  expect([...rules.keys()].every(selector => selector === '.json-editor-field' || selector.startsWith('[data-editor-theme'))).toBe(true)
})
