/**
 * Event Word Report Generator
 *
 * Styles: gerencia (executive), informal, divertido (fun)
 * Detail levels: basico, detallado, completo
 */
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType,
  Header, Footer, PageNumber,
  TableLayoutType,
} from 'docx'
import { saveAs } from 'file-saver'

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReportStyle = 'gerencia' | 'informal' | 'divertido'
export type DetailLevel = 'basico' | 'detallado' | 'completo'

interface ReportEvent {
  id: string; name: string; description?: string; event_date?: string; event_end?: string
  location?: string; status: string; total_participants: number
  participant_counts?: Record<string, number>
}

interface ReportParticipant {
  id: string; name: string; last_name?: string; short_name?: string
  phone?: string; email?: string; age?: number; status: string
  notes?: string; invited_at?: string; confirmed_at?: string
  attended_at?: string; last_interaction?: string
  tags?: { name: string; color: string }[]
}

interface ReportInteraction {
  id: string; type: string; direction: string; outcome: string; notes?: string
  created_at: string; created_by_name?: string
}

export interface ReportOptions {
  style: ReportStyle
  detail: DetailLevel
  event: ReportEvent
  participants: ReportParticipant[]
  interactions?: Record<string, ReportInteraction[]> // participantId -> interactions
}

// ─── Style Configurations ────────────────────────────────────────────────────

const STYLE_CONFIG = {
  gerencia: {
    titleFont: 'Calibri',
    bodyFont: 'Calibri',
    titleSize: 56,      // 28pt
    subtitleSize: 36,    // 18pt
    headingSize: 30,     // 15pt
    bodySize: 22,        // 11pt
    smallSize: 18,       // 9pt
    primaryColor: '1B4F72',
    secondaryColor: '2E86C1',
    accentColor: '148F77',
    headerBg: '1B4F72',
    headerText: 'FFFFFF',
    altRowBg: 'EBF5FB',
    borderColor: 'BDC3C7',
  },
  informal: {
    titleFont: 'Calibri',
    bodyFont: 'Calibri',
    titleSize: 52,
    subtitleSize: 32,
    headingSize: 28,
    bodySize: 22,
    smallSize: 18,
    primaryColor: '27AE60',
    secondaryColor: '2ECC71',
    accentColor: 'F39C12',
    headerBg: '27AE60',
    headerText: 'FFFFFF',
    altRowBg: 'EAFAF1',
    borderColor: 'D5F5E3',
  },
  divertido: {
    titleFont: 'Calibri',
    bodyFont: 'Calibri',
    titleSize: 56,
    subtitleSize: 34,
    headingSize: 28,
    bodySize: 22,
    smallSize: 18,
    primaryColor: '8E44AD',
    secondaryColor: 'E74C3C',
    accentColor: 'F39C12',
    headerBg: '8E44AD',
    headerText: 'FFFFFF',
    altRowBg: 'F5EEF8',
    borderColor: 'D7BDE2',
  },
}

const STATUS_LABELS: Record<string, string> = {
  invited: 'Invitado',
  contacted: 'Contactado',
  confirmed: 'Confirmado',
  declined: 'Declinado',
  attended: 'Asistió',
  no_show: 'No asistió',
}

const STATUS_EMOJI: Record<string, Record<string, string>> = {
  gerencia: {
    invited: '●', contacted: '●', confirmed: '●',
    declined: '●', attended: '●', no_show: '●',
  },
  informal: {
    invited: '📨', contacted: '📞', confirmed: '✅',
    declined: '❌', attended: '🎉', no_show: '😔',
  },
  divertido: {
    invited: '💌', contacted: '📱', confirmed: '🥳',
    declined: '💔', attended: '🎊', no_show: '😢',
  },
}

const INTERACTION_LABELS: Record<string, string> = {
  call: 'Llamada', whatsapp: 'WhatsApp', note: 'Nota', email: 'Email', meeting: 'Reunión',
}
const OUTCOME_LABELS: Record<string, string> = {
  answered: 'Contestó', no_answer: 'No contestó', voicemail: 'Buzón',
  busy: 'Ocupado', confirmed: 'Confirmó', declined: 'Declinó',
  rescheduled: 'Reprogramar', callback: 'Devolver',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(d?: string): string {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' })
  } catch { return d }
}

function fmtDateTime(d?: string): string {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleString('es-PE', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    })
  } catch { return d }
}

function fmtShortDate(d?: string): string {
  if (!d) return ''
  try {
    return new Date(d).toLocaleDateString('es-PE', { day: '2-digit', month: 'short' })
  } catch { return d }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ _-]/g, '').trim().replace(/\s+/g, '_')
}

function statusEmoji(style: ReportStyle, status: string): string {
  return STATUS_EMOJI[style]?.[status] || ''
}

// ─── Greeting/Closing text per style ─────────────────────────────────────────

function getGreeting(style: ReportStyle, eventName: string): string {
  switch (style) {
    case 'gerencia':
      return `Informe Ejecutivo — ${eventName}`
    case 'informal':
      return `📋 Resumen del Evento: ${eventName}`
    case 'divertido':
      return `🎉✨ ¡Informe del Evento: ${eventName}! ✨🎉`
  }
}

function getIntroText(style: ReportStyle, event: ReportEvent): string {
  const date = fmtDate(event.event_date)
  const loc = event.location || 'ubicación no especificada'
  switch (style) {
    case 'gerencia':
      return `El presente documento detalla los resultados del evento "${event.name}", realizado el ${date} en ${loc}. A continuación se presentan las métricas clave y el estado de los participantes.`
    case 'informal':
      return `¡Hola! 👋 Aquí va el resumen del evento "${event.name}" que se realizó el ${date} en ${loc}. Revisemos cómo nos fue...`
    case 'divertido':
      return `¡Holaaa! 🌟 ¿Listos para ver cómo nos fue en "${event.name}"? 🎯 Fue el ${date} en ${loc}. ¡Vamos a ver los números! 🚀`
  }
}

function getClosingText(style: ReportStyle): string {
  switch (style) {
    case 'gerencia':
      return 'Fin del informe. Se recomienda revisar las acciones pendientes con el equipo responsable.'
    case 'informal':
      return '¡Eso es todo por ahora! 🙌 Si necesitas más detalle, no dudes en consultar. ¡Buen trabajo equipo!'
    case 'divertido':
      return '¡Y eso es todo amigos! 🎬🍿 ¡Gracias por ser parte de este evento increíble! 💪🔥 ¡Nos vemos en el próximo! 🎉'
  }
}

function getSectionTitle(style: ReportStyle, section: string): string {
  const titles: Record<string, Record<string, string>> = {
    summary: {
      gerencia: 'RESUMEN EJECUTIVO',
      informal: '📊 Resumen General',
      divertido: '📊✨ Los Números Mágicos',
    },
    participants: {
      gerencia: 'LISTADO DE PARTICIPANTES',
      informal: '👥 Participantes',
      divertido: '👥🌈 ¡Nuestra Gente!',
    },
    details: {
      gerencia: 'DETALLE POR PARTICIPANTE',
      informal: '📝 Detalle Completo',
      divertido: '🔍💫 ¡Todo sobre cada uno!',
    },
    interactions: {
      gerencia: 'HISTORIAL DE INTERACCIONES',
      informal: '💬 Interacciones',
      divertido: '💬🎯 ¡Las Conversaciones!',
    },
  }
  return titles[section]?.[style] || section
}

function getStatusGroupTitle(style: ReportStyle, status: string, count: number): string {
  const label = STATUS_LABELS[status] || status
  const emoji = statusEmoji(style, status)
  switch (style) {
    case 'gerencia':
      return `${label.toUpperCase()} (${count})`
    case 'informal':
      return `${emoji} ${label} — ${count} persona${count !== 1 ? 's' : ''}`
    case 'divertido':
      return `${emoji} ${label} — ${count} persona${count !== 1 ? 's' : ''} ${emoji}`
  }
}

const STATUS_ORDER = ['confirmed', 'attended', 'contacted', 'invited', 'declined', 'no_show']

const STATUS_COLORS: Record<string, string> = {
  invited: '2980B9',
  contacted: 'F39C12',
  confirmed: '27AE60',
  declined: 'E74C3C',
  attended: '1ABC9C',
  no_show: '95A5A6',
}

// ─── Cell builders ───────────────────────────────────────────────────────────

function headerCell(text: string, cfg: typeof STYLE_CONFIG.gerencia, width?: number): TableCell {
  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: { type: ShadingType.SOLID, color: cfg.headerBg, fill: cfg.headerBg },
    children: [new Paragraph({
      spacing: { before: 40, after: 40 },
      children: [new TextRun({
        text,
        bold: true,
        size: cfg.smallSize,
        font: cfg.bodyFont,
        color: cfg.headerText,
      })],
    })],
  })
}

function dataCell(text: string, cfg: typeof STYLE_CONFIG.gerencia, opts?: {
  bold?: boolean; color?: string; bg?: string; size?: number; width?: number
}): TableCell {
  return new TableCell({
    width: opts?.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    shading: opts?.bg ? { type: ShadingType.SOLID, color: opts.bg, fill: opts.bg } : undefined,
    children: [new Paragraph({
      spacing: { before: 30, after: 30 },
      children: [new TextRun({
        text,
        bold: opts?.bold,
        size: opts?.size || cfg.bodySize,
        font: cfg.bodyFont,
        color: opts?.color || '333333',
      })],
    })],
  })
}

function emptyRow(cols: number, cfg: typeof STYLE_CONFIG.gerencia): TableRow {
  return new TableRow({
    children: Array.from({ length: cols }, () =>
      new TableCell({ children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [] })] })
    ),
  })
}

// ─── Document Builder ────────────────────────────────────────────────────────

export async function generateWordReport(options: ReportOptions): Promise<void> {
  const { style, detail, event, participants, interactions } = options
  const cfg = STYLE_CONFIG[style]

  const sections: Paragraph[] = []

  // ─── Title ─────────────────────────────────────────────────────────────────
  sections.push(
    new Paragraph({ spacing: { after: 100 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({
        text: getGreeting(style, event.name),
        bold: true,
        size: cfg.titleSize,
        font: cfg.titleFont,
        color: cfg.primaryColor,
      })],
    }),
  )

  // Subtitle with event date and location
  if (event.event_date || event.location) {
    const parts: string[] = []
    if (event.event_date) parts.push(`📅 ${fmtDate(event.event_date)}`)
    if (event.event_end) parts.push(`→ ${fmtDate(event.event_end)}`)
    if (event.location) parts.push(`📍 ${event.location}`)
    sections.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({
        text: parts.join('   |   '),
        size: cfg.subtitleSize - 8,
        font: cfg.bodyFont,
        color: '666666',
      })],
    }))
  }

  // Description
  if (event.description) {
    sections.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({
        text: event.description,
        italics: true,
        size: cfg.bodySize,
        font: cfg.bodyFont,
        color: '888888',
      })],
    }))
  }

  // Divider
  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 100, after: 200 },
    children: [new TextRun({
      text: style === 'divertido' ? '━━━━━━ ✨🌟✨ ━━━━━━' : style === 'informal' ? '━━━━━━━━━━━━━━━━━━━━' : '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      size: cfg.smallSize,
      color: cfg.borderColor,
    })],
  }))

  // ─── Intro text ────────────────────────────────────────────────────────────
  sections.push(new Paragraph({
    spacing: { after: 200 },
    children: [new TextRun({
      text: getIntroText(style, event),
      size: cfg.bodySize,
      font: cfg.bodyFont,
      color: '444444',
    })],
  }))

  // ─── Summary Section ──────────────────────────────────────────────────────
  sections.push(new Paragraph({
    spacing: { before: 200, after: 150 },
    children: [new TextRun({
      text: getSectionTitle(style, 'summary'),
      bold: true,
      size: cfg.headingSize,
      font: cfg.titleFont,
      color: cfg.primaryColor,
    })],
  }))

  // Stats table
  const counts = event.participant_counts || {}
  const statuses = ['invited', 'contacted', 'confirmed', 'declined', 'attended', 'no_show']
  const statsRows = statuses
    .filter(s => (counts[s] || 0) > 0)
    .map((s, i) => new TableRow({
      children: [
        dataCell(
          `${statusEmoji(style, s)} ${STATUS_LABELS[s] || s}`,
          cfg,
          { bold: true, bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF' }
        ),
        dataCell(
          (counts[s] || 0).toString(),
          cfg,
          { bold: true, color: cfg.secondaryColor, bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF' }
        ),
        dataCell(
          `${event.total_participants > 0 ? Math.round((counts[s] || 0) / event.total_participants * 100) : 0}%`,
          cfg,
          { color: '888888', bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF' }
        ),
      ],
    }))

  sections.push(new Paragraph({ children: [] })) // spacer
  const statsTable = new Table({
    width: { size: 5000, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        children: [
          headerCell('Estado', cfg, 2500),
          headerCell('Cantidad', cfg, 1500),
          headerCell('Porcentaje', cfg, 1000),
        ],
      }),
      ...statsRows,
      // Total row
      new TableRow({
        children: [
          dataCell(style === 'divertido' ? '🏆 TOTAL' : 'TOTAL', cfg, { bold: true, color: cfg.primaryColor }),
          dataCell(event.total_participants.toString(), cfg, { bold: true, color: cfg.primaryColor }),
          dataCell('100%', cfg, { bold: true, color: cfg.primaryColor }),
        ],
      }),
    ],
  })

  // Key metrics
  const withPhone = participants.filter(p => p.phone).length
  const withEmail = participants.filter(p => p.email).length
  const avgAge = participants.filter(p => p.age).reduce((a, p) => a + (p.age || 0), 0) / (participants.filter(p => p.age).length || 1)
  const tagCounts: Record<string, number> = {}
  participants.forEach(p => (p.tags || []).forEach(t => { tagCounts[t.name] = (tagCounts[t.name] || 0) + 1 }))

  // Metrics summary text
  const metricsText = style === 'divertido'
    ? `📱 ${withPhone} con teléfono   |   📧 ${withEmail} con email   |   🎂 Edad promedio: ${avgAge > 0 ? Math.round(avgAge) : '—'}`
    : style === 'informal'
    ? `📱 ${withPhone} con teléfono  ·  📧 ${withEmail} con email  ·  Edad promedio: ${avgAge > 0 ? Math.round(avgAge) : '—'}`
    : `Con teléfono: ${withPhone}  |  Con email: ${withEmail}  |  Edad promedio: ${avgAge > 0 ? Math.round(avgAge) : '—'}`

  // ─── Participants by Status Group ─────────────────────────────────────────
  // Group participants by status, ordered by STATUS_ORDER
  const grouped: Record<string, ReportParticipant[]> = {}
  for (const p of participants) {
    if (!grouped[p.status]) grouped[p.status] = []
    grouped[p.status].push(p)
  }
  // Sort each group by name
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }

  const orderedStatuses = STATUS_ORDER.filter(s => (grouped[s]?.length || 0) > 0)

  // We'll collect all doc children (paragraphs + tables) in order
  const allChildren: (Paragraph | Table)[] = []

  // Add all sections so far
  sections.forEach(p => allChildren.push(p))
  // Insert the stats table
  allChildren.push(statsTable)

  // Add metrics and tags after stats table
  allChildren.push(new Paragraph({ spacing: { before: 200, after: 100 }, children: [] }))
  allChildren.push(new Paragraph({
    spacing: { after: 100 },
    children: [new TextRun({
      text: metricsText,
      size: cfg.bodySize,
      font: cfg.bodyFont,
      color: '666666',
    })],
  }))

  if (Object.keys(tagCounts).length > 0) {
    const tagText = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} (${count})`).join(', ')
    allChildren.push(new Paragraph({
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: style === 'divertido' ? '🏷️ Etiquetas: ' : style === 'informal' ? '🏷️ ' : 'Etiquetas: ',
          bold: true,
          size: cfg.smallSize + 2,
          font: cfg.bodyFont,
          color: cfg.accentColor,
        }),
        new TextRun({
          text: tagText,
          size: cfg.smallSize + 2,
          font: cfg.bodyFont,
          color: '666666',
        }),
      ],
    }))
  }

  // ─── Render Each Status Group ──────────────────────────────────────────────
  for (const status of orderedStatuses) {
    const group = grouped[status]
    if (!group || group.length === 0) continue

    const statusColor = STATUS_COLORS[status] || cfg.primaryColor

    // Group divider
    allChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400, after: 100 },
      children: [new TextRun({
        text: style === 'divertido' ? '· · · · · · · · · · · · · · ·' : '───────────────────────────────',
        size: cfg.smallSize,
        color: cfg.borderColor,
      })],
    }))

    // Group header with colored accent
    allChildren.push(new Paragraph({
      spacing: { before: 100, after: 60 },
      children: [
        new TextRun({
          text: '▎ ',
          bold: true,
          size: cfg.headingSize + 4,
          font: cfg.titleFont,
          color: statusColor,
        }),
        new TextRun({
          text: getStatusGroupTitle(style, status, group.length),
          bold: true,
          size: cfg.headingSize,
          font: cfg.titleFont,
          color: statusColor,
        }),
      ],
    }))

    // Group percentage bar text
    const pctOfTotal = event.total_participants > 0 ? Math.round(group.length / event.total_participants * 100) : 0
    allChildren.push(new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({
        text: `${group.length} de ${event.total_participants} participantes (${pctOfTotal}%)`,
        size: cfg.smallSize + 2,
        font: cfg.bodyFont,
        color: '888888',
        italics: true,
      })],
    }))

    // Group participant table
    if (detail === 'basico') {
      const rows = group.map((p, i) => new TableRow({
        children: [
          dataCell((i + 1).toString(), cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 500 }),
          dataCell(`${p.name}${p.last_name ? ' ' + p.last_name : ''}`, cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 3500 }),
          dataCell(p.phone || '—', cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 2000 }),
          dataCell((p.tags || []).map(t => t.name).join(', ') || '—', cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 2000 }),
        ],
      }))

      allChildren.push(new Table({
        width: { size: 8000, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        rows: [
          new TableRow({
            children: [
              headerCell('#', cfg, 500),
              headerCell('Nombre', cfg, 3500),
              headerCell('Teléfono', cfg, 2000),
              headerCell('Etiquetas', cfg, 2000),
            ],
          }),
          ...rows,
        ],
      }))
    } else {
      // Detailed/completo table
      const rows = group.map((p, i) => new TableRow({
        children: [
          dataCell((i + 1).toString(), cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 400, size: cfg.smallSize }),
          dataCell(`${p.name}${p.last_name ? ' ' + p.last_name : ''}`, cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 2400, size: cfg.smallSize }),
          dataCell(p.phone || '—', cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 1400, size: cfg.smallSize }),
          dataCell(p.email || '—', cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 2000, size: cfg.smallSize }),
          dataCell(p.age ? p.age.toString() : '—', cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 500, size: cfg.smallSize }),
          dataCell((p.tags || []).map(t => t.name).join(', ') || '—', cfg, { bg: i % 2 === 0 ? cfg.altRowBg : 'FFFFFF', width: 1500, size: cfg.smallSize }),
        ],
      }))

      allChildren.push(new Table({
        width: { size: 8200, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        rows: [
          new TableRow({
            children: [
              headerCell('#', cfg, 400),
              headerCell('Nombre', cfg, 2400),
              headerCell('Teléfono', cfg, 1400),
              headerCell('Email', cfg, 2000),
              headerCell('Edad', cfg, 500),
              headerCell('Etiquetas', cfg, 1500),
            ],
          }),
          ...rows,
        ],
      }))
    }

    // ─── Detail cards per participant (completo only) within each group ─────
    if (detail === 'completo') {
      allChildren.push(new Paragraph({
        spacing: { before: 200, after: 80 },
        children: [new TextRun({
          text: style === 'gerencia'
            ? `DETALLE — ${(STATUS_LABELS[status] || status).toUpperCase()}`
            : style === 'informal'
            ? `📝 Detalle de ${STATUS_LABELS[status] || status}`
            : `🔍 Detalle de ${STATUS_LABELS[status] || status} ${statusEmoji(style, status)}`,
          bold: true,
          size: cfg.bodySize + 2,
          font: cfg.titleFont,
          color: statusColor,
        })],
      }))

      group.forEach((p, idx) => {
        const pInteractions = interactions?.[p.id] || []
        const fullName = `${p.name}${p.last_name ? ' ' + p.last_name : ''}`

        // Participant sub-header
        allChildren.push(new Paragraph({
          spacing: { before: idx === 0 ? 80 : 200, after: 60 },
          children: [
            new TextRun({
              text: `${idx + 1}. `,
              bold: true,
              size: cfg.bodySize + 2,
              font: cfg.bodyFont,
              color: statusColor,
            }),
            new TextRun({
              text: fullName,
              bold: true,
              size: cfg.bodySize + 2,
              font: cfg.bodyFont,
              color: '333333',
            }),
            ...(p.short_name ? [new TextRun({
              text: `  (${p.short_name})`,
              size: cfg.bodySize,
              font: cfg.bodyFont,
              color: 'AAAAAA',
              italics: true,
            })] : []),
          ],
        }))

        // Info line
        const infoParts: string[] = []
        if (p.phone) infoParts.push(`📱 ${p.phone}`)
        if (p.email) infoParts.push(`📧 ${p.email}`)
        if (p.age) infoParts.push(`🎂 ${p.age} años`)
        if (p.tags && p.tags.length) infoParts.push(`🏷️ ${p.tags.map(t => t.name).join(', ')}`)
        if (infoParts.length) {
          allChildren.push(new Paragraph({
            spacing: { after: 40 },
            indent: { left: 300 },
            children: [new TextRun({
              text: infoParts.join('   ·   '),
              size: cfg.smallSize + 2,
              font: cfg.bodyFont,
              color: '666666',
            })],
          }))
        }

        // Dates
        const dateParts: string[] = []
        if (p.invited_at) dateParts.push(`Invitado: ${fmtShortDate(p.invited_at)}`)
        if (p.confirmed_at) dateParts.push(`Confirmado: ${fmtShortDate(p.confirmed_at)}`)
        if (p.attended_at) dateParts.push(`Asistió: ${fmtShortDate(p.attended_at)}`)
        if (dateParts.length) {
          allChildren.push(new Paragraph({
            spacing: { after: 40 },
            indent: { left: 300 },
            children: [new TextRun({
              text: dateParts.join('  |  '),
              size: cfg.smallSize,
              font: cfg.bodyFont,
              color: '999999',
              italics: true,
            })],
          }))
        }

        // Notes
        if (p.notes) {
          allChildren.push(new Paragraph({
            spacing: { after: 40 },
            indent: { left: 300 },
            children: [
              new TextRun({ text: 'Notas: ', bold: true, size: cfg.smallSize + 2, font: cfg.bodyFont, color: '666666' }),
              new TextRun({ text: p.notes, size: cfg.smallSize + 2, font: cfg.bodyFont, color: '666666', italics: true }),
            ],
          }))
        }

        // Interactions
        if (pInteractions.length > 0) {
          allChildren.push(new Paragraph({
            spacing: { before: 60, after: 30 },
            indent: { left: 300 },
            children: [new TextRun({
              text: style === 'divertido' ? `💬 ${pInteractions.length} interacciones:` : `Interacciones (${pInteractions.length}):`,
              bold: true,
              size: cfg.smallSize + 2,
              font: cfg.bodyFont,
              color: cfg.accentColor,
            })],
          }))

          pInteractions.slice(0, 10).forEach(int => {
            const typeLabel = INTERACTION_LABELS[int.type] || int.type
            const outcomeLabel = OUTCOME_LABELS[int.outcome] || int.outcome
            const dir = int.direction === 'inbound' ? '←' : '→'
            allChildren.push(new Paragraph({
              spacing: { after: 20 },
              indent: { left: 600 },
              children: [
                new TextRun({
                  text: `${dir} ${typeLabel} — ${outcomeLabel}`,
                  size: cfg.smallSize,
                  font: cfg.bodyFont,
                  color: '555555',
                  bold: true,
                }),
                new TextRun({
                  text: `  ${fmtShortDate(int.created_at)}${int.created_by_name ? ` (${int.created_by_name})` : ''}`,
                  size: cfg.smallSize,
                  font: cfg.bodyFont,
                  color: '999999',
                }),
                ...(int.notes ? [new TextRun({
                  text: `  "${int.notes}"`,
                  size: cfg.smallSize,
                  font: cfg.bodyFont,
                  color: '888888',
                  italics: true,
                })] : []),
              ],
            }))
          })

          if (pInteractions.length > 10) {
            allChildren.push(new Paragraph({
              spacing: { after: 40 },
              indent: { left: 600 },
              children: [new TextRun({
                text: `... y ${pInteractions.length - 10} interacciones más`,
                size: cfg.smallSize,
                font: cfg.bodyFont,
                color: '999999',
                italics: true,
              })],
            }))
          }
        }
      })
    }
  }

  // ─── Closing ───────────────────────────────────────────────────────────────
  allChildren.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400, after: 100 },
      children: [new TextRun({
        text: style === 'divertido' ? '━━━━━━ 🌟🎯🌟 ━━━━━━' : style === 'informal' ? '━━━━━━━━━━━━━━━━━━━━' : '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        size: cfg.smallSize,
        color: cfg.borderColor,
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({
        text: getClosingText(style),
        size: cfg.bodySize,
        font: cfg.bodyFont,
        color: '888888',
        italics: style !== 'gerencia',
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 100 },
      children: [new TextRun({
        text: `Generado el ${new Date().toLocaleString('es-PE', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} — Clarin CRM`,
        size: cfg.smallSize,
        font: cfg.bodyFont,
        color: 'BBBBBB',
      })],
    }),
  )

  // ─── Build document ────────────────────────────────────────────────────────
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: cfg.bodyFont,
            size: cfg.bodySize,
          },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({
              text: `${event.name} — Informe`,
              size: cfg.smallSize - 2,
              color: 'BBBBBB',
              font: cfg.bodyFont,
            })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Página ', size: cfg.smallSize - 2, color: 'BBBBBB', font: cfg.bodyFont }),
              new TextRun({ children: [PageNumber.CURRENT], size: cfg.smallSize - 2, color: 'BBBBBB', font: cfg.bodyFont }),
              new TextRun({ text: ' — Clarin CRM', size: cfg.smallSize - 2, color: 'BBBBBB', font: cfg.bodyFont }),
            ],
          })],
        }),
      },
      children: allChildren,
    }],
  })

  const blob = await Packer.toBlob(doc)
  const styleLabel = style === 'gerencia' ? 'ejecutivo' : style
  saveAs(blob, `${sanitizeFilename(event.name)}_informe_${styleLabel}.docx`)
}
