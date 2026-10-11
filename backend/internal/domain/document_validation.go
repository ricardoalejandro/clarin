package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strings"
	"unicode/utf8"
)

const DocumentCanvasMaxBytes = 2 * 1024 * 1024
const DocumentCanvasMaxObjects = 1000
const DocumentCanvasMaxDepth = 10
const DocumentCanvasMaxJSONDepth = 64

var documentObjectTypes = map[string]bool{"rect": true, "circle": true, "ellipse": true, "triangle": true, "line": true, "path": true, "polygon": true, "polyline": true, "text": true, "itext": true, "i-text": true, "textbox": true, "dynamictext": true, "image": true, "group": true}

func ValidateDocumentTemplate(t *DocumentTemplate) error {
	t.Name = strings.TrimSpace(t.Name)
	if utf8.RuneCountInString(t.Name) < 1 || utf8.RuneCountInString(t.Name) > 200 {
		return fmt.Errorf("El nombre debe contener entre 1 y 200 caracteres.")
	}
	if utf8.RuneCountInString(t.Description) > 2000 {
		return fmt.Errorf("La descripción admite hasta 2000 caracteres.")
	}
	for _, n := range []float64{t.PageWidth, t.PageHeight} {
		if math.IsNaN(n) || math.IsInf(n, 0) || n < 10 || n > 2000 {
			return fmt.Errorf("Las dimensiones deben estar entre 10 y 2000 mm.")
		}
	}
	if t.PageOrientation != "portrait" && t.PageOrientation != "landscape" {
		return fmt.Errorf("Orientación de página no válida.")
	}
	if len(t.FieldsUsed) > 200 {
		return fmt.Errorf("La plantilla admite hasta 200 campos.")
	}
	if err := validateDocumentAssetURL(t.ThumbnailURL); err != nil {
		return err
	}
	return ValidateDocumentCanvas(t.CanvasJSON)
}
func validateDocumentAssetURL(raw string) error {
	if raw == "" {
		return nil
	}
	lower := strings.ToLower(strings.TrimSpace(raw))
	if strings.HasPrefix(lower, "data:") {
		for _, prefix := range []string{"data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"} {
			if strings.HasPrefix(lower, prefix) {
				return nil
			}
		}
		return fmt.Errorf("El recurso debe ser una imagen raster autorizada.")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || strings.ContainsAny(raw, "\x00\r\n") || (parsed.Scheme != "" && parsed.Scheme != "https" && parsed.Scheme != "http") || (parsed.Scheme == "" && (parsed.Host != "" || !strings.HasPrefix(parsed.Path, "/api/media/file/"))) {
		return fmt.Errorf("La dirección del recurso no es válida.")
	}
	return nil
}
func ValidateDocumentCanvas(raw json.RawMessage) error {
	if len(raw) > DocumentCanvasMaxBytes {
		return fmt.Errorf("El diseño supera el límite de 2 MiB.")
	}
	var root map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&root); err != nil || root == nil {
		return fmt.Errorf("El diseño debe ser un objeto JSON válido.")
	}
	if v, ok := root["version"]; ok && v != float64(2) && v != float64(3) {
		return fmt.Errorf("Versión de diseño no compatible.")
	}
	count := 0
	var visit func(any, int, string, bool, int) error
	visit = func(value any, depth int, key string, object bool, hierarchy int) error {
		switch x := value.(type) {
		case map[string]any:
			if depth > DocumentCanvasMaxJSONDepth {
				return fmt.Errorf("El diseño supera 64 niveles JSON.")
			}
			if object {
				count++
				if count > DocumentCanvasMaxObjects {
					return fmt.Errorf("El diseño admite hasta 1000 objetos.")
				}
				typ, _ := x["type"].(string)
				if strings.EqualFold(typ, "group") || key == "clipPath" {
					hierarchy++
				}
				if hierarchy > DocumentCanvasMaxDepth {
					return fmt.Errorf("El diseño admite hasta 10 niveles de grupos o recortes.")
				}
				if !documentObjectTypes[strings.ToLower(typ)] {
					return fmt.Errorf("El diseño contiene un tipo de objeto no compatible.")
				}
			}
			for k, v := range x {
				if k == "source" && x["type"] == "pattern" {
					if source, ok := v.(string); ok {
						if err := validateDocumentAssetURL(source); err != nil {
							return err
						}
					}
				}
				if k == "__proto__" || k == "constructor" || k == "prototype" {
					return fmt.Errorf("El diseño contiene propiedades no válidas.")
				}
				if err := visit(v, depth+1, k, k == "clipPath" || k == "backgroundImage" || k == "overlayImage", hierarchy); err != nil {
					return err
				}
			}
		case []any:
			if depth > DocumentCanvasMaxJSONDepth {
				return fmt.Errorf("El diseño supera 64 niveles JSON.")
			}
			for _, v := range x {
				if err := visit(v, depth+1, "", key == "objects" || key == "elements", hierarchy); err != nil {
					return err
				}
			}
		case string:
			if key == "src" || key == "imageUrl" {
				return validateDocumentAssetURL(x)
			}
		case float64:
			if math.IsInf(x, 0) || math.IsNaN(x) || math.Abs(x) > 1e7 {
				return fmt.Errorf("El diseño contiene una medida fuera de rango.")
			}
		}
		return nil
	}
	return visit(root, 1, "", false, 0)
}
