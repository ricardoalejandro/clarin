package api

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestRenderErosFileUsesHiddenToolContent(t *testing.T) {
	spec, err := json.Marshal(map[string]any{
		"title":   "Leads nuevos",
		"content": "Nombre | Telefono\nMiriam | 51956170657",
	})
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	file := &domain.ErosFile{
		Filename:       "leads_nuevos.txt",
		Format:         "txt",
		GenerationSpec: spec,
	}

	payload, contentType, filename, err := renderErosFile(file, "He preparado el adjunto leads_nuevos.txt.")
	if err != nil {
		t.Fatalf("renderErosFile returned error: %v", err)
	}

	if filename != "leads_nuevos.txt" {
		t.Fatalf("filename = %q, want leads_nuevos.txt", filename)
	}
	if contentType != "text/plain; charset=utf-8" {
		t.Fatalf("contentType = %q", contentType)
	}
	text := string(payload)
	if !strings.Contains(text, "Miriam | 51956170657") {
		t.Fatalf("payload did not use hidden content: %q", text)
	}
	if strings.Contains(text, "He preparado el adjunto") {
		t.Fatalf("payload used visible chat response instead of hidden content: %q", text)
	}
}

func TestRenderErosPDF(t *testing.T) {
	spec, err := json.Marshal(map[string]any{
		"title":   "Reporte Eros",
		"content": "Linea con acentos: áéíóú ñ\nOtra linea",
	})
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	file := &domain.ErosFile{
		Filename:       "reporte",
		Format:         "pdf",
		GenerationSpec: spec,
	}

	payload, contentType, filename, err := renderErosFile(file, "contenido visible")
	if err != nil {
		t.Fatalf("renderErosFile returned error: %v", err)
	}
	if filename != "reporte.pdf" {
		t.Fatalf("filename = %q, want reporte.pdf", filename)
	}
	if contentType != "application/pdf" {
		t.Fatalf("contentType = %q", contentType)
	}
	if !bytes.HasPrefix(payload, []byte("%PDF-1.4")) {
		t.Fatalf("payload does not look like a PDF: %q", string(payload[:min(len(payload), 32)]))
	}
	if !bytes.Contains(payload, []byte("/Type /Catalog")) {
		t.Fatalf("payload missing PDF catalog")
	}
}

func TestDisplayErosFileExportResponseHidesContent(t *testing.T) {
	response := displayErosFileExportResponse("Nombre | Telefono\nMiriam | 51956170657", []erosFileExportHint{{
		Filename: "leads_nuevos_iquitos.txt",
		Format:   "txt",
		Content:  "Nombre | Telefono\nMiriam | 51956170657",
	}})

	if strings.Contains(response, "51956170657") {
		t.Fatalf("response leaked file content: %q", response)
	}
	if !strings.Contains(response, "leads_nuevos_iquitos.txt") {
		t.Fatalf("response did not mention attachment filename: %q", response)
	}
}

func TestErosFileGenerationSpecIsNotSerialized(t *testing.T) {
	file := domain.ErosFile{
		Filename:       "leads.txt",
		Format:         "txt",
		GenerationSpec: json.RawMessage(`{"content":"telefono privado"}`),
	}

	raw, err := json.Marshal(file)
	if err != nil {
		t.Fatalf("marshal file: %v", err)
	}
	if strings.Contains(string(raw), "telefono privado") || strings.Contains(string(raw), "generation_spec") {
		t.Fatalf("generation spec leaked in JSON: %s", raw)
	}
}
