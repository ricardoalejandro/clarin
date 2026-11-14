package utilities

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"
)

// During rolling master-key rotation, a read can overlap a material replacement
// made by another instance. Its old data key must never overwrite the replacement
// envelope; rotation belongs exclusively to the transaction holding the row lock.
func TestVaultMaterialCannotRewriteEnvelope(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "vault.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var material *ast.FuncDecl
	for _, declaration := range file.Decls {
		if fn, ok := declaration.(*ast.FuncDecl); ok && fn.Name.Name == "VaultMaterial" {
			material = fn
			break
		}
	}
	if material == nil {
		t.Fatal("vault material read route was not found")
	}
	ast.Inspect(material.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if selector.Sel.Name == "Rewrap" || selector.Sel.Name == "Seal" {
			t.Error("material reads must leave envelope replacement to the row-locked worker")
		}
		if selector.Sel.Name != "Exec" {
			return true
		}
		if len(call.Args) < 2 {
			t.Error("unrecognized write in material read route")
			return true
		}
		query, ok := call.Args[1].(*ast.BasicLit)
		if !ok || query.Kind != token.STRING {
			t.Error("material reads may write only a literal security audit statement")
			return true
		}
		sql, err := strconv.Unquote(query.Value)
		if err != nil || !strings.HasPrefix(strings.ToUpper(strings.TrimSpace(sql)), "INSERT INTO SECURITY_EVENTS(") || strings.Contains(sql, ";") {
			t.Error("material reads may write only the access audit event")
		}
		return true
	})
}
