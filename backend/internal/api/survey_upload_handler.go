package api

import (
	"context"
	"fmt"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

const (
	surveyUploadCleanupStartDelay = 45 * time.Second
	surveyUploadCleanupInterval   = 15 * time.Minute
	surveyUploadCleanupTimeout    = 2 * time.Minute
)

func sanitizeSurveyUploadFilename(raw string) string {
	raw = strings.ReplaceAll(raw, "\\", "/")
	base := strings.TrimSpace(filepath.Base(raw))
	if base == "" || base == "." || base == ".." {
		return ""
	}
	clean := strings.Map(func(value rune) rune {
		if unicode.IsControl(value) || value == '/' || value == '\\' {
			return -1
		}
		return value
	}, base)
	runes := []rune(strings.TrimSpace(clean))
	if len(runes) > 180 {
		runes = runes[:180]
	}
	return string(runes)
}

func safeSurveyUploadExtension(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if len(ext) < 2 || len(ext) > 12 {
		return ".bin"
	}
	for _, value := range ext[1:] {
		if (value < 'a' || value > 'z') && (value < '0' || value > '9') {
			return ".bin"
		}
	}
	return ext
}

func validateSurveyUploadContent(question *domain.SurveyQuestion, filename, rawContentType string, data []byte) (string, error) {
	ext := strings.ToLower(filepath.Ext(filename))
	claimed := strings.ToLower(strings.TrimSpace(strings.SplitN(rawContentType, ";", 2)[0]))
	detected := strings.ToLower(strings.TrimSpace(strings.SplitN(http.DetectContentType(data), ";", 2)[0]))
	dangerousExtensions := map[string]struct{}{
		".apk": {}, ".bat": {}, ".cmd": {}, ".com": {}, ".dll": {}, ".exe": {},
		".htm": {}, ".html": {}, ".jar": {}, ".js": {}, ".mjs": {}, ".ps1": {},
		".sh": {}, ".svg": {},
	}
	if _, denied := dangerousExtensions[ext]; denied {
		return "", errorsSurveyUploadType()
	}
	for _, contentType := range []string{claimed, detected} {
		if contentType == "text/html" || contentType == "image/svg+xml" ||
			contentType == "application/javascript" || contentType == "text/javascript" ||
			contentType == "application/x-msdownload" || contentType == "application/x-sh" {
			return "", errorsSurveyUploadType()
		}
	}
	if claimed == "" || claimed == "application/octet-stream" {
		claimed = detected
	}
	if strings.HasPrefix(claimed, "image/") && !strings.HasPrefix(detected, "image/") {
		return "", errorsSurveyUploadType()
	}
	if claimed == "application/pdf" && detected != "application/pdf" {
		return "", errorsSurveyUploadType()
	}
	if len(question.Config.AllowedTypes) > 0 {
		allowed := false
		for _, rawAllowed := range question.Config.AllowedTypes {
			value := strings.ToLower(strings.TrimSpace(rawAllowed))
			switch {
			case value == ext:
				allowed = true
			case strings.HasSuffix(value, "/*"):
				prefix := strings.TrimSuffix(value, "*")
				allowed = strings.HasPrefix(claimed, prefix) && strings.HasPrefix(detected, prefix)
			case value == claimed || value == detected:
				allowed = true
			}
			if allowed {
				break
			}
		}
		if !allowed {
			return "", fmt.Errorf("el tipo de archivo no está permitido para esta pregunta")
		}
	}
	if claimed == "" {
		claimed = "application/octet-stream"
	}
	return claimed, nil
}

func errorsSurveyUploadType() error {
	return fmt.Errorf("el contenido del archivo no es seguro o no coincide con su tipo")
}

func (s *Server) handleGetPublicSurveyFile(c *fiber.Ctx) error {
	accessToken, err := uuid.Parse(c.Params("accessToken"))
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Archivo no encontrado"})
	}
	upload, err := s.repos.Survey.GetSurveyFileUploadByAccessToken(c.Context(), accessToken)
	if err != nil || upload == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Archivo no encontrado"})
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": upload.OriginalFilename})
	if disposition != "" {
		c.Set(fiber.HeaderContentDisposition, disposition)
	}
	c.Set(fiber.HeaderXContentTypeOptions, "nosniff")
	cacheControl := "private, no-store, max-age=0"
	if upload.Status == "attached" {
		cacheControl = "private, max-age=3600"
	}
	return s.serveStorageObject(c, upload.ObjectKey, cacheControl)
}

func (s *Server) startSurveyUploadCleanupWorker() {
	if s.storage == nil || s.repos == nil || s.repos.Survey == nil {
		return
	}
	go func() {
		timer := time.NewTimer(surveyUploadCleanupStartDelay)
		defer timer.Stop()
		<-timer.C
		s.runSurveyUploadCleanupPass()
		ticker := time.NewTicker(surveyUploadCleanupInterval)
		defer ticker.Stop()
		for range ticker.C {
			s.runSurveyUploadCleanupPass()
		}
	}()
}

func (s *Server) runSurveyUploadCleanupPass() {
	ctx, cancel := context.WithTimeout(context.Background(), surveyUploadCleanupTimeout)
	defer cancel()
	for batch := 0; batch < 5; batch++ {
		items, err := s.repos.Survey.ClaimExpiredSurveyFileUploads(ctx, 100)
		if err != nil {
			log.Printf("[SURVEY] Failed to claim expired file uploads: %v", err)
			return
		}
		if len(items) == 0 {
			return
		}
		for _, item := range items {
			deleteErr := s.storage.DeleteFile(ctx, item.ObjectKey)
			if finishErr := s.repos.Survey.FinishSurveyFileUploadCleanup(ctx, item, deleteErr); finishErr != nil {
				log.Printf("[SURVEY] Failed to finalize upload cleanup %s: %v", item.ID, finishErr)
			}
		}
	}
}
