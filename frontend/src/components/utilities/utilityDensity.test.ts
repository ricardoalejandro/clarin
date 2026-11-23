// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { expect, it } from 'vitest'

it('emits real compact mouse, touch and measured-column CSS through the production PostCSS pipeline', async () => {
  const source = readFileSync(resolve('src/components/utilities/utility-density.css'), 'utf8')
  const result = await postcss([tailwindcss({
    content: [{ raw: '<button class="utility-control utility-field utility-work-toolbar"></button>', extension: 'html' }],
    corePlugins: { preflight: false },
  })]).process(`@tailwind utilities;\n${source}`, { from: undefined })
  const media: Record<string, string[]> = {}
  result.root.walkAtRules('media', rule => { media[rule.params] = [] })
  result.root.walkDecls('--utility-control-size', declaration => {
    const parent = declaration.parent?.parent
    if (parent?.type === 'atrule') media[parent.params]?.push(declaration.value)
  })
  expect(media['(hover: hover) and (pointer: fine)']).toContain('32px')
  expect(media['(any-pointer: coarse)']).toContain('44px')
  expect(result.css.indexOf('@media (any-pointer: coarse)')).toBeGreaterThan(result.css.indexOf('@media (hover: hover)'))
  const columns: string[] = []
  result.root.walkAtRules('container', rule => {
    if (rule.params === 'utilities-workspace (min-width: 672px)') {
      rule.walkDecls('grid-template-columns', declaration => { columns.push(declaration.value) })
    }
  })
  expect(columns).toEqual(['repeat(2, minmax(0, 1fr))'])
  expect(result.css).toContain('height: var(--utility-control-size)')
  expect(result.css).toContain('height: var(--utility-toolbar-height)')
})
