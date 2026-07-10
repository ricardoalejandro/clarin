package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

// MCPServer wraps the MCP SDK server and Clarin repositories.
// Authentication is handled exclusively via API keys generated from the dashboard.
type MCPServer struct {
	mcpServer *server.MCPServer
	repos     *repository.Repositories
	services  *service.Services
	jwtSecret string
	rateMu    sync.Mutex
	rateByIP  map[string]*mcpRateWindow
}

type mcpRateWindow struct {
	count   int
	resetAt time.Time
}

const (
	mcpAccountSlugArgDescription = "Slug de cuenta. Si list_accounts devuelve slug vacío, usa account_id; como compatibilidad también se acepta name exacto."

	mcpErrorAccountNotAllowed = "ACCOUNT_NOT_ALLOWED"
	mcpErrorAccountNotFound   = "ACCOUNT_NOT_FOUND"
)

type mcpCodedError struct {
	Code    string
	Message string
}

func (e *mcpCodedError) Error() string {
	return e.Message
}

func newMCPCodedError(code, message string) error {
	return &mcpCodedError{Code: code, Message: message}
}

func mcpErrorCode(err error, fallback string) string {
	var coded *mcpCodedError
	if errors.As(err, &coded) && coded.Code != "" {
		return coded.Code
	}
	return fallback
}

func mcpErrorMessage(err error, fallback string) string {
	var coded *mcpCodedError
	if errors.As(err, &coded) && coded.Message != "" {
		return coded.Message
	}
	if err != nil && err.Error() != "" {
		return err.Error()
	}
	return fallback
}

func readOnlyTool(name string, opts ...mcp.ToolOption) mcp.Tool {
	opts = append([]mcp.ToolOption{
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithIdempotentHintAnnotation(true),
		mcp.WithOpenWorldHintAnnotation(false),
	}, opts...)
	return mcp.NewTool(name, opts...)
}

// New creates a new MCP server with all Clarin CRM tools registered.
func New(repos *repository.Repositories, services *service.Services, jwtSecret string, buildVersion string) *MCPServer {
	if strings.TrimSpace(buildVersion) == "" {
		buildVersion = "dev"
	}
	s := &MCPServer{
		repos:     repos,
		services:  services,
		jwtSecret: jwtSecret,
		rateByIP:  make(map[string]*mcpRateWindow),
	}

	mcpSrv := server.NewMCPServer(
		"Clarin CRM",
		buildVersion,
		server.WithToolCapabilities(true),
		server.WithToolHandlerMiddleware(s.auditToolCallMiddleware()),
	)

	// ──────────────── Category A: Data Queries ────────────────

	mcpSrv.AddTool(readOnlyTool("list_accounts",
		mcp.WithDescription("Lista las cuentas activas disponibles para esta conexión MCP global. Usa account_id como identificador preferido. Usa account_slug sólo cuando slug no esté vacío; name es identificador humano y se acepta como compatibilidad si falta slug."),
	), s.toolListAccounts)

	mcpSrv.AddTool(readOnlyTool("get_crm_stats",
		mcp.WithDescription("Resumen general del CRM de una cuenta: total de leads por etapa, contactos, eventos activos, programas. Usa list_accounts primero y pasa account_id o account_slug."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
	), s.toolGetCRMStats)

	mcpSrv.AddTool(readOnlyTool("list_events",
		mcp.WithDescription("Busca y lista eventos por nombre, estado o fecha. Devuelve nombre, fecha, ubicación, total de participantes y conteos por etapa. Úsalo para encontrar un evento antes de consultar sus detalles o participantes."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("search", mcp.Description("Buscar evento por nombre, descripción o ubicación (ej: 'amistad', 'iquitos')")),
		mcp.WithString("status", mcp.Description("Filtrar por estado: active, draft, completed, cancelled. Vacío = todos.")),
		mcp.WithNumber("limit", mcp.Description("Máximo de resultados (default 20, max 100)")),
	), s.toolListEvents)

	mcpSrv.AddTool(readOnlyTool("get_event_summary",
		mcp.WithDescription("Resumen detallado de un evento específico: participantes por etapa (confirmados, contactados, declinados, etc.), descripción, fechas. Necesitas el event_id, obtenlo primero con list_events."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("event_id", mcp.Required(), mcp.Description("UUID del evento")),
	), s.toolGetEventSummary)

	mcpSrv.AddTool(readOnlyTool("search_leads",
		mcp.WithDescription("Busca leads específicos con filtros precisos. Devuelve nombre, tags, etapa y fecha de creación. IMPORTANTE: Usa SIEMPRE filtros específicos (tag, etapa, fecha, nombre). Para análisis de todos los leads, usa primero get_lead_analytics o analyze_leads. Esta herramienta es para consultas puntuales como 'leads con tag matemáticas creados esta semana' o 'buscar a Juan Pérez'."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("query", mcp.Description("Texto de búsqueda (nombre, teléfono, email)")),
		mcp.WithString("tag", mcp.Description("Filtrar por nombre de tag")),
		mcp.WithString("stage", mcp.Description("Filtrar por nombre de etapa")),
		mcp.WithString("created_after", mcp.Description("Fecha de creación desde (formato YYYY-MM-DD, ej: '2026-03-01'). Inclusive.")),
		mcp.WithString("created_before", mcp.Description("Fecha de creación hasta (formato YYYY-MM-DD, ej: '2026-03-05'). Inclusive.")),
		mcp.WithNumber("limit", mcp.Description("Máximo de resultados (default 20, max 100)")),
		mcp.WithNumber("offset", mcp.Description("Desplazamiento para paginación (default 0).")),
	), s.toolSearchLeads)

	mcpSrv.AddTool(readOnlyTool("get_lead_detail",
		mcp.WithDescription("Información completa de un lead: datos personales, todos los tags, etapa actual, notas, fuente, campos personalizados, edad, fecha de creación. Necesitas el lead_id, obtenlo con search_leads."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("lead_id", mcp.Required(), mcp.Description("UUID del lead")),
	), s.toolGetLeadDetail)

	mcpSrv.AddTool(readOnlyTool("list_tags",
		mcp.WithDescription("Lista todos los tags disponibles en el CRM con nombre y color. Útil para saber qué tags existen antes de filtrar leads o eventos."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
	), s.toolListTags)

	mcpSrv.AddTool(readOnlyTool("list_pipelines",
		mcp.WithDescription("Lista los pipelines de ventas con sus etapas, colores y posiciones. Útil para conocer las etapas disponibles antes de filtrar leads."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
	), s.toolListPipelines)

	mcpSrv.AddTool(readOnlyTool("search_contacts",
		mcp.WithDescription("Busca contactos de WhatsApp por nombre o teléfono. Útil para verificar si alguien tiene WhatsApp o encontrar su chat."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("query", mcp.Required(), mcp.Description("Texto de búsqueda (nombre o teléfono)")),
		mcp.WithNumber("limit", mcp.Description("Máximo de resultados (default 20, max 50)")),
	), s.toolSearchContacts)

	// ──────────────── Category A.2: Event Participants ────────────────

	mcpSrv.AddTool(readOnlyTool("list_event_participants",
		mcp.WithDescription("Lista participantes de un evento para reportes. Por defecto devuelve datos mínimos: id, nombre, etapa, estado y fecha. Si el usuario pide explícitamente teléfonos, emails o notas, usa include_sensitive=true."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("event_id", mcp.Required(), mcp.Description("UUID del evento")),
		mcp.WithString("status", mcp.Description("Filtrar por estado: invited, contacted, confirmed, declined, attended, no_show")),
		mcp.WithString("stage", mcp.Description("Filtrar por nombre de etapa del evento")),
		mcp.WithString("search", mcp.Description("Buscar participante por nombre o teléfono")),
		mcp.WithBoolean("include_sensitive", mcp.Description("Incluir teléfono, email y notas sólo si el usuario lo pidió explícitamente. Default false.")),
		mcp.WithNumber("limit", mcp.Description("Máximo de resultados (default 50, max 200)")),
	), s.toolListEventParticipants)

	// ──────────────── Category A.3: Lead Analytics ────────────────

	mcpSrv.AddTool(readOnlyTool("get_lead_analytics",
		mcp.WithDescription("Estadísticas agregadas de leads SIN datos personales. Devuelve: distribución por tags (top 30 con conteo), distribución por etapa, leads por mes (últimos 6), leads con/sin WhatsApp, con/sin teléfono, por fuente. ÚSALO para entender la composición de la base antes de filtrar. Ideal para '¿cuántos leads tienen tag X?', '¿tags más comunes?', '¿cuántos leads nuevos por mes?'. No devuelve datos individuales — para eso usa search_leads con filtros específicos."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("tag", mcp.Description("Filtrar análisis solo a leads con este tag")),
		mcp.WithString("stage", mcp.Description("Filtrar análisis solo a leads en esta etapa")),
		mcp.WithString("created_after", mcp.Description("Solo analizar leads creados desde esta fecha (YYYY-MM-DD)")),
		mcp.WithString("created_before", mcp.Description("Solo analizar leads creados hasta esta fecha (YYYY-MM-DD)")),
	), s.toolGetLeadAnalytics)

	mcpSrv.AddTool(readOnlyTool("analyze_leads",
		mcp.WithDescription("Análisis avanzado de leads con scoring de conversión calculado en el servidor. Puntúa cada lead según: posición en pipeline (etapas avanzadas = mayor score), actividad de WhatsApp (tiene chat activo), cantidad de mensajes recientes, presencia de notas, cantidad de tags, y antigüedad. Devuelve un ranking con score, factores explicados, etapa y tags — SIN teléfonos ni emails. Úsalo para responder preguntas como '¿cuáles leads tienen más probabilidad de convertir?', 'top 20 leads más comprometidos', 'leads que debería contactar primero'. Para ver datos de contacto de un lead específico, usa get_lead_detail con su ID."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("tag", mcp.Description("Filtrar solo leads con este tag (ej: 'matemáticas', 'iquitos')")),
		mcp.WithString("stage", mcp.Description("Filtrar solo leads en esta etapa (ej: 'CONFIRMADO', 'PRE-INSCRITO')")),
		mcp.WithString("created_after", mcp.Description("Solo leads creados desde esta fecha (YYYY-MM-DD)")),
		mcp.WithString("created_before", mcp.Description("Solo leads creados hasta esta fecha (YYYY-MM-DD)")),
		mcp.WithString("sort_by", mcp.Description("Criterio de ranking: 'score' (default, score compuesto), 'chat_activity' (más mensajes recientes), 'stage' (etapa más avanzada), 'recent' (leads más nuevos)")),
		mcp.WithNumber("limit", mcp.Description("Top N leads a devolver (default 20, max 50)")),
	), s.toolAnalyzeLeads)

	// ──────────────── Category A.4: Simple Lead JSON Queries ────────────────

	leadFieldsSchema := map[string]any{
		"type": "string",
		"enum": []string{"id", "name", "phone", "normalized_phone", "email", "stage", "source", "created_at", "tags", "status"},
	}

	mcpSrv.AddTool(readOnlyTool("count_leads",
		mcp.WithDescription("Cuenta leads con filtros ligeros y devuelve total_found, filters_applied y la herramienta recomendada para el siguiente paso. Úsalo antes de listar datos cuando el usuario pregunte 'cuántos leads hay' o 'cuántos con tag X'. Si el usuario pide un archivo, usa prepare_file_export/render_file_export para que Clarin adjunte la descarga en el chat."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("query", mcp.Description("Buscar por nombre, teléfono o email.")),
		mcp.WithString("tag", mcp.Description("Filtrar por nombre de tag.")),
		mcp.WithString("stage", mcp.Description("Filtrar por nombre de etapa CRM.")),
		mcp.WithString("source", mcp.Description("Filtrar por fuente.")),
		mcp.WithString("status", mcp.Description("Filtrar por status del lead.")),
		mcp.WithString("created_from", mcp.Description("Fecha desde en formato YYYY-MM-DD o RFC3339. Usa timezone para interpretar fechas sin hora.")),
		mcp.WithString("created_to", mcp.Description("Fecha hasta en formato YYYY-MM-DD o RFC3339. YYYY-MM-DD incluye todo ese día en timezone.")),
		mcp.WithString("timezone", mcp.Description("Zona horaria IANA para created_from/created_to sin hora. Default America/Lima.")),
		mcp.WithString("created_after", mcp.Description("Compatibilidad legacy: equivalente a created_from si created_from no se envía.")),
		mcp.WithString("created_before", mcp.Description("Compatibilidad legacy: equivalente a created_to si created_to no se envía.")),
		mcp.WithBoolean("active_only", mcp.Description("Si true, excluye leads archivados y bloqueados. Default false.")),
	), s.toolCountLeads)

	mcpSrv.AddTool(readOnlyTool("list_leads",
		mcp.WithDescription("Lista leads en JSON paginado y predecible. Siempre devuelve items/leads, returned, total, has_more, next_cursor y filters_applied. Ideal para revisar datos simples sin chat, scoring ni reportes pesados. Si el usuario pide CSV, Excel, Word, PowerPoint, PDF o descarga, usa esta herramienta por páginas y luego prepare_file_export/render_file_export con content para que Clarin adjunte el archivo sin pegarlo en el chat."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("query", mcp.Description("Buscar por nombre, teléfono o email.")),
		mcp.WithString("tag", mcp.Description("Filtrar por nombre de tag.")),
		mcp.WithString("stage", mcp.Description("Filtrar por nombre de etapa CRM.")),
		mcp.WithString("source", mcp.Description("Filtrar por fuente.")),
		mcp.WithString("status", mcp.Description("Filtrar por status del lead.")),
		mcp.WithString("created_from", mcp.Description("Fecha desde en formato YYYY-MM-DD o RFC3339. Usa timezone para interpretar fechas sin hora.")),
		mcp.WithString("created_to", mcp.Description("Fecha hasta en formato YYYY-MM-DD o RFC3339. YYYY-MM-DD incluye todo ese día en timezone.")),
		mcp.WithString("timezone", mcp.Description("Zona horaria IANA para created_from/created_to sin hora. Default America/Lima.")),
		mcp.WithString("created_after", mcp.Description("Compatibilidad legacy: equivalente a created_from si created_from no se envía.")),
		mcp.WithString("created_before", mcp.Description("Compatibilidad legacy: equivalente a created_to si created_to no se envía.")),
		mcp.WithBoolean("active_only", mcp.Description("Si true, excluye leads archivados y bloqueados. Default false.")),
		mcp.WithArray("fields", mcp.Description("Campos a devolver. Permitidos: id, name, phone, normalized_phone, email, stage, source, created_at, tags, status. Si omites fields devuelve un listado útil para revisar y difusión."), mcp.Items(leadFieldsSchema), mcp.UniqueItems(true)),
		mcp.WithNumber("limit", mcp.Description("Leads por página (default 500, max 1000).")),
		mcp.WithString("cursor", mcp.Description("Cursor devuelto por la llamada anterior. No reutilices el mismo cursor si has_more=true; usa next_cursor.")),
	), s.toolListLeads)

	mcpSrv.AddTool(readOnlyTool("prepare_file_export",
		mcp.WithDescription("Prepara un adjunto descargable de Eros sin guardar binarios en MinIO ni devolver URL pública. Úsalo cuando el usuario pida crear un archivo, fichero, Excel, CSV, Word, PowerPoint, PDF o TXT. Devuelve metadata segura para que Clarin pinte el adjunto en el chat."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("format", mcp.Required(), mcp.Description("Formato: txt, csv, xlsx, docx, pptx o pdf.")),
		mcp.WithString("filename", mcp.Description("Nombre sugerido del archivo. Se sanitiza y se ajusta la extensión.")),
		mcp.WithString("title", mcp.Description("Título humano del archivo.")),
	), s.toolPrepareFileExport)

	mcpSrv.AddTool(readOnlyTool("render_file_export",
		mcp.WithDescription("Confirma el adjunto descargable de Eros. No escribe archivos, no usa MinIO y no devuelve base64; envía el contenido completo en content para que el backend genere el binario bajo demanda sin pegarlo en el chat."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("format", mcp.Required(), mcp.Description("Formato: txt, csv, xlsx, docx, pptx o pdf.")),
		mcp.WithString("filename", mcp.Description("Nombre sugerido del archivo. Se sanitiza y se ajusta la extensión.")),
		mcp.WithString("title", mcp.Description("Título humano del archivo.")),
		mcp.WithString("source", mcp.Description("Fuente del contenido. Default assistant_response.")),
		mcp.WithString("content", mcp.Description("Contenido completo del archivo en texto/Markdown/CSV. Clarin lo guarda oculto en el descriptor temporal; no lo pegues en la respuesta final.")),
	), s.toolRenderFileExport)

	// ──────────────── Category A.5: Deep Lead Analysis Exports ────────────────

	mcpSrv.AddTool(readOnlyTool("get_analysis_capabilities",
		mcp.WithDescription("Explica qué datos profundos puede entregar Clarin por MCP para análisis de leads, qué herramientas usar, límites técnicos de página/cursor y conteos actuales de la cuenta. Úsalo primero antes de pedir exports grandes."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
	), s.toolGetAnalysisCapabilities)

	mcpSrv.AddTool(readOnlyTool("get_lead_analysis_overview",
		mcp.WithDescription("Resumen analítico agregado de TODA la base de leads de una cuenta: etapas, fuentes, tags, calidad de datos, chats, eventos, notas, campañas, programas, encuestas y dinámicas. No está limitado a 20/50 leads porque calcula agregados en servidor."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("tag", mcp.Description("Opcional: filtrar por tag.")),
		mcp.WithString("stage", mcp.Description("Opcional: filtrar por etapa CRM.")),
		mcp.WithString("source", mcp.Description("Opcional: filtrar por fuente.")),
		mcp.WithString("query", mcp.Description("Opcional: búsqueda por nombre, teléfono o email.")),
		mcp.WithString("created_after", mcp.Description("Opcional: fecha desde YYYY-MM-DD.")),
		mcp.WithString("created_before", mcp.Description("Opcional: fecha hasta YYYY-MM-DD inclusive.")),
		mcp.WithBoolean("active_only", mcp.Description("Si true, excluye archivados y bloqueados. Default false para analizar toda la base.")),
	), s.toolGetLeadAnalysisOverview)

	mcpSrv.AddTool(readOnlyTool("get_lead_analysis_report",
		mcp.WithDescription("Reporte server-side de leads con prioridad A+/A/B/C/D/E, temperatura, perfil humano, acción recomendada, razón y evidencia breve de chat. Ideal cuando quieres que Clarin haga el trabajo pesado y ChatGPT interprete el resultado. Puede escanear miles de leads y devolver páginas por cursor."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("segment", mcp.Description("Opcional: filtrar resultado calculado por CALL, WHATSAPP_PERSONALIZADO, DIFUSION, NO_PRIORIZAR, OBSTACULO_REAL, ASISTENTE_PREVIO, CONFIRMADO_NO_ASISTIO, REDES_FRIAS.")),
		mcp.WithString("tag", mcp.Description("Opcional: filtrar por tag antes de calcular.")),
		mcp.WithString("stage", mcp.Description("Opcional: filtrar por etapa CRM antes de calcular.")),
		mcp.WithString("source", mcp.Description("Opcional: filtrar por fuente antes de calcular.")),
		mcp.WithString("query", mcp.Description("Opcional: búsqueda por nombre, teléfono o email.")),
		mcp.WithString("created_after", mcp.Description("Opcional: fecha desde YYYY-MM-DD.")),
		mcp.WithString("created_before", mcp.Description("Opcional: fecha hasta YYYY-MM-DD inclusive.")),
		mcp.WithBoolean("active_only", mcp.Description("Si true, excluye archivados y bloqueados. Default false.")),
		mcp.WithNumber("limit", mcp.Description("Cantidad de filas calculadas a devolver en esta página (default 200, max 1000).")),
		mcp.WithNumber("max_scan", mcp.Description("Máximo de leads a escanear para calcular ranking (default 5000, max 20000).")),
		mcp.WithString("cursor", mcp.Description("Cursor devuelto por la llamada anterior para continuar la paginación del reporte.")),
	), s.toolGetLeadAnalysisReport)

	mcpSrv.AddTool(readOnlyTool("export_leads_for_analysis",
		mcp.WithDescription("Export profundo paginado de leads para análisis externo por ChatGPT: lead, contacto, teléfono, email, etapa, fuente, tags, notas, campos personalizados, eventos, programas, campañas, encuestas, dinámicas, observaciones, duplicados y métricas de chat. Usa cursor para recorrer toda la cuenta por lotes grandes."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("tag", mcp.Description("Opcional: filtrar por tag.")),
		mcp.WithString("stage", mcp.Description("Opcional: filtrar por etapa CRM.")),
		mcp.WithString("source", mcp.Description("Opcional: filtrar por fuente.")),
		mcp.WithString("query", mcp.Description("Opcional: búsqueda por nombre, teléfono o email.")),
		mcp.WithString("created_after", mcp.Description("Opcional: fecha desde YYYY-MM-DD.")),
		mcp.WithString("created_before", mcp.Description("Opcional: fecha hasta YYYY-MM-DD inclusive.")),
		mcp.WithString("lead_id", mcp.Description("Opcional: exportar solo un lead.")),
		mcp.WithBoolean("active_only", mcp.Description("Si true, excluye archivados y bloqueados. Default false.")),
		mcp.WithNumber("limit", mcp.Description("Leads por página (default 500, max 1000).")),
		mcp.WithString("cursor", mcp.Description("Cursor devuelto por la llamada anterior para continuar.")),
	), s.toolExportLeadsForAnalysis)

	mcpSrv.AddTool(readOnlyTool("export_messages_for_analysis",
		mcp.WithDescription("Export profundo paginado de mensajes WhatsApp para análisis conversacional: mensaje, chat, contacto, lead_ids vinculados, dirección, tipo, texto, fecha, estado, proveedor y metadata de media. Puede recorrer todos los mensajes de la cuenta por cursor."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("lead_id", mcp.Description("Opcional: filtrar mensajes del contacto vinculado a un lead.")),
		mcp.WithString("contact_id", mcp.Description("Opcional: filtrar por contacto.")),
		mcp.WithString("phone", mcp.Description("Opcional: filtrar por teléfono.")),
		mcp.WithString("direction", mcp.Description("Opcional: inbound, outbound o vacío para ambos.")),
		mcp.WithString("created_after", mcp.Description("Opcional: mensajes desde YYYY-MM-DD.")),
		mcp.WithString("created_before", mcp.Description("Opcional: mensajes hasta YYYY-MM-DD inclusive.")),
		mcp.WithNumber("limit", mcp.Description("Mensajes por página (default 1000, max 5000).")),
		mcp.WithString("cursor", mcp.Description("Cursor devuelto por la llamada anterior para continuar.")),
	), s.toolExportMessagesForAnalysis)

	mcpSrv.AddTool(readOnlyTool("get_lead_analysis_detail",
		mcp.WithDescription("Ficha profunda de un lead específico para análisis: datos del lead/contacto, scoring, prioridad, eventos, programas, campañas, encuestas, dinámicas, observaciones y últimos mensajes completos. Úsalo después del reporte o export cuando necesites evidencia individual."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("lead_id", mcp.Required(), mcp.Description("UUID del lead.")),
		mcp.WithNumber("messages_limit", mcp.Description("Últimos mensajes a incluir (default 200, max 1000).")),
	), s.toolGetLeadAnalysisDetail)

	mcpSrv.AddTool(readOnlyTool("get_segment_members",
		mcp.WithDescription("Devuelve miembros de un segmento calculado del análisis: CALL, WHATSAPP_PERSONALIZADO, DIFUSION, NO_PRIORIZAR, OBSTACULO_REAL, ASISTENTE_PREVIO, CONFIRMADO_NO_ASISTIO, REDES_FRIAS. Útil para pedir 'dame los de llamada' sin rehacer lógica en ChatGPT."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("segment", mcp.Required(), mcp.Description("Segmento calculado: CALL, WHATSAPP_PERSONALIZADO, DIFUSION, NO_PRIORIZAR, OBSTACULO_REAL, ASISTENTE_PREVIO, CONFIRMADO_NO_ASISTIO, REDES_FRIAS.")),
		mcp.WithString("tag", mcp.Description("Opcional: filtrar por tag antes de calcular segmento.")),
		mcp.WithString("stage", mcp.Description("Opcional: filtrar por etapa antes de calcular segmento.")),
		mcp.WithString("source", mcp.Description("Opcional: filtrar por fuente antes de calcular segmento.")),
		mcp.WithString("query", mcp.Description("Opcional: búsqueda por nombre, teléfono o email.")),
		mcp.WithString("created_after", mcp.Description("Opcional: fecha desde YYYY-MM-DD.")),
		mcp.WithString("created_before", mcp.Description("Opcional: fecha hasta YYYY-MM-DD inclusive.")),
		mcp.WithBoolean("active_only", mcp.Description("Si true, excluye archivados y bloqueados. Default false.")),
		mcp.WithNumber("limit", mcp.Description("Cantidad de filas en esta página (default 200, max 1000).")),
		mcp.WithNumber("max_scan", mcp.Description("Máximo de leads a escanear para calcular segmento (default 5000, max 20000).")),
		mcp.WithString("cursor", mcp.Description("Cursor devuelto por la llamada anterior para continuar.")),
	), s.toolGetSegmentMembers)

	// ──────────────── Category B: Logbooks ────────────────

	mcpSrv.AddTool(readOnlyTool("list_event_logbooks",
		mcp.WithDescription("Lista las bitácoras de un evento con fecha, estado, notas generales y snapshot de etapas."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("event_id", mcp.Required(), mcp.Description("UUID del evento")),
	), s.toolListEventLogbooks)

	mcpSrv.AddTool(readOnlyTool("get_logbook_detail",
		mcp.WithDescription("Detalle de una bitácora: entradas por participante con su etapa y notas de ese día."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("logbook_id", mcp.Required(), mcp.Description("UUID de la bitácora")),
	), s.toolGetLogbookDetail)

	// ──────────────── Category C: Chats ────────────────

	mcpSrv.AddTool(readOnlyTool("get_chat_history",
		mcp.WithDescription("Obtiene los últimos mensajes de WhatsApp con un contacto o lead. Útil para analizar intención, hacer resumen de conversación o verificar último contacto."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("contact_name", mcp.Description("Nombre del contacto a buscar")),
		mcp.WithString("phone", mcp.Description("Teléfono del contacto (con o sin código de país)")),
		mcp.WithNumber("limit", mcp.Description("Número de mensajes a obtener (default 50, max 200)")),
	), s.toolGetChatHistory)

	mcpSrv.AddTool(readOnlyTool("get_leads_with_chats",
		mcp.WithDescription("Obtiene un grupo PEQUEÑO de leads con sus mensajes de WhatsApp para análisis de conversación. REQUIERE al menos un filtro (evento, tag, etapa o nombre). Evalúa las conversaciones para determinar intención, interés u objeciones. Para análisis de muchos leads, usa primero analyze_leads para identificar los más relevantes y luego consulta sus chats aquí."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("event_id", mcp.Description("UUID del evento para filtrar participantes")),
		mcp.WithString("tag", mcp.Description("Nombre de tag para filtrar leads")),
		mcp.WithString("stage", mcp.Description("Nombre de etapa para filtrar")),
		mcp.WithString("query", mcp.Description("Texto de búsqueda (nombre, teléfono, email)")),
		mcp.WithNumber("messages_per_lead", mcp.Description("Mensajes por lead (default 20, max 50)")),
		mcp.WithNumber("max_leads", mcp.Description("Máximo de leads a incluir (default 10, max 30)")),
	), s.toolGetLeadsWithChats)

	// ──────────────── Category D: Programs ────────────────

	mcpSrv.AddTool(readOnlyTool("list_programs",
		mcp.WithDescription("Lista los programas educativos de la cuenta con nombre, estado, participantes y sesiones. Úsalo para ver los programas disponibles antes de consultar detalle."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("status", mcp.Description("Filtrar por estado: active, completed, archived. Vacío = todos.")),
	), s.toolListPrograms)

	mcpSrv.AddTool(readOnlyTool("get_program_detail",
		mcp.WithDescription("Detalle completo de un programa educativo: descripción, horarios, participantes inscritos con estado, y sesiones programadas con estadísticas de asistencia."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("program_id", mcp.Required(), mcp.Description("UUID del programa")),
	), s.toolGetProgramDetail)

	mcpSrv.AddTool(readOnlyTool("get_program_attendance",
		mcp.WithDescription("Asistencia detallada de una sesión de programa: lista de participantes con su estado (present, absent, late, excused) y notas."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("session_id", mcp.Required(), mcp.Description("UUID de la sesión")),
	), s.toolGetProgramAttendance)

	// ──────────────── Category E: Campaigns ────────────────

	mcpSrv.AddTool(readOnlyTool("list_campaigns",
		mcp.WithDescription("Lista las campañas de mensajes masivos de WhatsApp con nombre, estado, totales de envío y fechas."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
	), s.toolListCampaigns)

	mcpSrv.AddTool(readOnlyTool("get_campaign_detail",
		mcp.WithDescription("Detalle de una campaña de mensajes: template, estado de cada destinatario (enviado, fallido, pendiente), adjuntos, y estadísticas."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("campaign_id", mcp.Required(), mcp.Description("UUID de la campaña")),
		mcp.WithNumber("recipient_limit", mcp.Description("Máximo de destinatarios a devolver (default 50, max 200)")),
	), s.toolGetCampaignDetail)

	// ──────────────── Category F: Surveys ────────────────

	mcpSrv.AddTool(readOnlyTool("list_surveys",
		mcp.WithDescription("Lista las encuestas creadas en la cuenta con nombre, estado, slug y total de respuestas."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
	), s.toolListSurveys)

	mcpSrv.AddTool(readOnlyTool("get_survey_detail",
		mcp.WithDescription("Detalle de una encuesta: preguntas con tipo, opciones y configuración. Necesitas el survey_id, obtenlo con list_surveys."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("survey_id", mcp.Required(), mcp.Description("UUID de la encuesta")),
	), s.toolGetSurveyDetail)

	mcpSrv.AddTool(readOnlyTool("get_survey_analytics",
		mcp.WithDescription("Analytics agregado de una encuesta: total de respuestas, tasa de completado, tiempo promedio y distribución de respuestas por pregunta."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("survey_id", mcp.Required(), mcp.Description("UUID de la encuesta")),
	), s.toolGetSurveyAnalytics)

	// ──────────────── Category G: Automations ────────────────

	mcpSrv.AddTool(readOnlyTool("list_automations",
		mcp.WithDescription("Lista las automatizaciones configuradas con nombre, tipo de trigger, estado activo/inactivo y conteo de ejecuciones."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
	), s.toolListAutomations)

	mcpSrv.AddTool(readOnlyTool("get_automation_detail",
		mcp.WithDescription("Detalle de una automatización: trigger, configuración, últimas ejecuciones con estado y estadísticas generales."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("automation_id", mcp.Required(), mcp.Description("UUID de la automatización")),
	), s.toolGetAutomationDetail)

	// ──────────────── Category H: Contacts & Chats ────────────────

	mcpSrv.AddTool(readOnlyTool("get_contact_detail",
		mcp.WithDescription("Información completa de un contacto de WhatsApp: nombre, nombre personalizado, teléfono, email, empresa, notas, tags, lead vinculado y último mensaje."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("contact_id", mcp.Description("UUID del contacto")),
		mcp.WithString("phone", mcp.Description("Teléfono del contacto (alternativa al ID)")),
	), s.toolGetContactDetail)

	mcpSrv.AddTool(readOnlyTool("list_chats",
		mcp.WithDescription("Lista los chats de WhatsApp activos de la cuenta: contacto, último mensaje, mensajes no leídos y fecha. Ordenados por último mensaje."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithNumber("limit", mcp.Description("Máximo de chats (default 30, max 100)")),
	), s.toolListChats)

	mcpSrv.AddTool(readOnlyTool("search_chat_messages",
		mcp.WithDescription("Busca mensajes por texto en todas las conversaciones de la cuenta. Devuelve el mensaje, contacto y fecha. Máximo 50 resultados."),
		mcp.WithString("account_id", mcp.Description("UUID de cuenta. Obténlo con list_accounts.")),
		mcp.WithString("account_slug", mcp.Description(mcpAccountSlugArgDescription)),
		mcp.WithString("query", mcp.Required(), mcp.Description("Texto a buscar en los mensajes")),
		mcp.WithNumber("limit", mcp.Description("Máximo de resultados (default 30, max 50)")),
	), s.toolSearchChatMessages)

	s.mcpServer = mcpSrv
	return s
}

// streamableHTTPHandler returns an MCP Streamable HTTP handler protected by global MCP client auth.
func (s *MCPServer) streamableHTTPHandler() http.Handler {
	httpServer := server.NewStreamableHTTPServer(s.mcpServer,
		server.WithHTTPContextFunc(func(ctx context.Context, r *http.Request) context.Context {
			if principal, ok := r.Context().Value(ctxKeyPrincipal).(*MCPPrincipal); ok {
				ctx = context.WithValue(ctx, ctxKeyPrincipal, principal)
			}
			return ctx
		}),
	)
	return s.authenticatedMCPHandler(httpServer, "streamable_http")
}

// sseHandler returns an http.Handler that serves MCP over SSE transport for legacy clients.
func (s *MCPServer) sseHandler() http.Handler {
	sseServer := server.NewSSEServer(s.mcpServer,
		server.WithBasePath("/mcp"),
		server.WithBaseURL("https://clarin.naperu.cloud"),
	)
	return s.authenticatedMCPHandler(sseServer, "sse")
}

func (s *MCPServer) authenticatedMCPHandler(next http.Handler, transport string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.allowMCPRequest(remoteIP(r)) {
			s.recordAuthFailure(r, "rate_limited", nil)
			http.Error(w, `{"error":"too many MCP requests"}`, http.StatusTooManyRequests)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			setMCPAuthChallenge(w, "missing_authorization")
			s.recordAuthFailure(r, "missing_authorization", nil)
			http.Error(w, `{"error":"missing Authorization header"}`, http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		if token == authHeader {
			setMCPAuthChallenge(w, "invalid_authorization_format")
			s.recordAuthFailure(r, "invalid_authorization_format", nil)
			http.Error(w, `{"error":"invalid Authorization format, expected: Bearer <api_key>"}`, http.StatusUnauthorized)
			return
		}

		keyHash := hashKey(token)
		client, err := s.repos.MCP.GetClientByOAuthTokenHash(r.Context(), keyHash, mcpResourceURI)
		if err != nil {
			log.Printf("[MCP] oauth token lookup error: %v", err)
		}
		if client == nil {
			client, err = s.repos.MCP.GetClientByTokenHash(r.Context(), keyHash)
		}
		if err != nil || client == nil {
			setMCPAuthChallenge(w, "invalid_token")
			s.recordAuthFailure(r, "invalid_token", nil)
			http.Error(w, `{"error":"invalid MCP token"}`, http.StatusUnauthorized)
			return
		}
		if client.Status == domain.MCPStatusBlocked || client.Status == domain.MCPStatusRevoked || client.Status == domain.MCPStatusPending {
			status := http.StatusForbidden
			s.recordAuthFailure(r, "client_"+client.Status, &client.ID)
			http.Error(w, `{"error":"MCP client is not active"}`, status)
			return
		}
		session := &domain.MCPSession{
			ID:             uuid.New(),
			ClientID:       client.ID,
			Transport:      transport,
			SessionKeyHash: hashKey(mcpSessionFingerprint(r, transport)),
			IPHash:         hashKey(remoteIP(r)),
			UserAgentHash:  hashKey(r.UserAgent()),
			OriginHash:     hashKey(r.Header.Get("Origin")),
		}
		storedSession, err := s.repos.MCP.UpsertSession(r.Context(), session)
		if err != nil {
			log.Printf("[MCP] session error: %v", err)
			http.Error(w, `{"error":"could not register MCP session"}`, http.StatusInternalServerError)
			return
		}
		if storedSession.Status == domain.MCPStatusBlocked {
			s.recordAuthFailure(r, "session_blocked", &client.ID)
			http.Error(w, `{"error":"MCP session is blocked"}`, http.StatusForbidden)
			return
		}

		principal := &MCPPrincipal{
			ClientID:          client.ID,
			ClientName:        client.Name,
			SessionID:         storedSession.ID,
			ScopeType:         client.ScopeType,
			ClientKind:        client.ClientKind,
			AllowedAccountIDs: client.AllowedAccountIDs,
			IPHash:            session.IPHash,
			UserAgentHash:     session.UserAgentHash,
		}
		go s.repos.MCP.TouchClient(context.Background(), client.ID)
		go s.repos.MCP.RecordAuditEvent(context.Background(), &domain.MCPAuditEvent{
			ClientID:      &client.ID,
			SessionID:     &storedSession.ID,
			EventType:     "auth_success",
			IPHash:        session.IPHash,
			UserAgentHash: session.UserAgentHash,
			Metadata:      map[string]any{"transport": transport},
		})

		ctx := context.WithValue(r.Context(), ctxKeyPrincipal, principal)
		r = r.WithContext(ctx)

		next.ServeHTTP(w, r)
	})
}

// Start launches the MCP HTTP server on the given port in a background goroutine.
func (s *MCPServer) Start(port string) {
	mux := http.NewServeMux()

	// MCP Streamable HTTP transport (protected by global MCP client token)
	httpHandler := s.streamableHTTPHandler()
	mutexHandler := func(handler http.Handler) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !setCORSHeaders(w, r) {
				s.recordAuthFailure(r, "origin_not_allowed", nil)
				http.Error(w, `{"error":"origin not allowed"}`, http.StatusForbidden)
				return
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			handler.ServeHTTP(w, r)
		}
	}
	mux.HandleFunc("/.well-known/oauth-protected-resource", s.oauthProtectedResourceMetadataHandler())
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", s.oauthProtectedResourceMetadataHandler())
	mux.HandleFunc("/.well-known/oauth-authorization-server", s.oauthAuthorizationServerMetadataHandler())
	mux.HandleFunc("/.well-known/oauth-authorization-server/mcp", s.oauthAuthorizationServerMetadataHandler())
	mux.HandleFunc("/oauth/authorize", s.oauthAuthorizeHandler())
	mux.HandleFunc("/oauth/token", s.oauthTokenHandler())
	mux.HandleFunc("/mcp", mutexHandler(httpHandler))

	// MCP SSE transport for legacy clients (same auth and audit)
	sseHandler := s.sseHandler()
	mux.HandleFunc("/mcp/", mutexHandler(sseHandler))

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  0,
		WriteTimeout: 0,
	}
	go func() {
		log.Printf("[MCP] ✅ MCP server starting on port %s (Streamable HTTP + SSE legacy, global MCP client auth)", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[MCP] Server error: %v", err)
		}
	}()
}

// setCORSHeaders adds CORS headers for MCP endpoints.
func setCORSHeaders(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if !isAllowedMCPOrigin(origin) {
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id")
	w.Header().Set("Access-Control-Max-Age", "86400")
	return true
}

func isAllowedMCPOrigin(origin string) bool {
	switch origin {
	case "https://clarin.naperu.cloud",
		"https://chatgpt.com",
		"http://localhost:3000",
		"http://localhost:8081",
		"http://127.0.0.1:3000",
		"http://127.0.0.1:8081":
		return true
	default:
		return false
	}
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

type contextKey string

const ctxKeyPrincipal contextKey = "mcp_principal"

type MCPPrincipal struct {
	ClientID          uuid.UUID
	ClientName        string
	SessionID         uuid.UUID
	ScopeType         string
	ClientKind        string
	AllowedAccountIDs []uuid.UUID
	IPHash            string
	UserAgentHash     string
}

func (s *MCPServer) getPrincipal(ctx context.Context) (*MCPPrincipal, error) {
	principal, ok := ctx.Value(ctxKeyPrincipal).(*MCPPrincipal)
	if !ok || principal == nil || principal.ClientID == uuid.Nil {
		return nil, errors.New("conexión MCP no autenticada")
	}
	return principal, nil
}

func (p *MCPPrincipal) allowsAccount(accountID uuid.UUID) bool {
	for _, allowedID := range p.AllowedAccountIDs {
		if allowedID == accountID {
			return true
		}
	}
	return false
}

func (s *MCPServer) getAccountIDFromRequest(ctx context.Context, req mcp.CallToolRequest) (uuid.UUID, error) {
	principal, err := s.getPrincipal(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	args := getArgs(req)
	var accountID uuid.UUID
	accountIDRaw := strings.TrimSpace(fmt.Sprint(args["account_id"]))
	if accountIDRaw != "" && accountIDRaw != "<nil>" {
		parsedID, err := uuid.Parse(accountIDRaw)
		if err != nil {
			return uuid.Nil, newMCPCodedError(mcpErrorAccountNotFound, "account_id inválido; usa list_accounts para obtenerlo")
		}
		if err := s.ensureActiveAccountExists(ctx, parsedID); err != nil {
			return uuid.Nil, err
		}
		accountID = parsedID
	} else {
		accountSlug := strings.TrimSpace(fmt.Sprint(args["account_slug"]))
		if accountSlug == "" || accountSlug == "<nil>" {
			return uuid.Nil, newMCPCodedError(mcpErrorAccountNotFound, "debes indicar account_id o account_slug; llama primero a list_accounts")
		}
		accountID, err = s.resolveAccountSelector(ctx, accountSlug)
		if err != nil {
			return uuid.Nil, err
		}
	}
	if !principal.allowsAccount(accountID) {
		return uuid.Nil, newMCPCodedError(mcpErrorAccountNotAllowed, "esta conexión MCP no tiene permiso para esa cuenta")
	}
	return accountID, nil
}

func (s *MCPServer) ensureActiveAccountExists(ctx context.Context, accountID uuid.UUID) error {
	var exists bool
	if err := s.repos.DB().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM accounts WHERE id = $1 AND is_active = true)`, accountID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return newMCPCodedError(mcpErrorAccountNotFound, "account_id no existe o la cuenta no está activa")
	}
	return nil
}

func (s *MCPServer) resolveAccountSelector(ctx context.Context, selector string) (uuid.UUID, error) {
	var accountID uuid.UUID
	err := s.repos.DB().QueryRow(ctx, `SELECT id FROM accounts WHERE slug = $1 AND is_active = true`, selector).Scan(&accountID)
	if err == nil {
		return accountID, nil
	}
	if err != pgx.ErrNoRows {
		return uuid.Nil, err
	}

	rows, err := s.repos.DB().Query(ctx, `
		SELECT id
		FROM accounts
		WHERE lower(trim(name)) = lower(trim($1))
		  AND is_active = true
		ORDER BY id
		LIMIT 2
	`, selector)
	if err != nil {
		return uuid.Nil, err
	}
	defer rows.Close()

	matches := make([]uuid.UUID, 0, 2)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return uuid.Nil, err
		}
		matches = append(matches, id)
	}
	if err := rows.Err(); err != nil {
		return uuid.Nil, err
	}
	if len(matches) == 0 {
		return uuid.Nil, newMCPCodedError(mcpErrorAccountNotFound, "account_slug/name no existe o la cuenta no está activa; llama list_accounts y usa account_id si slug está vacío")
	}
	if len(matches) > 1 {
		return uuid.Nil, newMCPCodedError(mcpErrorAccountNotFound, "más de una cuenta activa coincide con ese name; usa account_id desde list_accounts")
	}
	return matches[0], nil
}

func (s *MCPServer) allowMCPRequest(remote string) bool {
	const maxRequestsPerMinute = 120
	now := time.Now()
	key := hashKey(remote)

	s.rateMu.Lock()
	defer s.rateMu.Unlock()

	window := s.rateByIP[key]
	if window == nil || now.After(window.resetAt) {
		s.rateByIP[key] = &mcpRateWindow{count: 1, resetAt: now.Add(time.Minute)}
		return true
	}
	if window.count >= maxRequestsPerMinute {
		return false
	}
	window.count++
	return true
}

func hashKey(key string) string {
	h := sha256.Sum256([]byte(key))
	return hex.EncodeToString(h[:])
}

func remoteIP(r *http.Request) string {
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		return strings.TrimSpace(parts[0])
	}
	if realIP := strings.TrimSpace(r.Header.Get("X-Real-IP")); realIP != "" {
		return realIP
	}
	return r.RemoteAddr
}

func mcpSessionFingerprint(r *http.Request, transport string) string {
	sessionID := r.Header.Get("Mcp-Session-Id")
	if sessionID == "" {
		sessionID = r.URL.Query().Get("sessionId")
	}
	return strings.Join([]string{transport, sessionID, remoteIP(r), r.UserAgent(), r.Header.Get("Origin")}, "|")
}

func (s *MCPServer) recordAuthFailure(r *http.Request, reason string, clientID *uuid.UUID) {
	go s.repos.MCP.RecordAuditEvent(context.Background(), &domain.MCPAuditEvent{
		ClientID:      clientID,
		EventType:     "auth_failure",
		IPHash:        hashKey(remoteIP(r)),
		UserAgentHash: hashKey(r.UserAgent()),
		Metadata:      map[string]any{"reason": reason, "path": r.URL.Path},
	})
}

func (s *MCPServer) auditToolCallMiddleware() server.ToolHandlerMiddleware {
	return func(next server.ToolHandlerFunc) server.ToolHandlerFunc {
		return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			principal, principalErr := s.getPrincipal(ctx)
			result, err := next(ctx, request)
			if principalErr == nil {
				args := getArgs(request)
				accountIDs := make([]string, 0, 1)
				if raw := strings.TrimSpace(fmt.Sprint(args["account_id"])); raw != "" && raw != "<nil>" {
					accountIDs = append(accountIDs, raw)
				}
				metadata := map[string]any{}
				if raw := strings.TrimSpace(fmt.Sprint(args["account_slug"])); raw != "" && raw != "<nil>" {
					metadata["account_selector"] = "account_slug_or_name"
				}
				eventType := "tool_call"
				if err != nil || (result != nil && result.IsError) {
					eventType = "tool_denied"
					if code := toolResultErrorCode(result); code != "" {
						metadata["error_code"] = code
					}
				}
				if len(metadata) == 0 {
					metadata = nil
				}
				_ = s.repos.MCP.RecordAuditEvent(context.Background(), &domain.MCPAuditEvent{
					ClientID:      &principal.ClientID,
					SessionID:     &principal.SessionID,
					EventType:     eventType,
					ToolName:      request.Params.Name,
					AccountIDs:    accountIDs,
					IPHash:        principal.IPHash,
					UserAgentHash: principal.UserAgentHash,
					Metadata:      metadata,
				})
			}
			return result, err
		}
	}
}

func toolResultErrorCode(result *mcp.CallToolResult) string {
	if result == nil || !result.IsError || len(result.Content) == 0 {
		return ""
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		return ""
	}
	var payload struct {
		ErrorCode string `json:"error_code"`
	}
	if err := json.Unmarshal([]byte(text.Text), &payload); err != nil {
		return ""
	}
	return strings.TrimSpace(payload.ErrorCode)
}

func (s *MCPServer) toolListAccounts(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	principal, err := s.getPrincipal(ctx)
	if err != nil {
		return errResult(err.Error()), nil
	}
	rows, err := s.repos.DB().Query(ctx, `
		SELECT a.id, a.name, COALESCE(a.slug, ''), a.plan, a.is_active
		FROM accounts a
		JOIN mcp_client_accounts mca ON mca.account_id = a.id
		WHERE mca.client_id = $1
		  AND a.is_active = true
		ORDER BY a.name ASC
	`, principal.ClientID)
	if err != nil {
		return errResult("error consultando cuentas: " + err.Error()), nil
	}
	defer rows.Close()
	accounts := make([]map[string]any, 0)
	for rows.Next() {
		var id uuid.UUID
		var name, slug, plan string
		var active bool
		if err := rows.Scan(&id, &name, &slug, &plan, &active); err != nil {
			return errResult("error leyendo cuenta: " + err.Error()), nil
		}
		preferredIdentifier := "account_slug"
		if strings.TrimSpace(slug) == "" {
			preferredIdentifier = "account_id"
		}
		accounts = append(accounts, map[string]any{
			"account_id":           id,
			"name":                 name,
			"slug":                 slug,
			"preferred_identifier": preferredIdentifier,
			"plan":                 plan,
			"is_active":            active,
		})
	}
	return jsonResult(map[string]any{
		"scope":             domain.MCPScopeSelectedAccounts,
		"accounts":          accounts,
		"identifier_policy": "Usa account_id como identificador preferido. Usa account_slug sólo si slug no está vacío. Si slug falta, el MCP acepta name exacto por compatibilidad, pero account_id evita ambigüedad.",
		"format_policy":     "El MCP sólo entrega JSON de lectura; CSV, Excel, PDF y descargas son responsabilidad de la app cliente.",
	}), nil
}

func (s *MCPServer) toolGetCRMStats(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	type statResult struct {
		Label string
		Count int
	}

	queries := []struct {
		label string
		query string
	}{
		{"total_leads", `SELECT COUNT(*) FROM leads WHERE account_id = $1`},
		{"total_contacts", `SELECT COUNT(*) FROM contacts WHERE account_id = $1 AND is_group = false`},
		{"active_events", `SELECT COUNT(*) FROM events WHERE account_id = $1 AND status = 'active'`},
		{"total_events", `SELECT COUNT(*) FROM events WHERE account_id = $1`},
		{"active_programs", `SELECT COUNT(*) FROM programs WHERE account_id = $1 AND status = 'active'`},
		{"total_chats", `SELECT COUNT(*) FROM chats WHERE account_id = $1`},
		{"total_tags", `SELECT COUNT(*) FROM tags WHERE account_id = $1`},
	}

	stats := make(map[string]int)
	for _, q := range queries {
		var count int
		_ = s.repos.DB().QueryRow(ctx, q.query, accountID).Scan(&count)
		stats[q.label] = count
	}

	// Lead counts by pipeline stage
	stageRows, err := s.repos.DB().Query(ctx, `
		SELECT COALESCE(ps.name, 'Sin etapa') as stage_name, COUNT(*) as cnt
		FROM leads l
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
		WHERE l.account_id = $1
		GROUP BY ps.name, ps.position
		ORDER BY ps.position NULLS LAST
	`, accountID)
	if err == nil {
		defer stageRows.Close()
		stageCounts := make(map[string]int)
		for stageRows.Next() {
			var name string
			var count int
			if err := stageRows.Scan(&name, &count); err == nil {
				stageCounts[name] = count
			}
		}
		stats["leads_by_stage"] = 0 // placeholder
		result := map[string]interface{}{
			"totals":         stats,
			"leads_by_stage": stageCounts,
		}
		return jsonResult(result), nil
	}

	return jsonResult(stats), nil
}

// ──── list_events ────
func (s *MCPServer) toolListEvents(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	status := stringArg(req, "status")
	search := stringArg(req, "search")
	limit := intArg(req, "limit", 20, 100)

	filter := domain.EventFilter{Status: status, Search: search, Limit: limit}
	events, total, err := s.repos.Event.GetByAccountID(ctx, accountID, filter)
	if err != nil {
		return errResult("error al obtener eventos: " + err.Error()), nil
	}

	type eventSummary struct {
		ID           string         `json:"id"`
		Name         string         `json:"name"`
		Date         string         `json:"date,omitempty"`
		EndDate      string         `json:"end_date,omitempty"`
		Location     string         `json:"location,omitempty"`
		Status       string         `json:"status"`
		Participants int            `json:"total_participants"`
		Counts       map[string]int `json:"counts_by_stage,omitempty"`
	}

	result := make([]eventSummary, 0, len(events))
	for _, ev := range events {
		es := eventSummary{
			ID:           ev.ID.String(),
			Name:         ev.Name,
			Status:       ev.Status,
			Participants: ev.TotalParticipants,
			Counts:       ev.ParticipantCounts,
		}
		if ev.EventDate != nil {
			es.Date = ev.EventDate.Format("2006-01-02")
		}
		if ev.EventEnd != nil {
			es.EndDate = ev.EventEnd.Format("2006-01-02")
		}
		if ev.Location != nil {
			es.Location = *ev.Location
		}
		result = append(result, es)
	}

	return jsonResult(map[string]interface{}{
		"total":  total,
		"events": result,
	}), nil
}

// ──── get_event_summary ────
func (s *MCPServer) toolGetEventSummary(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	eventID, err := uuidArg(req, "event_id")
	if err != nil {
		return errResult("event_id inválido"), nil
	}

	ev, err := s.repos.Event.GetByID(ctx, eventID)
	if err != nil || ev == nil || ev.AccountID != accountID {
		return errResult("evento no encontrado"), nil
	}

	// Get pipeline stages to map counts to stage names
	var stageMap map[string]string // stageID → name
	if ev.PipelineID != nil {
		stages, _ := s.repos.EventPipeline.GetStagesByPipelineID(ctx, *ev.PipelineID)
		stageMap = make(map[string]string, len(stages))
		for _, st := range stages {
			stageMap[st.ID.String()] = st.Name
		}
	}

	// Get stage-level participant counts
	stageRows, _ := s.repos.DB().Query(ctx, `
		SELECT COALESCE(eps.name, 'Sin etapa') as stage_name, COUNT(*) as cnt
		FROM event_participants ep
		LEFT JOIN event_pipeline_stages eps ON eps.id = ep.stage_id
		WHERE ep.event_id = $1
		GROUP BY eps.name, eps.position
		ORDER BY eps.position NULLS LAST
	`, eventID)
	stageCounts := make(map[string]int)
	if stageRows != nil {
		defer stageRows.Close()
		for stageRows.Next() {
			var name string
			var count int
			if stageRows.Scan(&name, &count) == nil {
				stageCounts[name] = count
			}
		}
	}

	summary := map[string]interface{}{
		"id":                    ev.ID.String(),
		"name":                  ev.Name,
		"status":                ev.Status,
		"total_participants":    ev.TotalParticipants,
		"participants_by_stage": stageCounts,
	}
	if ev.Description != nil {
		summary["description"] = *ev.Description
	}
	if ev.EventDate != nil {
		summary["date"] = ev.EventDate.Format("2006-01-02")
	}
	if ev.EventEnd != nil {
		summary["end_date"] = ev.EventEnd.Format("2006-01-02")
	}
	if ev.Location != nil {
		summary["location"] = *ev.Location
	}

	return jsonResult(summary), nil
}

// ──── search_leads ────
func (s *MCPServer) toolSearchLeads(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	query := stringArg(req, "query")
	tag := stringArg(req, "tag")
	stage := stringArg(req, "stage")
	createdAfter := stringArg(req, "created_after")
	createdBefore := stringArg(req, "created_before")
	limit := intArg(req, "limit", 20, 100)
	offset := intArg(req, "offset", 0, 100000)

	// Build dynamic query
	baseWhere := ` FROM leads l
		LEFT JOIN contacts c ON c.id = l.contact_id
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
		LEFT JOIN contact_tags ct ON ct.contact_id = l.contact_id
		LEFT JOIN tags t ON t.id = ct.tag_id
		WHERE l.account_id = $1
	`
	args := []interface{}{accountID}
	argN := 2

	if query != "" {
		baseWhere += fmt.Sprintf(` AND (COALESCE(c.name, l.name) ILIKE $%d OR COALESCE(c.last_name, l.last_name) ILIKE $%d OR COALESCE(c.phone, l.phone) ILIKE $%d OR COALESCE(c.email, l.email) ILIKE $%d)`, argN, argN, argN, argN)
		args = append(args, "%"+query+"%")
		argN++
	}
	if tag != "" {
		baseWhere += fmt.Sprintf(` AND l.id IN (SELECT l3.id FROM leads l3 JOIN contact_tags ct3 ON ct3.contact_id = l3.contact_id JOIN tags t2 ON t2.id = ct3.tag_id WHERE t2.name ILIKE $%d AND t2.account_id = $1)`, argN)
		args = append(args, "%"+tag+"%")
		argN++
	}
	if stage != "" {
		baseWhere += fmt.Sprintf(` AND ps.name ILIKE $%d`, argN)
		args = append(args, "%"+stage+"%")
		argN++
	}
	if createdAfter != "" {
		t, err := time.Parse("2006-01-02", createdAfter)
		if err == nil {
			baseWhere += fmt.Sprintf(` AND l.created_at >= $%d`, argN)
			args = append(args, t)
			argN++
		}
	}
	if createdBefore != "" {
		t, err := time.Parse("2006-01-02", createdBefore)
		if err == nil {
			// Inclusive: add 1 day
			baseWhere += fmt.Sprintf(` AND l.created_at < $%d`, argN)
			args = append(args, t.Add(24*time.Hour))
			argN++
		}
	}

	// Count total matching
	var total int
	countSQL := `SELECT COUNT(DISTINCT l.id)` + baseWhere
	_ = s.repos.DB().QueryRow(ctx, countSQL, args...).Scan(&total)

	sql := `SELECT l.id, COALESCE(c.name, l.name), COALESCE(c.last_name, l.last_name), COALESCE(c.phone, l.phone), COALESCE(c.email, l.email), l.source, COALESCE(c.notes, l.notes),
		       COALESCE(ps.name, '') as stage_name,
		       COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') as tags,
		       l.created_at` + baseWhere
	sql += ` GROUP BY l.id, c.name, l.name, c.last_name, l.last_name, c.phone, l.phone, c.email, l.email, l.source, c.notes, l.notes, ps.name, ps.position, l.created_at
	         ORDER BY l.created_at DESC LIMIT ` + fmt.Sprintf("%d", limit) + ` OFFSET ` + fmt.Sprintf("%d", offset)

	rows, err := s.repos.DB().Query(ctx, sql, args...)
	if err != nil {
		return errResult("error en búsqueda: " + err.Error()), nil
	}
	defer rows.Close()

	type leadResult struct {
		ID        string   `json:"id"`
		Name      string   `json:"name"`
		Phone     string   `json:"phone,omitempty"`
		Email     string   `json:"email,omitempty"`
		Stage     string   `json:"stage,omitempty"`
		Source    string   `json:"source,omitempty"`
		Notes     string   `json:"notes,omitempty"`
		Tags      []string `json:"tags"`
		CreatedAt string   `json:"created_at"`
	}

	var results []leadResult
	for rows.Next() {
		var id uuid.UUID
		var name, lastName, phone, email, source, notes *string
		var stage_name *string
		var tags []string
		var createdAt time.Time
		if err := rows.Scan(&id, &name, &lastName, &phone, &email, &source, &notes, &stage_name, &tags, &createdAt); err != nil {
			continue
		}
		r := leadResult{ID: id.String(), Tags: tags, CreatedAt: createdAt.Format("2006-01-02")}
		if name != nil {
			r.Name = *name
			if lastName != nil {
				r.Name += " " + *lastName
			}
		}
		if phone != nil {
			r.Phone = *phone
		}
		if email != nil {
			r.Email = *email
		}
		if stage_name != nil && *stage_name != "" {
			r.Stage = *stage_name
		}
		if source != nil {
			r.Source = *source
		}
		if notes != nil && *notes != "" {
			// Truncate long notes
			n := *notes
			if len(n) > 200 {
				n = n[:200] + "..."
			}
			r.Notes = n
		}
		results = append(results, r)
	}

	if results == nil {
		results = []leadResult{}
	}

	return jsonResult(map[string]interface{}{
		"total":  total,
		"count":  len(results),
		"offset": offset,
		"leads":  results,
	}), nil
}

// ──── get_lead_detail ────
func (s *MCPServer) toolGetLeadDetail(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	leadID, err := uuidArg(req, "lead_id")
	if err != nil {
		return errResult("lead_id inválido"), nil
	}

	lead, err := s.repos.Lead.GetByID(ctx, leadID)
	if err != nil || lead == nil || lead.AccountID != accountID {
		return errResult("lead no encontrado"), nil
	}

	tags, _ := s.repos.Tag.GetByLead(ctx, leadID)
	tagNames := make([]string, 0, len(tags))
	for _, t := range tags {
		tagNames = append(tagNames, t.Name)
	}

	detail := map[string]interface{}{
		"id":         lead.ID.String(),
		"tags":       tagNames,
		"created_at": lead.CreatedAt.Format(time.RFC3339),
	}
	if lead.Name != nil {
		detail["name"] = *lead.Name
	}
	if lead.LastName != nil {
		detail["last_name"] = *lead.LastName
	}
	if lead.Phone != nil {
		detail["phone"] = *lead.Phone
	}
	if lead.Email != nil {
		detail["email"] = *lead.Email
	}
	if lead.Company != nil {
		detail["company"] = *lead.Company
	}
	if lead.Notes != nil {
		detail["notes"] = *lead.Notes
	}
	if lead.StageName != nil {
		detail["stage"] = *lead.StageName
	}
	if lead.Source != nil {
		detail["source"] = *lead.Source
	}
	if lead.Age != nil {
		detail["age"] = *lead.Age
	}
	if lead.DNI != nil {
		detail["dni"] = *lead.DNI
	}
	if lead.Status != nil {
		detail["status"] = *lead.Status
	}
	if lead.CustomFields != nil && len(lead.CustomFields) > 0 {
		detail["custom_fields"] = lead.CustomFields
	}

	return jsonResult(detail), nil
}

// ──── list_tags ────
func (s *MCPServer) toolListTags(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	tags, err := s.repos.Tag.GetByAccountID(ctx, accountID)
	if err != nil {
		return errResult("error al obtener tags: " + err.Error()), nil
	}

	type tagResult struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	result := make([]tagResult, 0, len(tags))
	for _, t := range tags {
		result = append(result, tagResult{ID: t.ID.String(), Name: t.Name, Color: t.Color})
	}

	return jsonResult(map[string]interface{}{
		"count": len(result),
		"tags":  result,
	}), nil
}

// ──── list_pipelines ────
func (s *MCPServer) toolListPipelines(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	pipelines, err := s.repos.Pipeline.GetByAccountID(ctx, accountID)
	if err != nil {
		return errResult("error al obtener pipelines: " + err.Error()), nil
	}

	type stageResult struct {
		Name     string `json:"name"`
		Color    string `json:"color"`
		Position int    `json:"position"`
	}
	type pipeResult struct {
		ID      string        `json:"id"`
		Name    string        `json:"name"`
		Default bool          `json:"is_default"`
		Stages  []stageResult `json:"stages"`
	}

	result := make([]pipeResult, 0, len(pipelines))
	for _, p := range pipelines {
		pr := pipeResult{ID: p.ID.String(), Name: p.Name, Default: p.IsDefault}
		stages, _ := s.repos.Pipeline.GetStages(ctx, p.ID)
		for _, st := range stages {
			pr.Stages = append(pr.Stages, stageResult{Name: st.Name, Color: st.Color, Position: st.Position})
		}
		if pr.Stages == nil {
			pr.Stages = []stageResult{}
		}
		result = append(result, pr)
	}

	return jsonResult(map[string]interface{}{
		"count":     len(result),
		"pipelines": result,
	}), nil
}

// ──── search_contacts ────
func (s *MCPServer) toolSearchContacts(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	query := stringArg(req, "query")
	limit := intArg(req, "limit", 20, 50)

	filter := domain.ContactFilter{
		Search: query,
		Limit:  limit,
	}

	contacts, total, err := s.repos.Contact.GetByAccountIDWithFilters(ctx, accountID, filter)
	if err != nil {
		return errResult("error al buscar contactos: " + err.Error()), nil
	}

	type contactResult struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Phone string `json:"phone"`
		Email string `json:"email,omitempty"`
	}

	result := make([]contactResult, 0, len(contacts))
	for _, c := range contacts {
		cr := contactResult{ID: c.ID.String()}
		if c.Name != nil {
			cr.Name = *c.Name
		}
		if c.CustomName != nil && *c.CustomName != "" {
			cr.Name = *c.CustomName
		}
		if c.Phone != nil {
			cr.Phone = *c.Phone
		}
		if c.Email != nil {
			cr.Email = *c.Email
		}
		result = append(result, cr)
	}

	return jsonResult(map[string]interface{}{
		"total":    total,
		"contacts": result,
	}), nil
}

// ──── get_lead_analytics ────
func (s *MCPServer) toolGetLeadAnalytics(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	tag := stringArg(req, "tag")
	stage := stringArg(req, "stage")
	createdAfter := stringArg(req, "created_after")
	createdBefore := stringArg(req, "created_before")

	// Build base filter
	baseWhere := ` WHERE l.account_id = $1`
	args := []interface{}{accountID}
	argN := 2

	if tag != "" {
		baseWhere += fmt.Sprintf(` AND l.id IN (SELECT l3.id FROM leads l3 JOIN contact_tags ct3 ON ct3.contact_id = l3.contact_id JOIN tags t2 ON t2.id = ct3.tag_id WHERE t2.name ILIKE $%d AND t2.account_id = $1)`, argN)
		args = append(args, "%"+tag+"%")
		argN++
	}
	if stage != "" {
		baseWhere += fmt.Sprintf(` AND l.stage_id IN (SELECT ps2.id FROM pipeline_stages ps2 WHERE ps2.name ILIKE $%d)`, argN)
		args = append(args, "%"+stage+"%")
		argN++
	}
	if createdAfter != "" {
		t, err := time.Parse("2006-01-02", createdAfter)
		if err == nil {
			baseWhere += fmt.Sprintf(` AND l.created_at >= $%d`, argN)
			args = append(args, t)
			argN++
		}
	}
	if createdBefore != "" {
		t, err := time.Parse("2006-01-02", createdBefore)
		if err == nil {
			baseWhere += fmt.Sprintf(` AND l.created_at < $%d`, argN)
			args = append(args, t.Add(24*time.Hour))
			argN++
		}
	}

	result := map[string]interface{}{}

	// Total count
	var totalLeads int
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*) FROM leads l`+baseWhere, args...).Scan(&totalLeads)
	result["total_leads"] = totalLeads

	// Leads by stage
	stageRows, err := s.repos.DB().Query(ctx, `
		SELECT COALESCE(ps.name, 'Sin etapa') as stage_name, COUNT(*) as cnt
		FROM leads l LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
	`+baseWhere+` GROUP BY ps.name, ps.position ORDER BY ps.position NULLS LAST`, args...)
	if err == nil {
		defer stageRows.Close()
		var stageDist []map[string]interface{}
		for stageRows.Next() {
			var name string
			var count int
			if stageRows.Scan(&name, &count) == nil {
				stageDist = append(stageDist, map[string]interface{}{"stage": name, "count": count})
			}
		}
		result["by_stage"] = stageDist
	}

	// Top 30 tags with counts
	tagRows, err := s.repos.DB().Query(ctx, `
		SELECT t.name, COUNT(DISTINCT l.id) as cnt
		FROM leads l
		JOIN contact_tags ct ON ct.contact_id = l.contact_id
		JOIN tags t ON t.id = ct.tag_id
	`+baseWhere+` GROUP BY t.name ORDER BY cnt DESC LIMIT 30`, args...)
	if err == nil {
		defer tagRows.Close()
		var tagDist []map[string]interface{}
		for tagRows.Next() {
			var name string
			var count int
			if tagRows.Scan(&name, &count) == nil {
				tagDist = append(tagDist, map[string]interface{}{"tag": name, "count": count})
			}
		}
		result["top_tags"] = tagDist
	}

	// Leads by source
	sourceRows, err := s.repos.DB().Query(ctx, `
		SELECT COALESCE(l.source, 'desconocido') as src, COUNT(*) as cnt
		FROM leads l
	`+baseWhere+` GROUP BY l.source ORDER BY cnt DESC`, args...)
	if err == nil {
		defer sourceRows.Close()
		var sourceDist []map[string]interface{}
		for sourceRows.Next() {
			var name string
			var count int
			if sourceRows.Scan(&name, &count) == nil {
				sourceDist = append(sourceDist, map[string]interface{}{"source": name, "count": count})
			}
		}
		result["by_source"] = sourceDist
	}

	// Leads by month (last 6 months)
	monthRows, err := s.repos.DB().Query(ctx, `
		SELECT TO_CHAR(l.created_at, 'YYYY-MM') as month, COUNT(*) as cnt
		FROM leads l
	`+baseWhere+` GROUP BY TO_CHAR(l.created_at, 'YYYY-MM') ORDER BY month DESC LIMIT 6`, args...)
	if err == nil {
		defer monthRows.Close()
		var monthDist []map[string]interface{}
		for monthRows.Next() {
			var month string
			var count int
			if monthRows.Scan(&month, &count) == nil {
				monthDist = append(monthDist, map[string]interface{}{"month": month, "count": count})
			}
		}
		result["by_month"] = monthDist
	}

	// Leads with vs without active chat
	var withChat, withPhone int
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*) FROM leads l`+baseWhere+` AND l.jid != '' AND l.jid IS NOT NULL`, args...).Scan(&withChat)
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*) FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id`+baseWhere+` AND COALESCE(c.phone, l.phone) IS NOT NULL AND COALESCE(c.phone, l.phone) != ''`, args...).Scan(&withPhone)
	result["with_whatsapp"] = withChat
	result["with_phone"] = withPhone

	// Leads with notes
	var withNotes int
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*) FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id`+baseWhere+` AND COALESCE(c.notes, l.notes) IS NOT NULL AND COALESCE(c.notes, l.notes) != ''`, args...).Scan(&withNotes)
	result["with_notes"] = withNotes

	return jsonResult(result), nil
}

// ──── analyze_leads (server-side scoring) ────
func (s *MCPServer) toolAnalyzeLeads(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	tag := stringArg(req, "tag")
	stage := stringArg(req, "stage")
	createdAfter := stringArg(req, "created_after")
	createdBefore := stringArg(req, "created_before")
	sortBy := stringArg(req, "sort_by")
	limit := intArg(req, "limit", 20, 50)

	if sortBy == "" {
		sortBy = "score"
	}

	// Build base filter
	baseWhere := ` WHERE l.account_id = $1`
	args := []interface{}{accountID}
	argN := 2

	if tag != "" {
		baseWhere += fmt.Sprintf(` AND l.id IN (SELECT l3.id FROM leads l3 JOIN contact_tags ct3 ON ct3.contact_id = l3.contact_id JOIN tags t2 ON t2.id = ct3.tag_id WHERE t2.name ILIKE $%d AND t2.account_id = $1)`, argN)
		args = append(args, "%"+tag+"%")
		argN++
	}
	if stage != "" {
		baseWhere += fmt.Sprintf(` AND l.stage_id IN (SELECT ps2.id FROM pipeline_stages ps2 WHERE ps2.name ILIKE $%d)`, argN)
		args = append(args, "%"+stage+"%")
		argN++
	}
	if createdAfter != "" {
		t, err := time.Parse("2006-01-02", createdAfter)
		if err == nil {
			baseWhere += fmt.Sprintf(` AND l.created_at >= $%d`, argN)
			args = append(args, t)
			argN++
		}
	}
	if createdBefore != "" {
		t, err := time.Parse("2006-01-02", createdBefore)
		if err == nil {
			baseWhere += fmt.Sprintf(` AND l.created_at < $%d`, argN)
			args = append(args, t.Add(24*time.Hour))
			argN++
		}
	}

	// Comprehensive scoring query:
	// - stage_score: position in pipeline (higher = more advanced, max ~10 points)
	// - whatsapp_score: has WhatsApp JID (5 points)
	// - chat_score: has recent messages in last 30 days (up to 10 points)
	// - notes_score: has notes (3 points)
	// - tag_score: number of tags (1 point each, max 5)
	// - recency_score: created recently (up to 5 points, decays over 90 days)
	scoringSQL := `
		WITH lead_scores AS (
			SELECT
				l.id,
				COALESCE(c.name, l.name) AS name,
				COALESCE(c.last_name, l.last_name) AS last_name,
				COALESCE(ps.name, 'Sin etapa') AS stage_name,
				COALESCE(ps.position, 0) AS stage_position,
				(CASE
					WHEN ps.position IS NULL THEN 0
					WHEN ps.position >= 5 THEN 10
					WHEN ps.position >= 3 THEN 7
					WHEN ps.position >= 1 THEN 4
					ELSE 2
				END) AS stage_score,
				(CASE WHEN l.jid IS NOT NULL AND l.jid != '' THEN 5 ELSE 0 END) AS whatsapp_score,
				COALESCE((
					SELECT LEAST(COUNT(*)::int, 10)
					FROM messages m
					JOIN chats ch ON ch.id = m.chat_id
					WHERE ch.account_id = l.account_id
					AND ch.jid = l.jid
					AND l.jid IS NOT NULL AND l.jid != ''
					AND m.timestamp > NOW() - INTERVAL '30 days'
				), 0) AS chat_score,
				(CASE WHEN COALESCE(c.notes, l.notes) IS NOT NULL AND COALESCE(c.notes, l.notes) != '' THEN 3 ELSE 0 END) AS notes_score,
				LEAST(COALESCE((
					SELECT COUNT(*)::int FROM contact_tags ct3 WHERE ct3.contact_id = l.contact_id
				), 0), 5) AS tag_score,
				(CASE
					WHEN l.created_at > NOW() - INTERVAL '7 days' THEN 5
					WHEN l.created_at > NOW() - INTERVAL '30 days' THEN 3
					WHEN l.created_at > NOW() - INTERVAL '90 days' THEN 1
					ELSE 0
				END) AS recency_score,
				COALESCE(array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags,
				l.created_at
			FROM leads l
			LEFT JOIN contacts c ON c.id = l.contact_id
			LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
			LEFT JOIN contact_tags ct ON ct.contact_id = l.contact_id
			LEFT JOIN tags t ON t.id = ct.tag_id
		` + baseWhere + `
			GROUP BY l.id, c.name, l.name, c.last_name, l.last_name, c.notes, l.notes, ps.name, ps.position, l.jid, l.created_at, l.account_id
		)
		SELECT
			id, name, last_name, stage_name, stage_position,
			stage_score, whatsapp_score, chat_score, notes_score, tag_score, recency_score,
			(stage_score + whatsapp_score + chat_score + notes_score + tag_score + recency_score) AS total_score,
			tags, created_at
		FROM lead_scores
	`

	// Apply sort order
	switch sortBy {
	case "chat_activity":
		scoringSQL += ` ORDER BY chat_score DESC, total_score DESC`
	case "stage":
		scoringSQL += ` ORDER BY stage_position DESC, total_score DESC`
	case "recent":
		scoringSQL += ` ORDER BY created_at DESC`
	default: // "score"
		scoringSQL += ` ORDER BY total_score DESC, chat_score DESC, stage_position DESC`
	}

	scoringSQL += fmt.Sprintf(` LIMIT %d`, limit)

	rows, err := s.repos.DB().Query(ctx, scoringSQL, args...)
	if err != nil {
		return errResult("error en análisis: " + err.Error()), nil
	}
	defer rows.Close()

	type scoredLead struct {
		Rank          int      `json:"rank"`
		ID            string   `json:"id"`
		Name          string   `json:"name"`
		Stage         string   `json:"stage"`
		TotalScore    int      `json:"total_score"`
		StageScore    int      `json:"stage_score"`
		WhatsAppScore int      `json:"whatsapp_score"`
		ChatScore     int      `json:"chat_score"`
		NotesScore    int      `json:"notes_score"`
		TagScore      int      `json:"tag_score"`
		RecencyScore  int      `json:"recency_score"`
		Tags          []string `json:"tags"`
		CreatedAt     string   `json:"created_at"`
	}

	var leads []scoredLead
	rank := 0
	for rows.Next() {
		var id uuid.UUID
		var name, lastName *string
		var stageName string
		var stagePosition int
		var stageScore, whatsappScore, chatScore, notesScore, tagScore, recencyScore, totalScore int
		var tags []string
		var createdAt time.Time

		if err := rows.Scan(&id, &name, &lastName, &stageName, &stagePosition,
			&stageScore, &whatsappScore, &chatScore, &notesScore, &tagScore, &recencyScore,
			&totalScore, &tags, &createdAt); err != nil {
			continue
		}

		rank++
		sl := scoredLead{
			Rank:          rank,
			ID:            id.String(),
			Stage:         stageName,
			TotalScore:    totalScore,
			StageScore:    stageScore,
			WhatsAppScore: whatsappScore,
			ChatScore:     chatScore,
			NotesScore:    notesScore,
			TagScore:      tagScore,
			RecencyScore:  recencyScore,
			Tags:          tags,
			CreatedAt:     createdAt.Format("2006-01-02"),
		}
		if name != nil {
			sl.Name = *name
			if lastName != nil {
				sl.Name += " " + *lastName
			}
		}
		leads = append(leads, sl)
	}

	if leads == nil {
		leads = []scoredLead{}
	}

	// Get total matching count
	var totalMatching int
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*) FROM leads l`+baseWhere, args...).Scan(&totalMatching)

	return jsonResult(map[string]interface{}{
		"total_matching": totalMatching,
		"analyzed":       len(leads),
		"sort_by":        sortBy,
		"scoring_factors": map[string]string{
			"stage_score":    "Posición en pipeline (0-10): etapa más avanzada = mayor score",
			"whatsapp_score": "Tiene WhatsApp vinculado (0 o 5)",
			"chat_score":     "Mensajes en últimos 30 días (0-10): más actividad = mayor score",
			"notes_score":    "Tiene notas registradas (0 o 3)",
			"tag_score":      "Cantidad de tags (0-5): más tags = mayor categorización",
			"recency_score":  "Antigüedad del lead (0-5): más reciente = mayor score",
		},
		"leads": leads,
		"tip":   "Para ver datos de contacto de un lead específico, usa get_lead_detail con su ID. Los scores van de 0 a 38 puntos máximo.",
	}), nil
}

// ──── list_event_logbooks ────
func (s *MCPServer) toolListEventLogbooks(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	eventID, err := uuidArg(req, "event_id")
	if err != nil {
		return errResult("event_id inválido"), nil
	}

	logbooks, err := s.repos.Logbook.GetByEventID(ctx, eventID)
	if err != nil {
		return errResult("error al obtener bitácoras: " + err.Error()), nil
	}

	type lbResult struct {
		ID                string                 `json:"id"`
		Date              string                 `json:"date"`
		Title             string                 `json:"title"`
		Status            string                 `json:"status"`
		GeneralNotes      string                 `json:"general_notes,omitempty"`
		TotalParticipants int                    `json:"total_participants"`
		StageSnapshot     map[string]interface{} `json:"stage_snapshot,omitempty"`
		CapturedAt        string                 `json:"captured_at,omitempty"`
	}

	result := make([]lbResult, 0, len(logbooks))
	for _, lb := range logbooks {
		r := lbResult{
			ID:                lb.ID.String(),
			Date:              lb.Date.Format("2006-01-02"),
			Title:             lb.Title,
			Status:            lb.Status,
			GeneralNotes:      lb.GeneralNotes,
			TotalParticipants: lb.TotalParticipants,
			StageSnapshot:     lb.StageSnapshot,
		}
		if lb.CapturedAt != nil {
			r.CapturedAt = lb.CapturedAt.Format(time.RFC3339)
		}
		result = append(result, r)
	}

	return jsonResult(map[string]interface{}{
		"count":    len(result),
		"logbooks": result,
	}), nil
}

// ──── get_logbook_detail ────
func (s *MCPServer) toolGetLogbookDetail(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}
	logbookID, err := uuidArg(req, "logbook_id")
	if err != nil {
		return errResult("logbook_id inválido"), nil
	}

	lb, err := s.repos.Logbook.GetByID(ctx, logbookID)
	if err != nil || lb == nil || lb.AccountID != accountID {
		return errResult("bitácora no encontrada"), nil
	}

	entries, _ := s.repos.Logbook.GetEntries(ctx, logbookID)

	type entryResult struct {
		ParticipantName  string `json:"participant_name"`
		ParticipantPhone string `json:"participant_phone,omitempty"`
		StageName        string `json:"stage_name"`
		Notes            string `json:"notes,omitempty"`
	}

	entryResults := make([]entryResult, 0, len(entries))
	for _, e := range entries {
		er := entryResult{
			ParticipantName: e.ParticipantName,
			StageName:       e.StageName,
			Notes:           e.Notes,
		}
		if e.ParticipantPhone != nil {
			er.ParticipantPhone = *e.ParticipantPhone
		}
		entryResults = append(entryResults, er)
	}

	detail := map[string]interface{}{
		"id":                 lb.ID.String(),
		"date":               lb.Date.Format("2006-01-02"),
		"title":              lb.Title,
		"status":             lb.Status,
		"general_notes":      lb.GeneralNotes,
		"total_participants": lb.TotalParticipants,
		"stage_snapshot":     lb.StageSnapshot,
		"entries":            entryResults,
	}
	if lb.CapturedAt != nil {
		detail["captured_at"] = lb.CapturedAt.Format(time.RFC3339)
	}

	return jsonResult(detail), nil
}

// ──── list_event_participants ────
func (s *MCPServer) toolListEventParticipants(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	eventID, err := uuidArg(req, "event_id")
	if err != nil {
		return errResult("event_id inválido"), nil
	}

	status := stringArg(req, "status")
	stage := stringArg(req, "stage")
	search := stringArg(req, "search")
	includeSensitive := boolArg(req, "include_sensitive", false)
	limit := intArg(req, "limit", 50, 200)

	// Build dynamic query
	baseSQL := ` FROM event_participants ep
		LEFT JOIN event_pipeline_stages eps ON eps.id = ep.stage_id
		WHERE ep.event_id = $1`
	args := []interface{}{eventID}
	argN := 2

	if status != "" {
		baseSQL += fmt.Sprintf(` AND ep.status = $%d`, argN)
		args = append(args, status)
		argN++
	}
	if stage != "" {
		baseSQL += fmt.Sprintf(` AND eps.name ILIKE $%d`, argN)
		args = append(args, "%"+stage+"%")
		argN++
	}
	if search != "" {
		baseSQL += fmt.Sprintf(` AND (ep.name ILIKE $%d OR COALESCE(ep.last_name, '') ILIKE $%d OR COALESCE(ep.phone, '') ILIKE $%d)`, argN, argN, argN)
		args = append(args, "%"+search+"%")
		argN++
	}

	// Count total
	var total int
	_ = s.repos.DB().QueryRow(ctx, `SELECT COUNT(*)`+baseSQL, args...).Scan(&total)

	// Fetch data
	dataSQL := `SELECT ep.id, ep.name, COALESCE(ep.last_name, ''), COALESCE(ep.phone, ''), COALESCE(ep.email, ''),
		ep.status, COALESCE(eps.name, ''), COALESCE(ep.notes, ''), ep.created_at` + baseSQL + ` ORDER BY ep.created_at DESC LIMIT ` + fmt.Sprintf("%d", limit)

	rows, err := s.repos.DB().Query(ctx, dataSQL, args...)
	if err != nil {
		return errResult("error al obtener participantes: " + err.Error()), nil
	}
	defer rows.Close()

	type participantResult struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Phone     string `json:"phone,omitempty"`
		Email     string `json:"email,omitempty"`
		Status    string `json:"status"`
		Stage     string `json:"stage,omitempty"`
		Notes     string `json:"notes,omitempty"`
		CreatedAt string `json:"created_at"`
	}

	var results []participantResult
	for rows.Next() {
		var id uuid.UUID
		var name, lastName, phone, email, pStatus, stageName, notes string
		var createdAt time.Time
		if err := rows.Scan(&id, &name, &lastName, &phone, &email, &pStatus, &stageName, &notes, &createdAt); err != nil {
			continue
		}
		fullName := name
		if lastName != "" {
			fullName += " " + lastName
		}
		results = append(results, participantResult{
			ID:        id.String(),
			Name:      fullName,
			Phone:     sensitiveString(includeSensitive, phone),
			Email:     sensitiveString(includeSensitive, email),
			Status:    pStatus,
			Stage:     stageName,
			Notes:     sensitiveString(includeSensitive, notes),
			CreatedAt: createdAt.Format("2006-01-02"),
		})
	}

	if results == nil {
		results = []participantResult{}
	}

	return jsonResult(map[string]interface{}{
		"total":        total,
		"count":        len(results),
		"participants": results,
	}), nil
}

// ──── get_chat_history ────
func (s *MCPServer) toolGetChatHistory(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	contactName := stringArg(req, "contact_name")
	phone := stringArg(req, "phone")
	limit := intArg(req, "limit", 50, 200)

	if contactName == "" && phone == "" {
		return errResult("debes proporcionar contact_name o phone"), nil
	}

	// Find the chat
	var chatID uuid.UUID
	var contactDisplay string
	found := false

	if phone != "" {
		// Normalize phone: try with and without country code
		normalizedPhone := normalizePhone(phone)
		jid := normalizedPhone + "@s.whatsapp.net"
		chat, err := s.repos.Chat.FindByJID(ctx, accountID, jid)
		if err == nil && chat != nil {
			chatID = chat.ID
			contactDisplay = phone
			found = true
		}
	}

	if !found && contactName != "" {
		// Search by contact name
		rows, err := s.repos.DB().Query(ctx, `
			SELECT c.id, ch.id as chat_id, COALESCE(c.custom_name, c.name, c.push_name, '') as display_name
			FROM contacts c
			JOIN chats ch ON ch.contact_id = c.id AND ch.account_id = $1
			WHERE c.account_id = $1 AND c.is_group = false
			AND (c.name ILIKE $2 OR c.custom_name ILIKE $2 OR c.push_name ILIKE $2)
			ORDER BY ch.last_message_at DESC NULLS LAST
			LIMIT 1
		`, accountID, "%"+contactName+"%")
		if err == nil {
			defer rows.Close()
			if rows.Next() {
				var cID uuid.UUID
				var display string
				if rows.Scan(&cID, &chatID, &display) == nil {
					contactDisplay = display
					found = true
				}
			}
		}
	}

	if !found {
		return errResult("no se encontró un chat con ese contacto"), nil
	}

	// Fetch messages
	messages, err := s.repos.Message.GetByChatID(ctx, chatID, limit, 0)
	if err != nil {
		return errResult("error al obtener mensajes: " + err.Error()), nil
	}

	type msgResult struct {
		From      string `json:"from"`
		Body      string `json:"body"`
		Type      string `json:"type"`
		Timestamp string `json:"timestamp"`
	}

	msgResults := make([]msgResult, 0, len(messages))
	for _, m := range messages {
		mr := msgResult{
			Timestamp: m.Timestamp.Format("2006-01-02 15:04"),
		}
		if m.IsFromMe {
			mr.From = "yo"
		} else {
			mr.From = contactDisplay
		}
		if m.Body != nil && *m.Body != "" {
			mr.Body = *m.Body
		} else if m.MessageType != nil {
			mr.Body = "[" + *m.MessageType + "]"
		}
		if m.MessageType != nil {
			mr.Type = *m.MessageType
		}
		msgResults = append(msgResults, mr)
	}

	return jsonResult(map[string]interface{}{
		"contact":  contactDisplay,
		"messages": msgResults,
		"count":    len(msgResults),
	}), nil
}

// ──── get_leads_with_chats ────
func (s *MCPServer) toolGetLeadsWithChats(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	accountID, err := s.getAccountIDFromRequest(ctx, req)
	if err != nil {
		return mcpAccountStructuredError(err), nil
	}

	eventIDStr := stringArg(req, "event_id")
	tag := stringArg(req, "tag")
	stage := stringArg(req, "stage")
	query := stringArg(req, "query")
	msgsPerLead := intArg(req, "messages_per_lead", 20, 50)
	maxLeads := intArg(req, "max_leads", 10, 30)

	if eventIDStr == "" && tag == "" && stage == "" && query == "" {
		return errResult("debes proporcionar al menos un filtro: event_id, tag, stage, o query"), nil
	}

	// Build query to get lead IDs matching filters
	sql := `SELECT DISTINCT l.id, l.name, l.last_name, l.phone, l.jid,
		       COALESCE(ps.name, '') as stage_name,
		       COALESCE(array_agg(DISTINCT t2.name) FILTER (WHERE t2.name IS NOT NULL), '{}') as tags
		FROM leads l
		LEFT JOIN pipeline_stages ps ON ps.id = l.stage_id
		LEFT JOIN contact_tags ct2 ON ct2.contact_id = l.contact_id
		LEFT JOIN tags t2 ON t2.id = ct2.tag_id`
	args := []interface{}{accountID}
	argN := 2

	if tag != "" {
		sql += ` JOIN contact_tags ct ON ct.contact_id = l.contact_id JOIN tags t ON t.id = ct.tag_id`
		sql += fmt.Sprintf(` WHERE l.account_id = $1 AND t.name ILIKE $%d`, argN)
		args = append(args, "%"+tag+"%")
		argN++
	} else {
		sql += ` WHERE l.account_id = $1`
	}

	if query != "" {
		sql += fmt.Sprintf(` AND (l.name ILIKE $%d OR l.last_name ILIKE $%d OR l.phone ILIKE $%d OR l.email ILIKE $%d)`, argN, argN, argN, argN)
		args = append(args, "%"+query+"%")
		argN++
	}

	if eventIDStr != "" {
		eventID, err := uuid.Parse(eventIDStr)
		if err == nil {
			sql += fmt.Sprintf(` AND l.id IN (SELECT ep.lead_id FROM event_participants ep WHERE ep.event_id = $%d AND ep.lead_id IS NOT NULL`, argN)
			args = append(args, eventID)
			argN++
			if stage != "" {
				sql += fmt.Sprintf(` AND ep.stage_id IN (SELECT eps.id FROM event_pipeline_stages eps WHERE eps.name ILIKE $%d)`, argN)
				args = append(args, "%"+stage+"%")
				argN++
			}
			sql += `)`
		}
	} else if stage != "" {
		sql += fmt.Sprintf(` AND l.stage_id IN (SELECT ps2.id FROM pipeline_stages ps2 WHERE ps2.name ILIKE $%d)`, argN)
		args = append(args, "%"+stage+"%")
		argN++
	}

	sql += ` GROUP BY l.id, l.name, l.last_name, l.phone, l.jid, ps.name`
	sql += fmt.Sprintf(` LIMIT %d`, maxLeads)

	rows, err := s.repos.DB().Query(ctx, sql, args...)
	if err != nil {
		return errResult("error en búsqueda de leads: " + err.Error()), nil
	}
	defer rows.Close()

	type leadChat struct {
		Name     string   `json:"name"`
		Phone    string   `json:"phone,omitempty"`
		Stage    string   `json:"stage,omitempty"`
		Tags     []string `json:"tags"`
		Messages []struct {
			From      string `json:"from"`
			Body      string `json:"body"`
			Timestamp string `json:"timestamp"`
		} `json:"messages"`
	}

	var results []leadChat
	for rows.Next() {
		var id uuid.UUID
		var name, lastName, phone, jid, stageName *string
		var tags []string
		if rows.Scan(&id, &name, &lastName, &phone, &jid, &stageName, &tags) != nil {
			continue
		}

		lc := leadChat{Tags: tags}
		if name != nil {
			lc.Name = *name
			if lastName != nil {
				lc.Name += " " + *lastName
			}
		}
		if phone != nil {
			lc.Phone = *phone
		}
		if stageName != nil && *stageName != "" {
			lc.Stage = *stageName
		}

		// Find chat by JID
		if jid != nil && *jid != "" {
			chat, err := s.repos.Chat.FindByJID(ctx, accountID, *jid)
			if err == nil && chat != nil {
				messages, _ := s.repos.Message.GetByChatID(ctx, chat.ID, msgsPerLead, 0)
				for _, m := range messages {
					msg := struct {
						From      string `json:"from"`
						Body      string `json:"body"`
						Timestamp string `json:"timestamp"`
					}{
						Timestamp: m.Timestamp.Format("2006-01-02 15:04"),
					}
					if m.IsFromMe {
						msg.From = "yo"
					} else {
						msg.From = lc.Name
					}
					if m.Body != nil {
						msg.Body = *m.Body
					} else if m.MessageType != nil {
						msg.Body = "[" + *m.MessageType + "]"
					}
					lc.Messages = append(lc.Messages, msg)
				}
			}
		}

		if lc.Messages == nil {
			lc.Messages = make([]struct {
				From      string `json:"from"`
				Body      string `json:"body"`
				Timestamp string `json:"timestamp"`
			}, 0)
		}
		results = append(results, lc)
	}

	if results == nil {
		results = []leadChat{}
	}

	return jsonResult(map[string]interface{}{
		"count": len(results),
		"leads": results,
		"note":  "Los mensajes están ordenados del más antiguo al más reciente. Analiza el contenido para determinar intención, interés u otras señales. Cada lead incluye su etapa y tags para correlación.",
	}), nil
}

func jsonResult(data interface{}) *mcp.CallToolResult {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return errResult("error al serializar resultado: " + err.Error())
	}
	return mcp.NewToolResultText(string(b))
}

func errResult(msg string) *mcp.CallToolResult {
	return mcp.NewToolResultError(msg)
}

func getArgs(req mcp.CallToolRequest) map[string]any {
	if m, ok := req.Params.Arguments.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func stringArg(req mcp.CallToolRequest, key string) string {
	v, _ := getArgs(req)[key].(string)
	return v
}

func uuidArg(req mcp.CallToolRequest, key string) (uuid.UUID, error) {
	return uuid.Parse(stringArg(req, key))
}

func intArg(req mcp.CallToolRequest, key string, defaultVal, maxVal int) int {
	v, ok := getArgs(req)[key].(float64)
	if !ok || int(v) <= 0 {
		return defaultVal
	}
	n := int(v)
	if n > maxVal {
		return maxVal
	}
	return n
}

func boolArg(req mcp.CallToolRequest, key string, defaultVal bool) bool {
	v, ok := getArgs(req)[key].(bool)
	if !ok {
		return defaultVal
	}
	return v
}

func sensitiveString(include bool, value string) string {
	if !include {
		return ""
	}
	return value
}

func normalizePhone(phone string) string {
	digits := ""
	for _, c := range phone {
		if c >= '0' && c <= '9' {
			digits += string(c)
		}
	}
	if len(digits) == 9 && digits[0] == '9' {
		return "51" + digits
	}
	if len(digits) >= 11 {
		return digits
	}
	return digits
}

func init() {
	log.Println("[MCP] Module loaded")
}

var _ = pgx.ErrNoRows
