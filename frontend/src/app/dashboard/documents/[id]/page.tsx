"use client"

/**
 * Document Template Editor — Fabric.js v6
 * Full-featured design editor with snap guides, zoom to 1000%, dynamic fields, QR codes.
 */

import { useState, useEffect, useRef, useCallback, useReducer } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, Save, Download, ZoomIn, ZoomOut, Undo2, Redo2, Type, Square, Circle,
  Image as ImageIcon, Minus, MousePointer, Trash2, Copy, Layers, Eye, EyeOff,
  Lock, Unlock, ChevronDown, AlignLeft, AlignCenter, AlignRight, Bold, Italic, Underline,
  FileDown, ImagePlus, Grid3X3, Hand,
  AlignStartVertical, AlignEndVertical, AlignCenterVertical,
  AlignStartHorizontal, AlignEndHorizontal, AlignCenterHorizontal,
  Ruler, FlipVertical2, Group, Ungroup, Triangle, Table2,
  Paintbrush, ClipboardPaste,
} from 'lucide-react'
import { api, apiUpload } from '@/lib/api'
import type { DocumentTemplate } from '@/types/document'

// Lazy import fabric types — only on client
import type {
  Canvas as FabricCanvasType,
  FabricObject,
} from 'fabric'

import type { CanvasHistory as CanvasHistoryType } from '@/lib/fabric/history'
import type { SnapGuide, DistanceLabel, ExportOptions } from '@/lib/fabric'
import { formatFieldValue, DATE_PRESETS, DEFAULT_FIELD_FORMAT, type FieldFormat, type FieldFormatType, type TextTransform } from '@/lib/dynamicFieldFormat'
import DynamicFieldsPicker from '@/components/DynamicFieldsPicker'

// ─── Page Component ───────────────────────────────────────────────────────────

export default function DocumentEditorPage() {
  const params = useParams()
  const router = useRouter()
  const templateId = params.id as string

  // ─── State ────────────────────────────────────────────────────────────
  const [template, setTemplate] = useState<DocumentTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [zoom, setZoom] = useState(1)
  const [background, setBackground] = useState<{ color: string; imageUrl?: string }>({ color: '#ffffff' })
  const [selectedObjects, setSelectedObjects] = useState<FabricObject[]>([])
  const [activeTool, setActiveTool] = useState<string>('select')
  const [showGrid, setShowGrid] = useState(false)
  const [gridSize, setGridSize] = useState(20)
  const [showRulers, setShowRulers] = useState(true)
  const [showMargins, setShowMargins] = useState(false)
  const [marginSize, setMarginSize] = useState(10)
  const [pasteboardColor, setPasteboardColorState] = useState('#61636b')
  const [pageWidth, setPageWidth] = useState(210)
  const [pageHeight, setPageHeight] = useState(297)
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
  const [distanceLabels, setDistanceLabels] = useState<DistanceLabel[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [showDynamicFields, setShowDynamicFields] = useState(false)
  const [rightTab, setRightTab] = useState<'properties' | 'layers'>('properties')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [allObjects, setAllObjects] = useState<FabricObject[]>([])
  const [editingText, setEditingText] = useState(false)
  const editingTextRef = useRef(false)
  const [editingTextObj, setEditingTextObj] = useState<FabricObject | null>(null)
  const [editingSelVersion, setEditingSelVersion] = useState(0)
  const [fabricReady, setFabricReady] = useState(false)
  const [drawingTool, setDrawingTool] = useState<'rect' | 'ellipse' | 'triangle' | 'line' | null>(null)
  const [userGuides, setUserGuides] = useState<{ id: string; orientation: 'h' | 'v'; position: number }[]>([])
  const [draggingGuide, setDraggingGuide] = useState<{ orientation: 'h' | 'v'; position: number } | null>(null)
  const [showTablePicker, setShowTablePicker] = useState(false)
  const [tableHover, setTableHover] = useState<{ rows: number; cols: number }>({ rows: 0, cols: 0 })
  const [, forceRender] = useReducer((x: number) => x + 1, 0)

  // ─── Refs ─────────────────────────────────────────────────────────────
  const canvasElRef = useRef<HTMLCanvasElement>(null)
  const fabricRef = useRef<FabricCanvasType | null>(null)
  const historyRef = useRef<CanvasHistoryType | null>(null)
  const clipboardRef = useRef<FabricObject[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const replaceImageInputRef = useRef<HTMLInputElement>(null)
  const bgFileInputRef = useRef<HTMLInputElement>(null)
  const tableButtonRef = useRef<HTMLButtonElement>(null)
  const dynamicFieldsBtnRef = useRef<HTMLButtonElement>(null)
  const spaceHeldRef = useRef(false)
  const drawingRef = useRef<{ startX: number; startY: number; obj: FabricObject } | null>(null)
  const pendingDynamicRef = useRef<{ key: string; label: string; template: string } | null>(null)
  const userGuidesRef = useRef(userGuides)
  userGuidesRef.current = userGuides

  // Copy/paste dynamic-field format (Excel-like "paintbrush")
  const copiedFieldFormatRef = useRef<import('@/lib/dynamicFieldFormat').FieldFormat | null>(null)

  // Reference to dynamically imported fabric modules
  const fabricModRef = useRef<typeof import('@/lib/fabric') | null>(null)
  const fabricCoreRef = useRef<typeof import('fabric') | null>(null)

  // ─── Custom fields (from account) ─────────────────────────────────────
  const [customFields, setCustomFields] = useState<Array<{ id: string; name: string; slug: string }>>([])

  // ─── Derived ──────────────────────────────────────────────────────────
  const selectedObj = selectedObjects.length === 1 ? selectedObjects[0] : null
  const hasSelection = selectedObjects.length > 0

  // ─── Load template ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ template: DocumentTemplate }>(`/api/document-templates/${templateId}`)
        if (res.success && res.data?.template) {
          setTemplate(res.data.template)
          setTemplateName(res.data.template.name)
          setPageWidth(res.data.template.page_width)
          setPageHeight(res.data.template.page_height)
        }
      } catch (err) {
        console.error('Failed to load template:', err)
      } finally {
        setLoading(false)
      }
    })()
  }, [templateId])

  // ─── Load custom field definitions for the account ───────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ fields: Array<{ id: string; name: string; slug: string }> }>('/api/custom-fields/')
        if (res.success && Array.isArray(res.data?.fields)) {
          setCustomFields(res.data.fields)
        }
      } catch (err) {
        console.error('Failed to load custom fields:', err)
      }
    })()
  }, [])

  // ─── Suppress native context menu inside canvas area (capture phase) ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const h = (e: Event) => { e.preventDefault(); e.stopPropagation() }
    el.addEventListener('contextmenu', h, true)
    return () => el.removeEventListener('contextmenu', h, true)
  }, [])

  // ─── Forward wheel events from user-guide overlays to the Fabric canvas ──
  // The guide <div> overlays sit above the Fabric canvas and steal wheel events
  // when the cursor happens to be on them (Ctrl+Wheel then zooms the BROWSER
  // page instead of the canvas). We intercept those events in capture phase and
  // proxy them to the canvas zoom/pan helpers.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null
      if (!target || !target.closest('[data-user-guide]')) return
      const canvas = fabricRef.current
      if (!canvas || !fabricModRef.current) return
      e.preventDefault()
      e.stopPropagation()
      if (e.ctrlKey || e.metaKey) {
        fabricModRef.current.applyWheelZoom(canvas, e.clientX, e.clientY, e.deltaY, setZoom)
      } else {
        fabricModRef.current.applyWheelPan(canvas, e.deltaX, e.deltaY, e.shiftKey)
      }
    }
    el.addEventListener('wheel', handler, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', handler, { capture: true } as any)
  }, [])

  // ─── Initialize Fabric canvas ─────────────────────────────────────────
  useEffect(() => {
    if (!template || !canvasElRef.current || !containerRef.current) return

    let disposed = false

    const initCanvas = async () => {
      // Dynamic import fabric (browser only)
      const fabricMod = await import('@/lib/fabric')
      const fabricCore = await import('fabric')
      if (disposed) return

      fabricModRef.current = fabricMod
      fabricCoreRef.current = fabricCore

      await fabricMod.ensureFontsLoaded()
      if (disposed) return

      // Restore saved pasteboard color
      const savedPasteboard = localStorage.getItem('editor-pasteboard-color')
      if (savedPasteboard) setPasteboardColorState(savedPasteboard)

      const canvas = fabricMod.createEditorCanvas({
        canvasEl: canvasElRef.current!,
        containerEl: containerRef.current!,
        pageWidth: pageWidth,
        pageHeight: pageHeight,
        pasteboardColor: savedPasteboard || '#61636b',
        onZoomChange: (z) => setZoom(z),
        onSelectionChange: (objs) => setSelectedObjects(objs),
        onObjectModified: () => {
          historyRef.current?.save()
          updateHistoryState()
          refreshObjectList()
        },
        onSnapGuides: (guides) => setSnapGuides(guides),
        onDistanceLabels: (labels) => setDistanceLabels(labels),
        getUserGuides: () => userGuidesRef.current,
        onPan: forceRender,
      })

      if (disposed) { canvas.dispose(); return }
      fabricRef.current = canvas

      // Grid drawing via afterRender (draw on lower/main canvas context)
      canvas.on('after:render', ({ ctx }: any) => {
        const gridEl = document.getElementById('__showGrid')
        if (!gridEl || gridEl.dataset.show !== 'true') return
        if (!ctx) return
        const vpt = canvas.viewportTransform!
        fabricMod.drawGridDots(
          ctx,
          canvas.getElement().width,
          canvas.getElement().height,
          parseInt(gridEl.dataset.size || '20'),
          canvas.getZoom(),
          vpt[4], vpt[5],
          canvas.__pageWidth,
          canvas.__pageHeight,
        )
      })

      // Right-click context menu
      canvas.on('mouse:down', (opt) => {
        const e = opt.e as MouseEvent
        if (e.button === 2) {
          e.preventDefault()
          setContextMenu({ x: e.clientX, y: e.clientY })
        } else {
          setContextMenu(null)
        }
      })

      // Text editing state
      canvas.on('text:editing:entered', (e: any) => {
        editingTextRef.current = true
        setEditingText(true)
        setEditingTextObj(e?.target ?? null)
      })
      canvas.on('text:editing:exited', () => {
        editingTextRef.current = false
        setEditingText(false)
        setEditingTextObj(null)
        historyRef.current?.save()
        updateHistoryState()
      })
      // Track cursor/selection changes inside an IText for toolbar active state.
      canvas.on('text:selection:changed', () => setEditingSelVersion(v => v + 1))
      canvas.on('text:changed', () => setEditingSelVersion(v => v + 1))

      // Load template data
      try {
        if (template.canvas_json && Object.keys(template.canvas_json).length > 0) {
          const bg = await fabricMod.loadTemplateToCanvas(canvas, template.canvas_json, pageWidth, pageHeight)
          if (disposed) return
          setBackground(bg)
          // Set page rect background color instead of canvas backgroundColor
          if (canvas.__pageRect) {
            canvas.__pageRect.set('fill', bg.color || '#ffffff')
          }
          fabricMod.ensurePageAtBottom(canvas)
          canvas.renderAll()

          // Restore persisted editor settings (margins, grid, rulers, pasteboard)
          const es = (template.canvas_json as any).editorSettings
          if (es && typeof es === 'object') {
            if (typeof es.showMargins === 'boolean') setShowMargins(es.showMargins)
            if (typeof es.marginSize === 'number') setMarginSize(es.marginSize)
            if (typeof es.showGrid === 'boolean') setShowGrid(es.showGrid)
            if (typeof es.gridSize === 'number') setGridSize(es.gridSize)
            if (typeof es.showRulers === 'boolean') setShowRulers(es.showRulers)
            if (typeof es.pasteboardColor === 'string') {
              setPasteboardColorState(es.pasteboardColor)
              canvas.backgroundColor = es.pasteboardColor
              canvas.requestRenderAll()
            }
          }
        }
      } catch (err) {
        console.error('[EDITOR] Failed to load template:', err)
      }

      // Set up history
      const { CanvasHistory } = fabricMod
      const history = new CanvasHistory(canvas)
      history.init()
      historyRef.current = history

      // Fit canvas in viewport
      setTimeout(() => {
        if (disposed) return
        const z = fabricMod.zoomToFit(canvas, 60)
        setZoom(z)
      }, 100)

      setFabricReady(true)
      refreshObjectList()
      updateHistoryState()
    }

    initCanvas()

    return () => {
      disposed = true
      // Clean up middle mouse event listeners before dispose
      if (fabricRef.current) {
        ;(fabricRef.current as any).__cleanupMiddleMouse?.()
      }
      fabricRef.current?.dispose()
      fabricRef.current = null
      setFabricReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template])

  // ─── Resize handler — keep canvas filling container ──────────────────
  useEffect(() => {
    const container = containerRef.current
    const canvas = fabricRef.current
    if (!container || !canvas || !fabricReady) return

    let resizeTimer: ReturnType<typeof setTimeout>
    const handleResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(async () => {
        const fabricMod = fabricModRef.current
        if (!fabricMod || !fabricRef.current) return
        fabricMod.resizeCanvas(fabricRef.current, container)
        const z = fabricMod.zoomToFit(fabricRef.current, 60)
        setZoom(z)
      }, 100)
    }

    const observer = new ResizeObserver(handleResize)
    observer.observe(container)
    return () => {
      clearTimeout(resizeTimer)
      observer.disconnect()
    }
  }, [fabricReady])

  // ─── Space key / Ctrl key / Hand tool for pan mode ────────────────────────────────
  useEffect(() => {
    const downHandler = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !editingText) {
        e.preventDefault()
        spaceHeldRef.current = true
        if (fabricRef.current) {
          fabricRef.current.setCursor('grab')
          fabricRef.current.selection = false
          fabricRef.current.__panActive = true
        }
      }
      if (e.key === 'Control' && !editingText) {
        spaceHeldRef.current = true
        if (fabricRef.current) {
          fabricRef.current.setCursor('grab')
          fabricRef.current.selection = false
          fabricRef.current.__panActive = true
        }
      }
    }
    const upHandler = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false
        if (fabricRef.current && activeTool !== 'hand') {
          fabricRef.current.setCursor('default')
          fabricRef.current.selection = true
          fabricRef.current.__panActive = false
        }
      }
      if (e.key === 'Control') {
        spaceHeldRef.current = false
        if (fabricRef.current && activeTool !== 'hand') {
          fabricRef.current.setCursor('default')
          fabricRef.current.selection = true
          fabricRef.current.__panActive = false
        }
      }
    }
    const mouseDown = (e: MouseEvent) => {
      if (spaceHeldRef.current || activeTool === 'hand') {
        (e as any).__spacePan = true
      }
    }
    document.addEventListener('keydown', downHandler)
    document.addEventListener('keyup', upHandler)
    document.addEventListener('mousedown', mouseDown, true)

    // If hand tool is active, set grab cursor permanently
    if (activeTool === 'hand' && fabricRef.current) {
      fabricRef.current.setCursor('grab')
      fabricRef.current.defaultCursor = 'grab'
      fabricRef.current.selection = false
      fabricRef.current.__panActive = true
    }

    return () => {
      document.removeEventListener('keydown', downHandler)
      document.removeEventListener('keyup', upHandler)
      document.removeEventListener('mousedown', mouseDown, true)
      if (activeTool === 'hand' && fabricRef.current) {
        fabricRef.current.setCursor('default')
        fabricRef.current.defaultCursor = 'default'
        fabricRef.current.selection = true
        fabricRef.current.__panActive = false
      }
    }
  }, [editingText, activeTool])

  // ─── Drag-to-create shapes ────────────────────────────────────────────
  useEffect(() => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    if (!canvas || !fc || !drawingTool) return

    canvas.selection = false
    canvas.skipTargetFind = true
    canvas.setCursor('crosshair')
    canvas.defaultCursor = 'crosshair'

    const onMouseDown = (opt: any) => {
      const e = opt.e as MouseEvent
      if (e.button !== 0 || spaceHeldRef.current) return
      const point = canvas.getScenePoint(e)
      let obj: FabricObject

      switch (drawingTool) {
        case 'rect':
          obj = new fc.Rect({
            left: point.x, top: point.y, width: 1, height: 1,
            fill: '#e2e8f0', stroke: '#94a3b8', strokeWidth: 1, rx: 4, ry: 4,
            originX: 'left', originY: 'top',
          })
          break
        case 'ellipse':
          obj = new fc.Ellipse({
            left: point.x, top: point.y, rx: 0.5, ry: 0.5,
            fill: '#dbeafe', stroke: '#60a5fa', strokeWidth: 1,
            originX: 'left', originY: 'top',
          })
          break
        case 'triangle':
          obj = new fc.Triangle({
            left: point.x, top: point.y, width: 1, height: 1,
            fill: '#fde68a', stroke: '#f59e0b', strokeWidth: 1,
            originX: 'left', originY: 'top',
          })
          break
        case 'line':
          obj = new fc.Line([point.x, point.y, point.x, point.y], {
            stroke: '#000000', strokeWidth: 2,
            originX: 'left', originY: 'top',
          })
          break
        default:
          return
      }

      canvas.add(obj)
      drawingRef.current = { startX: point.x, startY: point.y, obj }
      canvas.requestRenderAll()
    }

    const onMouseMove = (opt: any) => {
      const drawing = drawingRef.current
      if (!drawing) return
      const e = opt.e as MouseEvent
      const point = canvas.getScenePoint(e)
      const { startX, startY, obj } = drawing
      const w = Math.abs(point.x - startX)
      const h = Math.abs(point.y - startY)
      const left = Math.min(point.x, startX)
      const top = Math.min(point.y, startY)

      if (drawingTool === 'line') {
        (obj as any).set({ x1: startX, y1: startY, x2: point.x, y2: point.y })
        obj.setCoords()
      } else if (drawingTool === 'ellipse') {
        obj.set({ left, top, rx: w / 2, ry: h / 2 } as any)
        obj.setCoords()
      } else {
        obj.set({ left, top, width: w, height: h })
        obj.setCoords()
      }
      canvas.requestRenderAll()
    }

    const onMouseUp = () => {
      const drawing = drawingRef.current
      if (!drawing) return
      const { obj } = drawing
      drawingRef.current = null

      // If too small, use default size
      const bounds = obj.getBoundingRect()
      if (bounds.width < 5 && bounds.height < 5) {
        if (drawingTool === 'ellipse') {
          obj.set({ rx: 60, ry: 60 } as any)
        } else if (drawingTool === 'line') {
          (obj as any).set({ x2: (obj as any).x1 + 200 })
          obj.setCoords()
        } else {
          obj.set({ width: 150, height: 100 })
        }
      }

      obj.setCoords()
      canvas.setActiveObject(obj)
      canvas.requestRenderAll()
      historyRef.current?.save()
      refreshObjectList()

      // Reset to select
      setDrawingTool(null)
      setActiveTool('select')
    }

    canvas.on('mouse:down', onMouseDown)
    canvas.on('mouse:move', onMouseMove)
    canvas.on('mouse:up', onMouseUp)

    return () => {
      canvas.off('mouse:down', onMouseDown)
      canvas.off('mouse:move', onMouseMove)
      canvas.off('mouse:up', onMouseUp)
      canvas.selection = true
      canvas.skipTargetFind = false
      canvas.setCursor('default')
      canvas.defaultCursor = 'default'
      drawingRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingTool])

  // ─── Keyboard shortcuts ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = fabricRef.current
    const history = historyRef.current
    const fabricMod = fabricModRef.current
    const fabricCore = fabricCoreRef.current
    if (!canvas || !history || !fabricMod || !fabricCore) return

    const cleanup = fabricMod.setupShortcuts(canvas, history, {
      onSave: () => handleSave(),
      onDelete: () => deleteSelected(),
      onDuplicate: () => duplicateSelected(),
      onSelectAll: () => {
        const objs = canvas.getObjects().filter(o => o.selectable && o.visible)
        if (objs.length === 0) return
        canvas.discardActiveObject()
        const sel = new fabricCore.ActiveSelection(objs, { canvas })
        canvas.setActiveObject(sel)
        canvas.renderAll()
      },
      onGroup: () => groupSelected(),
      onUngroup: () => ungroupSelected(),
      onCopy: () => copySelected(),
      onPaste: () => pasteClipboard(),
      onDeselect: () => {
        canvas.discardActiveObject()
        canvas.renderAll()
        setContextMenu(null)
      },
      isEditingText: () => editingTextRef.current,
      onToolSelect: () => { setActiveTool('select'); setDrawingTool(null) },
      onToolText: () => addTextElement(),
      onToolRect: () => addRectElement(),
      onToolCircle: () => addCircleElement(),
      onToolLine: () => addLineElement(),
    })

    return () => document.removeEventListener('keydown', cleanup)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fabricReady])

  // ─── Helper functions ─────────────────────────────────────────────────

  const updateHistoryState = useCallback(() => {
    setCanUndo(historyRef.current?.canUndo ?? false)
    setCanRedo(historyRef.current?.canRedo ?? false)
  }, [])

  const refreshObjectList = useCallback(() => {
    if (!fabricRef.current) return
    setAllObjects([...fabricRef.current.getObjects().filter((o: any) => !o.__isPage)])
  }, [])

  const pushHistory = useCallback(() => {
    historyRef.current?.save()
    updateHistoryState()
    refreshObjectList()
  }, [updateHistoryState, refreshObjectList])

  // ─── Save ─────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const canvas = fabricRef.current
    const fabricMod = fabricModRef.current
    if (!canvas || !template || !fabricMod) return
    setSaving(true)
    try {
      // Generate thumbnail (only the page area)
      canvas.discardActiveObject()
      canvas.renderAll()
      const origVpt = [...canvas.viewportTransform!]
      canvas.setViewportTransform([1, 0, 0, 1, 0, 0] as any)
      const pageW = (canvas as any).__pageWidth || canvas.getWidth()
      const pageH = (canvas as any).__pageHeight || canvas.getHeight()
      const thumbDataUrl = canvas.toDataURL({
        format: 'jpeg', quality: 0.7, multiplier: 0.3,
        left: 0, top: 0, width: pageW, height: pageH,
      })
      canvas.setViewportTransform(origVpt as any)
      canvas.requestRenderAll()

      let thumbnailUrl = template.thumbnail_url
      try {
        const thumbBlob = await fetch(thumbDataUrl).then(r => r.blob())
        const formData = new FormData()
        formData.append('file', thumbBlob, 'thumbnail.jpg')
        formData.append('folder', 'document-thumbnails')
        const uploadRes = await apiUpload('/api/media/upload', formData)
        if (uploadRes.success && uploadRes.data) {
          const d = uploadRes.data as any
          thumbnailUrl = d.proxy_url || d.public_url
        }
      } catch (err) {
        console.warn('[EDITOR] Failed to upload thumbnail:', err)
      }

      const canvasJson = fabricMod.canvasToTemplateJson(canvas, background)
      const fieldsUsed = fabricMod.extractFieldsUsed(canvas)

      // Persist editor settings inside canvas_json so they survive reloads
      ;(canvasJson as any).editorSettings = {
        showMargins,
        marginSize,
        showGrid,
        gridSize,
        showRulers,
        pasteboardColor,
      }

      await api(`/api/document-templates/${template.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: templateName,
          description: template.description,
          canvas_json: canvasJson,
          thumbnail_url: thumbnailUrl,
          page_width: pageWidth,
          page_height: pageHeight,
          page_orientation: template.page_orientation,
          fields_used: fieldsUsed,
        }),
      })
    } catch (err) {
      console.error('Save error:', err)
    } finally {
      setSaving(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, templateName, background, pageWidth, pageHeight, showMargins, marginSize, showGrid, gridSize, showRulers, pasteboardColor])

  // ─── Export ───────────────────────────────────────────────────────────
  const handleExport = useCallback(async (format: 'png' | 'pdf' | 'jpeg') => {
    const canvas = fabricRef.current
    const fabricMod = fabricModRef.current
    if (!canvas || !fabricMod) return
    setExporting(true)
    setShowExportMenu(false)
    try {
      canvas.discardActiveObject()
      canvas.renderAll()
      // Quality tiers: PDF=4x (~200 DPI), PNG=6x (~300 DPI), JPEG=4x (~200 DPI, quality 0.92)
      const multiplier = format === 'pdf' ? 4 : format === 'jpeg' ? 4 : 6
      const quality = format === 'jpeg' ? 0.92 : undefined
      const blob = await fabricMod.exportCanvasToBlob(canvas, { format, multiplier, quality })
      const ext = format === 'jpeg' ? 'jpg' : format
      fabricMod.downloadBlob(blob, `${templateName || 'documento'}.${ext}`)
    } catch (err) {
      console.error('Export error:', err)
    } finally {
      setExporting(false)
    }
  }, [templateName])

  // ─── Delete template ──────────────────────────────────────────────────
  const handleDeleteTemplate = useCallback(async () => {
    if (!template) return
    if (!confirm(`¿Eliminar la plantilla "${template.name}"? Esta acción no se puede deshacer.`)) return
    try {
      await api(`/api/document-templates/${template.id}`, { method: 'DELETE' })
      router.push('/dashboard/documents')
    } catch (err) {
      console.error('Delete error:', err)
    }
  }, [template, router])

  // ─── Add element functions ────────────────────────────────────────────
  const addTextElement = useCallback(() => {
    setDrawingTool(null)
    setActiveTool('text')
  }, [])

  // ─── Text tool: click-to-place or drag-to-define area ────────────────
  useEffect(() => {
    const canvas = fabricRef.current
    const mod = fabricModRef.current
    if (!canvas || !mod || activeTool !== 'text') return

    canvas.selection = false
    canvas.skipTargetFind = true
    canvas.setCursor('crosshair')
    canvas.defaultCursor = 'crosshair'
    canvas.discardActiveObject()
    canvas.renderAll()

    let startPoint: { x: number; y: number } | null = null
    let previewRect: FabricObject | null = null

    const onMouseDown = (opt: any) => {
      const e = opt.e as MouseEvent
      if (e.button !== 0 || spaceHeldRef.current) return
      startPoint = canvas.getScenePoint(e)

      // Create a dashed preview rectangle
      const fc = fabricCoreRef.current
      if (fc) {
        previewRect = new fc.Rect({
          left: startPoint.x, top: startPoint.y, width: 1, height: 1,
          fill: 'rgba(5,150,105,0.05)', stroke: '#059669', strokeWidth: 1,
          strokeDashArray: [4, 4], selectable: false, evented: false,
          originX: 'left', originY: 'top',
        })
        canvas.add(previewRect)
        canvas.requestRenderAll()
      }
    }

    const onMouseMove = (opt: any) => {
      if (!startPoint || !previewRect) return
      const e = opt.e as MouseEvent
      const point = canvas.getScenePoint(e)
      const w = Math.abs(point.x - startPoint.x)
      const h = Math.abs(point.y - startPoint.y)
      const left = Math.min(point.x, startPoint.x)
      const top = Math.min(point.y, startPoint.y)
      previewRect.set({ left, top, width: w, height: h })
      previewRect.setCoords()
      canvas.requestRenderAll()
    }

    const onMouseUp = (opt: any) => {
      if (!startPoint) return
      const e = opt.e as MouseEvent
      const endPoint = canvas.getScenePoint(e)

      // Remove preview rect
      if (previewRect) {
        canvas.remove(previewRect)
        previewRect = null
      }

      // Calculate text area
      const w = Math.abs(endPoint.x - startPoint.x)
      const h = Math.abs(endPoint.y - startPoint.y)
      const left = Math.min(endPoint.x, startPoint.x)
      const top = Math.min(endPoint.y, startPoint.y)
      const isDrag = w > 5 || h > 5

      const textLeft = isDrag ? left : startPoint.x
      const textTop = isDrag ? top : startPoint.y
      const textWidth = isDrag ? Math.max(w, 40) : 200

      startPoint = null

      // Check if this is a dynamic field placement
      const dynField = pendingDynamicRef.current
      pendingDynamicRef.current = null

      const text = new mod.DynamicText(dynField ? dynField.template : '', {
        left: textLeft, top: textTop, width: textWidth,
        fontSize: 11, fontFamily: 'Arial',
        fill: '#000000', elementType: 'text',
        elementName: dynField ? dynField.label : 'Texto',
        splitByGrapheme: true,
        ...(dynField ? { isDynamic: true, fieldName: dynField.key } : {}),
      })
      canvas.add(text)
      canvas.setActiveObject(text)

      // Restore canvas state before entering edit mode
      canvas.selection = true
      canvas.skipTargetFind = false
      canvas.setCursor('default')
      canvas.defaultCursor = 'default'

      // Enter text editing mode
      text.enterEditing()
      canvas.renderAll()
      historyRef.current?.save()
      refreshObjectList()
      setActiveTool('select')
    }

    canvas.on('mouse:down', onMouseDown)
    canvas.on('mouse:move', onMouseMove)
    canvas.on('mouse:up', onMouseUp)

    return () => {
      canvas.off('mouse:down', onMouseDown)
      canvas.off('mouse:move', onMouseMove)
      canvas.off('mouse:up', onMouseUp)
      if (previewRect) {
        canvas.remove(previewRect)
      }
      pendingDynamicRef.current = null
      canvas.selection = true
      canvas.skipTargetFind = false
      canvas.setCursor('default')
      canvas.defaultCursor = 'default'
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool])

  const addRectElement = useCallback(() => {
    setDrawingTool('rect')
    setActiveTool('rect')
  }, [])

  const addCircleElement = useCallback(() => {
    setDrawingTool('ellipse')
    setActiveTool('circle')
  }, [])

  const addTriangleElement = useCallback(() => {
    setDrawingTool('triangle')
    setActiveTool('triangle')
  }, [])

  const addLineElement = useCallback(() => {
    setDrawingTool('line')
    setActiveTool('line')
  }, [])

  const addDynamicField = useCallback((field: { key: string; label: string; template: string }) => {
    pendingDynamicRef.current = field
    setDrawingTool(null)
    setActiveTool('text')
    setShowDynamicFields(false)
  }, [])

  const addTable = useCallback((rows: number, cols: number) => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    if (!canvas || !fc) return

    const cellW = 80
    const cellH = 30
    const objects: FabricObject[] = []

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Cell border — not interactive inside group, only the textbox is
        const cell = new fc.Rect({
          left: c * cellW,
          top: r * cellH,
          width: cellW,
          height: cellH,
          fill: r === 0 ? '#f1f5f9' : '#ffffff',
          stroke: '#cbd5e1',
          strokeWidth: 1,
          selectable: false,
          evented: false,
        })
        objects.push(cell)

        // Cell text
        const text = new fc.Textbox(r === 0 ? `Col ${c + 1}` : '', {
          left: c * cellW + 4,
          top: r * cellH + 6,
          width: cellW - 8,
          fontSize: 11,
          fontFamily: 'Arial',
          fill: r === 0 ? '#334155' : '#64748b',
          fontWeight: r === 0 ? 'bold' : 'normal',
          splitByGrapheme: true,
        })
        objects.push(text)
      }
    }

    const group = new fc.Group(objects, {
      left: 50,
      top: 50,
      subTargetCheck: true,
    })
    canvas.add(group)
    canvas.setActiveObject(group)
    canvas.renderAll()
    pushHistory()
    setShowTablePicker(false)
    setActiveTool('select')
  }, [pushHistory])

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    if (!canvas || !fc) return
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      console.warn('[EDITOR] File is not an image:', file.type)
      return
    }

    const formData = new FormData()
    formData.append('file', file)
    formData.append('folder', 'document-images')
    apiUpload('/api/media/upload', formData)
      .then(async (res) => {
        if (!res.success || !res.data) return
        const data = res.data as any
        const imageUrl = data.proxy_url || data.public_url
        if (imageUrl) {
          const img = await fc.FabricImage.fromURL(imageUrl, { crossOrigin: 'anonymous' })
          const maxW = canvas.getWidth() * 0.6
          const maxH = canvas.getHeight() * 0.6
          const sX = maxW / (img.width || 1)
          const sY = maxH / (img.height || 1)
          const scale = Math.min(sX, sY, 1)
          img.set({ left: 50, top: 50, scaleX: scale, scaleY: scale })
          canvas.add(img)
          canvas.setActiveObject(img)
          canvas.renderAll()
          pushHistory()
        }
      })
      .catch((err: Error) => console.error('[EDITOR] Image upload failed:', err))
    e.target.value = ''
    setActiveTool('select')
  }, [pushHistory])

  // ─── Smart image replacement (preserves position / scale / rotation) ─
  // Uploads the file, then swaps the src of the provided FabricImage while
  // keeping its display size/position intact. Scale is re-calibrated so the
  // new image fills the same on-canvas bounding box as the old one.
  const replaceImageOnObject = useCallback(async (targetImg: any, file: File) => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    if (!canvas || !fc || !targetImg) return
    if (!(targetImg instanceof fc.FabricImage)) return
    const formData = new FormData()
    formData.append('file', file)
    formData.append('folder', 'document-images')
    try {
      const res = await apiUpload('/api/media/upload', formData)
      if (!res.success || !res.data) return
      const data = res.data as any
      const imageUrl = data.proxy_url || data.public_url
      if (!imageUrl) return
      // Remember current displayed size to recalibrate scale after setSrc
      const displayW = targetImg.getScaledWidth()
      const displayH = targetImg.getScaledHeight()
      await targetImg.setSrc(imageUrl, { crossOrigin: 'anonymous' })
      // Reset any crop of the previous image
      targetImg.set({
        cropX: 0,
        cropY: 0,
        scaleX: displayW / (targetImg.width || 1),
        scaleY: displayH / (targetImg.height || 1),
      })
      targetImg.setCoords()
      canvas.renderAll()
      pushHistory()
    } catch (err) {
      console.error('[EDITOR] Image replace failed:', err)
    }
  }, [pushHistory])

  const handleReplaceImageInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) { e.target.value = ''; return }
    const canvas = fabricRef.current
    const active = canvas?.getActiveObject() as any
    if (!active) { e.target.value = ''; return }
    replaceImageOnObject(active, file)
    e.target.value = ''
  }, [replaceImageOnObject])

  // ─── Drag-drop image onto canvas (replaces if dropped on FabricImage) ─
  const [dragOverTargetId, setDragOverTargetId] = useState<string | null>(null)

  const getImageObjAtPointer = useCallback((clientX: number, clientY: number) => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    if (!canvas || !fc) return null
    const container = containerRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    const rulerOffset = 20 // matches rulers
    const offsetX = showRulers ? rulerOffset : 0
    const offsetY = showRulers ? rulerOffset : 0
    const ptr = new fc.Point(clientX - rect.left - offsetX, clientY - rect.top - offsetY)
    // Walk objects top-down to find the Image under pointer
    const objs = canvas.getObjects()
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i] as any
      if (o.__isPage || !o.visible) continue
      if (!(o instanceof fc.FabricImage)) continue
      if (o.containsPoint(ptr)) return o
    }
    return null
  }, [showRulers])

  const handleCanvasDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const target = getImageObjAtPointer(e.clientX, e.clientY)
    const id = target ? ((target as any).__id ||= Math.random().toString(36).slice(2)) : null
    if (id !== dragOverTargetId) setDragOverTargetId(id)
  }, [getImageObjAtPointer, dragOverTargetId])

  const handleCanvasDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when leaving the container entirely.
    if (e.currentTarget === e.target) setDragOverTargetId(null)
  }, [])

  const handleCanvasDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return
    e.preventDefault()
    setDragOverTargetId(null)
    const file = e.dataTransfer.files[0]
    if (!file.type.startsWith('image/')) return
    const target = getImageObjAtPointer(e.clientX, e.clientY)
    if (target) {
      await replaceImageOnObject(target, file)
      fabricRef.current?.setActiveObject(target)
      fabricRef.current?.renderAll()
    } else {
      // No image under cursor: add as new image at cursor position
      const fc = fabricCoreRef.current
      const canvas = fabricRef.current
      if (!canvas || !fc) return
      const formData = new FormData()
      formData.append('file', file)
      formData.append('folder', 'document-images')
      try {
        const res = await apiUpload('/api/media/upload', formData)
        if (!res.success || !res.data) return
        const data = res.data as any
        const imageUrl = data.proxy_url || data.public_url
        if (!imageUrl) return
        const img = await fc.FabricImage.fromURL(imageUrl, { crossOrigin: 'anonymous' })
        const pageW = (canvas as any).__pageWidth ?? canvas.getWidth()
        const pageH = (canvas as any).__pageHeight ?? canvas.getHeight()
        const maxW = pageW * 0.6
        const maxH = pageH * 0.6
        const sX = maxW / (img.width || 1)
        const sY = maxH / (img.height || 1)
        const scale = Math.min(sX, sY, 1)
        // Center on page
        const newW = (img.width || 1) * scale
        const newH = (img.height || 1) * scale
        img.set({ left: (pageW - newW) / 2, top: (pageH - newH) / 2, scaleX: scale, scaleY: scale })
        canvas.add(img)
        canvas.setActiveObject(img)
        canvas.renderAll()
        pushHistory()
      } catch (err) {
        console.error('[EDITOR] Drop image upload failed:', err)
      }
    }
  }, [getImageObjAtPointer, replaceImageOnObject, pushHistory])

  const handleBgImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    formData.append('folder', 'document-backgrounds')
    apiUpload('/api/media/upload', formData)
      .then((res) => {
        if (!res.success || !res.data) return
        const data = res.data as any
        const imageUrl = data.proxy_url || data.public_url
        if (imageUrl) setBackground(prev => ({ ...prev, imageUrl }))
      })
      .catch((err: unknown) => console.error('[EDITOR] Background image upload failed:', err))
    e.target.value = ''
  }, [])

  // ─── Object operations ────────────────────────────────────────────────
  const deleteSelected = useCallback(() => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    if (!canvas || !fc) return
    const active = canvas.getActiveObject()
    if (!active) return
    if ((active as any).__isPage) return  // Never delete the page rect
    if (active instanceof fc.ActiveSelection) {
      active.forEachObject(o => {
        if (!(o as any).__isPage) canvas.remove(o)
      })
    } else {
      canvas.remove(active)
    }
    canvas.discardActiveObject()
    canvas.renderAll()
    pushHistory()
  }, [pushHistory])

  const duplicateSelected = useCallback(async () => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    const mod = fabricModRef.current
    if (!canvas || !fc || !mod) return
    const active = canvas.getActiveObject()
    if (!active) return
    const cloned = await active.clone(mod.CUSTOM_PROPS)
    cloned.set({ left: (cloned.left ?? 0) + 15, top: (cloned.top ?? 0) + 15 })
    if (cloned instanceof fc.ActiveSelection) {
      cloned.forEachObject(o => canvas.add(o))
      canvas.setActiveObject(cloned)
    } else {
      canvas.add(cloned)
      canvas.setActiveObject(cloned)
    }
    canvas.renderAll()
    pushHistory()
  }, [pushHistory])

  const copySelected = useCallback(async () => {
    const canvas = fabricRef.current
    const mod = fabricModRef.current
    if (!canvas || !mod) return
    const active = canvas.getActiveObject()
    if (!active) return
    const cloned = await active.clone(mod.CUSTOM_PROPS)
    clipboardRef.current = [cloned]
  }, [])

  const pasteClipboard = useCallback(async () => {
    const canvas = fabricRef.current
    const mod = fabricModRef.current
    if (!canvas || !mod || clipboardRef.current.length === 0) return
    for (const obj of clipboardRef.current) {
      const cloned = await obj.clone(mod.CUSTOM_PROPS)
      cloned.set({ left: (cloned.left ?? 0) + 15, top: (cloned.top ?? 0) + 15 })
      canvas.add(cloned)
      canvas.setActiveObject(cloned)
    }
    canvas.renderAll()
    pushHistory()
  }, [pushHistory])

  const groupSelected = useCallback(() => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    if (!canvas || !fc) return
    const active = canvas.getActiveObject()
    if (!active || !(active instanceof fc.ActiveSelection)) return
    const objects = active.getObjects()
    canvas.discardActiveObject()
    objects.forEach(o => canvas.remove(o))
    const group = new fc.Group(objects)
    canvas.add(group)
    canvas.setActiveObject(group)
    canvas.renderAll()
    pushHistory()
  }, [pushHistory])

  const ungroupSelected = useCallback(() => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    if (!canvas || !fc) return
    const active = canvas.getActiveObject()
    if (!active || !(active instanceof fc.Group)) return
    const objects = active.getObjects().slice()
    canvas.remove(active)
    objects.forEach(o => canvas.add(o))
    const sel = new fc.ActiveSelection(objects, { canvas })
    canvas.setActiveObject(sel)
    canvas.renderAll()
    pushHistory()
  }, [pushHistory])

  const bringForward = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    const active = canvas.getActiveObject()
    if (active) { canvas.bringObjectForward(active); canvas.renderAll(); pushHistory() }
  }, [pushHistory])

  const sendBackward = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    const active = canvas.getActiveObject()
    if (active) { canvas.sendObjectBackwards(active); canvas.renderAll(); pushHistory() }
  }, [pushHistory])

  const bringToFront = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    const active = canvas.getActiveObject()
    if (active) { canvas.bringObjectToFront(active); canvas.renderAll(); pushHistory() }
  }, [pushHistory])

  const sendToBack = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    const active = canvas.getActiveObject()
    if (active) { canvas.sendObjectToBack(active); canvas.renderAll(); pushHistory() }
  }, [pushHistory])

  const toggleLock = useCallback(() => {
    if (!selectedObj) return
    const locked = !selectedObj.lockMovementX
    selectedObj.set({
      lockMovementX: locked, lockMovementY: locked,
      lockScalingX: locked, lockScalingY: locked,
      lockRotation: locked, hasControls: !locked, selectable: true,
    })
    fabricRef.current?.renderAll()
    pushHistory()
  }, [selectedObj, pushHistory])

  // ─── Alignment ────────────────────────────────────────────────────────
  // 1 object  → align against page bounds (Canva-style).
  // 2+ objects → align against the bounding box of the selection group.
  const handleAlign = useCallback((alignment: string) => {
    const canvas = fabricRef.current
    if (!canvas || !hasSelection) return
    const zoom = canvas.getZoom()
    const vpt = canvas.viewportTransform!

    // Helper: get scene-coord bbox of an object accounting for viewport zoom.
    const sceneBounds = (obj: FabricObject) => {
      const b = obj.getBoundingRect()
      return {
        left: (b.left - vpt[4]) / zoom,
        top: (b.top - vpt[5]) / zoom,
        width: b.width / zoom,
        height: b.height / zoom,
      }
    }

    // Given a desired top-left for the bbox, compute the obj.left/top (accounting
    // for the offset between obj.left and bbox.left for rotated/grouped objects).
    const applyPos = (obj: FabricObject, newBboxLeft: number | null, newBboxTop: number | null) => {
      const cur = sceneBounds(obj)
      if (newBboxLeft !== null) {
        const dx = newBboxLeft - cur.left
        obj.set('left', (obj.left ?? 0) + dx)
      }
      if (newBboxTop !== null) {
        const dy = newBboxTop - cur.top
        obj.set('top', (obj.top ?? 0) + dy)
      }
      obj.setCoords()
    }

    if (selectedObjects.length === 1) {
      // Align single object to PAGE bounds (scene units = fabric units).
      const pageW = (canvas as any).__pageWidth ?? canvas.getWidth()
      const pageH = (canvas as any).__pageHeight ?? canvas.getHeight()
      const obj = selectedObjects[0]
      const b = sceneBounds(obj)
      switch (alignment) {
        case 'left':     applyPos(obj, 0, null); break
        case 'center-h': applyPos(obj, (pageW - b.width) / 2, null); break
        case 'right':    applyPos(obj, pageW - b.width, null); break
        case 'top':      applyPos(obj, null, 0); break
        case 'center-v': applyPos(obj, null, (pageH - b.height) / 2); break
        case 'bottom':   applyPos(obj, null, pageH - b.height); break
      }
    } else {
      // 2+ objects: align relative to the selection's bounding box.
      const bounds = selectedObjects.map(o => ({ obj: o, b: sceneBounds(o) }))
      const minLeft = Math.min(...bounds.map(x => x.b.left))
      const maxRight = Math.max(...bounds.map(x => x.b.left + x.b.width))
      const minTop = Math.min(...bounds.map(x => x.b.top))
      const maxBottom = Math.max(...bounds.map(x => x.b.top + x.b.height))
      const centerX = (minLeft + maxRight) / 2
      const centerY = (minTop + maxBottom) / 2
      for (const { obj, b } of bounds) {
        switch (alignment) {
          case 'left':     applyPos(obj, minLeft, null); break
          case 'center-h': applyPos(obj, centerX - b.width / 2, null); break
          case 'right':    applyPos(obj, maxRight - b.width, null); break
          case 'top':      applyPos(obj, null, minTop); break
          case 'center-v': applyPos(obj, null, centerY - b.height / 2); break
          case 'bottom':   applyPos(obj, null, maxBottom - b.height); break
        }
      }
    }

    canvas.renderAll()
    pushHistory()
  }, [hasSelection, selectedObjects, pushHistory])

  // ─── Property update helper ───────────────────────────────────────────
  const updateProp = useCallback((prop: string, value: any) => {
    const canvas = fabricRef.current
    if (!canvas || !selectedObj) return
    selectedObj.set(prop as keyof FabricObject, value)
    selectedObj.setCoords()
    canvas.renderAll()
    pushHistory()
  }, [selectedObj, pushHistory])

  // ─── Background color ─────────────────────────────────────────────────
  const handleBgColorChange = useCallback((color: string) => {
    setBackground(prev => ({ ...prev, color }))
    if (fabricRef.current) {
      // Set color on the page rect, not canvas background
      const pageRect = (fabricRef.current as any).__pageRect
      if (pageRect) {
        pageRect.set('fill', color)
      }
      fabricRef.current.renderAll()
    }
  }, [])

  const handlePasteboardColorChange = useCallback((color: string) => {
    setPasteboardColorState(color)
    localStorage.setItem('editor-pasteboard-color', color)
    if (fabricRef.current) {
      fabricRef.current.backgroundColor = color
      fabricRef.current.requestRenderAll()
    }
  }, [])

  // ─── Re-establish page rect after history restore ──────────────────
  const restorePageRect = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    // Find the page rect in restored objects
    const pageObj = canvas.getObjects().find((o: any) => o.__isPage)
    if (pageObj) {
      (canvas as any).__pageRect = pageObj
      canvas.sendObjectToBack(pageObj)
    }
  }, [])

  // ─── Undo / Redo ──────────────────────────────────────────────────────
  const handleUndo = useCallback(async () => {
    await historyRef.current?.undo()
    restorePageRect()
    updateHistoryState()
    refreshObjectList()
    fabricRef.current?.renderAll()
  }, [updateHistoryState, refreshObjectList, restorePageRect])

  const handleRedo = useCallback(async () => {
    await historyRef.current?.redo()
    restorePageRect()
    updateHistoryState()
    refreshObjectList()
    fabricRef.current?.renderAll()
  }, [updateHistoryState, refreshObjectList, restorePageRect])

  // ─── Zoom handlers ────────────────────────────────────────────────────
  const handleZoomIn = useCallback(() => {
    const mod = fabricModRef.current
    if (!fabricRef.current || !mod) return
    const z = mod.zoomIn(fabricRef.current, mod.ZOOM_BTN_STEP)
    setZoom(z)
  }, [])

  const handleZoomOut = useCallback(() => {
    const mod = fabricModRef.current
    if (!fabricRef.current || !mod) return
    const z = mod.zoomOut(fabricRef.current, mod.ZOOM_BTN_STEP)
    setZoom(z)
  }, [])

  // ─── Helper to check object types (need fabric core) ──────────────────
  const isInstance = useCallback((obj: any, typeName: string) => {
    const fc = fabricCoreRef.current
    if (!fc || !obj) return false
    switch (typeName) {
      case 'DynamicText': return obj instanceof fabricModRef.current!.DynamicText
      case 'Rect': return obj instanceof fc.Rect
      case 'Ellipse': return obj instanceof fc.Ellipse
      case 'Line': return obj instanceof fc.Line
      case 'FabricImage': return obj instanceof fc.FabricImage
      case 'Triangle': return obj instanceof fc.Triangle
      case 'Group': return obj instanceof fc.Group
      case 'ActiveSelection': return obj instanceof fc.ActiveSelection
      case 'FabricText': return obj instanceof fc.FabricText
      default: return false
    }
  }, [])

  // ─── Loading ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[#13131f]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-400">Cargando editor...</p>
        </div>
      </div>
    )
  }

  if (!template) {
    return (
      <div className="flex items-center justify-center h-full bg-[#13131f]">
        <p className="text-slate-400">Plantilla no encontrada</p>
      </div>
    )
  }

  const zoomPercent = Math.round(zoom * 100)

  // Constants for rendering (from module or defaults)
  const SYSTEM_FONTS = fabricModRef.current?.SYSTEM_FONTS ?? ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana', 'Courier New']
  const GOOGLE_FONTS = fabricModRef.current?.GOOGLE_FONTS ?? ['Roboto', 'Open Sans', 'Montserrat', 'Poppins']
  const DYNAMIC_FIELD_CATEGORIES = (() => {
    const base = (fabricModRef.current?.DYNAMIC_FIELD_CATEGORIES ?? []) as Array<{ label: string; fields: Array<{ key: string; label: string; template: string }> }>
    if (customFields.length === 0) return base
    const personalizados = {
      label: 'Personalizados',
      fields: customFields.map(f => ({
        key: f.slug,
        label: f.name,
        template: `{{${f.slug}}}`,
      })),
    }
    return [...base, personalizados]
  })()
  const PAGE_SIZES = fabricModRef.current?.PAGE_SIZES ?? {}
  const GRID_SIZES = fabricModRef.current?.GRID_SIZES ?? [10, 20, 40, 50]
  const MM_TO_PX = fabricModRef.current?.MM_TO_PX ?? 2
  const GUIDE_COLOR = fabricModRef.current?.GUIDE_COLOR ?? '#10b981'
  const MARGIN_COLOR = fabricModRef.current?.MARGIN_COLOR ?? '#f59e0b'

  return (
    <div className="dark-editor flex flex-col h-screen bg-[#13131f] overflow-hidden">
      {/* Hidden elements to pass state to canvas afterRender */}
      <div id="__showGrid" data-show={String(showGrid)} data-size={String(gridSize)} className="hidden" />

      {/* ─── Top Bar ─────────────────────────────────────────────────── */}
      <div className="h-12 bg-[#1e1e2e] border-b border-[#2a2a3d] flex items-center px-3 gap-2 flex-shrink-0 z-20">
        <button onClick={() => router.push('/dashboard/documents')} className="p-1.5 hover:bg-white/10 rounded-lg transition text-slate-400">
          <ArrowLeft className="w-4 h-4" />
        </button>

        <input
          value={templateName}
          onChange={e => setTemplateName(e.target.value)}
          onBlur={() => handleSave()}
          className="text-sm font-semibold text-slate-200 bg-transparent border-none outline-none px-2 py-1 rounded hover:bg-white/5 focus:bg-white/5 w-48 truncate"
        />

        <span className="text-xs text-slate-500 ml-1">{pageWidth}×{pageHeight}mm</span>

        <div className="flex-1" />

        {/* Zoom controls */}
        <div className="flex items-center gap-1 bg-[#252536] rounded-lg px-1">
          <button onClick={handleZoomOut} className="p-1.5 hover:bg-white/10 rounded transition text-slate-400" title="Zoom out">
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs font-medium text-slate-300 w-12 text-center select-none">{zoomPercent}%</span>
          <button onClick={handleZoomIn} className="p-1.5 hover:bg-white/10 rounded transition text-slate-400" title="Zoom in">
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Undo / Redo */}
        <div className="flex items-center gap-0.5">
          <button onClick={handleUndo} disabled={!canUndo} className="p-1.5 hover:bg-white/10 rounded-lg transition text-slate-400 disabled:opacity-30" title="Deshacer (Ctrl+Z)">
            <Undo2 className="w-4 h-4" />
          </button>
          <button onClick={handleRedo} disabled={!canRedo} className="p-1.5 hover:bg-white/10 rounded-lg transition text-slate-400 disabled:opacity-30" title="Rehacer (Ctrl+Y)">
            <Redo2 className="w-4 h-4" />
          </button>
        </div>

        {/* Export */}
        <div className="relative">
          <button
            onClick={() => setShowExportMenu(!showExportMenu)}
            disabled={exporting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-300 border border-[#3a3a4d] rounded-lg hover:bg-white/5 transition disabled:opacity-50"
          >
            {exporting ? (
              <div className="w-3.5 h-3.5 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            {exporting ? 'Exportando...' : 'Exportar'}
            <ChevronDown className="w-3 h-3" />
          </button>
          {showExportMenu && (
            <div className="absolute right-0 top-full mt-1 bg-[#252536] border border-[#3a3a4d] rounded-lg shadow-lg py-1 w-44 z-30">
              <button onClick={() => handleExport('pdf')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-200 hover:bg-white/10">
                <FileDown className="w-4 h-4" /> PDF <span className="text-[10px] text-slate-500 ml-auto">~200 DPI</span>
              </button>
              <button onClick={() => handleExport('png')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-200 hover:bg-white/10">
                <ImageIcon className="w-4 h-4" /> PNG <span className="text-[10px] text-slate-500 ml-auto">~300 DPI</span>
              </button>
              <button onClick={() => handleExport('jpeg')} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-200 hover:bg-white/10">
                <ImageIcon className="w-4 h-4" /> JPEG <span className="text-[10px] text-slate-500 ml-auto">liviano</span>
              </button>
            </div>
          )}
        </div>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? 'Guardando...' : 'Guardar'}
        </button>

        <button onClick={handleDeleteTemplate} className="p-1.5 hover:bg-red-500/20 rounded-lg transition text-slate-500 hover:text-red-400" title="Eliminar plantilla">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* ─── Main Area ───────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ─── Left Toolbar ─────────────────────────────────────────── */}
        <div className="w-12 bg-[#252536] border-r border-[#2a2a3d] flex flex-col items-center py-2 gap-1 flex-shrink-0 z-10">
          {[
            { tool: 'select', icon: MousePointer, label: 'Seleccionar (V)', action: () => { setActiveTool('select'); setDrawingTool(null) } },
            { tool: 'hand', icon: Hand, label: 'Mover lienzo (Espacio)', action: () => { setActiveTool('hand'); setDrawingTool(null) } },
            { tool: 'text', icon: Type, label: 'Texto (T)', action: addTextElement },
            { tool: 'rect', icon: Square, label: 'Rectángulo (R)', action: addRectElement },
            { tool: 'circle', icon: Circle, label: 'Círculo (C)', action: addCircleElement },
            { tool: 'triangle', icon: Triangle, label: 'Triángulo', action: addTriangleElement },
            { tool: 'line', icon: Minus, label: 'Línea (L)', action: addLineElement },
          ].map(({ tool, icon: Icon, label, action }) => (
            <button
              key={tool}
              onClick={action}
              title={label}
              className={`p-2 rounded-lg transition ${activeTool === tool ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:text-slate-200 hover:bg-white/10'}`}
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}

          {/* Image upload */}
          <button onClick={() => fileInputRef.current?.click()} title="Subir imagen" className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition">
            <ImagePlus className="w-4 h-4" />
          </button>
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" className="hidden" onChange={handleImageUpload} />
          <input ref={replaceImageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" className="hidden" onChange={handleReplaceImageInput} />

          {/* Table */}
          <div className="relative">
            <button
              ref={tableButtonRef}
              onClick={() => { setShowTablePicker(!showTablePicker); setShowDynamicFields(false) }}
              title="Tabla"
              className={`p-2 rounded-lg transition ${showTablePicker ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:text-slate-200 hover:bg-white/10'}`}
            >
              <Table2 className="w-4 h-4" />
            </button>
            {showTablePicker && (
              <>
                <div className="fixed inset-0 z-[60]" onClick={() => setShowTablePicker(false)} />
                <div className="fixed bg-[#252536] border border-[#3a3a4d] rounded-xl shadow-xl p-3 z-[70] w-48"
                  style={{ left: `${(tableButtonRef.current?.getBoundingClientRect().right ?? 0) + 12}px`, top: `${tableButtonRef.current?.getBoundingClientRect().top ?? 0}px` }}>
                  <p className="text-xs font-semibold text-slate-400 mb-2">Insertar tabla</p>
                  <div className="grid grid-cols-6 gap-0.5 mb-2">
                  {Array.from({ length: 36 }, (_, i) => {
                    const row = Math.floor(i / 6) + 1
                    const col = (i % 6) + 1
                    const isActive = row <= tableHover.rows && col <= tableHover.cols
                    return (
                      <button
                        key={i}
                        className={`w-5 h-5 border rounded-sm transition ${isActive ? 'bg-emerald-900/40 border-emerald-500' : 'bg-[#2a2a3d] border-[#3a3a4d] hover:border-slate-400'}`}
                        onMouseEnter={() => setTableHover({ rows: row, cols: col })}
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                        onClick={() => addTable(row, col)}
                      />
                    )
                  })}
                </div>
                <p className="text-[10px] text-center text-slate-400">
                  {tableHover.rows > 0 ? `${tableHover.rows} × ${tableHover.cols}` : 'Selecciona tamaño'}
                </p>
                </div>
              </>
            )}
          </div>

          {/* Dynamic fields */}
          <div className="relative">
            <button
              ref={dynamicFieldsBtnRef}
              onClick={() => { setShowDynamicFields(!showDynamicFields); setShowTablePicker(false) }}
              title="Campos dinámicos"
              className={`p-2 rounded-lg transition ${showDynamicFields ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:text-slate-200 hover:bg-white/10'}`}
            >
              <Layers className="w-4 h-4" />
            </button>
            <DynamicFieldsPicker
              open={showDynamicFields}
              anchorRef={dynamicFieldsBtnRef}
              categories={DYNAMIC_FIELD_CATEGORIES as any}
              onSelect={(f) => { addDynamicField(f); setShowDynamicFields(false) }}
              onClose={() => setShowDynamicFields(false)}
            />
          </div>

          <hr className="w-6 border-[#3a3a4d] my-1" />

          {/* View toggles */}
          <button onClick={() => setShowGrid(!showGrid)} title="Grilla" className={`p-2 rounded-lg transition ${showGrid ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:text-slate-200 hover:bg-white/10'}`}>
            <Grid3X3 className="w-4 h-4" />
          </button>
          <button onClick={() => setShowRulers(!showRulers)} title="Reglas" className={`p-2 rounded-lg transition ${showRulers ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:text-slate-200 hover:bg-white/10'}`}>
            <Ruler className="w-4 h-4" />
          </button>
          <button onClick={() => setShowMargins(!showMargins)} title="Márgenes" className={`p-2 rounded-lg transition ${showMargins ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:text-slate-200 hover:bg-white/10'}`}>
            <FlipVertical2 className="w-4 h-4" />
          </button>

          <hr className="w-6 border-[#3a3a4d] my-1" />

          {/* Alignment — only when selection exists */}
          {hasSelection && (
            <>
              {(() => {
                const toPage = selectedObjects.length === 1
                const suffix = toPage ? ' en página' : ''
                const items: { align: string; icon: any; label: string }[] = [
                  { align: 'left',     icon: AlignStartVertical,    label: `Alinear a la izquierda${suffix}` },
                  { align: 'center-h', icon: AlignCenterVertical,   label: `Centrar horizontalmente${suffix}` },
                  { align: 'right',    icon: AlignEndVertical,      label: `Alinear a la derecha${suffix}` },
                  { align: 'top',      icon: AlignStartHorizontal,  label: `Alinear arriba${suffix}` },
                  { align: 'center-v', icon: AlignCenterHorizontal, label: `Centrar verticalmente${suffix}` },
                  { align: 'bottom',   icon: AlignEndHorizontal,    label: `Alinear abajo${suffix}` },
                ]
                return items.map(({ align, icon: Icon, label }) => (
                  <button key={align} onClick={() => handleAlign(align)} title={label} className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition">
                    <Icon className="w-4 h-4" />
                  </button>
                ))
              })()}
              <hr className="w-6 border-[#3a3a4d] my-1" />
            </>
          )}

          {/* Object actions */}
          {hasSelection && (
            <>
              {selectedObj?.lockMovementX ? (
                <button onClick={toggleLock} title="Desbloquear" className="p-2 rounded-lg text-amber-400 bg-amber-900/30 transition">
                  <Lock className="w-4 h-4" />
                </button>
              ) : selectedObj ? (
                <button onClick={toggleLock} title="Bloquear" className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition">
                  <Unlock className="w-4 h-4" />
                </button>
              ) : null}

              {selectedObjects.length >= 2 && (
                <button onClick={groupSelected} title="Agrupar (Ctrl+G)" className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition">
                  <Group className="w-4 h-4" />
                </button>
              )}
              {selectedObj && isInstance(selectedObj, 'Group') && (
                <button onClick={ungroupSelected} title="Desagrupar (Ctrl+Shift+G)" className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition">
                  <Ungroup className="w-4 h-4" />
                </button>
              )}

              <button onClick={duplicateSelected} title="Duplicar (Ctrl+D)" className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition">
                <Copy className="w-4 h-4" />
              </button>
              <button onClick={deleteSelected} title="Eliminar (Delete)" className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/20 transition">
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>

        {/* ─── Canvas Area ──────────────────────────────────────────── */}
        <div
          ref={containerRef}
          className="flex-1 relative overflow-hidden"
          style={{ backgroundColor: pasteboardColor }}
          onClick={() => { setShowDynamicFields(false); setShowTablePicker(false) }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
          onDragOver={handleCanvasDragOver}
          onDragLeave={handleCanvasDragLeave}
          onDrop={handleCanvasDrop}
        >
          {/* Rulers — drag from them to create guides */}
          {showRulers && (
            <>
              <div
                className="absolute top-0 left-0 right-0 h-5 bg-[#252536] border-b border-[#3a3a4d] z-10 flex items-end cursor-row-resize select-none"
                style={{ marginLeft: '20px' }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  const containerRect = containerRef.current?.getBoundingClientRect()
                  if (!containerRect) return
                  const vpt = fabricRef.current?.viewportTransform
                  const zoomVal = fabricRef.current?.getZoom() || 1

                  const handleMove = (me: MouseEvent) => {
                    const y = me.clientY - containerRect.top - 20
                    const sceneY = (y - (vpt?.[5] ?? 0)) / zoomVal
                    setDraggingGuide({ orientation: 'h', position: sceneY })
                  }
                  const handleUp = (me: MouseEvent) => {
                    document.removeEventListener('mousemove', handleMove)
                    document.removeEventListener('mouseup', handleUp)
                    const y = me.clientY - containerRect.top - 20
                    if (y > 0) {
                      const sceneY = (y - (vpt?.[5] ?? 0)) / zoomVal
                      setUserGuides(prev => [...prev, { id: crypto.randomUUID(), orientation: 'h', position: sceneY }])
                    }
                    setDraggingGuide(null)
                  }
                  document.addEventListener('mousemove', handleMove)
                  document.addEventListener('mouseup', handleUp)
                }}
              >
                {Array.from({ length: Math.ceil(pageWidth) + 1 }, (_, i) => i).map(mm => (
                  <div key={mm} className="absolute bottom-0" style={{ left: `${mm * MM_TO_PX * zoom + (fabricRef.current?.viewportTransform?.[4] ?? 0)}px` }}>
                    {mm % 10 === 0 ? (
                      <>
                        <div className="w-px h-2.5 bg-slate-500" />
                        <span className="text-[8px] text-slate-500 absolute -left-2 -top-2.5">{mm}</span>
                      </>
                    ) : mm % 5 === 0 ? (
                      <div className="w-px h-1.5 bg-slate-600" />
                    ) : null}
                  </div>
                ))}
              </div>
              <div
                className="absolute top-5 left-0 bottom-0 w-5 bg-[#252536] border-r border-[#3a3a4d] z-10 cursor-col-resize select-none"
                onMouseDown={(e) => {
                  e.preventDefault()
                  const containerRect = containerRef.current?.getBoundingClientRect()
                  if (!containerRect) return
                  const vpt = fabricRef.current?.viewportTransform
                  const zoomVal = fabricRef.current?.getZoom() || 1

                  const handleMove = (me: MouseEvent) => {
                    const x = me.clientX - containerRect.left - 20
                    const sceneX = (x - (vpt?.[4] ?? 0)) / zoomVal
                    setDraggingGuide({ orientation: 'v', position: sceneX })
                  }
                  const handleUp = (me: MouseEvent) => {
                    document.removeEventListener('mousemove', handleMove)
                    document.removeEventListener('mouseup', handleUp)
                    const x = me.clientX - containerRect.left - 20
                    if (x > 0) {
                      const sceneX = (x - (vpt?.[4] ?? 0)) / zoomVal
                      setUserGuides(prev => [...prev, { id: crypto.randomUUID(), orientation: 'v', position: sceneX }])
                    }
                    setDraggingGuide(null)
                  }
                  document.addEventListener('mousemove', handleMove)
                  document.addEventListener('mouseup', handleUp)
                }}
              >
                {Array.from({ length: Math.ceil(pageHeight) + 1 }, (_, i) => i).map(mm => (
                  <div key={mm} className="absolute left-0" style={{ top: `${mm * MM_TO_PX * zoom + (fabricRef.current?.viewportTransform?.[5] ?? 0)}px` }}>
                    {mm % 10 === 0 ? (
                      <>
                        <div className="h-px w-2.5 bg-slate-500" />
                        <span className="text-[8px] text-slate-500 absolute left-0 -top-1.5" style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}>{mm}</span>
                      </>
                    ) : mm % 5 === 0 ? (
                      <div className="h-px w-1.5 bg-slate-600" />
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="absolute top-0 left-0 w-5 h-5 bg-[#1e1e2e] border-r border-b border-[#3a3a4d] z-20"
                onDoubleClick={() => setUserGuides([])}
                title="Doble clic para borrar guías"
              />
            </>
          )}

          {/* Canvas container */}
          <div
            className="absolute inset-0"
            style={{ top: showRulers ? '20px' : '0', left: showRulers ? '20px' : '0' }}
          >
            <canvas ref={canvasElRef} />

            {/* Margin guides overlay */}
            {showMargins && (
              <div className="absolute pointer-events-none" style={{
                left: `${marginSize * MM_TO_PX * zoom + (fabricRef.current?.viewportTransform?.[4] ?? 0)}px`,
                top: `${marginSize * MM_TO_PX * zoom + (fabricRef.current?.viewportTransform?.[5] ?? 0)}px`,
                width: `${(pageWidth - marginSize * 2) * MM_TO_PX * zoom}px`,
                height: `${(pageHeight - marginSize * 2) * MM_TO_PX * zoom}px`,
                border: `1.5px dashed ${MARGIN_COLOR}`,
                opacity: 0.5,
                zIndex: 40,
              }} />
            )}

            {/* Drag-drop image replace: highlight over target */}
            {dragOverTargetId && (() => {
              const canvas = fabricRef.current
              const vpt = canvas?.viewportTransform
              if (!canvas) return null
              const target = canvas.getObjects().find((o: any) => o.__id === dragOverTargetId) as any
              if (!target) return null
              const b = target.getBoundingRect()
              return (
                <div className="absolute pointer-events-none" style={{
                  left: `${b.left}px`,
                  top: `${b.top}px`,
                  width: `${b.width}px`,
                  height: `${b.height}px`,
                  border: '2.5px dashed rgb(16, 185, 129)',
                  background: 'rgba(16,185,129,0.12)',
                  borderRadius: '4px',
                  zIndex: 55,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <span className="text-xs font-semibold text-emerald-300 bg-emerald-900/80 px-2.5 py-1 rounded-md border border-emerald-500/50 shadow-lg">
                    Reemplazar imagen
                  </span>
                </div>
              )
            })()}

            {/* Snap guides (clamped to page bounds for visual clarity) */}
            {snapGuides.map((guide, i) => {
              const vpt = fabricRef.current?.viewportTransform
              const pageLeftPx = vpt?.[4] ?? 0
              const pageTopPx = vpt?.[5] ?? 0
              const pageWScene = pageWidth * MM_TO_PX
              const pageHScene = pageHeight * MM_TO_PX
              const pageWPx = pageWScene * zoom
              const pageHPx = pageHScene * zoom
              // Skip guides that fall outside page rect — visual clarity
              if (guide.orientation === 'vertical' && (guide.position < 0 || guide.position > pageWScene)) return null
              if (guide.orientation === 'horizontal' && (guide.position < 0 || guide.position > pageHScene)) return null
              return guide.orientation === 'vertical' ? (
                <div key={i} className="absolute pointer-events-none" style={{
                  left: `${guide.position * zoom + pageLeftPx}px`,
                  top: `${pageTopPx}px`,
                  height: `${pageHPx}px`,
                  width: '1px',
                  borderLeft: `1px dashed ${GUIDE_COLOR}`,
                  zIndex: 50,
                }} />
              ) : (
                <div key={i} className="absolute pointer-events-none" style={{
                  top: `${guide.position * zoom + pageTopPx}px`,
                  left: `${pageLeftPx}px`,
                  width: `${pageWPx}px`,
                  height: '1px',
                  borderTop: `1px dashed ${GUIDE_COLOR}`,
                  zIndex: 50,
                }} />
              )
            })}

            {/* Distance labels (Figma-style "12px" between adjacent objects) */}
            {distanceLabels.map((d, i) => {
              const vpt = fabricRef.current?.viewportTransform
              const offL = vpt?.[4] ?? 0
              const offT = vpt?.[5] ?? 0
              // Convert scene → viewport px
              const x1 = d.x1 * zoom + offL
              const y1 = d.y1 * zoom + offT
              const x2 = d.x2 * zoom + offL
              const y2 = d.y2 * zoom + offT
              const midX = (x1 + x2) / 2
              const midY = (y1 + y2) / 2
              const lineColor = 'rgb(239, 68, 68)' // red-500
              return (
                <div key={`d-${i}`} className="absolute pointer-events-none" style={{ zIndex: 52 }}>
                  {/* Measurement line */}
                  <div style={{
                    position: 'absolute',
                    left: `${Math.min(x1, x2)}px`,
                    top: `${Math.min(y1, y2)}px`,
                    width: d.axis === 'h' ? `${Math.abs(x2 - x1)}px` : '1px',
                    height: d.axis === 'v' ? `${Math.abs(y2 - y1)}px` : '1px',
                    background: lineColor,
                  }} />
                  {/* End caps (perpendicular 6px ticks) */}
                  {d.axis === 'h' ? (
                    <>
                      <div style={{ position: 'absolute', left: `${x1}px`, top: `${y1 - 3}px`, width: '1px', height: '7px', background: lineColor }} />
                      <div style={{ position: 'absolute', left: `${x2}px`, top: `${y2 - 3}px`, width: '1px', height: '7px', background: lineColor }} />
                    </>
                  ) : (
                    <>
                      <div style={{ position: 'absolute', left: `${x1 - 3}px`, top: `${y1}px`, width: '7px', height: '1px', background: lineColor }} />
                      <div style={{ position: 'absolute', left: `${x2 - 3}px`, top: `${y2}px`, width: '7px', height: '1px', background: lineColor }} />
                    </>
                  )}
                  {/* Label bubble */}
                  <div style={{
                    position: 'absolute',
                    left: `${midX}px`,
                    top: `${midY}px`,
                    transform: d.axis === 'h' ? 'translate(-50%, -140%)' : 'translate(10px, -50%)',
                    background: lineColor,
                    color: 'white',
                    fontSize: '10px',
                    fontWeight: 600,
                    padding: '2px 6px',
                    borderRadius: '4px',
                    whiteSpace: 'nowrap',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  }}>
                    {d.distance}px
                  </div>
                </div>
              )
            })}

            {/* Rich-text floating toolbar */}
            {editingText && editingTextObj && (() => {
              const obj = editingTextObj as any
              const canvas = fabricRef.current
              const vpt = canvas?.viewportTransform
              if (!canvas || !vpt) return null
              const b = obj.getBoundingRect()
              // Position above the textbox (or below if no space)
              const toolbarH = 34
              let top = b.top - toolbarH - 4
              if (top < 4) top = b.top + b.height + 4
              const left = b.left + b.width / 2
              // Touch editingSelVersion to re-render on selection change
              void editingSelVersion

              const getSel = (): [number, number] => {
                const s = obj.selectionStart ?? 0
                const e = obj.selectionEnd ?? s
                return s === e ? [Math.max(0, s - 1), s] : [s, e]
              }

              const styleActive = (key: string, match: any): boolean => {
                const [s, e] = getSel()
                if (s === e) return false
                try {
                  const styles = obj.getSelectionStyles(s, e, true) as any[]
                  if (!styles || styles.length === 0) return false
                  return styles.every((st: any) => (st?.[key] ?? obj[key]) === match)
                } catch { return false }
              }

              const applyStyle = (partial: Record<string, any>) => {
                const [s, e] = getSel()
                if (s >= e) return
                obj.setSelectionStyles(partial, s, e)
                obj.initDimensions?.()
                canvas.renderAll()
                setEditingSelVersion(v => v + 1)
              }

              const toggleBold = () => {
                const bold = styleActive('fontWeight', 'bold')
                applyStyle({ fontWeight: bold ? 'normal' : 'bold' })
              }
              const toggleItalic = () => {
                const it = styleActive('fontStyle', 'italic')
                applyStyle({ fontStyle: it ? 'normal' : 'italic' })
              }
              const toggleUnderline = () => {
                const un = styleActive('underline', true)
                applyStyle({ underline: !un })
              }
              const setFill = (color: string) => applyStyle({ fill: color })
              const bumpSize = (delta: number) => {
                const [s, e] = getSel()
                if (s >= e) return
                const styles = obj.getSelectionStyles(s, e, true) as any[]
                const cur = styles?.[0]?.fontSize ?? obj.fontSize ?? 16
                applyStyle({ fontSize: Math.max(6, Math.min(400, Math.round(cur + delta))) })
              }

              const hasSel = getSel()[0] < getSel()[1]
              const btn = "h-7 w-7 flex items-center justify-center rounded-md text-slate-200 hover:bg-white/10 transition disabled:opacity-40 disabled:cursor-not-allowed"
              const activeBtn = "bg-emerald-600 text-white hover:bg-emerald-500"

              return (
                <div
                  className="absolute flex items-center gap-0.5 px-1.5 py-1 rounded-lg bg-[#1e1e2e]/95 backdrop-blur-sm border border-[#3a3a4d] shadow-2xl"
                  style={{
                    left: `${left}px`,
                    top: `${top}px`,
                    transform: 'translateX(-50%)',
                    zIndex: 80,
                  }}
                  // Prevent clicks from stealing focus / exiting editing
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <button
                    className={`${btn} ${styleActive('fontWeight', 'bold') ? activeBtn : ''}`}
                    title="Negrita"
                    disabled={!hasSel}
                    onClick={toggleBold}
                  ><Bold className="w-3.5 h-3.5" /></button>
                  <button
                    className={`${btn} ${styleActive('fontStyle', 'italic') ? activeBtn : ''}`}
                    title="Cursiva"
                    disabled={!hasSel}
                    onClick={toggleItalic}
                  ><Italic className="w-3.5 h-3.5" /></button>
                  <button
                    className={`${btn} ${styleActive('underline', true) ? activeBtn : ''}`}
                    title="Subrayado"
                    disabled={!hasSel}
                    onClick={toggleUnderline}
                  ><Underline className="w-3.5 h-3.5" /></button>
                  <div className="w-px h-5 bg-[#3a3a4d] mx-1" />
                  <button className={btn} title="Disminuir tamaño" disabled={!hasSel} onClick={() => bumpSize(-1)}>
                    <span className="text-xs font-bold">A-</span>
                  </button>
                  <button className={btn} title="Aumentar tamaño" disabled={!hasSel} onClick={() => bumpSize(1)}>
                    <span className="text-xs font-bold">A+</span>
                  </button>
                  <div className="w-px h-5 bg-[#3a3a4d] mx-1" />
                  <label
                    className={`h-7 w-7 flex items-center justify-center rounded-md cursor-pointer hover:bg-white/10 transition relative ${!hasSel ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''}`}
                    title="Color del texto"
                    onMouseDown={(e) => { e.stopPropagation() }}
                  >
                    <input
                      type="color"
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      onChange={(e) => setFill(e.target.value)}
                    />
                    <div className="w-3.5 h-3.5 rounded-sm border border-white/30 pointer-events-none" style={{
                      background: (() => {
                        const [s, e] = getSel()
                        if (s >= e) return obj.fill ?? '#ffffff'
                        try {
                          const st = obj.getSelectionStyles(s, e, true) as any[]
                          return st?.[0]?.fill ?? obj.fill ?? '#ffffff'
                        } catch { return obj.fill ?? '#ffffff' }
                      })(),
                    }} />
                  </label>
                </div>
              )
            })()}

            {/* User guides (persistent, from rulers) — draggable + right-click to delete */}
            {userGuides.map((guide) => (
              guide.orientation === 'v' ? (
                <div key={guide.id} data-user-guide="v" className="absolute cursor-col-resize" style={{
                  left: `${guide.position * zoom + (fabricRef.current?.viewportTransform?.[4] ?? 0) - 2}px`,
                  top: 0, bottom: 0, width: '5px',
                  borderLeft: '1px solid #06b6d4',
                  zIndex: 45,
                  opacity: 0.7,
                  paddingLeft: '2px',
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return
                  e.preventDefault()
                  e.stopPropagation()
                  const containerRect = containerRef.current!.getBoundingClientRect()
                  const rulerOffset = showRulers ? 20 : 0
                  const handleMove = (me: MouseEvent) => {
                    const x = me.clientX - containerRect.left - rulerOffset
                    const vpt = fabricRef.current?.viewportTransform
                    const sceneX = (x - (vpt?.[4] ?? 0)) / zoom
                    setDraggingGuide({ orientation: 'v', position: sceneX })
                  }
                  const handleUp = (me: MouseEvent) => {
                    document.removeEventListener('mousemove', handleMove)
                    document.removeEventListener('mouseup', handleUp)
                    const x = me.clientX - containerRect.left - rulerOffset
                    const vpt = fabricRef.current?.viewportTransform
                    const sceneX = (x - (vpt?.[4] ?? 0)) / zoom
                    if (x > 0) {
                      setUserGuides(prev => prev.map(g => g.id === guide.id ? { ...g, position: sceneX } : g))
                    } else {
                      setUserGuides(prev => prev.filter(g => g.id !== guide.id))
                    }
                    setDraggingGuide(null)
                  }
                  document.addEventListener('mousemove', handleMove)
                  document.addEventListener('mouseup', handleUp)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setUserGuides(prev => prev.filter(g => g.id !== guide.id))
                }}
                />
              ) : (
                <div key={guide.id} data-user-guide="h" className="absolute cursor-row-resize" style={{
                  top: `${guide.position * zoom + (fabricRef.current?.viewportTransform?.[5] ?? 0) - 2}px`,
                  left: 0, right: 0, height: '5px',
                  borderTop: '1px solid #06b6d4',
                  zIndex: 45,
                  opacity: 0.7,
                  paddingTop: '2px',
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return
                  e.preventDefault()
                  e.stopPropagation()
                  const containerRect = containerRef.current!.getBoundingClientRect()
                  const rulerOffset = showRulers ? 20 : 0
                  const handleMove = (me: MouseEvent) => {
                    const y = me.clientY - containerRect.top - rulerOffset
                    const vpt = fabricRef.current?.viewportTransform
                    const sceneY = (y - (vpt?.[5] ?? 0)) / zoom
                    setDraggingGuide({ orientation: 'h', position: sceneY })
                  }
                  const handleUp = (me: MouseEvent) => {
                    document.removeEventListener('mousemove', handleMove)
                    document.removeEventListener('mouseup', handleUp)
                    const y = me.clientY - containerRect.top - rulerOffset
                    const vpt = fabricRef.current?.viewportTransform
                    const sceneY = (y - (vpt?.[5] ?? 0)) / zoom
                    if (y > 0) {
                      setUserGuides(prev => prev.map(g => g.id === guide.id ? { ...g, position: sceneY } : g))
                    } else {
                      setUserGuides(prev => prev.filter(g => g.id !== guide.id))
                    }
                    setDraggingGuide(null)
                  }
                  document.addEventListener('mousemove', handleMove)
                  document.addEventListener('mouseup', handleUp)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setUserGuides(prev => prev.filter(g => g.id !== guide.id))
                }}
                />
              )
            ))}

            {/* Dragging guide preview */}
            {draggingGuide && (
              draggingGuide.orientation === 'v' ? (
                <div className="absolute pointer-events-none" style={{
                  left: `${draggingGuide.position * zoom + (fabricRef.current?.viewportTransform?.[4] ?? 0)}px`,
                  top: 0, bottom: 0, width: '1px',
                  borderLeft: '1px dashed #06b6d4',
                  zIndex: 55,
                }} />
              ) : (
                <div className="absolute pointer-events-none" style={{
                  top: `${draggingGuide.position * zoom + (fabricRef.current?.viewportTransform?.[5] ?? 0)}px`,
                  left: 0, right: 0, height: '1px',
                  borderTop: '1px dashed #06b6d4',
                  zIndex: 55,
                }} />
              )
            )}
          </div>

          {/* Background image via CSS */}
          {background.imageUrl && (
            <style>{`
              .canvas-container canvas {
                background-image: url('${background.imageUrl.replace(/'/g, "\\'")}');
                background-size: cover;
                background-position: center;
              }
            `}</style>
          )}
        </div>

        {/* ─── Right Panel ──────────────────────────────────────────── */}
        <div className="w-72 bg-[#1e1e2e] border-l border-[#2a2a3d] flex flex-col flex-shrink-0 overflow-hidden z-10">
          {/* Tabs */}
          <div className="flex border-b border-[#2a2a3d]">
            <button
              onClick={() => setRightTab('properties')}
              className={`flex-1 py-2.5 text-xs font-medium transition ${rightTab === 'properties' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-slate-500 hover:text-slate-300'}`}
            >
              Propiedades
            </button>
            <button
              onClick={() => setRightTab('layers')}
              className={`flex-1 py-2.5 text-xs font-medium transition ${rightTab === 'layers' ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-slate-500 hover:text-slate-300'}`}
            >
              Capas ({allObjects.length})
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {rightTab === 'properties' ? (
              selectedObj ? (
                <PropertiesContent
                  selectedObj={selectedObj}
                  updateProp={updateProp}
                  pushHistory={pushHistory}
                  isInstance={isInstance}
                  fabricRef={fabricRef}
                  fileInputRef={fileInputRef}
                  replaceImageInputRef={replaceImageInputRef}
                  SYSTEM_FONTS={SYSTEM_FONTS}
                  GOOGLE_FONTS={GOOGLE_FONTS}
                  bringForward={bringForward}
                  sendBackward={sendBackward}
                  bringToFront={bringToFront}
                  sendToBack={sendToBack}
                  copiedFieldFormatRef={copiedFieldFormatRef}
                />
              ) : selectedObjects.length > 1 ? (
                <MultiSelectProperties
                  selectedObjects={selectedObjects}
                  fabricRef={fabricRef}
                  pushHistory={pushHistory}
                  isInstance={isInstance}
                  copiedFieldFormatRef={copiedFieldFormatRef}
                />
              ) : (
                <DocumentProperties
                  pageWidth={pageWidth}
                  pageHeight={pageHeight}
                  background={background}
                  handleBgColorChange={handleBgColorChange}
                  handleBgImageUpload={handleBgImageUpload}
                  bgFileInputRef={bgFileInputRef}
                  setBackground={setBackground}
                  showGrid={showGrid}
                  setShowGrid={setShowGrid}
                  gridSize={gridSize}
                  setGridSize={setGridSize}
                  showRulers={showRulers}
                  setShowRulers={setShowRulers}
                  showMargins={showMargins}
                  setShowMargins={setShowMargins}
                  marginSize={marginSize}
                  setMarginSize={setMarginSize}
                  pasteboardColor={pasteboardColor}
                  onPasteboardColorChange={handlePasteboardColorChange}
                  allObjects={allObjects}
                  PAGE_SIZES={PAGE_SIZES}
                  GRID_SIZES={GRID_SIZES}
                  onPageResize={(w, h) => {
                    const fabricMod = fabricModRef.current
                    const canvas = fabricRef.current
                    if (fabricMod && canvas) {
                      fabricMod.resizePageRect(canvas, w, h)
                      setPageWidth(w)
                      setPageHeight(h)
                      pushHistory()
                    }
                  }}
                />
              )
            ) : (
              <LayersPanel
                allObjects={allObjects}
                selectedObjects={selectedObjects}
                fabricRef={fabricRef}
                refreshObjectList={refreshObjectList}
                setRightTab={setRightTab}
                isInstance={isInstance}
              />
            )}
          </div>
        </div>
      </div>

      {/* ─── Context Menu ──────────────────────────────────────────── */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
          <div
            className="fixed bg-[#252536] border border-[#3a3a4d] rounded-xl shadow-xl py-1.5 w-52 z-50"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {hasSelection ? (
              <>
                <button onClick={() => { copySelected(); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 transition">
                  <Copy className="w-3.5 h-3.5" /> Copiar <span className="ml-auto text-xs text-slate-500">Ctrl+C</span>
                </button>
                <button onClick={() => { duplicateSelected(); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 transition">
                  <Copy className="w-3.5 h-3.5" /> Duplicar <span className="ml-auto text-xs text-slate-500">Ctrl+D</span>
                </button>
                <hr className="my-1 border-[#3a3a4d]" />
                <button onClick={() => { bringToFront(); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 transition">Traer al frente</button>
                <button onClick={() => { bringForward(); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 transition">Subir una capa</button>
                <button onClick={() => { sendBackward(); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 transition">Bajar una capa</button>
                <button onClick={() => { sendToBack(); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 transition">Enviar al fondo</button>
                <hr className="my-1 border-[#3a3a4d]" />
                <button onClick={() => { toggleLock(); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 transition">
                  {selectedObj?.lockMovementX ? 'Desbloquear' : 'Bloquear'}
                </button>
                <hr className="my-1 border-[#3a3a4d]" />
                <button onClick={() => { deleteSelected(); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/20 transition">
                  <Trash2 className="w-3.5 h-3.5" /> Eliminar
                </button>
              </>
            ) : (
              <>
                <button onClick={() => { pasteClipboard(); setContextMenu(null) }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 transition">
                  Pegar <span className="ml-auto text-xs text-slate-500">Ctrl+V</span>
                </button>
                <button onClick={() => {
                  const canvas = fabricRef.current
                  const fc = fabricCoreRef.current
                  if (canvas && fc) {
                    const objs = canvas.getObjects().filter(o => o.selectable && o.visible)
                    if (objs.length > 0) {
                      canvas.discardActiveObject()
                      const sel = new fc.ActiveSelection(objs, { canvas })
                      canvas.setActiveObject(sel)
                      canvas.renderAll()
                    }
                  }
                  setContextMenu(null)
                }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/10 transition">
                  Seleccionar todo <span className="ml-auto text-xs text-slate-500">Ctrl+A</span>
                </button>
              </>
            )}
          </div>
        </>
      )}

      {showExportMenu && <div className="fixed inset-0 z-10" onMouseDown={() => setShowExportMenu(false)} />}
    </div>
  )
}


// ─── Properties Panel Sub-Component ─────────────────────────────────────────

function PropertiesContent({
  selectedObj, updateProp, pushHistory, isInstance, fabricRef, fileInputRef, replaceImageInputRef,
  SYSTEM_FONTS, GOOGLE_FONTS, bringForward, sendBackward, bringToFront, sendToBack,
  copiedFieldFormatRef,
}: {
  selectedObj: FabricObject
  updateProp: (prop: string, value: any) => void
  pushHistory: () => void
  isInstance: (obj: any, type: string) => boolean
  fabricRef: React.MutableRefObject<FabricCanvasType | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  replaceImageInputRef: React.RefObject<HTMLInputElement | null>
  SYSTEM_FONTS: string[]
  GOOGLE_FONTS: string[]
  bringForward: () => void
  sendBackward: () => void
  bringToFront: () => void
  sendToBack: () => void
  copiedFieldFormatRef: React.MutableRefObject<import('@/lib/dynamicFieldFormat').FieldFormat | null>
}) {
  const obj = selectedObj as any
  const isText = isInstance(obj, 'DynamicText') || isInstance(obj, 'FabricText')
  const isDynamicField = isInstance(obj, 'DynamicText') && obj.isDynamic && !!obj.fieldName
  const isRect = isInstance(obj, 'Rect')
  const isEllipse = isInstance(obj, 'Ellipse')
  const isTriangle = isInstance(obj, 'Triangle')
  const isLine = isInstance(obj, 'Line')
  const isImage = isInstance(obj, 'FabricImage')
  const isShape = isRect || isEllipse || isTriangle

  return (
    <>
      {/* Position & Size */}
      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Posición y tamaño</label>
        <div className="grid grid-cols-2 gap-1.5 mt-1">
          {[
            { label: 'X', value: Math.round(obj.left ?? 0), prop: 'left' },
            { label: 'Y', value: Math.round(obj.top ?? 0), prop: 'top' },
          ].map(({ label, value, prop }) => (
            <div key={prop}>
              <span className="text-[10px] text-slate-500">{label}</span>
              <input type="number" value={value} onChange={e => updateProp(prop, Number(e.target.value))}
                className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
            </div>
          ))}
          <div>
            <span className="text-[10px] text-slate-500">Ancho</span>
            <input type="number" value={Math.round(selectedObj.getScaledWidth())} onChange={e => { const v = Number(e.target.value); selectedObj.set({ scaleX: v / (selectedObj.width || 1) }); selectedObj.setCoords(); fabricRef.current?.renderAll(); pushHistory() }}
              className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
          </div>
          <div>
            <span className="text-[10px] text-slate-500">Alto</span>
            <input type="number" value={Math.round(selectedObj.getScaledHeight())} onChange={e => { const v = Number(e.target.value); selectedObj.set({ scaleY: v / (selectedObj.height || 1) }); selectedObj.setCoords(); fabricRef.current?.renderAll(); pushHistory() }}
              className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
          </div>
          <div className="col-span-2">
            <span className="text-[10px] text-slate-500">Rotación (°)</span>
            <input type="number" value={Math.round(obj.angle ?? 0)} onChange={e => updateProp('angle', Number(e.target.value))}
              className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
          </div>
        </div>
      </div>

      <hr className="border-[#2a2a3d]" />

      {/* Text properties */}
      {isText && (
        <>
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Texto</label>
            <select
              value={obj.fontFamily || 'Arial'}
              onChange={e => updateProp('fontFamily', e.target.value)}
              className="w-full px-2 py-1.5 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none mt-1"
            >
              <optgroup label="Sistema">
                {SYSTEM_FONTS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
              </optgroup>
              <optgroup label="Google Fonts">
                {GOOGLE_FONTS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
              </optgroup>
            </select>

            <div className="flex gap-1.5 mt-1.5">
              <input type="number" min={6} max={500} value={obj.fontSize || 16} onChange={e => updateProp('fontSize', Number(e.target.value))}
                className="w-20 px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
              <select value={String(obj.fontWeight || 'normal')} onChange={e => updateProp('fontWeight', e.target.value)}
                className="flex-1 px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none">
                <option value="300">Light</option>
                <option value="normal">Normal</option>
                <option value="500">Medium</option>
                <option value="600">Semibold</option>
                <option value="bold">Bold</option>
                <option value="800">Extra Bold</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5 mt-1.5">
              <input type="color" value={String(obj.fill || '#000000')} onChange={e => updateProp('fill', e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border border-[#3a3a4d]" />
              <input type="text" value={String(obj.fill || '#000000')} onChange={e => updateProp('fill', e.target.value)}
                className="flex-1 px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none font-mono" />
            </div>

            <div className="flex gap-1 mt-1.5">
              <button onClick={() => updateProp('fontWeight', obj.fontWeight === 'bold' ? 'normal' : 'bold')}
                className={`p-1.5 rounded transition ${obj.fontWeight === 'bold' ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:bg-white/10'}`}>
                <Bold className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => updateProp('fontStyle', obj.fontStyle === 'italic' ? 'normal' : 'italic')}
                className={`p-1.5 rounded transition ${obj.fontStyle === 'italic' ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:bg-white/10'}`}>
                <Italic className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => updateProp('underline', !obj.underline)}
                className={`p-1.5 rounded transition ${obj.underline ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:bg-white/10'}`}>
                <Underline className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex gap-1 mt-1.5">
              {['left', 'center', 'right'].map(align => (
                <button key={align} onClick={() => updateProp('textAlign', align)}
                  className={`p-1.5 rounded transition ${obj.textAlign === align ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:bg-white/10'}`}>
                  {align === 'left' ? <AlignLeft className="w-3.5 h-3.5" /> : align === 'center' ? <AlignCenter className="w-3.5 h-3.5" /> : <AlignRight className="w-3.5 h-3.5" />}
                </button>
              ))}
            </div>

            <div className="mt-1.5">
              <span className="text-[10px] text-slate-500">Interlineado</span>
              <input type="number" min={0.5} max={5} step={0.1} value={obj.lineHeight || 1.2} onChange={e => updateProp('lineHeight', Number(e.target.value))}
                className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
            </div>

            <div className="mt-1.5">
              <span className="text-[10px] text-slate-500">Espaciado entre letras</span>
              <div className="flex items-center gap-2">
                <input
                  type="range" min={-200} max={1000} step={10}
                  value={obj.charSpacing || 0}
                  onChange={e => updateProp('charSpacing', Number(e.target.value))}
                  className="flex-1 h-1 accent-emerald-500"
                />
                <input
                  type="number" min={-200} max={1000} step={10}
                  value={obj.charSpacing || 0}
                  onChange={e => updateProp('charSpacing', Number(e.target.value))}
                  className="w-16 px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none"
                />
              </div>
            </div>

            <div className="mt-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Contorno</span>
              <div className="grid grid-cols-2 gap-1.5 mt-1">
                <div>
                  <span className="text-[10px] text-slate-500">Color</span>
                  <input
                    type="color"
                    value={typeof obj.stroke === 'string' ? obj.stroke : '#000000'}
                    onChange={e => updateProp('stroke', e.target.value)}
                    className="w-full h-8 rounded cursor-pointer bg-[#2a2a3d] border border-[#3a3a4d]"
                  />
                </div>
                <div>
                  <span className="text-[10px] text-slate-500">Grosor</span>
                  <input
                    type="number" min={0} max={20} step={0.5}
                    value={obj.strokeWidth || 0}
                    onChange={e => {
                      const v = Number(e.target.value)
                      updateProp('strokeWidth', v)
                      // Ensure stroke behind fill for text (avoids thickening appearance)
                      if (v > 0 && !obj.paintFirst) updateProp('paintFirst', 'stroke')
                    }}
                    className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none"
                  />
                </div>
              </div>
            </div>
          </div>
          <hr className="border-[#2a2a3d]" />
        </>
      )}

      {/* Dynamic-field format (Excel-like) */}
      {isDynamicField && (
        <>
          <DynamicFormatSection
            objs={[obj]}
            fabricRef={fabricRef}
            pushHistory={pushHistory}
            copiedFieldFormatRef={copiedFieldFormatRef}
          />
          <hr className="border-[#2a2a3d]" />
        </>
      )}

      {/* Shape fill/stroke */}
      {isShape && (
        <>
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Forma</label>
            <div className="space-y-1.5 mt-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-slate-500 w-10">Relleno</span>
                <input type="color" value={String(obj.fill || '#e2e8f0')} onChange={e => updateProp('fill', e.target.value)}
                  className="w-7 h-7 rounded cursor-pointer border border-[#3a3a4d]" />
                <input type="text" value={String(obj.fill || '#e2e8f0')} onChange={e => updateProp('fill', e.target.value)}
                  className="flex-1 px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none font-mono" />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-slate-500 w-10">Borde</span>
                <input type="color" value={obj.stroke || '#000000'} onChange={e => updateProp('stroke', e.target.value)}
                  className="w-7 h-7 rounded cursor-pointer border border-[#3a3a4d]" />
                <input type="number" min={0} max={20} step={0.25} value={obj.strokeWidth || 0} onChange={e => updateProp('strokeWidth', Number(e.target.value))}
                  className="w-16 px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
              </div>
              {isRect && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-slate-500 w-10">Radio</span>
                  <input type="number" min={0} max={200} value={obj.rx || 0} onChange={e => { const v = Number(e.target.value); updateProp('rx', v); updateProp('ry', v) }}
                    className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
                </div>
              )}
            </div>
          </div>
          <hr className="border-[#2a2a3d]" />
        </>
      )}

      {/* Line properties */}
      {isLine && (
        <>
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Línea</label>
            <div className="space-y-1.5 mt-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-slate-500 w-10">Color</span>
                <input type="color" value={obj.stroke || '#000000'} onChange={e => updateProp('stroke', e.target.value)}
                  className="w-7 h-7 rounded cursor-pointer border border-[#3a3a4d]" />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-slate-500 w-10">Grosor</span>
                <input type="number" min={0.25} max={20} step={0.25} value={obj.strokeWidth || 2} onChange={e => updateProp('strokeWidth', Number(e.target.value))}
                  className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
              </div>
            </div>
          </div>
          <hr className="border-[#2a2a3d]" />
        </>
      )}

      {/* Image */}
      {isImage && (
        <>
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Imagen</label>
            <button
              onClick={() => replaceImageInputRef.current?.click()}
              title="Reemplazar preservando posición y tamaño"
              className="w-full mt-1 px-3 py-2 text-xs text-slate-300 border border-dashed border-[#3a3a4d] rounded-lg hover:bg-white/5 hover:border-emerald-500/50 transition"
            >
              Reemplazar imagen
            </button>
            <p className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">
              Tip: también puedes arrastrar una imagen sobre este objeto para reemplazarla.
            </p>
          </div>
          <hr className="border-[#2a2a3d]" />
        </>
      )}

      {/* Opacity */}
      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Opacidad</label>
        <div className="flex items-center gap-2 mt-1">
          <input type="range" min={0} max={1} step={0.01} value={obj.opacity ?? 1} onChange={e => updateProp('opacity', Number(e.target.value))}
            className="flex-1 accent-emerald-500" />
          <span className="text-xs text-slate-400 w-10 text-right">{Math.round((obj.opacity ?? 1) * 100)}%</span>
        </div>
      </div>

      {/* Shadow */}
      <ShadowControl selectedObj={selectedObj} updateProp={updateProp} />

      {/* Layer order */}
      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Capa</label>
        <div className="flex gap-1 mt-1">
          <button onClick={bringForward} className="flex-1 px-2 py-1 text-[10px] text-slate-300 bg-[#2a2a3d] border border-[#3a3a4d] rounded hover:bg-[#333348] transition">↑ Subir</button>
          <button onClick={sendBackward} className="flex-1 px-2 py-1 text-[10px] text-slate-300 bg-[#2a2a3d] border border-[#3a3a4d] rounded hover:bg-[#333348] transition">↓ Bajar</button>
        </div>
        <div className="flex gap-1 mt-1">
          <button onClick={bringToFront} className="flex-1 px-2 py-1 text-[10px] text-slate-300 bg-[#2a2a3d] border border-[#3a3a4d] rounded hover:bg-[#333348] transition">⬆ Frente</button>
          <button onClick={sendToBack} className="flex-1 px-2 py-1 text-[10px] text-slate-300 bg-[#2a2a3d] border border-[#3a3a4d] rounded hover:bg-[#333348] transition">⬇ Fondo</button>
        </div>
      </div>
    </>
  )
}


// ─── Shadow Control Sub-Component ───────────────────────────────────────────

function ShadowControl({ selectedObj, updateProp }: { selectedObj: FabricObject; updateProp: (prop: string, value: any) => void }) {
  // Dynamic import Shadow constructor
  const toggleShadow = async () => {
    const { Shadow } = await import('fabric')
    if (selectedObj.shadow) {
      updateProp('shadow', null)
    } else {
      updateProp('shadow', new Shadow({ offsetX: 2, offsetY: 2, blur: 4, color: 'rgba(0,0,0,0.25)' }))
    }
  }

  const updateShadowProp = async (prop: string, value: number) => {
    const { Shadow } = await import('fabric')
    const s = selectedObj.shadow as any
    if (!s) return
    updateProp('shadow', new Shadow({
      offsetX: prop === 'offsetX' ? value : s.offsetX ?? 0,
      offsetY: prop === 'offsetY' ? value : s.offsetY ?? 0,
      blur: prop === 'blur' ? value : s.blur ?? 0,
      color: s.color ?? 'rgba(0,0,0,0.25)',
    }))
  }

  const shadow = selectedObj.shadow as any

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Sombra</label>
        <button onClick={toggleShadow}
          className={`text-[10px] px-2 py-0.5 rounded ${shadow ? 'bg-emerald-900/40 text-emerald-400' : 'bg-[#2a2a3d] text-slate-400'}`}>
          {shadow ? 'ON' : 'OFF'}
        </button>
      </div>
      {shadow && (
        <div className="mt-1.5 space-y-1">
          {[{ label: 'X', prop: 'offsetX' }, { label: 'Y', prop: 'offsetY' }, { label: 'Blur', prop: 'blur' }].map(({ label, prop }) => (
            <div key={prop} className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-500 w-8">{label}</span>
              <input type="number" value={shadow[prop] ?? 0} onChange={e => updateShadowProp(prop, Number(e.target.value))}
                className="flex-1 px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


// ─── Document Properties Sub-Component ──────────────────────────────────────

function DocumentProperties({
  pageWidth, pageHeight, background, handleBgColorChange, handleBgImageUpload, bgFileInputRef,
  setBackground, showGrid, setShowGrid, gridSize, setGridSize, showRulers, setShowRulers,
  showMargins, setShowMargins, marginSize, setMarginSize, pasteboardColor, onPasteboardColorChange,
  allObjects, PAGE_SIZES, GRID_SIZES, onPageResize,
}: {
  pageWidth: number
  pageHeight: number
  background: { color: string; imageUrl?: string }
  handleBgColorChange: (color: string) => void
  handleBgImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  bgFileInputRef: React.RefObject<HTMLInputElement>
  setBackground: React.Dispatch<React.SetStateAction<{ color: string; imageUrl?: string }>>
  showGrid: boolean; setShowGrid: (v: boolean) => void
  gridSize: number; setGridSize: (v: number) => void
  showRulers: boolean; setShowRulers: (v: boolean) => void
  showMargins: boolean; setShowMargins: (v: boolean) => void
  marginSize: number; setMarginSize: (v: number) => void
  pasteboardColor: string; onPasteboardColorChange: (color: string) => void
  allObjects: FabricObject[]
  PAGE_SIZES: Record<string, { label: string; w: number; h: number }>
  GRID_SIZES: number[]
  onPageResize: (widthMm: number, heightMm: number) => void
}) {
  return (
    <>
      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Página</label>
        <div className="flex flex-wrap gap-1 mt-1">
          {Object.entries(PAGE_SIZES).filter(([k]) => k !== 'custom').map(([key, cfg]) => (
            <button key={key} onClick={() => {
              const isLandscape = pageWidth > pageHeight
              const w = isLandscape ? cfg.h : cfg.w
              const h = isLandscape ? cfg.w : cfg.h
              onPageResize(w, h)
            }} className={`px-2 py-1 text-[10px] border rounded transition ${
              pageWidth === cfg.w && pageHeight === cfg.h
                ? 'bg-emerald-900/40 border-emerald-600 text-emerald-400'
                : pageWidth === cfg.h && pageHeight === cfg.w
                  ? 'bg-emerald-900/40 border-emerald-600 text-emerald-400'
                  : 'bg-[#2a2a3d] border-[#3a3a4d] text-slate-400 hover:bg-white/5'
            }`}>
              {cfg.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1.5 mt-1.5">
          <div>
            <span className="text-[10px] text-slate-500">Ancho (mm)</span>
            <input type="number" value={pageWidth} onChange={e => {
              const v = parseInt(e.target.value)
              if (v > 0 && v <= 1000) onPageResize(v, pageHeight)
            }} className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded outline-none focus:border-emerald-500" />
          </div>
          <div>
            <span className="text-[10px] text-slate-500">Alto (mm)</span>
            <input type="number" value={pageHeight} onChange={e => {
              const v = parseInt(e.target.value)
              if (v > 0 && v <= 1000) onPageResize(pageWidth, v)
            }} className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded outline-none focus:border-emerald-500" />
          </div>
        </div>
      </div>

      <hr className="border-[#2a2a3d]" />

      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Fondo</label>
        <div className="flex items-center gap-1.5 mt-1">
          <input type="color" value={background.color} onChange={e => handleBgColorChange(e.target.value)}
            className="w-8 h-8 rounded cursor-pointer border border-[#3a3a4d]" />
          <input type="text" value={background.color} onChange={e => handleBgColorChange(e.target.value)}
            className="flex-1 px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none font-mono" />
        </div>
        <div className="mt-1.5">
          {background.imageUrl ? (
            <div className="flex items-center gap-2">
              <img src={background.imageUrl} alt="bg" className="w-12 h-8 object-cover rounded border border-[#3a3a4d]" />
              <button onClick={() => bgFileInputRef.current?.click()} className="text-[10px] text-emerald-400 hover:underline">Cambiar</button>
              <button onClick={() => setBackground(prev => ({ ...prev, imageUrl: undefined }))} className="text-[10px] text-red-400 hover:underline">Quitar</button>
            </div>
          ) : (
            <button onClick={() => bgFileInputRef.current?.click()} className="w-full px-3 py-2 text-xs text-slate-400 border border-dashed border-[#3a3a4d] rounded-lg hover:bg-white/5 transition">
              + Imagen de fondo
            </button>
          )}
          <input ref={bgFileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" className="hidden" onChange={handleBgImageUpload} />
        </div>
      </div>

      <hr className="border-[#2a2a3d]" />

      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Vista</label>
        <div className="space-y-1.5 mt-1">
          <label className="flex items-center justify-between text-xs text-slate-300">
            <span>Grilla</span>
            <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} className="accent-emerald-500" />
          </label>
          {showGrid && (
            <select value={gridSize} onChange={e => setGridSize(Number(e.target.value))} className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded outline-none">
              {GRID_SIZES.map(s => <option key={s} value={s}>{s}px</option>)}
            </select>
          )}
          <label className="flex items-center justify-between text-xs text-slate-300">
            <span>Reglas</span>
            <input type="checkbox" checked={showRulers} onChange={e => setShowRulers(e.target.checked)} className="accent-emerald-500" />
          </label>
          <label className="flex items-center justify-between text-xs text-slate-300">
            <span>Márgenes</span>
            <input type="checkbox" checked={showMargins} onChange={e => setShowMargins(e.target.checked)} className="accent-emerald-500" />
          </label>
          {showMargins && (
            <div>
              <span className="text-[10px] text-slate-500">Margen (mm)</span>
              <input type="number" min={1} max={50} value={marginSize} onChange={e => setMarginSize(Number(e.target.value))}
                className="w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
            </div>
          )}
          <div>
            <span className="text-[10px] text-slate-500">Fondo del lienzo</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <input type="color" value={pasteboardColor} onChange={e => onPasteboardColorChange(e.target.value)}
                className="w-7 h-7 rounded border border-[#3a3a4d] cursor-pointer bg-transparent p-0.5" />
              <input type="text" value={pasteboardColor} onChange={e => onPasteboardColorChange(e.target.value)}
                className="flex-1 px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none" />
            </div>
          </div>
        </div>
      </div>

      <div className="text-xs text-slate-500 text-center pt-2">
        {allObjects.length} elemento{allObjects.length !== 1 ? 's' : ''} en el lienzo
      </div>
    </>
  )
}


// ─── Layers Panel Sub-Component ─────────────────────────────────────────────

function LayersPanel({
  allObjects, selectedObjects, fabricRef, refreshObjectList, setRightTab, isInstance,
}: {
  allObjects: FabricObject[]
  selectedObjects: FabricObject[]
  fabricRef: React.MutableRefObject<FabricCanvasType | null>
  refreshObjectList: () => void
  setRightTab: (tab: 'properties' | 'layers') => void
  isInstance: (obj: any, type: string) => boolean
}) {
  if (allObjects.length === 0) {
    return (
      <div className="text-center py-8 text-slate-400">
        <Layers className="w-8 h-8 mx-auto mb-2 opacity-30" />
        <p className="text-xs">Sin elementos</p>
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {[...allObjects].reverse().map((obj, i) => {
        const isSelected = selectedObjects.includes(obj)
        const isDynamic = isInstance(obj, 'DynamicText') && (obj as any).isDynamic
        const isGroup = isInstance(obj, 'Group')
        const isLocked = obj.lockMovementX
        const name = (obj as any).elementName || (obj as any).text?.substring(0, 20) || obj.type || 'Objeto'

        return (
          <div
            key={i}
            onClick={() => { fabricRef.current?.setActiveObject(obj); fabricRef.current?.renderAll(); setRightTab('properties') }}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition ${isSelected ? 'bg-emerald-900/40 text-emerald-400' : 'hover:bg-white/5 text-slate-300'}`}
          >
            <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 opacity-50">
              {isInstance(obj, 'DynamicText') || isInstance(obj, 'FabricText') ? <Type className="w-3 h-3" /> :
               isInstance(obj, 'Rect') ? <Square className="w-3 h-3" /> :
               isInstance(obj, 'Ellipse') ? <Circle className="w-3 h-3" /> :
               isInstance(obj, 'Line') ? <Minus className="w-3 h-3" /> :
               isInstance(obj, 'FabricImage') ? <ImageIcon className="w-3 h-3" /> :
               isInstance(obj, 'Triangle') ? <Triangle className="w-3 h-3" /> :
               <Square className="w-3 h-3" />}
            </span>

            <span className="text-xs truncate flex-1">{name}</span>

            {isDynamic && <span className="text-[9px] px-1 py-0.5 bg-emerald-900/40 text-emerald-400 rounded font-bold">D</span>}
            {isGroup && <span className="text-[9px] px-1 py-0.5 bg-blue-900/40 text-blue-400 rounded font-bold">G</span>}

            <button
              onClick={(e) => { e.stopPropagation(); obj.set('visible', !obj.visible); fabricRef.current?.renderAll(); refreshObjectList() }}
              className="p-0.5 transition"
            >
              {obj.visible !== false ? <Eye className="w-3 h-3 text-slate-400" /> : <EyeOff className="w-3 h-3 text-slate-300" />}
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation()
                const locked = !obj.lockMovementX
                obj.set({ lockMovementX: locked, lockMovementY: locked, lockScalingX: locked, lockScalingY: locked, lockRotation: locked, hasControls: !locked })
                fabricRef.current?.renderAll()
                refreshObjectList()
              }}
              className="p-0.5 transition"
            >
              {isLocked ? <Lock className="w-3 h-3 text-amber-500" /> : <Unlock className="w-3 h-3 text-slate-300" />}
            </button>
          </div>
        )
      })}
    </div>
  )
}


// ─── Multi-Select Properties Panel ─────────────────────────────────────────
// Shows shared props across N selected objects. Mixed values show "—".
// Editing applies the new value to all objects in the selection.

function MultiSelectProperties({
  selectedObjects, fabricRef, pushHistory, isInstance, copiedFieldFormatRef,
}: {
  selectedObjects: FabricObject[]
  fabricRef: React.MutableRefObject<FabricCanvasType | null>
  pushHistory: () => void
  isInstance: (obj: any, type: string) => boolean
  copiedFieldFormatRef: React.MutableRefObject<import('@/lib/dynamicFieldFormat').FieldFormat | null>
}) {
  const count = selectedObjects.length
  const allText = selectedObjects.every(o => isInstance(o, 'DynamicText') || isInstance(o, 'FabricText'))
  const allDynamicField = selectedObjects.every(o => isInstance(o, 'DynamicText') && (o as any).isDynamic && (o as any).fieldName)
  const allShape = selectedObjects.every(o => isInstance(o, 'Rect') || isInstance(o, 'Ellipse') || isInstance(o, 'Triangle'))
  const allHaveFill = selectedObjects.every(o => (o as any).fill !== undefined)
  const allHaveStroke = selectedObjects.every(o => 'stroke' in (o as any))

  // Shared value helper: returns value if all equal, or null if mixed
  const shared = <T,>(read: (o: any) => T): T | null => {
    if (count === 0) return null
    const first = read(selectedObjects[0])
    for (let i = 1; i < count; i++) {
      if (read(selectedObjects[i]) !== first) return null
    }
    return first
  }

  const writeAll = (prop: string, value: any) => {
    const canvas = fabricRef.current
    if (!canvas) return
    selectedObjects.forEach(o => {
      o.set(prop as keyof FabricObject, value)
      o.setCoords()
    })
    canvas.renderAll()
    pushHistory()
  }

  // Bounding box of selection (page coords)
  const bbox = (() => {
    if (count === 0) return { left: 0, top: 0, width: 0, height: 0 }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    selectedObjects.forEach(o => {
      const b = (o as any).getBoundingRect() as { left: number; top: number; width: number; height: number }
      const canvas = fabricRef.current
      const vpt = canvas?.viewportTransform
      const zoom = canvas?.getZoom?.() ?? 1
      // Convert viewport → scene coords
      const sx = vpt ? (b.left - vpt[4]) / zoom : b.left
      const sy = vpt ? (b.top - vpt[5]) / zoom : b.top
      const sw = b.width / zoom
      const sh = b.height / zoom
      minX = Math.min(minX, sx)
      minY = Math.min(minY, sy)
      maxX = Math.max(maxX, sx + sw)
      maxY = Math.max(maxY, sy + sh)
    })
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY }
  })()

  const opacity = shared(o => o.opacity ?? 1)
  const angle = shared(o => Math.round(o.angle ?? 0))
  const fill = allHaveFill ? shared(o => String(o.fill ?? '')) : null
  const stroke = allHaveStroke ? shared(o => String(o.stroke ?? '')) : null
  const strokeWidth = allHaveStroke ? shared(o => o.strokeWidth ?? 0) : null
  const fontSize = allText ? shared(o => o.fontSize ?? 16) : null
  const fontFamily = allText ? shared(o => o.fontFamily ?? 'Arial') : null
  const fontWeight = allText ? shared(o => o.fontWeight ?? 'normal') : null
  const fontStyle = allText ? shared(o => o.fontStyle ?? 'normal') : null
  const underline = allText ? shared(o => Boolean(o.underline)) : null
  const textAlign = allText ? shared(o => o.textAlign ?? 'left') : null

  const inputCls = "w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none"
  const mixedPH = '—'

  return (
    <>
      <div className="flex items-center gap-2 px-1">
        <div className="w-7 h-7 rounded-md bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 text-[11px] font-bold">{count}</div>
        <div>
          <p className="text-xs font-semibold text-slate-100">Selección múltiple</p>
          <p className="text-[10px] text-slate-500">{count} objetos</p>
        </div>
      </div>

      <hr className="border-[#2a2a3d]" />

      {/* Bounding box (read-only) */}
      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Posición y tamaño (grupo)</label>
        <div className="grid grid-cols-2 gap-1.5 mt-1">
          <div>
            <span className="text-[10px] text-slate-500">X</span>
            <input type="number" readOnly value={Math.round(bbox.left)} className={inputCls + ' opacity-60 cursor-default'} />
          </div>
          <div>
            <span className="text-[10px] text-slate-500">Y</span>
            <input type="number" readOnly value={Math.round(bbox.top)} className={inputCls + ' opacity-60 cursor-default'} />
          </div>
          <div>
            <span className="text-[10px] text-slate-500">Ancho</span>
            <input type="number" readOnly value={Math.round(bbox.width)} className={inputCls + ' opacity-60 cursor-default'} />
          </div>
          <div>
            <span className="text-[10px] text-slate-500">Alto</span>
            <input type="number" readOnly value={Math.round(bbox.height)} className={inputCls + ' opacity-60 cursor-default'} />
          </div>
        </div>
      </div>

      <hr className="border-[#2a2a3d]" />

      {/* Rotation + Opacity */}
      <div>
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Apariencia</label>
        <div className="grid grid-cols-2 gap-1.5 mt-1">
          <div>
            <span className="text-[10px] text-slate-500">Rotación (°)</span>
            <input
              type="number"
              value={angle ?? ''}
              placeholder={angle === null ? mixedPH : ''}
              onChange={e => writeAll('angle', Number(e.target.value))}
              className={inputCls}
            />
          </div>
          <div>
            <span className="text-[10px] text-slate-500">Opacidad</span>
            <input
              type="number" min={0} max={1} step={0.05}
              value={opacity ?? ''}
              placeholder={opacity === null ? mixedPH : ''}
              onChange={e => writeAll('opacity', Number(e.target.value))}
              className={inputCls}
            />
          </div>
        </div>
      </div>

      {/* Fill (shared) */}
      {allHaveFill && (
        <>
          <hr className="border-[#2a2a3d]" />
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Relleno</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="color"
                value={typeof fill === 'string' && fill.startsWith('#') ? fill : '#000000'}
                onChange={e => writeAll('fill', e.target.value)}
                className="w-9 h-9 rounded bg-[#2a2a3d] cursor-pointer"
              />
              <input
                type="text"
                value={fill ?? ''}
                placeholder={fill === null ? mixedPH : ''}
                onChange={e => writeAll('fill', e.target.value)}
                className={inputCls}
              />
            </div>
          </div>
        </>
      )}

      {/* Stroke (shared) */}
      {allHaveStroke && allShape && (
        <>
          <hr className="border-[#2a2a3d]" />
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Borde</label>
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              <input
                type="color"
                value={typeof stroke === 'string' && stroke.startsWith('#') ? stroke : '#000000'}
                onChange={e => writeAll('stroke', e.target.value)}
                className="w-full h-8 rounded bg-[#2a2a3d] cursor-pointer"
              />
              <input
                type="number" min={0} max={50} step={0.25}
                value={strokeWidth ?? ''}
                placeholder={strokeWidth === null ? mixedPH : ''}
                onChange={e => writeAll('strokeWidth', Number(e.target.value))}
                className={inputCls}
              />
            </div>
          </div>
        </>
      )}

      {/* Text (shared) */}
      {allText && (
        <>
          <hr className="border-[#2a2a3d]" />
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Texto</label>
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              <div className="col-span-2">
                <span className="text-[10px] text-slate-500">Familia</span>
                <input
                  type="text"
                  value={fontFamily ?? ''}
                  placeholder={fontFamily === null ? mixedPH : ''}
                  onChange={e => writeAll('fontFamily', e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <span className="text-[10px] text-slate-500">Tamaño</span>
                <input
                  type="number" min={6} max={500}
                  value={fontSize ?? ''}
                  placeholder={fontSize === null ? mixedPH : ''}
                  onChange={e => writeAll('fontSize', Number(e.target.value))}
                  className={inputCls}
                />
              </div>
              <div>
                <span className="text-[10px] text-slate-500">Color</span>
                <input
                  type="color"
                  value={typeof fill === 'string' && fill.startsWith('#') ? fill : '#000000'}
                  onChange={e => writeAll('fill', e.target.value)}
                  className="w-full h-7 rounded bg-[#2a2a3d] cursor-pointer"
                />
              </div>
            </div>
            <div className="flex items-center gap-1 mt-2">
              <button
                onClick={() => writeAll('fontWeight', fontWeight === 'bold' ? 'normal' : 'bold')}
                className={`flex-1 px-2 py-1 text-xs rounded border ${fontWeight === 'bold' ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-[#2a2a3d] border-[#3a3a4d] text-slate-300'}`}
                title={fontWeight === null ? 'Negrita (mixto)' : 'Negrita'}
              ><strong>B</strong></button>
              <button
                onClick={() => writeAll('fontStyle', fontStyle === 'italic' ? 'normal' : 'italic')}
                className={`flex-1 px-2 py-1 text-xs rounded border ${fontStyle === 'italic' ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-[#2a2a3d] border-[#3a3a4d] text-slate-300'}`}
                title={fontStyle === null ? 'Cursiva (mixto)' : 'Cursiva'}
              ><em>I</em></button>
              <button
                onClick={() => writeAll('underline', !underline)}
                className={`flex-1 px-2 py-1 text-xs rounded border ${underline === true ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-[#2a2a3d] border-[#3a3a4d] text-slate-300'}`}
                title={underline === null ? 'Subrayado (mixto)' : 'Subrayado'}
              ><u>U</u></button>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1.5">
              {(['left', 'center', 'right', 'justify'] as const).map(a => (
                <button
                  key={a}
                  onClick={() => writeAll('textAlign', a)}
                  className={`px-2 py-1 text-[10px] rounded border ${textAlign === a ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-[#2a2a3d] border-[#3a3a4d] text-slate-300'}`}
                >{a}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Dynamic-field format (shared) */}
      {allDynamicField && (
        <>
          <hr className="border-[#2a2a3d]" />
          <DynamicFormatSection
            objs={selectedObjects as any[]}
            fabricRef={fabricRef}
            pushHistory={pushHistory}
            copiedFieldFormatRef={copiedFieldFormatRef}
          />
        </>
      )}

      <hr className="border-[#2a2a3d]" />
      <p className="text-[10px] text-slate-500 px-1">
        Los valores marcados con <span className="font-mono text-slate-400">—</span> tienen valores distintos en los objetos seleccionados. Editar aplica a todos.
      </p>
    </>
  )
}

// ─── Dynamic Field Format Section ──────────────────────────────────────────
// Excel-like format configuration for dynamic fields. Supports:
//  - single or multi-object edit
//  - live preview
//  - copy/paste format (paintbrush)

function DynamicFormatSection({
  objs, fabricRef, pushHistory, copiedFieldFormatRef,
}: {
  objs: any[]
  fabricRef: React.MutableRefObject<FabricCanvasType | null>
  pushHistory: () => void
  copiedFieldFormatRef: React.MutableRefObject<FieldFormat | null>
}) {
  const firstFmt: FieldFormat = objs[0]?.fieldFormat ?? DEFAULT_FIELD_FORMAT
  const allSameSerialized = objs.every(o => JSON.stringify(o.fieldFormat ?? DEFAULT_FIELD_FORMAT) === JSON.stringify(firstFmt))
  const fmt: FieldFormat = allSameSerialized ? firstFmt : DEFAULT_FIELD_FORMAT
  const mixed = !allSameSerialized

  const [, force] = useReducer((x: number) => x + 1, 0)

  const writeFormat = (updates: Partial<FieldFormat>) => {
    const canvas = fabricRef.current
    if (!canvas) return
    objs.forEach(o => {
      const current: FieldFormat = o.fieldFormat ?? DEFAULT_FIELD_FORMAT
      const next: FieldFormat = { ...current, ...updates }
      o.set('fieldFormat', next)
      // Force re-render of preview text so the editor shows the formatted marker
      // (actual value only shows during generation — editor keeps the {{slug}} marker)
      o.setCoords()
    })
    canvas.renderAll()
    pushHistory()
    force()
  }

  const setType = (type: FieldFormatType) => {
    // When switching types, reset incompatible fields to sensible defaults
    const base: FieldFormat = { ...fmt, type }
    if (type === 'number') {
      base.decimals = fmt.decimals ?? 2
      base.thousandsSep = fmt.thousandsSep ?? true
    } else if (type === 'currency') {
      base.decimals = fmt.decimals ?? 2
      base.thousandsSep = fmt.thousandsSep ?? true
      base.currency = fmt.currency ?? 'S/ '
      base.currencyPos = fmt.currencyPos ?? 'before'
    } else if (type === 'percent') {
      base.decimals = fmt.decimals ?? 2
    } else if (type === 'date' || type === 'datetime') {
      base.datePreset = fmt.datePreset ?? (type === 'datetime' ? 'datetime_short' : 'date_long_es')
    }
    writeFormat(base)
  }

  // Sample values for live preview by type
  const sampleFor = (t: FieldFormatType): number | Date | string | boolean | '' => {
    switch (t) {
      case 'number':
      case 'currency':
      case 'percent':
        return 12345.678
      case 'date':
      case 'datetime':
        return new Date()
      case 'text':
      case 'custom':
        return 'Texto de ejemplo'
      default:
        return 12345.678
    }
  }
  const preview = formatFieldValue(sampleFor(fmt.type), fmt)

  const selCls = "w-full px-2 py-1 text-xs text-slate-100 bg-[#2a2a3d] border border-[#3a3a4d] rounded focus:bg-[#333348] focus:border-emerald-500 outline-none"
  const inputCls = selCls

  const canPaste = copiedFieldFormatRef.current != null

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
          Formato {mixed && <span className="text-amber-400 normal-case font-normal">(mixto)</span>}
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { copiedFieldFormatRef.current = { ...fmt }; force() }}
            disabled={mixed}
            title={mixed ? 'No se puede copiar un formato mixto' : 'Copiar formato'}
            className="p-1 rounded bg-[#2a2a3d] border border-[#3a3a4d] text-slate-300 hover:text-emerald-400 hover:border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Paintbrush className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (!copiedFieldFormatRef.current) return
              writeFormat({ ...copiedFieldFormatRef.current })
            }}
            disabled={!canPaste}
            title={canPaste ? 'Pegar formato' : 'Copia primero un formato'}
            className="p-1 rounded bg-[#2a2a3d] border border-[#3a3a4d] text-slate-300 hover:text-emerald-400 hover:border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-1.5 space-y-1.5">
        <div>
          <span className="text-[10px] text-slate-500">Tipo</span>
          <select value={fmt.type} onChange={e => setType(e.target.value as FieldFormatType)} className={selCls}>
            <option value="general">General</option>
            <option value="number">Número</option>
            <option value="currency">Moneda</option>
            <option value="percent">Porcentaje</option>
            <option value="date">Fecha</option>
            <option value="datetime">Fecha y hora</option>
            <option value="text">Texto</option>
            <option value="custom">Personalizado</option>
          </select>
        </div>

        {(fmt.type === 'number' || fmt.type === 'currency' || fmt.type === 'percent') && (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <span className="text-[10px] text-slate-500">Decimales</span>
                <input type="number" min={0} max={10} value={fmt.decimals ?? 2}
                  onChange={e => writeFormat({ decimals: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
                  className={inputCls} />
              </div>
              <div>
                <span className="text-[10px] text-slate-500">Separador miles</span>
                <select value={(fmt.thousandsSep ?? true) ? 'yes' : 'no'}
                  onChange={e => writeFormat({ thousandsSep: e.target.value === 'yes' })} className={selCls}>
                  <option value="yes">Sí (1,234)</option>
                  <option value="no">No (1234)</option>
                </select>
              </div>
            </div>
            {fmt.type === 'currency' && (
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <span className="text-[10px] text-slate-500">Símbolo</span>
                  <input type="text" value={fmt.currency ?? 'S/ '}
                    onChange={e => writeFormat({ currency: e.target.value })}
                    className={inputCls} placeholder="S/ " />
                </div>
                <div>
                  <span className="text-[10px] text-slate-500">Posición</span>
                  <select value={fmt.currencyPos ?? 'before'}
                    onChange={e => writeFormat({ currencyPos: e.target.value as 'before' | 'after' })} className={selCls}>
                    <option value="before">Antes</option>
                    <option value="after">Después</option>
                  </select>
                </div>
              </div>
            )}
          </>
        )}

        {(fmt.type === 'date' || fmt.type === 'datetime') && (() => {
          const currentPreset = fmt.datePreset ?? (fmt.type === 'datetime' ? 'dd/MM/yyyy HH:mm' : 'dd/MM/yyyy')
          const matchesPreset = DATE_PRESETS.some(p => p.value === currentPreset)
          const selectValue = matchesPreset ? currentPreset : 'custom'
          return (
            <>
              <div>
                <span className="text-[10px] text-slate-500">Preset</span>
                <select value={selectValue}
                  onChange={e => {
                    if (e.target.value === 'custom') {
                      // Keep the current pattern; if it already matches a preset, start with same
                      writeFormat({ datePreset: currentPreset })
                    } else {
                      writeFormat({ datePreset: e.target.value })
                    }
                  }}
                  className={selCls}>
                  {DATE_PRESETS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                  <option value="custom">Personalizado…</option>
                </select>
              </div>
              {!matchesPreset && (
                <div>
                  <span className="text-[10px] text-slate-500">Patrón</span>
                  <input type="text" value={currentPreset}
                    onChange={e => writeFormat({ datePreset: e.target.value })}
                    className={inputCls} placeholder="dd/MM/yyyy HH:mm" />
                  <span className="text-[9px] text-slate-500 block mt-0.5">dd, MM, MMMM, yyyy, HH, mm, ss, EEEE</span>
                </div>
              )}
            </>
          )
        })()}

        {(fmt.type === 'text' || fmt.type === 'custom' || fmt.type === 'number' || fmt.type === 'currency' || fmt.type === 'percent' || fmt.type === 'date' || fmt.type === 'datetime') && (
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <span className="text-[10px] text-slate-500">Prefijo</span>
              <input type="text" value={fmt.prefix ?? ''}
                onChange={e => writeFormat({ prefix: e.target.value })}
                className={inputCls} />
            </div>
            <div>
              <span className="text-[10px] text-slate-500">Sufijo</span>
              <input type="text" value={fmt.suffix ?? ''}
                onChange={e => writeFormat({ suffix: e.target.value })}
                className={inputCls} />
            </div>
          </div>
        )}

        {fmt.type === 'text' && (
          <div>
            <span className="text-[10px] text-slate-500">Transformar</span>
            <select value={fmt.transform ?? 'none'}
              onChange={e => writeFormat({ transform: e.target.value as TextTransform })} className={selCls}>
              <option value="none">Sin cambio</option>
              <option value="uppercase">MAYÚSCULAS</option>
              <option value="lowercase">minúsculas</option>
              <option value="capitalize">Capitalizar</option>
            </select>
          </div>
        )}

        {fmt.type === 'custom' && (
          <div>
            <span className="text-[10px] text-slate-500">Patrón personalizado</span>
            <textarea rows={2} value={fmt.pattern ?? ''}
              onChange={e => writeFormat({ pattern: e.target.value })}
              className={inputCls + ' font-mono resize-y'}
              placeholder="#,##0.00 &quot;soles&quot;" />
            <span className="text-[9px] text-slate-500 block mt-0.5">Excel-like: 0, #, ,, . y secciones ; para positivos;negativos;cero</span>
          </div>
        )}

        <div className="mt-2 p-2 rounded bg-[#14141c] border border-[#2a2a3d]">
          <span className="text-[9px] text-slate-500 uppercase tracking-wider">Vista previa</span>
          <div className="text-xs text-emerald-300 font-mono break-all mt-0.5">{preview || '(vacío)'}</div>
        </div>
      </div>
    </div>
  )
}

