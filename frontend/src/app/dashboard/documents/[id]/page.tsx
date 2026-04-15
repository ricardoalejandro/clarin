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
} from 'lucide-react'
import { api, apiUpload } from '@/lib/api'
import type { DocumentTemplate } from '@/types/document'

// Lazy import fabric types — only on client
import type {
  Canvas as FabricCanvasType,
  FabricObject,
} from 'fabric'

import type { CanvasHistory as CanvasHistoryType } from '@/lib/fabric/history'
import type { SnapGuide, ExportOptions } from '@/lib/fabric'

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
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [showDynamicFields, setShowDynamicFields] = useState(false)
  const [rightTab, setRightTab] = useState<'properties' | 'layers'>('properties')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [allObjects, setAllObjects] = useState<FabricObject[]>([])
  const [editingText, setEditingText] = useState(false)
  const editingTextRef = useRef(false)
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
  const bgFileInputRef = useRef<HTMLInputElement>(null)
  const tableButtonRef = useRef<HTMLButtonElement>(null)
  const spaceHeldRef = useRef(false)
  const drawingRef = useRef<{ startX: number; startY: number; obj: FabricObject } | null>(null)
  const pendingDynamicRef = useRef<{ key: string; label: string; template: string } | null>(null)
  const userGuidesRef = useRef(userGuides)
  userGuidesRef.current = userGuides

  // Reference to dynamically imported fabric modules
  const fabricModRef = useRef<typeof import('@/lib/fabric') | null>(null)
  const fabricCoreRef = useRef<typeof import('fabric') | null>(null)

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
      canvas.on('text:editing:entered', () => { editingTextRef.current = true; setEditingText(true) })
      canvas.on('text:editing:exited', () => {
        editingTextRef.current = false
        setEditingText(false)
        historyRef.current?.save()
        updateHistoryState()
      })

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
  }, [template, templateName, background, pageWidth, pageHeight])

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
  const handleAlign = useCallback((alignment: string) => {
    const canvas = fabricRef.current
    if (!canvas || !hasSelection) return
    const docW = canvas.getWidth()
    const docH = canvas.getHeight()

    if (selectedObjects.length === 1) {
      const obj = selectedObjects[0]
      const bound = obj.getBoundingRect()
      const z = canvas.getZoom()
      const oW = bound.width / z
      const oH = bound.height / z
      switch (alignment) {
        case 'left': obj.set('left', 0); break
        case 'center-h': obj.set('left', (docW - oW) / 2); break
        case 'right': obj.set('left', docW - oW); break
        case 'top': obj.set('top', 0); break
        case 'center-v': obj.set('top', (docH - oH) / 2); break
        case 'bottom': obj.set('top', docH - oH); break
      }
      obj.setCoords()
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
  const DYNAMIC_FIELD_CATEGORIES = fabricModRef.current?.DYNAMIC_FIELD_CATEGORIES ?? []
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
              onClick={() => { setShowDynamicFields(!showDynamicFields); setShowTablePicker(false) }}
              title="Campos dinámicos"
              className={`p-2 rounded-lg transition ${showDynamicFields ? 'bg-emerald-900/40 text-emerald-400' : 'text-slate-400 hover:text-slate-200 hover:bg-white/10'}`}
            >
              <Layers className="w-4 h-4" />
            </button>
            {showDynamicFields && (
              <div className="absolute left-full ml-2 top-0 bg-[#252536] border border-[#3a3a4d] rounded-xl shadow-xl py-2 w-56 z-30 max-h-[60vh] overflow-y-auto">
                {DYNAMIC_FIELD_CATEGORIES.map((cat: any) => (
                  <div key={cat.label}>
                    <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{cat.label}</p>
                    {cat.fields.map((f: any) => (
                      <button
                        key={f.key}
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                        onClick={() => addDynamicField(f)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-300 hover:bg-emerald-900/30 hover:text-emerald-400 transition"
                      >
                        <span className="w-5 h-5 bg-emerald-900/40 rounded text-[9px] font-bold text-emerald-400 flex items-center justify-center flex-shrink-0">
                          {f.key.charAt(0).toUpperCase()}
                        </span>
                        {f.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
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
              {[
                { align: 'left', icon: AlignStartVertical },
                { align: 'center-h', icon: AlignCenterVertical },
                { align: 'right', icon: AlignEndVertical },
                { align: 'top', icon: AlignStartHorizontal },
                { align: 'center-v', icon: AlignCenterHorizontal },
                { align: 'bottom', icon: AlignEndHorizontal },
              ].map(({ align, icon: Icon }) => (
                <button key={align} onClick={() => handleAlign(align)} title={`Alinear ${align}`} className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition">
                  <Icon className="w-4 h-4" />
                </button>
              ))}
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
        <div ref={containerRef} className="flex-1 relative overflow-hidden" style={{ backgroundColor: pasteboardColor }} onClick={() => { setShowDynamicFields(false); setShowTablePicker(false) }} onContextMenu={(e) => e.preventDefault()}>
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

            {/* Snap guides */}
            {snapGuides.map((guide, i) => (
              guide.orientation === 'vertical' ? (
                <div key={i} className="absolute pointer-events-none" style={{
                  left: `${guide.position * zoom + (fabricRef.current?.viewportTransform?.[4] ?? 0)}px`,
                  top: 0, bottom: 0, width: '1px',
                  borderLeft: `1px dashed ${GUIDE_COLOR}`,
                  zIndex: 50,
                }} />
              ) : (
                <div key={i} className="absolute pointer-events-none" style={{
                  top: `${guide.position * zoom + (fabricRef.current?.viewportTransform?.[5] ?? 0)}px`,
                  left: 0, right: 0, height: '1px',
                  borderTop: `1px dashed ${GUIDE_COLOR}`,
                  zIndex: 50,
                }} />
              )
            ))}

            {/* User guides (persistent, from rulers) — draggable + right-click to delete */}
            {userGuides.map((guide) => (
              guide.orientation === 'v' ? (
                <div key={guide.id} className="absolute cursor-col-resize" style={{
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
                <div key={guide.id} className="absolute cursor-row-resize" style={{
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
                  SYSTEM_FONTS={SYSTEM_FONTS}
                  GOOGLE_FONTS={GOOGLE_FONTS}
                  bringForward={bringForward}
                  sendBackward={sendBackward}
                  bringToFront={bringToFront}
                  sendToBack={sendToBack}
                />
              ) : selectedObjects.length > 1 ? (
                <div className="text-center py-6 text-slate-400">
                  <p className="text-sm font-medium">{selectedObjects.length} objetos seleccionados</p>
                  <p className="text-xs text-slate-500 mt-1">Usa las herramientas de alineación o agrupa</p>
                </div>
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
  selectedObj, updateProp, pushHistory, isInstance, fabricRef, fileInputRef,
  SYSTEM_FONTS, GOOGLE_FONTS, bringForward, sendBackward, bringToFront, sendToBack,
}: {
  selectedObj: FabricObject
  updateProp: (prop: string, value: any) => void
  pushHistory: () => void
  isInstance: (obj: any, type: string) => boolean
  fabricRef: React.MutableRefObject<FabricCanvasType | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  SYSTEM_FONTS: string[]
  GOOGLE_FONTS: string[]
  bringForward: () => void
  sendBackward: () => void
  bringToFront: () => void
  sendToBack: () => void
}) {
  const obj = selectedObj as any
  const isText = isInstance(obj, 'DynamicText') || isInstance(obj, 'FabricText')
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
          </div>
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
                <input type="number" min={0} max={20} value={obj.strokeWidth || 0} onChange={e => updateProp('strokeWidth', Number(e.target.value))}
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
                <input type="number" min={1} max={20} value={obj.strokeWidth || 2} onChange={e => updateProp('strokeWidth', Number(e.target.value))}
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
            <button onClick={() => fileInputRef.current?.click()} className="w-full mt-1 px-3 py-2 text-xs text-slate-300 border border-dashed border-[#3a3a4d] rounded-lg hover:bg-white/5 transition">
              Reemplazar imagen
            </button>
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
