import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { editor, languages } from 'monaco-editor'
import { LARGE_JSON_LANGUAGE } from './editorWorkspaceState'
import { largeJsonSyntax, registerLargeJsonSyntax } from './largeJsonSyntax'

function tokenAt(lines: ReturnType<typeof editor.tokenize>, line: number, offset: number) {
  return lines[line].filter(token => token.offset <= offset).at(-1)?.type
}

describe('large JSON lexical colors', () => {
  let registration: { dispose(): void }
  beforeAll(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })))
    registration = registerLargeJsonSyntax(languages)
  })
  afterAll(() => { registration?.dispose(); vi.unstubAllGlobals() })

  it('colors keys, values, numbers and literals with the existing JSON theme scopes', () => {
    const source = '{"name":"árbol", "value":-12.5e+3, "ok":true, "empty":null, "rows":[]}'
    const result = editor.tokenize(source, LARGE_JSON_LANGUAGE)
    expect(tokenAt(result, 0, source.indexOf('name'))).toBe('string.key.json')
    expect(tokenAt(result, 0, source.indexOf('árbol'))).toBe('string.value.json')
    expect(tokenAt(result, 0, source.indexOf('-12'))).toBe('number.json')
    expect(tokenAt(result, 0, source.indexOf('true'))).toBe('keyword.json')
    expect(tokenAt(result, 0, source.indexOf('null'))).toBe('keyword.json')
    expect(tokenAt(result, 0, source.indexOf('['))).toBe('delimiter.array.json')
  })

  it('keeps comments across lines and resumes ordinary JSON after their end', () => {
    const result = editor.tokenize('/* first\n{ "inside": true }\n*/ "outside": false // final', LARGE_JSON_LANGUAGE)
    expect(tokenAt(result, 1, 5)).toBe('comment.json')
    expect(tokenAt(result, 2, 5)).toBe('string.key.json')
    expect(tokenAt(result, 2, 15)).toBe('keyword.json')
    expect(tokenAt(result, 2, 24)).toBe('comment.json')
  })

  it('honors escaped quotes, Unicode escapes and invalid escape coloring', () => {
    const source = String.raw`{"value":"a\"b\u00f1\q"}`
    const result = editor.tokenize(source, LARGE_JSON_LANGUAGE)
    expect(tokenAt(result, 0, source.indexOf('\\"'))).toBe('string.escape.json')
    expect(tokenAt(result, 0, source.indexOf('\\u'))).toBe('string.escape.json')
    expect(tokenAt(result, 0, source.indexOf('\\q'))).toBe('string.escape.invalid.json')
    expect(tokenAt(result, 0, source.lastIndexOf('}'))).toBe('delimiter.bracket.json')
  })

  it('uses a fixed number of lexical states even for deeply nested content', () => {
    const result = editor.tokenize('['.repeat(1000) + 'true' + ']'.repeat(1000), LARGE_JSON_LANGUAGE)
    expect(tokenAt(result, 0, 1000)).toBe('keyword.json')
    expect(Object.keys(largeJsonSyntax.tokenizer)).toEqual(['root', 'string', 'comment'])
  })
})

it('shares one registration across panels without installing any semantic provider', () => {
  const known: { id: string }[] = []
  const dispose = vi.fn()
  const registry = {
    getLanguages: vi.fn(() => known),
    register: vi.fn((language: { id: string }) => { known.push(language) }),
    setMonarchTokensProvider: vi.fn(() => ({ dispose })),
  }
  const first = registerLargeJsonSyntax(registry)
  expect(registerLargeJsonSyntax(registry)).toBe(first)
  expect(registry.register).toHaveBeenCalledTimes(1)
  expect(registry.setMonarchTokensProvider).toHaveBeenCalledExactlyOnceWith(LARGE_JSON_LANGUAGE, largeJsonSyntax)
  first.dispose()
  expect(dispose).toHaveBeenCalledTimes(1)
  const next = registerLargeJsonSyntax(registry)
  first.dispose()
  expect(registerLargeJsonSyntax(registry)).toBe(next)
  expect(registry.register).toHaveBeenCalledTimes(1)
  expect(registry.setMonarchTokensProvider).toHaveBeenCalledTimes(2)
})
