package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDocumentDesignBoundaries(t *testing.T) {
	valid := []string{`{}`, `{"version":2,"elements":[{"type":"text","content":"Perú 🦙"}]}`, `{"version":3,"fabricJson":{"objects":[{"type":"Group","objects":[{"type":"DynamicText","text":"Ficha","fieldFormat":{"type":"general"}},{"type":"Image","src":"/api/media/file/account/image.png","filters":[{"type":"Brightness","brightness":0.2}]}]},{"type":"Path","path":[["M",0,0],["L",10,20]],"fill":{"type":"linear","colorStops":[{"offset":0,"color":"#FFFFFF"}]}}]}}`}
	for _, raw := range valid {
		if err := ValidateDocumentCanvas(json.RawMessage(raw)); err != nil {
			t.Fatalf("valid design rejected: %v", err)
		}
	}
	invalid := []string{`[]`, `null`, `{"version":99}`, `{"version":3,"fabricJson":{"objects":[{"type":"Script"}]}}`, `{"elements":[{"type":"image","src":"javascript:alert(1)"}]}`, `{"elements":[{"type":"image","src":"data:image/svg+xml;base64,xxx"}]}`, `{"__proto__":{"polluted":true}}`, `{"width":1e100}`}
	for _, raw := range invalid {
		if ValidateDocumentCanvas(json.RawMessage(raw)) == nil {
			t.Fatal("unsafe design accepted")
		}
	}
	huge := `{"elements":[` + strings.Repeat(`{"type":"rect"},`, 1000) + `{"type":"rect"}]}`
	if ValidateDocumentCanvas(json.RawMessage(huge)) == nil {
		t.Fatal("object limit ignored")
	}
	deep := strings.Repeat(`{"x":`, 65) + `1` + strings.Repeat(`}`, 65)
	if ValidateDocumentCanvas(json.RawMessage(deep)) == nil {
		t.Fatal("depth limit ignored")
	}
	if ValidateDocumentCanvas(json.RawMessage(`{"text":"`+strings.Repeat("a", DocumentCanvasMaxBytes)+`"}`)) == nil {
		t.Fatal("byte limit ignored")
	}
}
func TestDocumentTemplateDimensions(t *testing.T) {
	template := DocumentTemplate{Name: "  Ficha  ", PageWidth: 210, PageHeight: 140, PageOrientation: "landscape", CanvasJSON: []byte(`{}`)}
	if err := ValidateDocumentTemplate(&template); err != nil || template.Name != "Ficha" {
		t.Fatalf("valid template %v", err)
	}
	for _, size := range []float64{-1, 0, 9.99, 2000.01} {
		template.PageWidth = size
		if ValidateDocumentTemplate(&template) == nil {
			t.Fatalf("accepted %f", size)
		}
	}
}

func TestDocumentGroupDepth(t *testing.T) {
	for _, depth := range []int{9, 10, 11} {
		var object any = map[string]any{"type": "Rect", "fill": map[string]any{"type": "linear", "colorStops": []any{map[string]any{"offset": 0, "color": "red"}}}}
		for i := 0; i < depth; i++ {
			object = map[string]any{"type": "Group", "objects": []any{object}}
		}
		raw, _ := json.Marshal(map[string]any{"version": 3, "fabricJson": map[string]any{"objects": []any{object}}})
		err := ValidateDocumentCanvas(raw)
		if (err == nil) != (depth <= 10) {
			t.Fatalf("groups %d: %v", depth, err)
		}
	}
	raw := json.RawMessage(`{"version":3,"fabricJson":{"objects":[{"type":"Image","clipPath":{"type":"Rect","width":4,"height":4},"filters":[{"type":"Brightness","brightness":0.1}]}]}}`)
	if err := ValidateDocumentCanvas(raw); err != nil {
		t.Fatal(err)
	}
}
