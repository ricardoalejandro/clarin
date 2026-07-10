package api

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

const erosFileDefaultTTL = 4 * time.Hour

var erosSafeFilenamePattern = regexp.MustCompile(`[^a-zA-Z0-9._ -]+`)

func (s *Server) handleDownloadErosFile(c *fiber.Ctx) error {
	accountID, ok := c.Locals("account_id").(uuid.UUID)
	if !ok || accountID == uuid.Nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	fileID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid file id"})
	}

	file, sourceContent, err := s.repos.ErosFile.GetForDownload(c.Context(), accountID, userID, fileID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "file not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not load file"})
	}
	if file.Status != "ready" || time.Now().After(file.ExpiresAt) {
		return c.Status(fiber.StatusGone).JSON(fiber.Map{
			"success": false,
			"error":   "file_expired",
			"message": "Este archivo ya no está disponible. Puedes pedirme que lo genere otra vez.",
		})
	}

	payload, contentType, filename, err := renderErosFile(file, sourceContent)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	sum := sha256.Sum256(payload)
	checksum := hex.EncodeToString(sum[:])
	_ = s.repos.ErosFile.MarkDelivered(c.Context(), accountID, userID, fileID, int64(len(payload)), checksum)

	c.Set("Content-Type", contentType)
	c.Set("Content-Length", fmt.Sprintf("%d", len(payload)))
	c.Set("Content-Disposition", erosAttachmentDisposition(filename))
	c.Set("Cache-Control", "no-store, private, max-age=0")
	c.Set("Pragma", "no-cache")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.Send(payload)
}

func renderErosFile(file *domain.ErosFile, source string) ([]byte, string, string, error) {
	format := normalizeErosFileFormat(file.Format)
	if format == "" {
		return nil, "", "", fmt.Errorf("formato no soportado")
	}
	filename := ensureErosFileExtension(safeErosFilename(file.Filename), format)
	contentType := erosFileContentType(format)
	title := erosFileTitle(file, filename)
	source = erosFileSourceContent(file, source)
	clean := strings.TrimSpace(stripErosChartBlocks(source))
	if clean == "" {
		clean = "Sin contenido disponible."
	}

	switch format {
	case "txt":
		return []byte(clean + "\n"), contentType, filename, nil
	case "csv":
		payload, err := renderErosCSV(clean)
		return payload, contentType, filename, err
	case "xlsx":
		payload, err := renderErosXLSX(clean)
		return payload, contentType, filename, err
	case "docx":
		payload, err := renderErosDOCX(title, clean)
		return payload, contentType, filename, err
	case "pptx":
		payload, err := renderErosPPTX(title, clean)
		return payload, contentType, filename, err
	case "pdf":
		payload, err := renderErosPDF(title, clean)
		return payload, contentType, filename, err
	default:
		return nil, "", "", fmt.Errorf("formato no soportado")
	}
}

func buildErosFileDescriptor(accountID, userID, convID, messageID uuid.UUID, requestedMessage, assistantText string, hints []erosFileExportHint) *domain.ErosFile {
	format, filename, title, content := inferErosFileRequest(requestedMessage, assistantText, hints)
	if format == "" {
		return nil
	}
	if filename == "" {
		filename = fmt.Sprintf("eros_%s.%s", time.Now().UTC().Format("20060102_150405"), format)
	}
	filename = ensureErosFileExtension(safeErosFilename(filename), format)
	contentSource := "assistant_message"
	if strings.TrimSpace(content) != "" {
		contentSource = "mcp_tool_content"
	}
	specMap := map[string]any{
		"source":             "assistant_message",
		"content_source":     contentSource,
		"source_message_id":  messageID.String(),
		"requested_format":   format,
		"requested_filename": filename,
		"title":              title,
		"retention_hours":    4,
		"storage":            "ephemeral_render",
	}
	if strings.TrimSpace(content) != "" {
		specMap["content"] = strings.TrimSpace(content)
	}
	spec, _ := json.Marshal(specMap)
	return &domain.ErosFile{
		AccountID:      accountID,
		UserID:         userID,
		ConversationID: convID,
		MessageID:      messageID,
		Filename:       filename,
		Format:         format,
		ContentType:    erosFileContentType(format),
		Status:         "ready",
		GenerationSpec: json.RawMessage(spec),
		ExpiresAt:      time.Now().Add(erosFileDefaultTTL),
	}
}

func displayErosFileExportResponse(response string, hints []erosFileExportHint) string {
	filenames := make([]string, 0, len(hints))
	for _, hint := range hints {
		if strings.TrimSpace(hint.Content) == "" {
			continue
		}
		format := normalizeErosFileFormat(hint.Format)
		if format == "" {
			continue
		}
		filename := strings.TrimSpace(hint.Filename)
		if filename == "" {
			filename = fmt.Sprintf("eros_%s.%s", time.Now().UTC().Format("20060102_150405"), format)
		}
		filenames = append(filenames, ensureErosFileExtension(safeErosFilename(filename), format))
	}
	if len(filenames) == 0 {
		return response
	}
	if len(filenames) == 1 {
		return fmt.Sprintf("He preparado el adjunto **%s** con el contenido solicitado.", filenames[0])
	}
	if len(filenames) > 3 {
		filenames = filenames[:3]
	}
	return fmt.Sprintf("He preparado %d adjuntos con el contenido solicitado: **%s**.", len(filenames), strings.Join(filenames, "**, **"))
}

func inferErosFileRequest(requestedMessage, assistantText string, hints []erosFileExportHint) (format, filename, title, content string) {
	for _, hint := range hints {
		format = normalizeErosFileFormat(hint.Format)
		if format != "" {
			return format, strings.TrimSpace(hint.Filename), strings.TrimSpace(hint.Title), strings.TrimSpace(hint.Content)
		}
	}
	normalized := normalizeErosText(requestedMessage)
	if !looksLikeErosFileRequest(normalized) {
		return "", "", "", ""
	}
	switch {
	case strings.Contains(normalized, "pdf"):
		format = "pdf"
	case strings.Contains(normalized, "excel") || strings.Contains(normalized, "xlsx"):
		format = "xlsx"
	case strings.Contains(normalized, "csv"):
		format = "csv"
	case strings.Contains(normalized, "word") || strings.Contains(normalized, "docx") || strings.Contains(normalized, "documento"):
		format = "docx"
	case strings.Contains(normalized, "ppt") || strings.Contains(normalized, "powerpoint") || strings.Contains(normalized, "presentacion"):
		format = "pptx"
	case strings.Contains(normalized, "txt") || strings.Contains(normalized, "texto"):
		format = "txt"
	default:
		if _, _, ok := extractMarkdownTable(assistantText); ok {
			format = "xlsx"
		} else {
			format = "docx"
		}
	}
	return format, "", "", ""
}

func looksLikeErosFileRequest(normalized string) bool {
	return strings.Contains(normalized, "archivo") ||
		strings.Contains(normalized, "fichero") ||
		strings.Contains(normalized, "descarga") ||
		strings.Contains(normalized, "descargar") ||
		strings.Contains(normalized, "exporta") ||
		strings.Contains(normalized, "exportar") ||
		strings.Contains(normalized, "excel") ||
		strings.Contains(normalized, "csv") ||
		strings.Contains(normalized, "pdf") ||
		strings.Contains(normalized, "word") ||
		strings.Contains(normalized, "docx") ||
		strings.Contains(normalized, "ppt") ||
		strings.Contains(normalized, "powerpoint")
}

func normalizeErosFileFormat(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.TrimPrefix(value, ".")
	switch value {
	case "txt", "text", "texto":
		return "txt"
	case "csv":
		return "csv"
	case "xlsx", "excel":
		return "xlsx"
	case "docx", "word", "doc":
		return "docx"
	case "pptx", "ppt", "powerpoint":
		return "pptx"
	case "pdf":
		return "pdf"
	default:
		return ""
	}
}

func erosFileContentType(format string) string {
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

func safeErosFilename(raw string) string {
	name := strings.TrimSpace(filepath.Base(raw))
	if name == "." || name == "/" || name == "" {
		name = "eros_archivo"
	}
	name = erosSafeFilenamePattern.ReplaceAllString(name, "_")
	name = strings.Trim(name, ". ")
	if name == "" {
		return "eros_archivo"
	}
	if len(name) > 120 {
		ext := filepath.Ext(name)
		base := strings.TrimSuffix(name, ext)
		if len(base) > 100 {
			base = base[:100]
		}
		name = base + ext
	}
	return name
}

func ensureErosFileExtension(filename, format string) string {
	ext := "." + format
	if strings.EqualFold(filepath.Ext(filename), ext) {
		return filename
	}
	base := strings.TrimSuffix(filename, filepath.Ext(filename))
	if base == "" {
		base = "eros_archivo"
	}
	return base + ext
}

func erosAttachmentDisposition(filename string) string {
	quoted := strings.ReplaceAll(filename, `"`, "")
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, quoted, url.PathEscape(filename))
}

func erosFileTitle(file *domain.ErosFile, filename string) string {
	spec := map[string]any{}
	if len(file.GenerationSpec) > 0 && json.Valid(file.GenerationSpec) {
		_ = json.Unmarshal(file.GenerationSpec, &spec)
	}
	if title, ok := spec["title"].(string); ok && strings.TrimSpace(title) != "" {
		return strings.TrimSpace(title)
	}
	return strings.TrimSuffix(filename, filepath.Ext(filename))
}

func erosFileSourceContent(file *domain.ErosFile, fallback string) string {
	spec := map[string]any{}
	if len(file.GenerationSpec) > 0 && json.Valid(file.GenerationSpec) {
		_ = json.Unmarshal(file.GenerationSpec, &spec)
	}
	if content, ok := spec["content"].(string); ok && strings.TrimSpace(content) != "" {
		return content
	}
	return fallback
}

func stripErosChartBlocks(text string) string {
	re := regexp.MustCompile(`(?s)<chart>.*?</chart>`)
	return strings.TrimSpace(re.ReplaceAllString(text, "[Gráfico]"))
}

func normalizeErosText(text string) string {
	replacer := strings.NewReplacer(
		"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u", "ñ", "n",
		"Á", "a", "É", "e", "Í", "i", "Ó", "o", "Ú", "u", "Ü", "u", "Ñ", "n",
	)
	return strings.ToLower(replacer.Replace(text))
}

func renderErosCSV(content string) ([]byte, error) {
	headers, rows, ok := extractMarkdownTable(content)
	if !ok {
		headers = []string{"Contenido"}
		for _, paragraph := range splitErosParagraphs(content, 400) {
			rows = append(rows, []string{paragraph})
		}
	}
	buf := &bytes.Buffer{}
	buf.WriteString("\ufeff")
	writer := csv.NewWriter(buf)
	if err := writer.Write(sanitizeSpreadsheetRow(headers)); err != nil {
		return nil, err
	}
	for _, row := range rows {
		if err := writer.Write(sanitizeSpreadsheetRow(row)); err != nil {
			return nil, err
		}
	}
	writer.Flush()
	return buf.Bytes(), writer.Error()
}

func renderErosXLSX(content string) ([]byte, error) {
	headers, rows, ok := extractMarkdownTable(content)
	if !ok {
		headers = []string{"Contenido"}
		for _, paragraph := range splitErosParagraphs(content, 400) {
			rows = append(rows, []string{paragraph})
		}
	}
	allRows := append([][]string{sanitizeSpreadsheetRow(headers)}, sanitizeSpreadsheetRows(rows)...)
	sheetRows := strings.Builder{}
	for r, row := range allRows {
		rowNum := r + 1
		sheetRows.WriteString(fmt.Sprintf(`<row r="%d">`, rowNum))
		for c, value := range row {
			ref := fmt.Sprintf("%s%d", xlsxColumnName(c+1), rowNum)
			sheetRows.WriteString(fmt.Sprintf(`<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, ref, xmlEscape(value)))
		}
		sheetRows.WriteString(`</row>`)
	}
	return zipParts(map[string]string{
		"[Content_Types].xml":        xlsxContentTypesXML,
		"_rels/.rels":                packageRelsXML("http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "xl/workbook.xml"),
		"xl/workbook.xml":            xlsxWorkbookXML,
		"xl/_rels/workbook.xml.rels": xlsxWorkbookRelsXML,
		"xl/worksheets/sheet1.xml":   fmt.Sprintf(xlsxWorksheetXML, sheetRows.String()),
	})
}

func renderErosDOCX(title, content string) ([]byte, error) {
	body := strings.Builder{}
	body.WriteString(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>`)
	body.WriteString(xmlEscape(title))
	body.WriteString(`</w:t></w:r></w:p>`)
	for _, paragraph := range splitErosParagraphs(content, 900) {
		body.WriteString(`<w:p><w:r><w:t xml:space="preserve">`)
		body.WriteString(xmlEscape(paragraph))
		body.WriteString(`</w:t></w:r></w:p>`)
	}
	return zipParts(map[string]string{
		"[Content_Types].xml":          docxContentTypesXML,
		"_rels/.rels":                  packageRelsXML("http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "word/document.xml"),
		"word/document.xml":            fmt.Sprintf(docxDocumentXML, body.String()),
		"word/_rels/document.xml.rels": emptyRelsXML,
	})
}

func renderErosPPTX(title, content string) ([]byte, error) {
	lines := splitErosParagraphs(content, 110)
	if len(lines) > 8 {
		lines = lines[:8]
	}
	if len(lines) == 0 {
		lines = []string{"Sin contenido disponible."}
	}
	body := strings.Builder{}
	y := 1200000
	for i, line := range lines {
		body.WriteString(fmt.Sprintf(pptxTextBoxXML, i+3, 700000, y, 7800000, 360000, xmlEscape(line)))
		y += 430000
	}
	slide := fmt.Sprintf(pptxSlideXML, xmlEscape(title), body.String())
	return zipParts(map[string]string{
		"[Content_Types].xml":                          pptxContentTypesXML,
		"_rels/.rels":                                  pptxPackageRelsXML,
		"docProps/core.xml":                            pptxCoreXML,
		"docProps/app.xml":                             pptxAppXML,
		"ppt/presentation.xml":                         pptxPresentationXML,
		"ppt/_rels/presentation.xml.rels":              pptxPresentationRelsXML,
		"ppt/slides/slide1.xml":                        slide,
		"ppt/slides/_rels/slide1.xml.rels":             pptxSlideRelsXML,
		"ppt/slideMasters/slideMaster1.xml":            pptxSlideMasterXML,
		"ppt/slideMasters/_rels/slideMaster1.xml.rels": pptxSlideMasterRelsXML,
		"ppt/slideLayouts/slideLayout1.xml":            pptxSlideLayoutXML,
		"ppt/slideLayouts/_rels/slideLayout1.xml.rels": pptxSlideLayoutRelsXML,
		"ppt/theme/theme1.xml":                         pptxThemeXML,
	})
}

func renderErosPDF(title, content string) ([]byte, error) {
	lines := splitErosPDFLines(title, content)
	pageWidth := 595.0
	pageHeight := 842.0
	margin := 48.0
	lineHeight := 14.0
	maxLines := int((pageHeight - margin*2 - 22) / lineHeight)
	if maxLines < 1 {
		maxLines = 50
	}
	var pages [][]string
	for len(lines) > 0 {
		n := maxLines
		if len(lines) < n {
			n = len(lines)
		}
		pages = append(pages, lines[:n])
		lines = lines[n:]
	}
	if len(pages) == 0 {
		pages = [][]string{{"Sin contenido disponible."}}
	}

	objects := []string{"", ""}
	fontRef := len(objects) + 1
	objects = append(objects, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`)
	pageRefs := make([]int, 0, len(pages))
	for _, pageLines := range pages {
		stream := strings.Builder{}
		stream.WriteString("BT\n")
		stream.WriteString("/F1 16 Tf\n")
		stream.WriteString(fmt.Sprintf("%.0f %.0f Td\n", margin, pageHeight-margin))
		if len(pageLines) > 0 {
			stream.WriteString(fmt.Sprintf("(%s) Tj\n", pdfEscapeText(pageLines[0])))
		}
		stream.WriteString("/F1 10 Tf\n")
		stream.WriteString(fmt.Sprintf("0 -%.0f Td\n", lineHeight+8))
		for _, line := range pageLines[1:] {
			stream.WriteString(fmt.Sprintf("(%s) Tj\n", pdfEscapeText(line)))
			stream.WriteString(fmt.Sprintf("0 -%.0f Td\n", lineHeight))
		}
		stream.WriteString("ET\n")

		contentRef := len(objects) + 1
		streamText := stream.String()
		objects = append(objects, fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len([]byte(streamText)), streamText))
		pageRef := len(objects) + 1
		pageRefs = append(pageRefs, pageRef)
		objects = append(objects, fmt.Sprintf(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.0f %.0f] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>`, pageWidth, pageHeight, fontRef, contentRef))
	}

	kids := strings.Builder{}
	for _, ref := range pageRefs {
		kids.WriteString(fmt.Sprintf("%d 0 R ", ref))
	}
	objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`
	objects[1] = fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.TrimSpace(kids.String()), len(pageRefs))

	buf := &bytes.Buffer{}
	buf.WriteString("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
	offsets := make([]int, len(objects)+1)
	for i, obj := range objects {
		ref := i + 1
		offsets[ref] = buf.Len()
		buf.WriteString(fmt.Sprintf("%d 0 obj\n%s\nendobj\n", ref, obj))
	}
	xref := buf.Len()
	buf.WriteString(fmt.Sprintf("xref\n0 %d\n", len(objects)+1))
	buf.WriteString("0000000000 65535 f \n")
	for i := 1; i <= len(objects); i++ {
		buf.WriteString(fmt.Sprintf("%010d 00000 n \n", offsets[i]))
	}
	buf.WriteString(fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref))
	return buf.Bytes(), nil
}

func splitErosPDFLines(title, content string) []string {
	lines := []string{}
	if strings.TrimSpace(title) != "" {
		lines = append(lines, strings.TrimSpace(title), "")
	}
	for _, paragraph := range splitErosParagraphs(content, 900) {
		lines = append(lines, wrapPDFLine(paragraph, 92)...)
	}
	if len(lines) == 0 {
		return []string{"Sin contenido disponible."}
	}
	return lines
}

func wrapPDFLine(text string, maxRunes int) []string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return []string{""}
	}
	var out []string
	current := ""
	for _, word := range words {
		if utf8.RuneCountInString(word) > maxRunes {
			if current != "" {
				out = append(out, current)
				current = ""
			}
			runes := []rune(word)
			for len(runes) > maxRunes {
				out = append(out, string(runes[:maxRunes]))
				runes = runes[maxRunes:]
			}
			current = string(runes)
			continue
		}
		next := word
		if current != "" {
			next = current + " " + word
		}
		if utf8.RuneCountInString(next) > maxRunes {
			out = append(out, current)
			current = word
		} else {
			current = next
		}
	}
	if current != "" {
		out = append(out, current)
	}
	return out
}

func pdfEscapeText(value string) string {
	buf := &strings.Builder{}
	for _, r := range value {
		b := pdfWinAnsiByte(r)
		switch b {
		case '\\', '(', ')':
			buf.WriteByte('\\')
			buf.WriteByte(b)
		case '\n', '\r', '\t':
			buf.WriteByte(' ')
		default:
			if b < 32 || b > 126 {
				buf.WriteString(fmt.Sprintf("\\%03o", b))
			} else {
				buf.WriteByte(b)
			}
		}
	}
	return buf.String()
}

func pdfWinAnsiByte(r rune) byte {
	if r >= 32 && r <= 126 {
		return byte(r)
	}
	if r >= 160 && r <= 255 {
		return byte(r)
	}
	switch r {
	case '€':
		return 128
	case '‘', '’':
		return '\''
	case '“', '”':
		return '"'
	case '–', '—':
		return '-'
	default:
		return '?'
	}
}

func extractMarkdownTable(content string) ([]string, [][]string, bool) {
	lines := strings.Split(content, "\n")
	var table []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "|") && strings.HasSuffix(trimmed, "|") {
			table = append(table, trimmed)
			continue
		}
		if len(table) >= 2 {
			break
		}
		table = nil
	}
	if len(table) < 2 {
		return nil, nil, false
	}
	headers := splitMarkdownRow(table[0])
	if len(headers) == 0 {
		return nil, nil, false
	}
	rows := [][]string{}
	for _, line := range table[1:] {
		if isMarkdownSeparator(line) {
			continue
		}
		cells := splitMarkdownRow(line)
		if len(cells) == 0 {
			continue
		}
		for len(cells) < len(headers) {
			cells = append(cells, "")
		}
		if len(cells) > len(headers) {
			cells = cells[:len(headers)]
		}
		rows = append(rows, cells)
	}
	return headers, rows, len(rows) > 0
}

func splitMarkdownRow(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	parts := strings.Split(line, "|")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		out = append(out, strings.TrimSpace(part))
	}
	return out
}

func isMarkdownSeparator(line string) bool {
	for _, r := range strings.Trim(line, "|: -") {
		if r != ' ' && r != '\t' {
			return false
		}
	}
	return strings.Contains(line, "-")
}

func splitErosParagraphs(content string, maxLen int) []string {
	clean := strings.ReplaceAll(content, "\r\n", "\n")
	parts := strings.Split(clean, "\n")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(strings.Trim(part, "`"))
		if part == "" || isMarkdownSeparator(part) {
			continue
		}
		if strings.HasPrefix(part, "|") && strings.HasSuffix(part, "|") {
			part = strings.Join(splitMarkdownRow(part), " · ")
		}
		for len(part) > maxLen {
			out = append(out, strings.TrimSpace(part[:maxLen]))
			part = strings.TrimSpace(part[maxLen:])
		}
		if part != "" {
			out = append(out, part)
		}
	}
	if len(out) == 0 {
		return []string{"Sin contenido disponible."}
	}
	return out
}

func sanitizeSpreadsheetRows(rows [][]string) [][]string {
	out := make([][]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, sanitizeSpreadsheetRow(row))
	}
	return out
}

func sanitizeSpreadsheetRow(row []string) []string {
	out := make([]string, len(row))
	for i, value := range row {
		out[i] = sanitizeSpreadsheetCell(value)
	}
	return out
}

func sanitizeSpreadsheetCell(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	first := value[0]
	if first == '=' || first == '+' || first == '-' || first == '@' || first == '\t' || first == '\r' || first == '\n' {
		return "'" + value
	}
	return value
}

func xlsxColumnName(index int) string {
	name := ""
	for index > 0 {
		index--
		name = string(rune('A'+(index%26))) + name
		index /= 26
	}
	return name
}

func zipParts(parts map[string]string) ([]byte, error) {
	buf := &bytes.Buffer{}
	zw := zip.NewWriter(buf)
	for name, content := range parts {
		w, err := zw.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write([]byte(content)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func xmlEscape(value string) string {
	buf := &bytes.Buffer{}
	_ = xml.EscapeText(buf, []byte(value))
	return buf.String()
}

const emptyRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`

func packageRelsXML(relType, target string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="%s" Target="%s"/></Relationships>`, relType, target)
}

const xlsxContentTypesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
const xlsxWorkbookXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Reporte" sheetId="1" r:id="rId1"/></sheets></workbook>`
const xlsxWorkbookRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
const xlsxWorksheetXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>%s</sheetData></worksheet>`

const docxContentTypesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
const docxDocumentXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>%s<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

const pptxContentTypesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
const pptxPackageRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
const pptxCoreXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Eros</dc:title></cp:coreProperties>`
const pptxAppXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Clarin</Application></Properties>`
const pptxPresentationXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
const pptxPresentationRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`
const pptxSlideXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="350000"/><a:ext cx="8144000" cy="600000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="3200" b="1"/><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>%s</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
const pptxTextBoxXML = `<p:sp><p:nvSpPr><p:cNvPr id="%d" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1800"/><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>`
const pptxSlideRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
const pptxSlideMasterXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`
const pptxSlideMasterRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`
const pptxSlideLayoutXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
const pptxSlideLayoutRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
const pptxThemeXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Clarin"><a:themeElements><a:clrScheme name="Clarin"><a:dk1><a:srgbClr val="1f2937"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="334155"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="10B981"/></a:accent1><a:accent2><a:srgbClr val="0F766E"/></a:accent2><a:accent3><a:srgbClr val="2563EB"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="64748B"/></a:accent5><a:accent6><a:srgbClr val="111827"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Clarin"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Clarin"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`
