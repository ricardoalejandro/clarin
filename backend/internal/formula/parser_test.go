package formula

import "testing"

func TestParseNotInGroup(t *testing.T) {
	node, err := Parse(`"kommo" and not in ("iquitos" or "conf_03-jun" or "interesados junio")`)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if node == nil || node.Type != NodeAnd {
		t.Fatalf("expected AND root, got %#v", node)
	}

	if !Evaluate(node, []string{"kommo"}) {
		t.Fatalf("expected formula to match kommo without excluded tags")
	}
	if Evaluate(node, []string{"kommo", "iquitos"}) {
		t.Fatalf("expected formula to reject kommo with excluded tag")
	}
	if Evaluate(node, []string{"kommo", "conf_03-jun"}) {
		t.Fatalf("expected formula to reject kommo with excluded tag in group")
	}
}

func TestParseInGroup(t *testing.T) {
	node, err := Parse(`in ("iquitos" or "conf_03-jun")`)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if !Evaluate(node, []string{"conf_03-jun"}) {
		t.Fatalf("expected in-group formula to match one grouped tag")
	}
}
