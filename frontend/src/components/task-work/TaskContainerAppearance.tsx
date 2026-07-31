'use client'

import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive, Award, Bell, BookOpen, Box, Brain, Briefcase, Bug, Building2, CalendarDays, Camera, CheckSquare2, CircleDollarSign, ClipboardList, Cloud, Code2, Coffee, Compass, FileText,
  Flag, Folder, GraduationCap, Inbox, Layers3, ListTodo, Megaphone,
  Check, ChevronDown, Gem, Gift, Globe2, Heart, Home, KeyRound, Laptop, Lightbulb, Link2, LockKeyhole, MapPin, MessageCircle, Package, Palette, Phone, Plane, Rocket, Search, Settings2, ShieldCheck, ShoppingCart, Sparkles, Star, Store, Tag, Target, ThumbsUp, Trophy, Truck, UserRound, Users, Video, Wallet, Wrench, X,
} from 'lucide-react'
import { apiDelete, apiPut } from '@/lib/api'
import type { TaskFolder, TaskList } from '@/types/task'
import TaskDestructiveConfirmDialog from './TaskDestructiveConfirmDialog'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { useDebouncedValue } from '@/lib/useDebouncedValue'

export const TASK_CONTAINER_COLORS = ['#059669', '#10b981', '#0d9488', '#14b8a6', '#0891b2', '#06b6d4', '#0284c7', '#3b82f6', '#4f46e5', '#6366f1', '#7c3aed', '#8b5cf6', '#a855f7', '#c026d3', '#d946ef', '#db2777', '#e11d48', '#dc2626', '#ef4444', '#ea580c', '#f97316', '#d97706', '#f59e0b', '#475569']

export const TASK_CONTAINER_ICONS: Array<{ value: string; label: string; icon: ComponentType<{ className?: string }> }> = [
  { value: 'inbox', label: 'Bandeja', icon: Inbox },
  { value: 'list', label: 'Lista', icon: ListTodo },
  { value: 'folder', label: 'Carpeta', icon: Folder },
  { value: 'briefcase', label: 'Trabajo', icon: Briefcase },
  { value: 'rocket', label: 'Lanzamiento', icon: Rocket },
  { value: 'target', label: 'Objetivo', icon: Target },
  { value: 'users', label: 'Equipo', icon: Users },
  { value: 'megaphone', label: 'Campaña', icon: Megaphone },
  { value: 'graduation-cap', label: 'Formación', icon: GraduationCap },
  { value: 'building', label: 'Organización', icon: Building2 },
  { value: 'clipboard-list', label: 'Procesos', icon: ClipboardList },
  { value: 'layers', label: 'Proyecto', icon: Layers3 },
  { value: 'calendar', label: 'Calendario', icon: CalendarDays },
  { value: 'flag', label: 'Prioridad', icon: Flag },
  { value: 'phone', label: 'Llamadas', icon: Phone },
  { value: 'message-circle', label: 'Mensajes', icon: MessageCircle },
  { value: 'bell', label: 'Recordatorios', icon: Bell },
  { value: 'check-square', label: 'Checklist', icon: CheckSquare2 },
  { value: 'archive', label: 'Archivo', icon: Archive }, { value: 'award', label: 'Reconocimiento', icon: Award },
  { value: 'book-open', label: 'Conocimiento', icon: BookOpen }, { value: 'box', label: 'Caja', icon: Box },
  { value: 'brain', label: 'Ideas', icon: Brain }, { value: 'bug', label: 'Incidencias', icon: Bug },
  { value: 'camera', label: 'Fotografía', icon: Camera }, { value: 'money', label: 'Finanzas', icon: CircleDollarSign },
  { value: 'cloud', label: 'Nube', icon: Cloud }, { value: 'code', label: 'Desarrollo', icon: Code2 },
  { value: 'coffee', label: 'Pausa', icon: Coffee }, { value: 'compass', label: 'Dirección', icon: Compass },
  { value: 'file-text', label: 'Documentos', icon: FileText }, { value: 'gem', label: 'Especial', icon: Gem },
  { value: 'gift', label: 'Beneficios', icon: Gift }, { value: 'globe', label: 'Global', icon: Globe2 },
  { value: 'heart', label: 'Bienestar', icon: Heart }, { value: 'home', label: 'Inicio', icon: Home },
  { value: 'key', label: 'Accesos', icon: KeyRound }, { value: 'laptop', label: 'Tecnología', icon: Laptop },
  { value: 'lightbulb', label: 'Innovación', icon: Lightbulb }, { value: 'link', label: 'Enlaces', icon: Link2 },
  { value: 'lock', label: 'Seguridad', icon: LockKeyhole }, { value: 'map-pin', label: 'Ubicación', icon: MapPin },
  { value: 'package', label: 'Entregables', icon: Package }, { value: 'palette', label: 'Diseño', icon: Palette },
  { value: 'plane', label: 'Viajes', icon: Plane }, { value: 'settings', label: 'Configuración', icon: Settings2 },
  { value: 'shield', label: 'Protección', icon: ShieldCheck }, { value: 'shopping-cart', label: 'Compras', icon: ShoppingCart },
  { value: 'sparkles', label: 'Destacado', icon: Sparkles }, { value: 'star', label: 'Favorito', icon: Star },
  { value: 'store', label: 'Comercio', icon: Store }, { value: 'tag', label: 'Categoría', icon: Tag },
  { value: 'thumbs-up', label: 'Aprobación', icon: ThumbsUp }, { value: 'trophy', label: 'Logros', icon: Trophy },
  { value: 'truck', label: 'Logística', icon: Truck }, { value: 'user', label: 'Persona', icon: UserRound },
  { value: 'video', label: 'Video', icon: Video }, { value: 'wallet', label: 'Presupuesto', icon: Wallet },
  { value: 'wrench', label: 'Mantenimiento', icon: Wrench },
]

const iconByValue = new Map(TASK_CONTAINER_ICONS.map(item => [item.value, item.icon]))

const ICON_CATEGORY_BY_VALUE: Record<string, string> = {
  inbox: 'Organización', list: 'Organización', folder: 'Organización', briefcase: 'Organización', building: 'Organización', 'clipboard-list': 'Organización', layers: 'Organización', archive: 'Organización', box: 'Organización', package: 'Organización',
  rocket: 'Proyectos', target: 'Proyectos', flag: 'Proyectos', calendar: 'Proyectos', 'check-square': 'Proyectos', award: 'Proyectos', trophy: 'Proyectos', star: 'Proyectos', sparkles: 'Proyectos',
  users: 'Personas', user: 'Personas', 'graduation-cap': 'Personas', heart: 'Personas', 'thumbs-up': 'Personas', coffee: 'Personas', gift: 'Personas',
  megaphone: 'Comunicación', phone: 'Comunicación', 'message-circle': 'Comunicación', bell: 'Comunicación', camera: 'Comunicación', video: 'Comunicación', tag: 'Comunicación',
  brain: 'Conocimiento', 'book-open': 'Conocimiento', lightbulb: 'Conocimiento', 'file-text': 'Conocimiento', code: 'Conocimiento', laptop: 'Conocimiento', link: 'Conocimiento',
  money: 'Operaciones', wallet: 'Operaciones', store: 'Operaciones', 'shopping-cart': 'Operaciones', truck: 'Operaciones', wrench: 'Operaciones', settings: 'Operaciones', bug: 'Operaciones',
  shield: 'Seguridad', lock: 'Seguridad', key: 'Seguridad', cloud: 'Tecnología', globe: 'Ubicación', 'map-pin': 'Ubicación', compass: 'Ubicación', plane: 'Ubicación', home: 'Ubicación', palette: 'Creatividad', gem: 'Creatividad',
}

const TASK_RECENT_COLORS_KEY = 'clarin:tasks:recent-colors:v1'
const TASK_RECENT_ICONS_KEY = 'clarin:tasks:recent-icons:v1'

export function normalizeTaskHexColor(value: string, fallback = '#10B981') {
  const normalized = value.trim().toUpperCase()
  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : fallback.toUpperCase()
}

function hexChannels(value: string) {
  const hex = normalizeTaskHexColor(value).slice(1)
  return [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number]
}

export function taskColorContrast(value: string) {
  const [red, green, blue] = hexChannels(value)
  const relative = [red, green, blue].map(channel => {
    const current = channel / 255
    return current <= 0.03928 ? current / 12.92 : ((current + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * relative[0] + 0.7152 * relative[1] + 0.0722 * relative[2]
  const onWhite = 1.05 / (luminance + 0.05)
  const onSlate = (luminance + 0.05) / 0.057
  return {
    textColor: onWhite >= onSlate ? '#FFFFFF' : '#0F172A',
    ratio: Math.max(onWhite, onSlate),
    passesAA: Math.max(onWhite, onSlate) >= 4.5,
  }
}

export function taskHexToHsl(value: string) {
  const [rawRed, rawGreen, rawBlue] = hexChannels(value)
  const red = rawRed / 255; const green = rawGreen / 255; const blue = rawBlue / 255
  const max = Math.max(red, green, blue); const min = Math.min(red, green, blue)
  let hue = 0; let saturation = 0; const lightness = (max + min) / 2
  if (max !== min) {
    const delta = max - min
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
    if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0)
    else if (max === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue /= 6
  }
  return { h: Math.round(hue * 360), s: Math.round(saturation * 100), l: Math.round(lightness * 100) }
}

export function taskHslToHex(h: number, s: number, l: number) {
  const hue = ((h % 360) + 360) % 360 / 360; const saturation = Math.max(0, Math.min(100, s)) / 100; const lightness = Math.max(0, Math.min(100, l)) / 100
  const hueToRgb = (p: number, q: number, tValue: number) => {
    let t = tValue
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let red = lightness; let green = lightness; let blue = lightness
  if (saturation !== 0) {
    const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
    const p = 2 * lightness - q
    red = hueToRgb(p, q, hue + 1 / 3); green = hueToRgb(p, q, hue); blue = hueToRgb(p, q, hue - 1 / 3)
  }
  const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')
  return `#${channel(red)}${channel(green)}${channel(blue)}`.toUpperCase()
}

function readRecent(key: string) {
  if (typeof window === 'undefined') return []
  try { const parsed = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string').slice(0, 8) : [] } catch { return [] }
}

function rememberRecent(key: string, value: string) {
  if (typeof window === 'undefined') return
  localStorage.setItem(key, JSON.stringify([value, ...readRecent(key).filter(item => item !== value)].slice(0, 8)))
}

function pickerPosition(trigger: HTMLElement | null, width: number, height: number): CSSProperties {
  const rect = trigger?.getBoundingClientRect()
  if (!rect || typeof window === 'undefined') return { left: 12, top: 12, width }
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
  const below = rect.bottom + 8
  const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 8)
  return { left, top, width }
}

const PICKER_FOCUSABLE_SELECTOR = [
  'button:not([disabled]):not([tabindex="-1"])',
  'a[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function useTaskPickerFocusTrap({
  open,
  dialogRef,
  triggerRef,
  onClose,
}: {
  open: boolean
  dialogRef: { current: HTMLElement | null }
  triggerRef: { current: HTMLButtonElement | null }
  onClose: () => void
}) {
  const closeRef = useRef(onClose)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : triggerRef.current
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current
      if (!dialog) return
      const preferred = dialog.querySelector<HTMLElement>('[data-task-picker-initial-focus]')
      ;(preferred || dialog).focus({ preventScroll: true })
    })
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(PICKER_FOCUSABLE_SELECTOR))
      if (!focusable.length) {
        event.preventDefault()
        dialogRef.current.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyboard)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyboard)
      const focusTarget = previousFocusRef.current?.isConnected ? previousFocusRef.current : triggerRef.current
      focusTarget?.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [dialogRef, open, triggerRef])
}

export function TaskContainerIcon({ value, className = 'h-4 w-4' }: { value?: string; className?: string }) {
  const Icon = iconByValue.get(value || '') || ListTodo
  return <Icon className={className} />
}

export function TaskColorPicker({ value, onChange, label = 'Color', disabled = false, compact = false }: { value: string; onChange: (value: string) => void; label?: string; disabled?: boolean; compact?: boolean }) {
  const normalized = normalizeTaskHexColor(value)
  const [open, setOpen] = useState(false)
  const [hexDraft, setHexDraft] = useState(normalized)
  const [hsl, setHsl] = useState(() => taskHexToHsl(normalized))
  const [recent, setRecent] = useState<string[]>([])
  const [style, setStyle] = useState<CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const contrast = taskColorContrast(normalized)
  useEffect(() => { setHexDraft(normalized); setHsl(taskHexToHsl(normalized)) }, [normalized])
  useEffect(() => {
    if (!open) return
    setRecent(readRecent(TASK_RECENT_COLORS_KEY))
    const position = () => setStyle(pickerPosition(triggerRef.current, Math.min(360, window.innerWidth - 24), 508))
    position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open])
  useTaskPickerFocusTrap({ open, dialogRef, triggerRef, onClose: () => setOpen(false) })
  const choose = (next: string, confirm = false) => {
    const color = normalizeTaskHexColor(next, normalized)
    onChange(color); setHexDraft(color); setHsl(taskHexToHsl(color))
    if (confirm) {
      rememberRecent(TASK_RECENT_COLORS_KEY, color)
      setRecent(readRecent(TASK_RECENT_COLORS_KEY))
      setOpen(false)
    }
  }
  const updateHsl = (key: 'h' | 's' | 'l', next: number) => { const current = { ...hsl, [key]: next }; setHsl(current); choose(taskHslToHex(current.h, current.s, current.l)) }
  return <>
    <button ref={triggerRef} type="button" disabled={disabled} aria-label={`${label}: ${normalized}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(current => !current)} className={`flex min-h-11 w-full items-center rounded-xl border border-slate-200 bg-white text-left outline-none transition hover:border-slate-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-40 ${compact ? 'justify-center gap-1 px-1.5' : 'gap-3 px-3'}`}><span className="h-7 w-7 shrink-0 rounded-lg border-2 border-white shadow ring-1 ring-slate-200" style={{ backgroundColor: normalized }} />{!compact && <span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-slate-700">{normalized}</span><span className="block truncate text-[9px] text-slate-400">{contrast.passesAA ? 'Contraste AA verificado' : 'Combínalo con texto oscuro'}</span></span>}{!compact && <ChevronDown className="h-4 w-4 text-slate-400" />}</button>
    {open && typeof document !== 'undefined' && createPortal(<><button type="button" tabIndex={-1} aria-label={`Cerrar ${label}`} data-task-picker-backdrop onMouseDown={() => setOpen(false)} className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} /><section ref={dialogRef} tabIndex={-1} data-task-color-picker role="dialog" aria-modal="true" aria-label={label} style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.picker }} className="fixed max-h-[calc(100vh-24px)] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-4 shadow-2xl shadow-slate-900/20 outline-none">
      <div className="flex items-center gap-3"><div className="flex h-12 w-12 items-center justify-center rounded-2xl shadow-inner" style={{ backgroundColor: normalized, color: contrast.textColor }}><Palette className="h-5 w-5" /></div><div className="min-w-0 flex-1"><h3 className="text-sm font-black text-slate-900">Color de identificación</h3><p className="text-[10px] leading-4 text-slate-400">Vista previa y contraste sobre superficies reales.</p></div><button type="button" data-task-picker-initial-focus aria-label={`Cerrar ${label}`} onClick={() => setOpen(false)} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>
      {recent.length > 0 && <div className="mt-4"><p className="mb-2 text-[9px] font-black uppercase tracking-[.14em] text-slate-400">Recientes</p><div className="flex gap-2">{recent.map(color => <button key={color} type="button" aria-label={`Color reciente ${color}`} onClick={() => choose(color)} className="h-8 w-8 rounded-xl border-2 border-white shadow ring-1 ring-slate-200" style={{ backgroundColor: color }} />)}</div></div>}
      <div className="mt-4"><p className="mb-2 text-[9px] font-black uppercase tracking-[.14em] text-slate-400">Paleta Clarin</p><div className="grid grid-cols-8 gap-2">{TASK_CONTAINER_COLORS.map(color => <button key={color} type="button" aria-label={`Color ${color}`} aria-pressed={normalized === color.toUpperCase()} onClick={() => choose(color)} className={`h-8 rounded-xl border-2 border-white shadow ring-1 transition hover:scale-105 ${normalized === color.toUpperCase() ? 'ring-2 ring-slate-900' : 'ring-slate-200'}`} style={{ backgroundColor: color }} />)}</div></div>
      <div className="mt-4 space-y-3 rounded-2xl bg-slate-50 p-3"><div className="flex items-center gap-2"><span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Hex</span><input value={hexDraft} maxLength={7} onChange={event => setHexDraft(event.target.value.toUpperCase())} onBlur={() => choose(hexDraft)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); choose(hexDraft) } }} className={`min-h-9 min-w-0 flex-1 rounded-xl border bg-white px-3 font-mono text-xs font-bold outline-none ${/^#[0-9A-F]{6}$/.test(hexDraft) ? 'border-slate-200 focus:border-emerald-400' : 'border-rose-300 text-rose-600'}`} /></div>{([['h', 'Matiz', 360], ['s', 'Intensidad', 100], ['l', 'Luminosidad', 88]] as const).map(([key, text, max]) => <label key={key} className="grid grid-cols-[72px_1fr_38px] items-center gap-2 text-[10px] font-semibold text-slate-500"><span>{text}</span><input type="range" min={key === 'l' ? 12 : 0} max={max} value={hsl[key]} onChange={event => updateHsl(key, Number(event.target.value))} className="accent-emerald-600" /><span className="text-right tabular-nums">{hsl[key]}{key === 'h' ? '°' : '%'}</span></label>)}</div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-[9px] font-bold"><div className="rounded-xl border border-slate-200 bg-white px-2 py-3 text-center" style={{ color: normalized }}>Claro</div><div className="rounded-xl bg-slate-900 px-2 py-3 text-center" style={{ color: normalized }}>Oscuro</div><div className="rounded-xl px-2 py-3 text-center" style={{ color: contrast.textColor, backgroundColor: normalized }}>{contrast.passesAA ? `AA ${contrast.ratio.toFixed(1)}:1` : `${contrast.ratio.toFixed(1)}:1`}</div></div>
      <button type="button" onClick={() => choose(normalized, true)} className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-black text-white"><Check className="h-4 w-4" />Usar este color</button>
    </section></>, document.body)}
  </>
}

export function TaskIconPicker({ value, onChange, label = 'Icono', disabled = false }: { value: string; onChange: (value: string) => void; label?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [recent, setRecent] = useState<string[]>([])
  const [style, setStyle] = useState<CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const selected = TASK_CONTAINER_ICONS.find(item => item.value === value) || TASK_CONTAINER_ICONS[1]
  const SelectedIcon = selected.icon
  useEffect(() => {
    if (!open) return
    setRecent(readRecent(TASK_RECENT_ICONS_KEY))
    const position = () => setStyle(pickerPosition(triggerRef.current, Math.min(420, window.innerWidth - 24), 520))
    position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open])
  useTaskPickerFocusTrap({ open, dialogRef, triggerRef, onClose: () => setOpen(false) })
  const needle = debouncedQuery.trim().toLocaleLowerCase('es')
  const groups = useMemo(() => {
    const visible = TASK_CONTAINER_ICONS.filter(item => !needle || `${item.label} ${item.value} ${ICON_CATEGORY_BY_VALUE[item.value] || ''}`.toLocaleLowerCase('es').includes(needle))
    const grouped = new Map<string, typeof visible>()
    visible.forEach(item => { const category = ICON_CATEGORY_BY_VALUE[item.value] || 'Otros'; grouped.set(category, [...(grouped.get(category) || []), item]) })
    return Array.from(grouped.entries())
  }, [needle])
  const choose = (next: string) => { onChange(next); rememberRecent(TASK_RECENT_ICONS_KEY, next); setOpen(false) }
  return <>
    <button ref={triggerRef} type="button" disabled={disabled} aria-label={`${label}: ${selected.label}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(current => !current)} className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 text-left outline-none transition hover:border-slate-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-40"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-600"><SelectedIcon className="h-4 w-4" /></span><span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">{selected.label}</span><ChevronDown className="h-4 w-4 text-slate-400" /></button>
    {open && typeof document !== 'undefined' && createPortal(<><button type="button" tabIndex={-1} aria-label={`Cerrar ${label}`} data-task-picker-backdrop onMouseDown={() => setOpen(false)} className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} /><section ref={dialogRef} tabIndex={-1} data-task-icon-picker role="dialog" aria-modal="true" aria-label={label} style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.picker }} className="fixed flex max-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 outline-none"><header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3"><div><h3 className="text-sm font-black text-slate-900">Catálogo de iconos</h3><p className="text-[10px] text-slate-400">Iconos seguros, consistentes y reutilizables.</p></div><button type="button" aria-label={`Cerrar ${label}`} onClick={() => setOpen(false)} className="ml-auto rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></header><div className="border-b border-slate-100 p-3"><div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3"><Search className="h-4 w-4 text-slate-400" /><input autoFocus data-task-picker-initial-focus value={query} onChange={event => { const next = event.target.value; setQuery(next); if (!next) setDebouncedQuery('') }} placeholder="Buscar por nombre o categoría…" className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none" />{query !== debouncedQuery && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}{query && <button type="button" aria-label="Limpiar búsqueda de iconos" onClick={() => { setQuery(''); setDebouncedQuery('') }} className="rounded-lg p-1 text-slate-400 hover:bg-white"><X className="h-3.5 w-3.5" /></button>}</div></div><div className="min-h-0 flex-1 overflow-y-auto p-3">{!needle && recent.length > 0 && <div className="mb-4"><p className="mb-2 text-[9px] font-black uppercase tracking-[.14em] text-slate-400">Recientes</p><div className="grid grid-cols-8 gap-2">{recent.map(id => { const option = TASK_CONTAINER_ICONS.find(item => item.value === id); if (!option) return null; return <button key={id} type="button" title={option.label} onClick={() => choose(id)} className="flex h-10 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-emerald-50 hover:text-emerald-700"><option.icon className="h-4 w-4" /></button> })}</div></div>}{groups.map(([category, items]) => <div key={category} className="mb-4"><p className="mb-2 text-[9px] font-black uppercase tracking-[.14em] text-slate-400">{category}</p><div className="grid grid-cols-8 gap-2">{items.map(option => <button key={option.value} type="button" title={option.label} aria-label={option.label} aria-pressed={selected.value === option.value} onClick={() => choose(option.value)} className={`flex h-10 items-center justify-center rounded-xl border transition ${selected.value === option.value ? 'border-emerald-400 bg-emerald-50 text-emerald-700 ring-2 ring-emerald-100' : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50'}`}><option.icon className="h-4 w-4" /></button>)}</div></div>)}{!groups.length && <div className="py-12 text-center text-xs text-slate-400">No encontramos iconos con esa búsqueda.</div>}</div></section></>, document.body)}
  </>
}

export function TaskAppearanceDialog({ item, type, onClose, onSaved, onError, onOperation }: {
  item: TaskList | TaskFolder
  type: 'list' | 'folder'
  onClose: () => void
  onSaved: () => Promise<void> | void
  onError: (message: string) => void
  onOperation?: (operationID: string, active: boolean) => void
}) {
  const [name, setName] = useState(item.name)
  const [color, setColor] = useState(item.color || '#10b981')
  const isDefault = 'is_default' in item && Boolean(item.is_default)
  const [icon, setIcon] = useState(item.icon || (type === 'folder' ? 'folder' : isDefault ? 'inbox' : 'list'))
  const [saving, setSaving] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && !saving && !document.querySelector('[data-task-destructive-dialog], [data-task-picker-backdrop]') && onClose()
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose, saving])
  if (typeof document === 'undefined') return null
  const save = async () => {
    if (!name.trim()) return
    const operationID = crypto.randomUUID()
    setSaving(true)
    onOperation?.(operationID, true)
    try {
      const path = type === 'folder' ? `/api/tasks/folders/${item.id}` : `/api/tasks/lists/${item.id}/structure`
      const result = await apiPut(path, { name: name.trim(), color, icon, operation_id: operationID })
      if (!result.success) {
        onError(result.error || `No se pudo actualizar ${type === 'folder' ? 'la carpeta' : 'la lista'}.`)
        return
      }
      await onSaved()
      onClose()
    } catch {
      onError(`No se pudo actualizar ${type === 'folder' ? 'la carpeta' : 'la lista'}.`)
    } finally {
      onOperation?.(operationID, false)
      setSaving(false)
    }
  }
  const archive = async () => {
    if (isDefault || item.task_count > 0 || saving) return
    setArchiveError('')
    setSaving(true)
    try {
      const path = type === 'folder' ? `/api/tasks/folders/${item.id}` : `/api/tasks/lists/${item.id}`
      const operationID = crypto.randomUUID()
      const result = await apiDelete(path, { confirmation_name: item.name, operation_id: operationID })
      if (!result.success) { setArchiveError(result.error || 'No se pudo mover a Papelera.'); return }
      setArchiveOpen(false); await onSaved(); onClose()
    } catch { setArchiveError('No se pudo mover a Papelera. Reintenta.') } finally { setSaving(false) }
  }
  return createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.dialog }} role="presentation" onMouseDown={event => event.target === event.currentTarget && !saving && onClose()}>
    <section role="dialog" aria-modal="true" aria-labelledby="task-appearance-title" className="w-full max-w-lg overflow-hidden rounded-3xl border border-white/70 bg-white shadow-2xl">
      <header className="flex items-center border-b border-slate-100 px-5 py-4"><div className="flex h-10 w-10 items-center justify-center rounded-2xl" style={{ color, backgroundColor: `${color}18` }}><TaskContainerIcon value={icon} className="h-5 w-5" /></div><div className="ml-3 min-w-0 flex-1"><h2 id="task-appearance-title" className="text-base font-black text-slate-900">Personalizar {type === 'folder' ? 'carpeta' : 'lista'}</h2><p className="text-xs text-slate-400">Nombre, color e icono visibles en todo Clarin Work.</p></div><button type="button" disabled={saving} onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></header>
      <div className="space-y-5 p-5">
        <label className="block text-xs font-bold text-slate-600">Nombre<input autoFocus value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save() }} maxLength={120} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label>
        <div><p className="mb-1.5 text-xs font-bold text-slate-600">Color</p><TaskColorPicker value={color} onChange={setColor} label={`Color de ${type === 'folder' ? 'carpeta' : 'lista'}`} disabled={saving} /></div>
        <div><p className="mb-1.5 text-xs font-bold text-slate-600">Icono</p><TaskIconPicker value={icon} onChange={setIcon} label={`Icono de ${type === 'folder' ? 'carpeta' : 'lista'}`} disabled={saving} /></div>
      </div>
      <footer className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-4">{!isDefault && <button type="button" disabled={saving || item.task_count > 0} title={item.task_count > 0 ? 'Mueve o envía primero las tareas activas a Papelera' : 'Mover a Papelera'} onClick={() => { setArchiveError(''); setArchiveOpen(true) }} className="mr-auto rounded-xl px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-30">Mover a Papelera</button>}<button type="button" disabled={saving} onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-white">Cancelar</button><button type="button" disabled={saving || !name.trim()} onClick={() => void save()} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-lg disabled:opacity-40">{saving ? 'Guardando…' : 'Guardar cambios'}</button></footer>
    </section>
    <TaskDestructiveConfirmDialog open={archiveOpen} title={`Mover ${type === 'folder' ? 'carpeta' : 'lista'} a Papelera`} description={type === 'folder' ? 'La carpeta y sus listas activas se archivarán juntas. Podrás restaurarlas desde Papelera.' : 'La lista conservará su ubicación original y podrá restaurarse desde Papelera.'} actionLabel="Mover a Papelera" confirmationName={item.name} busy={saving} error={archiveError} onClose={() => { if (!saving) { setArchiveOpen(false); setArchiveError('') } }} onConfirm={() => { void archive() }} />
  </div>, document.body)
}
