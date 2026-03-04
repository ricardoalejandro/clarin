// Package formula implements a boolean tag formula parser, SQL builder, and in-memory evaluator.
//
// Grammar (Jira JQL-like):
//
//	expr      → or_expr
//	or_expr   → and_expr ("or" and_expr)*
//	and_expr  → unary ("and" unary)*
//	unary     → "not" unary | primary
//	primary   → "(" or_expr ")" | QUOTED_STRING
//
// QUOTED_STRING = double-quoted string e.g. "iquitos"
// Without '%' = exact match (case-insensitive).
// With '%' = LIKE/ILIKE pattern e.g. "04-mar%" matches any tag starting with "04-mar".
//
// Example: (("04-mar" or "07-mar") and "iquitos") and not "elimi%"
package formula

import (
	"fmt"
	"strings"
	"unicode"
)

// NodeType identifies the kind of AST node.
type NodeType int

const (
	NodeAnd     NodeType = iota // binary AND
	NodeOr                      // binary OR
	NodeNot                     // unary NOT
	NodeLiteral                 // leaf: tag name pattern
)

// Node is an AST node for a boolean tag formula.
type Node struct {
	Type     NodeType
	Children []*Node // NodeAnd, NodeOr: 2+ children; NodeNot: 1 child; NodeLiteral: none
	Value    string  // only for NodeLiteral — the tag pattern (lowercase, may contain %)
	IsLike   bool    // true when Value contains '%' → use ILIKE instead of exact match
}

// String returns a human-readable representation for debugging.
func (n *Node) String() string {
	switch n.Type {
	case NodeLiteral:
		return fmt.Sprintf("%q", n.Value)
	case NodeNot:
		return fmt.Sprintf("NOT(%s)", n.Children[0].String())
	case NodeAnd:
		parts := make([]string, len(n.Children))
		for i, c := range n.Children {
			parts[i] = c.String()
		}
		return "AND(" + strings.Join(parts, ", ") + ")"
	case NodeOr:
		parts := make([]string, len(n.Children))
		for i, c := range n.Children {
			parts[i] = c.String()
		}
		return "OR(" + strings.Join(parts, ", ") + ")"
	}
	return "?"
}

// ──────────────────────────────────────────────────────────
// Tokenizer
// ──────────────────────────────────────────────────────────

type tokenKind int

const (
	tokEOF    tokenKind = iota
	tokLParen           // (
	tokRParen           // )
	tokAnd              // and
	tokOr               // or
	tokNot              // not
	tokString           // quoted string value
)

type token struct {
	kind  tokenKind
	value string // raw string content (for tokString)
}

func tokenize(input string) ([]token, error) {
	var tokens []token
	i := 0
	runes := []rune(input)

	for i < len(runes) {
		ch := runes[i]

		// Skip whitespace
		if unicode.IsSpace(ch) {
			i++
			continue
		}

		// Parentheses
		if ch == '(' {
			tokens = append(tokens, token{kind: tokLParen})
			i++
			continue
		}
		if ch == ')' {
			tokens = append(tokens, token{kind: tokRParen})
			i++
			continue
		}

		// Quoted string
		if ch == '"' {
			i++ // skip opening quote
			start := i
			for i < len(runes) && runes[i] != '"' {
				i++
			}
			if i >= len(runes) {
				return nil, fmt.Errorf("unterminated string starting at position %d", start-1)
			}
			val := string(runes[start:i])
			i++ // skip closing quote
			tokens = append(tokens, token{kind: tokString, value: val})
			continue
		}

		// Keywords: and, or, not (case-insensitive)
		if unicode.IsLetter(ch) {
			start := i
			for i < len(runes) && (unicode.IsLetter(runes[i]) || runes[i] == '_') {
				i++
			}
			word := strings.ToLower(string(runes[start:i]))
			switch word {
			case "and":
				tokens = append(tokens, token{kind: tokAnd})
			case "or":
				tokens = append(tokens, token{kind: tokOr})
			case "not":
				tokens = append(tokens, token{kind: tokNot})
			default:
				return nil, fmt.Errorf("unexpected keyword %q at position %d (tag names must be quoted)", word, start)
			}
			continue
		}

		return nil, fmt.Errorf("unexpected character %q at position %d", string(ch), i)
	}

	tokens = append(tokens, token{kind: tokEOF})
	return tokens, nil
}

// ──────────────────────────────────────────────────────────
// Parser (recursive descent)
// ──────────────────────────────────────────────────────────

type parser struct {
	tokens []token
	pos    int
}

func (p *parser) peek() token {
	if p.pos >= len(p.tokens) {
		return token{kind: tokEOF}
	}
	return p.tokens[p.pos]
}

func (p *parser) advance() token {
	t := p.peek()
	p.pos++
	return t
}

func (p *parser) expect(kind tokenKind) (token, error) {
	t := p.advance()
	if t.kind != kind {
		return t, fmt.Errorf("expected %v but got %v at token %d", kindName(kind), kindName(t.kind), p.pos-1)
	}
	return t, nil
}

// Parse parses a formula string and returns the AST root.
// Returns nil for an empty formula.
func Parse(input string) (*Node, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return nil, nil
	}

	tokens, err := tokenize(input)
	if err != nil {
		return nil, fmt.Errorf("tokenize error: %w", err)
	}

	p := &parser{tokens: tokens}
	node, err := p.parseOrExpr()
	if err != nil {
		return nil, err
	}

	// Ensure all tokens consumed
	if p.peek().kind != tokEOF {
		return nil, fmt.Errorf("unexpected token %v at position %d", kindName(p.peek().kind), p.pos)
	}

	return node, nil
}

// Validate checks if a formula string is syntactically valid.
// Returns nil if valid, or an error describing the problem.
func Validate(input string) error {
	_, err := Parse(input)
	return err
}

func (p *parser) parseOrExpr() (*Node, error) {
	left, err := p.parseAndExpr()
	if err != nil {
		return nil, err
	}

	children := []*Node{left}
	for p.peek().kind == tokOr {
		p.advance() // consume "or"
		right, err := p.parseAndExpr()
		if err != nil {
			return nil, err
		}
		children = append(children, right)
	}

	if len(children) == 1 {
		return children[0], nil
	}
	return &Node{Type: NodeOr, Children: children}, nil
}

func (p *parser) parseAndExpr() (*Node, error) {
	left, err := p.parseUnary()
	if err != nil {
		return nil, err
	}

	children := []*Node{left}
	for p.peek().kind == tokAnd {
		p.advance() // consume "and"
		right, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		children = append(children, right)
	}

	if len(children) == 1 {
		return children[0], nil
	}
	return &Node{Type: NodeAnd, Children: children}, nil
}

func (p *parser) parseUnary() (*Node, error) {
	if p.peek().kind == tokNot {
		p.advance() // consume "not"
		child, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return &Node{Type: NodeNot, Children: []*Node{child}}, nil
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() (*Node, error) {
	t := p.peek()

	if t.kind == tokLParen {
		p.advance() // consume "("
		node, err := p.parseOrExpr()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokRParen); err != nil {
			return nil, fmt.Errorf("missing closing parenthesis")
		}
		return node, nil
	}

	if t.kind == tokString {
		p.advance()
		val := strings.ToLower(t.value)
		isLike := strings.Contains(val, "%")
		return &Node{Type: NodeLiteral, Value: val, IsLike: isLike}, nil
	}

	return nil, fmt.Errorf("expected tag name or '(' but got %v at position %d", kindName(t.kind), p.pos)
}

// ExtractLiterals walks the AST and returns all unique literal tag patterns (lowercase).
func ExtractLiterals(node *Node) []string {
	if node == nil {
		return nil
	}
	seen := map[string]bool{}
	var result []string
	var walk func(n *Node)
	walk = func(n *Node) {
		if n.Type == NodeLiteral {
			if !seen[n.Value] {
				seen[n.Value] = true
				result = append(result, n.Value)
			}
			return
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	walk(node)
	return result
}

func kindName(k tokenKind) string {
	switch k {
	case tokEOF:
		return "EOF"
	case tokLParen:
		return "'('"
	case tokRParen:
		return "')'"
	case tokAnd:
		return "'and'"
	case tokOr:
		return "'or'"
	case tokNot:
		return "'not'"
	case tokString:
		return "string"
	}
	return "unknown"
}
