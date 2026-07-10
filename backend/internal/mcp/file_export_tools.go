package mcp

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

var mcpExportFilenameUnsafe = regexp.MustCompile(`[^a-zA-Z0-9._ -]+`)

func (s *MCPServer) toolPrepareFileExport(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	format := mcpNormalizeExportFormat(stringArg(req, "format"))
	if format == "" {
		return mcpStructuredError("UNSUPPORTED_FORMAT", "formato no soportado; usa txt, csv, xlsx, docx, pptx o pdf", nil), nil
	}
	title := strings.TrimSpace(stringArg(req, "title"))
	filename := mcpExportFilename(stringArg(req, "filename"), format)
	return jsonResult(map[string]any{
		"eros_file_export":  true,
		"tool":              "prepare_file_export",
		"account_id":        accountID.String(),
		"format":            format,
		"filename":          filename,
		"title":             title,
		"content_type":      mcpExportContentType(format),
		"download_delivery": "clarin_chat_attachment",
		"storage":           "no_minio_ephemeral_render",
		"retention_hours":   4,
		"ready_for_render":  true,
		"note":              "Clarin adjuntará el archivo en el chat. No devuelvas base64, URL pública ni pegues el contenido completo en la respuesta final.",
	}), nil
}

func (s *MCPServer) toolRenderFileExport(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	format := mcpNormalizeExportFormat(stringArg(req, "format"))
	if format == "" {
		return mcpStructuredError("UNSUPPORTED_FORMAT", "formato no soportado; usa txt, csv, xlsx, docx, pptx o pdf", nil), nil
	}
	title := strings.TrimSpace(stringArg(req, "title"))
	filename := mcpExportFilename(stringArg(req, "filename"), format)
	source := strings.TrimSpace(stringArg(req, "source"))
	if source == "" {
		source = "assistant_response"
	}
	content := strings.TrimSpace(stringArg(req, "content"))
	return jsonResult(map[string]any{
		"eros_file_export":  true,
		"tool":              "render_file_export",
		"account_id":        accountID.String(),
		"format":            format,
		"filename":          filename,
		"title":             title,
		"source":            source,
		"content":           content,
		"content_type":      mcpExportContentType(format),
		"download_delivery": "clarin_chat_attachment",
		"storage":           "no_minio_ephemeral_render",
		"retention_hours":   4,
		"expires_hint":      time.Now().Add(4 * time.Hour).UTC().Format(time.RFC3339),
		"note":              "El backend de Clarin generará el binario bajo demanda desde content y lo adjuntará al chat. No pegues content en la respuesta final.",
	}), nil
}

func mcpNormalizeExportFormat(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.TrimPrefix(value, ".")
	switch value {
	case "txt", "text", "texto":
		return "txt"
	case "csv":
		return "csv"
	case "xlsx", "excel":
		return "xlsx"
	case "docx", "doc", "word":
		return "docx"
	case "pptx", "ppt", "powerpoint":
		return "pptx"
	case "pdf":
		return "pdf"
	default:
		return ""
	}
}

func mcpExportFilename(raw, format string) string {
	name := strings.TrimSpace(filepath.Base(raw))
	if name == "" || name == "." || name == "/" {
		name = fmt.Sprintf("eros_%s.%s", time.Now().UTC().Format("20060102_150405"), format)
	}
	name = mcpExportFilenameUnsafe.ReplaceAllString(name, "_")
	name = strings.Trim(name, ". ")
	if name == "" {
		name = "eros_archivo"
	}
	ext := "." + format
	if !strings.EqualFold(filepath.Ext(name), ext) {
		name = strings.TrimSuffix(name, filepath.Ext(name)) + ext
	}
	if len(name) > 120 {
		name = name[:120-len(ext)] + ext
	}
	return name
}

func mcpExportContentType(format string) string {
	switch format {
	case "csv":
		return "text/csv; charset=utf-8"
	case "xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case "docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case "pptx":
		return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	case "pdf":
		return "application/pdf"
	default:
		return "text/plain; charset=utf-8"
	}
}
