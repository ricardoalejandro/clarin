import * as XLSX from 'xlsx'
import { saveAs } from 'file-saver'
import type { LeadIntelligenceResult, LeadIntelligenceRow } from '@/types/report'

const leadHeaders = [
  'lead_id', 'contact_id', 'nombre', 'telefono', 'email', 'edad', 'dni', 'fecha_creacion', 'fuente', 'etapa_crm', 'status', 'tags',
  'eventos_asociados', 'programa_asociado', 'campañas_recibidas', 'notas_lead', 'notas_contacto', 'observaciones_llamada_o_contacto',
  'tiene_chat', 'total_mensajes_entrantes', 'total_mensajes_salientes', 'ultimo_mensaje_entrante_fecha', 'ultimo_mensaje_saliente_fecha',
  'ultimo_mensaje_de_quien', 'resumen_chat', 'evidencia_chat_clave', 'respuesta_whatsapp_categoria', 'ultimo_estado_conversacion',
  'score_interes_real_0_5', 'score_respuesta_whatsapp_0_5', 'score_perfil_idealista_0_5', 'score_necesidad_emocional_0_5',
  'score_probabilidad_conversion_0_100', 'score_prioridad_contacto_0_100', 'nivel_prioridad', 'temperatura_real', 'perfil_humano_principal',
  'perfil_humano_secundario', 'razon_prioridad', 'accion_recomendada', 'mensaje_sugerido_tipo', 'riesgo_de_insistir', 'posible_duplicado',
  'lead_principal_sugerido', 'requiere_revision_humana', 'comentarios_analista',
]

function safeCell(value: unknown): string | number | boolean {
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return value
  const text = String(value)
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text
}

function rowValues(row: LeadIntelligenceRow, headers = leadHeaders) {
  return headers.map(header => safeCell(row[header]))
}

function appendSheet(workbook: XLSX.WorkBook, name: string, data: Array<Array<string | number | boolean>>, widths?: number[]) {
  const sheet = XLSX.utils.aoa_to_sheet(data)
  if (data.length > 0 && data[0].length > 0) sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length - 1, c: data[0].length - 1 } }) }
  sheet['!cols'] = (widths || data[0]?.map(value => Math.min(36, Math.max(12, String(value).length + 2))) || []).map(width => ({ wch: width }))
  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

function topRows(rows: LeadIntelligenceRow[], priorities: string[]) {
  return rows.filter(row => priorities.includes(String(row.nivel_prioridad))).sort((a, b) => Number(b.score_prioridad_contacto_0_100 || 0) - Number(a.score_prioridad_contacto_0_100 || 0))
}

export function exportLeadIntelligenceExcel(result: LeadIntelligenceResult) {
  const workbook = XLSX.utils.book_new()
  const summary = result.summary
  const calls = topRows(result.rows, ['A+', 'A'])
  const personalized = result.rows.filter(row => String(row.accion_recomendada) === 'WhatsApp personalizado')
  const summaryRows: Array<Array<string | number | boolean>> = [
    ['Métrica', 'Valor'], ['Objetivo', safeCell(summary.objective_name)], ['Contexto', safeCell(summary.campaign_context)],
    ['Total leads analizados', summary.total_leads], ['Leads con chats', summary.leads_with_chats], ['Leads con observaciones', summary.leads_with_notes],
    ['Leads con eventos', summary.leads_with_events], ['Candidatos revisados por IA', `${summary.ai_processed_count}/${summary.ai_candidate_count}`],
    ['Cobertura IA', `${Number(summary.ai_coverage_percent || 0).toFixed(1)}%`], [], ['Prioridad', 'Total'],
    ...Object.entries(summary.priority_distribution || {}).map(([key, value]) => [key, value] as Array<string | number>),
    [], ['Perfil humano', 'Total'], ...Object.entries(summary.profile_distribution || {}).sort((a, b) => b[1] - a[1]).map(([key, value]) => [key, value] as Array<string | number>),
    [], ['Hallazgos clave', 'Detalle'], ...(summary.hallazgos || []).map((value, index) => [`Hallazgo ${index + 1}`, safeCell(value)]),
    [], ['Limitaciones', 'Detalle'], ...(summary.limitaciones || []).map((value, index) => [`Limitación ${index + 1}`, safeCell(value)]),
    [], ['Respuestas ejecutivas', 'Detalle'], ...Object.entries(summary.respuestas || {}).map(([key, value]) => [safeCell(key.replaceAll('_', ' ')), safeCell(value)]),
    [], ['Top 20 para llamada', 'Teléfono', 'Prioridad', 'Razón'], ...calls.slice(0, 20).map(row => [safeCell(row.nombre), safeCell(row.telefono), safeCell(row.nivel_prioridad), safeCell(row.razon_prioridad)]),
    [], ['Top 20 para WhatsApp personalizado', 'Teléfono', 'Prioridad', 'Razón'], ...personalized.slice(0, 20).map(row => [safeCell(row.nombre), safeCell(row.telefono), safeCell(row.nivel_prioridad), safeCell(row.razon_prioridad)]),
  ]
  appendSheet(workbook, 'RESUMEN_EJECUTIVO', summaryRows, [38, 90, 18, 70])
  appendSheet(workbook, 'TODOS_LOS_LEADS_ANALIZADOS', [leadHeaders, ...result.rows.map(row => rowValues(row))])
  const contactHeaders = ['nombre', 'telefono', 'nivel_prioridad', 'score_prioridad_contacto_0_100', 'perfil_humano_principal', 'razon_prioridad', 'evidencia_chat_clave', 'mensaje_sugerido_tipo']
  appendSheet(workbook, 'TOP_PRIORIDAD_LLAMADA', [contactHeaders, ...calls.map(row => rowValues(row, contactHeaders))], [28, 18, 12, 12, 34, 70, 80, 42])
  appendSheet(workbook, 'WHATSAPP_PERSONALIZADO', [contactHeaders, ...personalized.map(row => rowValues(row, contactHeaders))], [28, 18, 12, 12, 34, 70, 80, 42])
  appendSheet(workbook, 'DIFUSION_SEGMENTADA', [['segmento', 'nombre', 'telefono', 'prioridad', 'tipo_mensaje', 'razón'], ...result.rows.filter(row => ['B', 'C', 'D'].includes(String(row.nivel_prioridad))).map(row => [safeCell(row.perfil_humano_principal), safeCell(row.nombre), safeCell(row.telefono), safeCell(row.nivel_prioridad), safeCell(row.mensaje_sugerido_tipo), safeCell(row.razon_prioridad)])], [34, 28, 18, 12, 38, 75])
  appendSheet(workbook, 'NO_PRIORIZAR', [['nombre', 'telefono', 'prioridad', 'motivo', 'etapa', 'tags', 'último_estado', 'duplicado'], ...result.rows.filter(row => ['D', 'E'].includes(String(row.nivel_prioridad))).map(row => [safeCell(row.nombre), safeCell(row.telefono), safeCell(row.nivel_prioridad), safeCell(row.razon_prioridad), safeCell(row.etapa_crm), safeCell(row.tags), safeCell(row.ultimo_estado_conversacion), safeCell(row.posible_duplicado)])], [28, 18, 12, 75, 26, 55, 30, 16])
  const eventRows = result.rows.flatMap(row => (Array.isArray(row.eventos_detalle) ? row.eventos_detalle : []).map(event => [safeCell(row.lead_id), safeCell(row.nombre), safeCell(row.telefono), safeCell(event.evento), safeCell(event.fecha), safeCell(event.estado_evento), safeCell(event.estado_participante), safeCell(event.notas)]))
  appendSheet(workbook, 'EVENTOS_Y_PARTICIPACION', [['lead_id', 'contacto', 'telefono', 'evento', 'fecha', 'estado_evento', 'estado_participante', 'notas'], ...eventRows], [38, 28, 18, 48, 22, 20, 24, 70])
  appendSheet(workbook, 'OBSERVACIONES_Y_NOTAS', [['lead_id', 'nombre', 'telefono', 'notas_lead', 'notas_contacto', 'observación_consolidada'], ...result.rows.filter(row => String(row.observaciones_llamada_o_contacto || '') !== 'Sin observaciones formales encontradas.').map(row => [safeCell(row.lead_id), safeCell(row.nombre), safeCell(row.telefono), safeCell(row.notas_lead), safeCell(row.notas_contacto), safeCell(row.observaciones_llamada_o_contacto)])], [38, 28, 18, 65, 65, 90])
  appendSheet(workbook, 'DICCIONARIO_DE_SEGMENTOS', [
    ['Perfil', 'Indicadores', 'Abordaje'],
    ['Buscador filosófico / idealista', 'Filosofía, autoconocimiento o sentido de vida.', 'Mensaje profundo y no comercial.'],
    ['Mejora personal práctica', 'Herramientas para decisiones, hábitos o emociones.', 'Resaltar utilidad concreta.'],
    ['Necesidad emocional / contención', 'Ansiedad, cansancio, dolor o búsqueda de equilibrio.', 'Tono cálido y sin presión.'],
    ['Cultural / comunitario', 'Comunidad, cultura, libros, poesía u oratoria.', 'Invitación desde cultura y comunidad.'],
    ['Estudiante / joven con limitación de horario', 'Clases, universidad o examen.', 'Horarios claros y flexibilidad.'],
    ['Familiar / referidor', 'Familiares, amigos o acompañantes.', 'Permitir asistir acompañado.'],
    ['Asistente previo recuperable', 'Asistencia previa registrada.', 'Mensaje de continuidad.'],
    ['Lead frío de redes/ads', 'Entrada por ads sin continuación.', 'Difusión ocasional.'],
  ], [38, 85, 65])
  appendSheet(workbook, 'LIMITACIONES_Y_CALIDAD', [['Tema', 'Detalle'], ['Cobertura', `Se analizaron ${summary.total_leads} leads.`], ['IA selectiva', `${summary.ai_processed_count} de ${summary.ai_candidate_count} candidatos recibieron revisión semántica.`], ['Read receipts', 'No se infieren vistos; solo ausencia de respuesta entrante.'], ['Seguridad', 'No contactar, menores y convertidos prevalecen sobre la IA.'], ...result.warnings.map((warning, index) => [`Advertencia ${index + 1}`, safeCell(warning)]), ...(summary.limitaciones || []).map((value, index) => [`Limitación ${index + 1}`, safeCell(value)])], [34, 120])
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true })
  const filename = `analisis_inteligente_leads_${new Date(summary.generated_at || Date.now()).toISOString().slice(0, 10)}.xlsx`
  saveAs(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename)
}
