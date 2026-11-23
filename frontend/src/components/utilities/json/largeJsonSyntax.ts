import type { languages } from 'monaco-editor'
import { LARGE_JSON_LANGUAGE } from './editorWorkspaceState'

/** Lexical colors only: no JSON worker, schema lookup, AST or growing parent stack. */
export const largeJsonSyntax: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.json',
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      // Key classification stays line-local; colorization never builds a JSON tree.
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
      [/"/, 'string.value', '@string'],
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/[{}]/, 'delimiter.bracket'],
      [/[\[\]]/, 'delimiter.array'],
      [/[:,]/, 'delimiter'],
      [/\s+/, ''],
    ],
    string: [
      [/[^"\\]+/, 'string.value'],
      [/\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string.value', '@pop'],
    ],
    comment: [
      [/[^*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/\*/, 'comment'],
    ],
  },
}

type SyntaxRegistry = Pick<typeof languages, 'getLanguages' | 'register' | 'setMonarchTokensProvider'>
const registrations = new WeakMap<SyntaxRegistry, { dispose(): void }>()

export function registerLargeJsonSyntax(registry: SyntaxRegistry) {
  const existing = registrations.get(registry)
  if (existing) return existing
  if (!registry.getLanguages().some(language => language.id === LARGE_JSON_LANGUAGE)) registry.register({ id: LARGE_JSON_LANGUAGE })
  const tokens = registry.setMonarchTokensProvider(LARGE_JSON_LANGUAGE, largeJsonSyntax)
  let disposed = false
  const registration = { dispose() { if (!disposed) { disposed = true; tokens.dispose(); registrations.delete(registry) } } }
  registrations.set(registry, registration)
  return registration
}
