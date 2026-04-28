/**
 * Fabric.js Editor Constants
 */

export const MM_TO_PX = 2
export const SNAP_THRESHOLD = 5
export const MIN_SIZE = 10
export const HISTORY_LIMIT = 50

// ─── Zoom ─────────────────────────────────────────────────────────────────────

export const ZOOM_MIN = 0.05   // 5%
export const ZOOM_MAX = 50     // 5000%
export const ZOOM_STEP = 0.1   // 10% per scroll tick
export const ZOOM_BTN_STEP = 0.25 // 25% per button click

// ─── Export quality presets ───────────────────────────────────────────────────

export const EXPORT_PRESETS = {
  draft:    { multiplier: 2, label: 'Borrador',     dpi: '~100 DPI' },
  standard: { multiplier: 4, label: 'Estándar',     dpi: '~200 DPI' },
  high:     { multiplier: 6, label: 'Alta calidad',  dpi: '~300 DPI' },
  ultra:    { multiplier: 8, label: 'Ultra',         dpi: '~400 DPI' },
} as const

export type ExportPreset = keyof typeof EXPORT_PRESETS

// ─── Fonts ────────────────────────────────────────────────────────────────────

export const SYSTEM_FONTS = [
  'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana',
  'Courier New', 'Impact', 'Trebuchet MS', 'Palatino', 'Garamond',
  'Book Antiqua', 'Lucida Console', 'Tahoma', 'Century Gothic',
]

export const GOOGLE_FONTS = [
  'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Oswald',
  'Raleway', 'Nunito', 'Playfair Display', 'Merriweather', 'Inter',
  'Rubik', 'Work Sans', 'Quicksand', 'Josefin Sans', 'Bebas Neue',
  'Comfortaa', 'Pacifico', 'Lobster', 'Dancing Script', 'Righteous',
  'Russo One', 'Fredoka One', 'Permanent Marker', 'Caveat',
  'Anton', 'Abril Fatface', 'Archivo Black', 'Passion One', 'Titan One',
]

export const GOOGLE_FONTS_URL = `https://fonts.googleapis.com/css2?${GOOGLE_FONTS.map(f => `family=${f.replace(/ /g, '+')}:wght@300;400;500;600;700;800`).join('&')}&display=swap`

// ─── Colors ───────────────────────────────────────────────────────────────────

export const GUIDE_COLOR = '#10b981'    // emerald-500
export const DYNAMIC_COLOR = '#059669'  // emerald-600
export const GRID_COLOR = '#4a5568'     // dark-friendly grid dots
export const MARGIN_COLOR = '#f59e0b'   // amber-500
export const SELECTION_COLOR = '#10b981'

// ─── Grid ─────────────────────────────────────────────────────────────────────

export const GRID_SIZES = [10, 20, 40, 50]
export const DEFAULT_GRID_SIZE = 20

// ─── Dynamic Fields ───────────────────────────────────────────────────────────

export const DYNAMIC_FIELD_CATEGORIES = [
  {
    label: 'Datos personales',
    fields: [
      { key: 'nombre', label: 'Nombre', template: '{{nombre}}' },
      { key: 'apellido', label: 'Apellido', template: '{{apellido}}' },
      { key: 'nombre_completo', label: 'Nombre completo', template: '{{nombre_completo}}' },
      { key: 'dni', label: 'DNI', template: '{{dni}}' },
      { key: 'telefono', label: 'Teléfono', template: '{{telefono}}' },
      { key: 'email', label: 'Email', template: '{{email}}' },
      { key: 'empresa', label: 'Empresa', template: '{{empresa}}' },
      { key: 'direccion', label: 'Dirección', template: '{{direccion}}' },
      { key: 'distrito', label: 'Distrito', template: '{{distrito}}' },
      { key: 'ocupacion', label: 'Ocupación', template: '{{ocupacion}}' },
      { key: 'edad', label: 'Edad', template: '{{edad}}' },
      { key: 'fecha_nacimiento', label: 'Fecha de nacimiento', template: '{{fecha_nacimiento}}' },
    ],
  },
  {
    label: 'CRM',
    fields: [
      { key: 'etapa', label: 'Etapa del pipeline', template: '{{etapa}}' },
      { key: 'pipeline', label: 'Pipeline', template: '{{pipeline}}' },
      { key: 'tags', label: 'Etiquetas', template: '{{tags}}' },
      { key: 'notas', label: 'Notas', template: '{{notas}}' },
    ],
  },
  {
    label: 'Programa / Evento',
    fields: [
      { key: 'programa_nombre', label: 'Nombre del programa', template: '{{programa_nombre}}' },
      { key: 'evento_nombre', label: 'Nombre del evento', template: '{{evento_nombre}}' },
      { key: 'fecha_sesion', label: 'Fecha de sesión', template: '{{fecha_sesion}}' },
    ],
  },
  {
    label: 'Sistema',
    fields: [
      { key: 'fecha_actual', label: 'Fecha actual', template: '{{fecha_actual}}' },
      { key: 'qr_code', label: 'Código QR', template: '{{qr_code}}' },
    ],
  },
]

// ─── Page Sizes ───────────────────────────────────────────────────────────────

export const PAGE_SIZES: Record<string, { label: string; w: number; h: number }> = {
  a4: { label: 'A4', w: 210, h: 297 },
  a5: { label: 'A5', w: 148, h: 210 },
  letter: { label: 'Carta', w: 216, h: 279 },
  card: { label: 'Tarjeta', w: 85, h: 55 },
  custom: { label: 'Personalizado', w: 210, h: 297 },
}

// ─── Fabric custom property names ─────────────────────────────────────────────

export const CUSTOM_PROPS = [
  'isDynamic', 'fieldName', 'elementType', 'elementName',
  'verticalAlign', 'qrData', 'lineHeightRatio', 'letterSpacingValue',
  'fieldFormat',
  '__isPage',
]
