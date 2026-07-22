package api

import (
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestSurveyUploadRejectsActiveContentAndSpoofedImages(t *testing.T) {
	question := &domain.SurveyQuestion{Type: "file_upload"}
	if _, err := validateSurveyUploadContent(question, "respuesta.html", "text/html", []byte("<html><script>alert(1)</script></html>")); err == nil {
		t.Fatal("active HTML content was accepted")
	}
	if _, err := validateSurveyUploadContent(question, "foto.png", "image/png", []byte("this is plain text")); err == nil {
		t.Fatal("a spoofed image MIME type was accepted")
	}
}

func TestSurveyUploadHonorsQuestionTypesAndSanitizesFilename(t *testing.T) {
	question := &domain.SurveyQuestion{
		Type:   "file_upload",
		Config: domain.SurveyQuestionConfig{AllowedTypes: []string{"application/pdf"}},
	}
	pdf := []byte("%PDF-1.7\n1 0 obj\n")
	contentType, err := validateSurveyUploadContent(question, "constancia.pdf", "application/pdf", pdf)
	if err != nil {
		t.Fatalf("valid allowed PDF was rejected: %v", err)
	}
	if contentType != "application/pdf" {
		t.Fatalf("content type=%q, want application/pdf", contentType)
	}
	if _, err := validateSurveyUploadContent(question, "foto.png", "image/png", []byte("\x89PNG\r\n\x1a\n")); err == nil {
		t.Fatal("a type outside allowed_types was accepted")
	}
	if got := sanitizeSurveyUploadFilename("../../reporte\nfinal.pdf"); got != "reportefinal.pdf" {
		t.Fatalf("sanitized filename=%q", got)
	}
}
