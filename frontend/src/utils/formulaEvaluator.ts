// Client-side formula parser + evaluator
// Mirrors backend/internal/formula/parser.go + evaluator.go

// ─── AST Types ────────────────────────────────────────────────────────────────

export type NodeType = 'and' | 'or' | 'not' | 'literal'

export interface FormulaNode {
  type: NodeType
  children: FormulaNode[]
  value: string   // only for 'literal'
  isLike: boolean // true when value contains '%'
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

type TokenKind = 'eof' | 'lparen' | 'rparen' | 'and' | 'or' | 'not' | 'string'

interface Token {
  kind: TokenKind
  value: string
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const boundary = (pos: number) => pos >= input.length || /[\s()"']/.test(input[pos])

  while (i < input.length) {
    if (/\s/.test(input[i])) { i++; continue }
    if (input[i] === '(') { tokens.push({ kind: 'lparen', value: '(' }); i++; continue }
    if (input[i] === ')') { tokens.push({ kind: 'rparen', value: ')' }); i++; continue }

    if (input[i] === '"') {
      i++
      let val = ''
      while (i < input.length && input[i] !== '"') { val += input[i]; i++ }
      if (i >= input.length) throw new Error('Unterminated string')
      i++ // skip closing quote
      tokens.push({ kind: 'string', value: val })
      continue
    }

    const rest = input.slice(i).toLowerCase()
    if (rest.startsWith('and') && boundary(i + 3)) { tokens.push({ kind: 'and', value: 'and' }); i += 3; continue }
    if (rest.startsWith('or') && boundary(i + 2)) { tokens.push({ kind: 'or', value: 'or' }); i += 2; continue }
    if (rest.startsWith('not') && boundary(i + 3)) { tokens.push({ kind: 'not', value: 'not' }); i += 3; continue }

    throw new Error(`Unexpected character at position ${i}`)
  }
  tokens.push({ kind: 'eof', value: '' })
  return tokens
}

// ─── Parser (recursive descent) ──────────────────────────────────────────────

class Parser {
  private tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) { this.tokens = tokens }

  peek(): Token { return this.pos < this.tokens.length ? this.tokens[this.pos] : { kind: 'eof', value: '' } }
  advance(): Token { const t = this.peek(); this.pos++; return t }

  parseOrExpr(): FormulaNode {
    const children: FormulaNode[] = [this.parseAndExpr()]
    while (this.peek().kind === 'or') { this.advance(); children.push(this.parseAndExpr()) }
    return children.length === 1 ? children[0] : { type: 'or', children, value: '', isLike: false }
  }

  parseAndExpr(): FormulaNode {
    const children: FormulaNode[] = [this.parseUnary()]
    while (this.peek().kind === 'and') { this.advance(); children.push(this.parseUnary()) }
    return children.length === 1 ? children[0] : { type: 'and', children, value: '', isLike: false }
  }

  parseUnary(): FormulaNode {
    if (this.peek().kind === 'not') {
      this.advance()
      return { type: 'not', children: [this.parseUnary()], value: '', isLike: false }
    }
    return this.parsePrimary()
  }

  parsePrimary(): FormulaNode {
    const t = this.peek()
    if (t.kind === 'lparen') {
      this.advance()
      const node = this.parseOrExpr()
      if (this.peek().kind !== 'rparen') throw new Error('Missing closing parenthesis')
      this.advance()
      return node
    }
    if (t.kind === 'string') {
      this.advance()
      const val = t.value.toLowerCase()
      return { type: 'literal', children: [], value: val, isLike: val.includes('%') }
    }
    throw new Error(`Expected tag name or '(' but got ${t.kind}`)
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function parseFormula(input: string): FormulaNode | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const tokens = tokenize(trimmed)
  const parser = new Parser(tokens)
  const node = parser.parseOrExpr()
  if (parser.peek().kind !== 'eof') throw new Error('Unexpected tokens after formula')
  return node
}

export function evaluateFormula(node: FormulaNode | null, tagNames: string[]): boolean {
  if (!node) return true // empty formula matches everything
  const tagSet = new Set(tagNames.map(t => t.toLowerCase()))
  const lowerNames = tagNames.map(t => t.toLowerCase())
  return evalNode(node, lowerNames, tagSet)
}

function evalNode(node: FormulaNode, tagNames: string[], tagSet: Set<string>): boolean {
  switch (node.type) {
    case 'literal':
      return matchLiteral(node, tagNames, tagSet)
    case 'not':
      return !evalNode(node.children[0], tagNames, tagSet)
    case 'and':
      return node.children.every(c => evalNode(c, tagNames, tagSet))
    case 'or':
      return node.children.some(c => evalNode(c, tagNames, tagSet))
  }
}

function matchLiteral(node: FormulaNode, tagNames: string[], tagSet: Set<string>): boolean {
  if (!node.isLike) return tagSet.has(node.value)
  return tagNames.some(name => likeMatch(name, node.value))
}

function likeMatch(s: string, pattern: string): boolean {
  const parts = pattern.split('%')
  const regexStr = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  try { return new RegExp('^' + regexStr + '$', 'i').test(s) }
  catch { return false }
}
