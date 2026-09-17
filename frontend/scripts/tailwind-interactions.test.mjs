import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { REQUIRED_INTERACTION_RULES, verifyTailwindInteractionCSS } from './verify-tailwind-interactions.mjs'

const require = createRequire(import.meta.url)

test('the resolved selector parser is the hardened v7 implementation with no v6 copy', () => {
  const parserVersion = require('postcss-selector-parser/package.json').version
  assert.equal(parserVersion, '7.1.6')
  const lock = require('../package-lock.json')
  const versions = Object.entries(lock.packages)
    .filter(([path]) => path.endsWith('node_modules/postcss-selector-parser'))
    .map(([, metadata]) => metadata.version)
  assert.deepEqual([...new Set(versions)], ['7.1.6'])
})

test('Tailwind emits every interaction rule required by task mouse, keyboard and touch controls', async () => {
  const classes = REQUIRED_INTERACTION_RULES.map(([selector]) => selector).join(' ')
  const result = await postcss([tailwindcss({
    content: [{ raw: `<div class="group"><button class="${classes}"></button></div>`, extension: 'html' }],
    corePlugins: { preflight: false },
  })]).process('@tailwind utilities;', { from: undefined })
  verifyTailwindInteractionCSS(result.css)
})

test('the verifier fails closed when any compiled interaction disappears', () => {
  assert.throws(
    () => verifyTailwindInteractionCSS('.group:hover .group-hover\\:opacity-100{opacity:1}'),
    /perdió variantes interactivas críticas/,
  )
})
