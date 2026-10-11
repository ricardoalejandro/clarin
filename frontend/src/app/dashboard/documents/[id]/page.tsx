"use client"

/**
 * Document Template Editor — Fabric.js 7.4
 * Full-featured design editor with snap guides, zoom to 1000%, dynamic fields, QR codes.
 */

import { useState, useEffect, useRef, useCallback, useReducer, useSyncExternalStore } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {flushSync} from 'react-dom'
import {commitFocusedEditorDraft} from '@/lib/fabric/shortcuts'
import {
  ArrowLeft, Save, Download, ZoomIn, ZoomOut, Undo2, Redo2, Type, Square, Circle,
  Image as ImageIcon, Minus, MousePointer, Trash2, Copy, Layers, Eye, EyeOff,
  Lock, Unlock, ChevronDown, AlignLeft, AlignCenter, AlignRight, Bold, Italic, Underline,
  FileDown, ImagePlus, Grid3X3, Hand,
  AlignStartVertical, AlignEndVertical, AlignCenterVertical,
  AlignStartHorizontal, AlignEndHorizontal, AlignCenterHorizontal,
  Ruler, FlipVertical2, Group, Ungroup, Triangle, Table2,
  Paintbrush, ClipboardPaste, MoreHorizontal, PanelRightClose, PanelRightOpen, Check, AlertCircle, X, MoveHorizontal, MoveVertical,
} from 'lucide-react'
import { api, apiUpload } from '@/lib/api'
import {getAuthScope,isAuthIdentityChanging,subscribeAuthScope} from '@/lib/authScope'
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
import EditorPopover from '@/components/documents/EditorPopover'
import EditorColorPicker from '@/components/documents/EditorColorPicker'
import EditorFontPicker from '@/components/documents/EditorFontPicker'
import EditorDesignProvider from '@/components/documents/EditorDesignContext'
import EditorLayers from '@/components/documents/EditorLayers'
import EditorImageControls, {ImageDraft} from '@/components/documents/EditorImageControls'
import EditorCommandMenu from '@/components/documents/EditorCommandMenu'
import EditorCommandIcon from '@/components/documents/EditorCommandIcon'
import {executeEditorCommand,resolveEditorCommand,type EditorCommandId,type EditorCommandState,type EditorCommandHandlers,type EditorCommandInvocation} from '@/lib/fabric/editorCommands'
import EditorConfirmDialog from '@/components/documents/EditorConfirmDialog'
import DocumentExportDialog from '@/components/documents/DocumentExportDialog'
import DocumentResourceAlert from '@/components/documents/DocumentResourceAlert'
import {DocumentImageLoadError} from '@/lib/documents/resourceErrors'
import { validateDocumentCanvas, validateDocumentTemplate } from '@/lib/documents/documentValidation'
import { editorSelection, isDocumentObject, isObjectLocked, applyObjectLock, ensureObjectIds, groupEditorSelection, ungroupEditorSelection, serializeWorldObjects, pasteWorldObjects, alignEditorSelection, distributeEditorSelection, coverImageCrop, editorInputOwnsKeyboard } from '@/lib/fabric/editorModel'
import { imageFrameChild,imageEditingTarget,imageTargetAtPoint,replaceEditorImage } from '@/lib/fabric/imageFrame'
import {liveDocumentImagePixels,documentImageBudgetError,imageFilterPixelFactor} from '@/lib/fabric/imageBudget'
import { createDocumentRenderSnapshot } from '@/lib/fabric/editorSnapshot'
import {installEditorNavigationGuard} from '@/lib/fabric/editorNavigation'
import {selectionPaintCapabilities} from '@/lib/fabric/selectionStyle'
import {createDocumentThumbnail} from '@/lib/fabric/editorThumbnail'


// ─── Page Component ───────────────────────────────────────────────────────────

export default function DocumentEditorPage() {
  const scope=useSyncExternalStore(subscribeAuthScope,getAuthScope,()=> 'server')
  if(scope==='server'||isAuthIdentityChanging(scope))return <div role="status" className="flex h-full items-center justify-center text-sm text-slate-500">Preparando las plantillas de la cuenta…</div>
  return <DocumentEditorWorkspace key={scope}/>
}
function DocumentEditorWorkspace() {
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
  const [pasteboardColor, setPasteboardColorState] = useState('#E8EDF3')
  const [pageWidth, setPageWidth] = useState(210)
  const [pageHeight, setPageHeight] = useState(297)
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
  const [distanceLabels, setDistanceLabels] = useState<DistanceLabel[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [showDynamicFields, setShowDynamicFields] = useState(false)
  const [rightTab, setRightTab] = useState<'properties' | 'layers'>('properties')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; scene?:{x:number;y:number};documentActions?:boolean } | null>(null)
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
  const clipboardRef = useRef<Record<string, unknown>[]>([])
  const clipboardAbortRef=useRef(new AbortController())
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const replaceImageInputRef = useRef<HTMLInputElement>(null)
  const imageInsertPointRef=useRef<{x:number;y:number}|undefined>(undefined)
  const imageReplaceTargetRef=useRef<FabricObject|null>(null)
  const [imageEditorTarget,setImageEditorTarget]=useState<{image:any;frame?:any;point:{x:number;y:number}}|null>(null)
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
  const fabricCoreRef = useRef<typeof import('@/lib/fabric/runtime') | null>(null)

  const [editorError, setEditorError] = useState('')
  const [imageLoadError, setImageLoadError] = useState<DocumentImageLoadError | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [conflict, setConflict] = useState<DocumentTemplate | null>(null)
  const [loadNonce, setLoadNonce] = useState(0)
  const [leaveTarget, setLeaveTarget] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [surfaceWidth, setSurfaceWidth] = useState(1200)
  const [uploading, setUploading] = useState(false)
  const [alignToPage, setAlignToPage] = useState(false)
  const [brushColor, setBrushColor] = useState('#0F172A')
  const [brushWidth, setBrushWidth] = useState(2)
  const [editingGroup, setEditingGroup] = useState<FabricObject | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const latestActionsRef = useRef<Record<string, (...args:any[])=>any>>({})
  const templateRef = useRef<DocumentTemplate | null>(null)
  const sessionRef = useRef(0)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const savedSnapshotRef = useRef('')
  const saveLockRef = useRef(false)
  const saveAbortRef=useRef<AbortController|null>(null)
  const deleteAbortRef=useRef<AbortController|null>(null)
  const [deleting,setDeleting]=useState(false)
  const [restoring,setRestoring]=useState(false)
  const [commandPending,setCommandPending]=useState(false)
  const commandBusyRef=useRef(false)
  const pendingNavigationRef=useRef<(()=>void)|null>(null)
  const dirtyRef = useRef(false)
  const documentSettingsRef = useRef<any>({})
  documentSettingsRef.current = {name:templateName,pageWidth,pageHeight,background,showGrid,gridSize,showRulers,showMargins,marginSize,pasteboardColor,userGuides}
  dirtyRef.current = dirty
  const captureDocument = () => {
    const canvas=fabricRef.current,mod=fabricModRef.current
    if(!canvas||!mod)return null
    const state=documentSettingsRef.current
    return {...state,canvasJson:mod.canvasToTemplateJson(canvas,state.background)}
  }
  const reconcileDirty = () => {
    const next=JSON.stringify(captureDocument())
    setDirty(!!savedSnapshotRef.current&&next!==savedSnapshotRef.current)
    setCanUndo(historyRef.current?.canUndo??false);setCanRedo(historyRef.current?.canRedo??false)
  }
  const requestLeave = (href:string) => {if(dirtyRef.current)setLeaveTarget(href);else router.push(href)}
  const continueLeave=(target:string)=>{
    dirtyRef.current=false;setDirty(false);setLeaveTarget(null)
    if(target==='history'){const resume=pendingNavigationRef.current;pendingNavigationRef.current=null;resume?.()}
    else if(target==='reload')setLoadNonce(n=>n+1)
    else router.push(target)
  }
  useEffect(()=>installEditorNavigationGuard(window,()=>dirtyRef.current,resume=>{pendingNavigationRef.current=resume;setLeaveTarget('history')}),[])
  useEffect(()=>{
    const before=(e:BeforeUnloadEvent)=>{if(dirtyRef.current){e.preventDefault();e.returnValue=''}}
    const links=(e:MouseEvent)=>{const a=(e.target as HTMLElement)?.closest<HTMLAnchorElement>('a[href]');if(!dirtyRef.current||!a||a.target==='_blank'||e.ctrlKey||e.metaKey||a.download)return;const next=new URL(a.href,location.href);if(next.href===location.href)return;e.preventDefault();e.stopPropagation();setLeaveTarget(next.href)}
    window.addEventListener('beforeunload',before);document.addEventListener('click',links,true)
    return()=>{window.removeEventListener('beforeunload',before);document.removeEventListener('click',links,true);uploadAbortRef.current?.abort()}
  },[])
  useEffect(()=>{const el=surfaceRef.current;if(!el)return;const observer=new ResizeObserver(entries=>setSurfaceWidth(entries[0].contentRect.width));observer.observe(el);return()=>observer.disconnect()},[loading])
  useEffect(()=>{if(fabricReady){historyRef.current?.save();reconcileDirty()}},[templateName,pageWidth,pageHeight,background,showGrid,gridSize,showRulers,showMargins,marginSize,pasteboardColor,userGuides,fabricReady])

  // ─── Custom fields (from account) ─────────────────────────────────────
  const [customFields, setCustomFields] = useState<Array<{ id: string; name: string; slug: string }>>([])

  // ─── Derived ──────────────────────────────────────────────────────────
  const selectedObj = selectedObjects.length === 1 ? selectedObjects[0] : null
  const hasSelection = selectedObjects.length > 0

  // ─── Resource-scoped template session ───────────────────────────────
  useEffect(() => {
    const controller=new AbortController(),generation=++sessionRef.current
    clipboardAbortRef.current.abort();clipboardAbortRef.current=new AbortController()
    setLoading(true);setSaving(false);setEditorError('');setImageLoadError(null);setTemplate(null);setConflict(null);setDirty(false);savedSnapshotRef.current=''
    ;(async()=>{
      const res=await api<{template:DocumentTemplate}>(`/api/document-templates/${templateId}`,{signal:controller.signal})
      if(controller.signal.aborted||generation!==sessionRef.current)return
      if(res.success&&res.data?.template){const item=res.data.template;templateRef.current=item;setTemplate(item);setTemplateName(item.name);setPageWidth(item.page_width);setPageHeight(item.page_height)}
      else setEditorError(res.error||'No se pudo abrir la plantilla. Inténtalo de nuevo.')
      setLoading(false)
    })()
    return()=>{controller.abort();uploadAbortRef.current?.abort();saveAbortRef.current?.abort();deleteAbortRef.current?.abort();clipboardAbortRef.current.abort();sessionRef.current++}
  },[templateId,loadNonce])

  // Custom field definitions share the editor's account/resource lifetime.
  useEffect(()=>{
    const controller=new AbortController()
    void api<{fields:Array<{id:string;name:string;slug:string}>}>('/api/custom-fields/',{signal:controller.signal}).then(result=>{if(!controller.signal.aborted&&result.success&&Array.isArray(result.data?.fields))setCustomFields(result.data.fields)})
    return()=>controller.abort()
  },[])

  // ─── Suppress native context menu inside canvas area (capture phase) ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const h = (e: Event) => { e.preventDefault(); e.stopPropagation() }
    el.addEventListener('contextmenu', h, true)
    return () => el.removeEventListener('contextmenu', h, true)
  }, [fabricReady])

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
  }, [fabricReady])

  // ─── Initialize Fabric canvas ─────────────────────────────────────────
  useEffect(() => {
    if (!template || !canvasElRef.current || !containerRef.current) return

    let disposed = false
    const initialization=new AbortController()

    const initCanvas = async () => {
      // Dynamic import fabric (browser only)
      const fabricMod = await import('@/lib/fabric')
      const fabricCore = await import('@/lib/fabric/runtime')
      if (disposed) return

      fabricModRef.current = fabricMod
      fabricCoreRef.current = fabricCore

      await fabricMod.ensureFontsLoaded()
      if (disposed) return

      // Restore saved pasteboard color
      const savedPasteboard = ((template.canvas_json as any)?.editorSettings?.pasteboardColor as string) || '#E8EDF3'
      if (savedPasteboard) setPasteboardColorState(savedPasteboard)

      const canvas = fabricMod.createEditorCanvas({
        canvasEl: canvasElRef.current!,
        containerEl: canvasElRef.current!.parentElement!,
        pageWidth: pageWidth,
        pageHeight: pageHeight,
        pasteboardColor: savedPasteboard || '#E8EDF3',
        onZoomChange: (z) => setZoom(z),
        onSelectionChange: (objs) => { setSelectedObjects(objs); forceRender() },
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
          const target=opt.target
          const current=editorSelection(canvas)
          if(target&&isDocumentObject(target)&&!current.includes(target))canvas.setActiveObject(target)
          if(!target||!isDocumentObject(target))canvas.discardActiveObject()
          canvas.requestRenderAll()
          setContextMenu({ x: e.clientX, y: e.clientY,scene:canvas.getScenePoint(e) })
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
      canvas.on('text:changed', () => {setEditingSelVersion(v => v + 1);reconcileDirty()})

      // Load template data
      try {
        if (template.canvas_json && Object.keys(template.canvas_json).length > 0) {
          const invalid=validateDocumentCanvas(template.canvas_json);if(invalid)throw new Error(invalid)
          const bg = await fabricMod.loadTemplateToCanvas(canvas, template.canvas_json, pageWidth, pageHeight,initialization.signal)
          if (disposed) return
          setBackground(bg)
          documentSettingsRef.current={...documentSettingsRef.current,background:bg,...((template.canvas_json as any).editorSettings||{})}
          // Set page rect background color instead of canvas backgroundColor
          if (canvas.__pageRect) {
            canvas.__pageRect.set('fill', bg.color || '#ffffff')
          }
          fabricMod.ensurePageAtBottom(canvas)
          canvas.renderAll()

          // Restore persisted editor settings (margins, grid, rulers, pasteboard)
          const es = (template.canvas_json as any).editorSettings
          if (es && typeof es === 'object') {
            if (Array.isArray(es.userGuides)) setUserGuides(es.userGuides)
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
        if (disposed || initialization.signal.aborted) return
        if (err instanceof DocumentImageLoadError) setImageLoadError(err)
        else setEditorError(err instanceof Error&&/^(Las imágenes|Una imagen)/.test(err.message)?err.message:'No se pudieron cargar todos los recursos. Reintenta antes de editar o guardar.')
        return
      }

      ensureObjectIds(canvas.getObjects().filter(isDocumentObject))
      canvas.backgroundColor=savedPasteboard
      documentSettingsRef.current={...documentSettingsRef.current,pasteboardColor:savedPasteboard}
      // Set up history
      const { CanvasHistory } = fabricMod
      const history = new CanvasHistory(canvas, {
        capture: captureDocument,
        restore: async (snapshot:any) => {
          await fabricMod.loadTemplateToCanvas(canvas,snapshot.canvasJson,snapshot.pageWidth,snapshot.pageHeight)
          documentSettingsRef.current={...snapshot}
          setTemplateName(snapshot.name);setPageWidth(snapshot.pageWidth);setPageHeight(snapshot.pageHeight);setBackground(snapshot.background)
          setShowGrid(snapshot.showGrid);setGridSize(snapshot.gridSize);setShowRulers(snapshot.showRulers);setShowMargins(snapshot.showMargins);setMarginSize(snapshot.marginSize);setPasteboardColorState(snapshot.pasteboardColor);setUserGuides(snapshot.userGuides||[])
          canvas.backgroundColor=snapshot.pasteboardColor;setSelectedObjects([]);setEditingGroup(null);refreshObjectList()
        },
        onChange: reconcileDirty,
      })
      history.init()
      historyRef.current = history
      savedSnapshotRef.current=JSON.stringify(captureDocument());setDirty(false)
      canvas.on('path:created',()=>{ensureObjectIds(canvas.getObjects().filter(isDocumentObject));pushHistory()})
      canvas.on('mouse:dblclick',(event:any)=>{const target=event.target;if(target instanceof fabricCoreRef.current!.Group && !(target instanceof fabricCoreRef.current!.ActiveSelection) && !isObjectLocked(target)){target.set({interactive:true,subTargetCheck:true});setEditingGroup(target);canvas.requestRenderAll()}})

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

    initCanvas().catch(()=>{
      if (!disposed && !initialization.signal.aborted) setEditorError('No se pudo preparar el editor. Reintenta la carga.')
    })

    return () => {
      disposed = true
      initialization.abort()
      // Clean up middle mouse event listeners before dispose
      if (fabricRef.current) {
        ;(fabricRef.current as any).__cleanupMiddleMouse?.()
      }
      fabricRef.current?.dispose()
      fabricRef.current = null
      setFabricReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.id])

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
        fabricMod.resizeCanvas(fabricRef.current,(fabricRef.current as any).wrapperEl?.parentElement||container)
        fabricRef.current.calcOffset();fabricRef.current.requestRenderAll();forceRender()
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
      if (editorInputOwnsKeyboard(e.target)) return
      if (e.code === 'Space' && !editingText) {
        e.preventDefault()
        spaceHeldRef.current = true
        if (fabricRef.current) {
          fabricRef.current.setCursor('grab')
          fabricRef.current.selection = false
          fabricRef.current.__panActive = true
          fabricRef.current.skipTargetFind=true
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
          fabricRef.current.skipTargetFind=activeTool!=='select'
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

      ;(obj as any).__editorPreview=true
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
      if(e.shiftKey){const dx=point.x-startX,dy=point.y-startY;if(drawingTool==='line'){const angle=Math.round(Math.atan2(dy,dx)/(Math.PI/4))*(Math.PI/4),distance=Math.hypot(dx,dy);point.x=startX+Math.cos(angle)*distance;point.y=startY+Math.sin(angle)*distance}else{const size=Math.max(Math.abs(dx),Math.abs(dy));point.x=startX+Math.sign(dx||1)*size;point.y=startY+Math.sign(dy||1)*size}}
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

      delete (obj as any).__editorPreview
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
      if(drawingRef.current)canvas.remove(drawingRef.current.obj)
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
      onCommand:id=>latestActionsRef.current.command(id),
      onChanged:()=>latestActionsRef.current.changed(),
      isEditingText: () => editingTextRef.current,
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
    ensureObjectIds(fabricRef.current.getObjects().filter(isDocumentObject));setAllObjects([...fabricRef.current.getObjects().filter(isDocumentObject)])
  }, [])

  const pushHistory = useCallback(() => {
    refreshObjectList()
    historyRef.current?.save()
    updateHistoryState()
  }, [updateHistoryState, refreshObjectList])

  // Saving acknowledges exactly the captured version, never later edits.
  const handleSave = useCallback(async (asCopy=false) => {
    if(historyRef.current?.busy||commandBusyRef.current||uploadAbortRef.current){setEditorError('Espera a que termine la operación actual antes de guardar.');return false}
    if(saveLockRef.current||!fabricRef.current||!templateRef.current||!fabricModRef.current)return false
    const captured=captureDocument();if(!captured)return false
    const current=templateRef.current,generation=sessionRef.current
    const canvasJson={...captured.canvasJson,editorSettings:{showMargins:captured.showMargins,marginSize:captured.marginSize,showGrid:captured.showGrid,gridSize:captured.gridSize,showRulers:captured.showRulers,pasteboardColor:captured.pasteboardColor,userGuides:captured.userGuides}}
    const payload={name:asCopy?captured.name+' (copia)':captured.name,description:current.description,canvas_json:canvasJson,thumbnail_url:current.thumbnail_url,page_width:captured.pageWidth,page_height:captured.pageHeight,page_orientation:captured.pageWidth>captured.pageHeight?'landscape':'portrait',fields_used:fabricModRef.current.extractFieldsUsed(fabricRef.current),...(!asCopy?{expected_revision:current.revision}: {source_template_id:current.id})}
    const validation=validateDocumentTemplate(payload)
    if(validation){setEditorError(validation);return false}
    saveLockRef.current=true;setSaving(true);setEditorError('');setSaveMessage('')
    const controller=new AbortController();saveAbortRef.current=controller
    const timeout=setTimeout(()=>controller.abort(),30000)
    let thumbnailFailed=false
    try {
      try {
        const render={canvasJson:captured.canvasJson,width:captured.pageWidth*2,height:captured.pageHeight*2}
        const {StaticCanvas}=await import('@/lib/fabric/runtime')
        const preview=new StaticCanvas(undefined,{width:render.width,height:render.height,renderOnAddRemove:false})
        try {
          await fabricModRef.current.loadTemplateToCanvas(preview,render.canvasJson,render.width/2,render.height/2,controller.signal)
          const blob=await createDocumentThumbnail(preview,render.width),form=new FormData();form.append('file',blob,'thumbnail.jpg');form.append('folder','document-thumbnails')
          const uploaded=await apiUpload('/api/document-templates/assets',form,{signal:controller.signal})
          if(uploaded.success&&uploaded.data)payload.thumbnail_url=(uploaded.data as any).proxy_url||(uploaded.data as any).public_url
          else thumbnailFailed=true
        } finally {await preview.dispose()}
      } catch {thumbnailFailed=true}
      if(generation!==sessionRef.current)return false
      controller.signal.throwIfAborted()
      const result=await api<{template:DocumentTemplate}>(asCopy?'/api/document-templates':`/api/document-templates/${current.id}`,{method:asCopy?'POST':'PUT',body:JSON.stringify(payload),signal:controller.signal})
      if(generation!==sessionRef.current)return false
      if(!result.success){
        if(result.status===409)setConflict(result.data?.template||null)
        setEditorError(result.error||'No se guardó la plantilla. Tus cambios siguen aquí.');return false
      }
      if(!result.data?.template){setEditorError('El servidor no confirmó la versión guardada. Reintenta.');return false}
      const canonical=result.data.template
      if(asCopy){
        if(JSON.stringify(captureDocument())!==JSON.stringify(captured)){setSaveMessage('Copia guardada. Hay cambios posteriores sin guardar.');setEditorError('La copia se guardó. Tus cambios más recientes siguen en esta plantilla para que puedas guardarlos también.');return true}
        dirtyRef.current=false;setDirty(false);router.replace('/dashboard/documents/'+canonical.id);return true
      }
      templateRef.current=canonical;setTemplate(canonical);setConflict(null)
      const canonicalSnapshot={...captured,name:canonical.name}
      if(documentSettingsRef.current.name===captured.name){documentSettingsRef.current.name=canonical.name;setTemplateName(canonical.name)}
      savedSnapshotRef.current=JSON.stringify(canonicalSnapshot);reconcileDirty();setSaveMessage(thumbnailFailed?'Cambios guardados. La miniatura se actualizará al volver a guardar.':'Guardado')
      return true
    } catch {setEditorError('No se pudo confirmar el guardado. Tu borrador se conserva; comprueba la versión actual antes de volver a intentarlo.');return false}
    finally {clearTimeout(timeout);if(saveAbortRef.current===controller)saveAbortRef.current=null;saveLockRef.current=false;if(generation===sessionRef.current)setSaving(false)}
  },[])

  const handleDeleteTemplate=useCallback(async()=>{
    const current=templateRef.current;if(!current||deleteAbortRef.current)return
    const controller=new AbortController(),generation=sessionRef.current;deleteAbortRef.current=controller;setDeleting(true)
    const timeout=setTimeout(()=>controller.abort(),30000)
    try{
      const result=await api('/api/document-templates/'+current.id+'?expected_revision='+current.revision,{method:'DELETE',signal:controller.signal})
      if(generation!==sessionRef.current)return
      if(!result.success){setEditorError(result.error||'No se pudo eliminar la plantilla.');return}
      dirtyRef.current=false;setDirty(false);router.push('/dashboard/documents')
    }finally{clearTimeout(timeout);if(deleteAbortRef.current===controller)deleteAbortRef.current=null;if(generation===sessionRef.current){setDeleting(false);setDeleteConfirm(false)}}
  },[router])

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
        ;(previewRect as any).__editorPreview=true
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

  const prepareImage=useCallback(async(file:File,apply:(url:string,signal:AbortSignal)=>Promise<void>,replaced?:FabricObject)=>{
    if(!fabricRef.current||!fabricReady)return
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)){setEditorError('Elige una imagen PNG, JPEG, WebP o GIF.');return}
    if(file.size>10*1024*1024){setEditorError('La imagen supera el límite de 10 MB.');return}
    uploadAbortRef.current?.abort();const controller=new AbortController();uploadAbortRef.current=controller
    const generation=sessionRef.current;setUploading(true);setEditorError('')
    const timeout=setTimeout(()=>controller.abort(),30000)
    try{
      const bitmap=await createImageBitmap(file);const pixels=bitmap.width*bitmap.height;bitmap.close()
      const allocatedPixels=pixels*imageFilterPixelFactor((replaced as any)?.filters)
      const budgetError=documentImageBudgetError(liveDocumentImagePixels(fabricRef.current,replaced)+allocatedPixels,allocatedPixels)
      if(budgetError)throw new Error(budgetError)
      controller.signal.throwIfAborted()
      const form=new FormData();form.append('file',file);form.append('folder','document-images')
      const result=await apiUpload('/api/document-templates/assets',form,{signal:controller.signal})
      if(controller.signal.aborted||generation!==sessionRef.current)return
      const url=(result.data as any)?.proxy_url||(result.data as any)?.public_url
      if(!result.success||!url)throw new Error(result.error||'No se pudo subir la imagen.')
      await apply(url,controller.signal)
      if(controller.signal.aborted||generation!==sessionRef.current)return
      pushHistory();setActiveTool('select')
    }catch(error){if(!controller.signal.aborted&&generation===sessionRef.current)setEditorError(error instanceof Error?error.message:'No se pudo preparar la imagen. Reintenta.')}
    finally{clearTimeout(timeout);if(uploadAbortRef.current===controller){setUploading(false);uploadAbortRef.current=null}}
  },[fabricReady,pushHistory])
  const insertImage=useCallback(async(file:File,point?:{x:number;y:number})=>{
    const canvas=fabricRef.current,fc=fabricCoreRef.current;if(!canvas||!fc)return
    await prepareImage(file,async(url,signal)=>{
      const image=await fc.FabricImage.fromURL(url,{crossOrigin:'anonymous',signal});signal.throwIfAborted()
      const w=canvas.__pageWidth||canvas.width,h=canvas.__pageHeight||canvas.height
      const scale=Math.min(w*.6/image.width,h*.6/image.height,1)
      image.set({left:point?.x??(w-image.width*scale)/2,top:point?.y??(h-image.height*scale)/2,scaleX:scale,scaleY:scale})
      canvas.add(image);canvas.setActiveObject(image);canvas.requestRenderAll()
    })
  },[prepareImage])
  const handleImageUpload=(e:React.ChangeEvent<HTMLInputElement>)=>{const file=e.target.files?.[0],point=imageInsertPointRef.current;imageInsertPointRef.current=undefined;e.target.value='';if(file)void insertImage(file,point)}
  const replaceImageOnObject=useCallback(async(target:any,file:File)=>{
    const canvas=fabricRef.current;if(!canvas||isObjectLocked(target))return
    await prepareImage(file,async(url,signal)=>{
      const next=await fabricCoreRef.current!.FabricImage.fromURL(url,{crossOrigin:'anonymous',signal});signal.throwIfAborted()
      replaceEditorImage(canvas,target,next)
    },imageEditingTarget(target)?.image||target)
  },[prepareImage])
  const handleReplaceImageInput=(e:React.ChangeEvent<HTMLInputElement>)=>{const file=e.target.files?.[0],target=imageReplaceTargetRef.current||fabricRef.current?.getActiveObject();imageReplaceTargetRef.current=null;e.target.value='';if(file&&target)void replaceImageOnObject(target,file)}
  const [dragOverTarget,setDragOverTarget]=useState<FabricObject|null>(null)
  const getImageObjAtPointer=useCallback((clientX:number,clientY:number)=>{
    const c=fabricRef.current,fc=fabricCoreRef.current;if(!c||!fc)return null
    const point=c.getScenePoint(new MouseEvent('mousemove',{clientX,clientY}))
    return imageTargetAtPoint(c.getObjects().filter(isDocumentObject),point)
  },[])
  const handleCanvasDragOver=(e:React.DragEvent<HTMLDivElement>)=>{if(!e.dataTransfer.types.includes('Files'))return;e.preventDefault();const target=getImageObjAtPointer(e.clientX,e.clientY);e.dataTransfer.dropEffect=target&&isObjectLocked(target)?'none':'copy';setDragOverTarget(target&&!isObjectLocked(target)?target:null)}
  const handleCanvasDragLeave=(e:React.DragEvent<HTMLDivElement>)=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragOverTarget(null)}
  const handleCanvasDrop=async(e:React.DragEvent<HTMLDivElement>)=>{const file=e.dataTransfer.files[0];if(!file)return;e.preventDefault();setDragOverTarget(null);const target=getImageObjAtPointer(e.clientX,e.clientY),canvas=fabricRef.current;if(target)await replaceImageOnObject(target,file);else if(canvas)await insertImage(file,canvas.getScenePoint(e.nativeEvent))}
  const handleBgImageUpload=(e:React.ChangeEvent<HTMLInputElement>)=>{const file=e.target.files?.[0];e.target.value='';if(file)void prepareImage(file,async(url,signal)=>{signal.throwIfAborted();setBackground(prev=>({...prev,imageUrl:url}))},fabricRef.current?.getObjects().find(o=>(o as any).__isDocumentBackground))}

  // ─── Object operations ────────────────────────────────────────────────
  const deleteSelected = useCallback(() => {
    const canvas = fabricRef.current
    const fc = fabricCoreRef.current
    if (!canvas || !fc) return
    const active = canvas.getActiveObject()
    if (!active) return
    if (editorSelection(canvas).some(isObjectLocked)) return
    if ((active as any).__isPage) return  // Never delete the page rect
    if (active instanceof fc.ActiveSelection) {
      active.forEachObject(o => {
        if (!(o as any).__isPage) canvas.remove(o)
      })
    } else {
      (active.parent||canvas).remove(active)
    }
    canvas.discardActiveObject()
    canvas.renderAll()
    pushHistory()
  }, [pushHistory])

  const runResourceCommand=useCallback(async(run:()=>Promise<void>)=>{
    if(commandBusyRef.current||historyRef.current?.busy)return
    commandBusyRef.current=true;setCommandPending(true)
    const generation=sessionRef.current
    try{await run()}finally{commandBusyRef.current=false;if(generation===sessionRef.current)setCommandPending(false)}
  },[])
  const duplicateSelected = useCallback(async () => {
    const canvas=fabricRef.current;if(!canvas)return
    await runResourceCommand(async()=>{
      const generation=sessionRef.current,objects=await serializeWorldObjects(editorSelection(canvas))
      if(generation!==sessionRef.current)return
      try{await pasteWorldObjects(canvas,objects,undefined,clipboardAbortRef.current.signal);pushHistory()}catch{if(generation===sessionRef.current)setEditorError('No se pudo duplicar el recurso. Reintenta.')}
    })
  },[pushHistory,runResourceCommand])
  const copySelected = useCallback(async () => {
    const canvas=fabricRef.current;if(!canvas)return
    const generation=sessionRef.current,data=await serializeWorldObjects(editorSelection(canvas))
    if(generation===sessionRef.current){clipboardRef.current=data;forceRender()}
  },[])
  const pasteClipboard = useCallback(async (point?:{x:number;y:number}) => {
    const canvas=fabricRef.current;if(!canvas||!clipboardRef.current.length)return
    await runResourceCommand(async()=>{
      const generation=sessionRef.current
      try{await pasteWorldObjects(canvas,clipboardRef.current,point,clipboardAbortRef.current.signal);pushHistory()}catch{if(generation===sessionRef.current)setEditorError('No se pudo pegar el recurso. Reintenta.')}
    })
  },[pushHistory,runResourceCommand])
  const groupSelected = useCallback(()=>{const c=fabricRef.current;if(c&&groupEditorSelection(c))pushHistory()},[pushHistory])
  const ungroupSelected = useCallback(()=>{const c=fabricRef.current;if(c&&ungroupEditorSelection(c).length){setEditingGroup(null);pushHistory()}},[pushHistory])

  const orderSelection=useCallback((direction:'up'|'down'|'front'|'back')=>{
    const canvas=fabricRef.current;if(!canvas)return
    const objects=editorSelection(canvas);if(objects.some(isObjectLocked))return
    canvas.discardActiveObject()
    const sorted=[...objects].sort((a,b)=>canvas.getObjects().indexOf(a)-canvas.getObjects().indexOf(b))
    if(direction==='up'||direction==='front')sorted.reverse()
    for(const object of sorted){const collection=object.parent||canvas,items=collection.getObjects(),index=items.indexOf(object),min=object.parent?0:items.filter(o=>!isDocumentObject(o)).length
      collection.moveObjectTo(object,direction==='front'?items.length-1:direction==='back'?min:Math.max(min,index+(direction==='up'?1:-1)))}
    if(objects.length)canvas.setActiveObject(objects.length===1?objects[0]:new fabricCoreRef.current!.ActiveSelection(objects,{canvas}))
    canvas.requestRenderAll();pushHistory()
  },[pushHistory])
  const bringForward=()=>orderSelection('up'),sendBackward=()=>orderSelection('down'),bringToFront=()=>orderSelection('front'),sendToBack=()=>orderSelection('back')

  const toggleLock = useCallback(() => {
    const objects=fabricRef.current?editorSelection(fabricRef.current):[]
    const locked=!objects.every(o=>o.lockMovementX)
    objects.forEach(o=>applyObjectLock(o,locked));fabricRef.current?.requestRenderAll();pushHistory()
  },[pushHistory])
  const handleAlign = useCallback((alignment:string)=>{if(fabricRef.current){alignEditorSelection(fabricRef.current,alignment,alignToPage||editorSelection(fabricRef.current).length===1);pushHistory()}},[alignToPage,pushHistory])

  // ─── Property update helper ───────────────────────────────────────────
  const updateProp = useCallback((prop: string, value: any) => {
    const canvas = fabricRef.current
    if (!canvas || !selectedObj || isObjectLocked(selectedObj)) return
    selectedObj.set(prop as keyof FabricObject, value)
    selectedObj.setCoords()
    canvas.renderAll()
    pushHistory()
  }, [selectedObj, pushHistory])

  // ─── Background color ─────────────────────────────────────────────────
  const handleBgColorChange = useCallback((color: string) => {
    documentSettingsRef.current.background={...documentSettingsRef.current.background,color}
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
    setRestoring(true)
    try {await historyRef.current?.undo()}catch{setEditorError('No se pudo deshacer: falta un recurso. Reintenta.');return}finally{setRestoring(false)}
    restorePageRect()
    updateHistoryState()
    refreshObjectList()
    fabricRef.current?.renderAll()
  }, [updateHistoryState, refreshObjectList, restorePageRect])

  const handleRedo = useCallback(async () => {
    setRestoring(true)
    try {await historyRef.current?.redo()}catch{setEditorError('No se pudo rehacer: falta un recurso. Reintenta.');return}finally{setRestoring(false)}
    restorePageRect()
    updateHistoryState()
    refreshObjectList()
    fabricRef.current?.renderAll()
  }, [updateHistoryState, refreshObjectList, restorePageRect])

  useEffect(()=>{
    const canvas=fabricRef.current,mod=fabricModRef.current;if(!canvas||!mod||!fabricReady)return
    const controller=new AbortController()
    mod.applyDocumentBackground(canvas,background,pageWidth,pageHeight,controller.signal).then(()=>{if(!controller.signal.aborted)canvas.requestRenderAll()}).catch(()=>{if(!controller.signal.aborted)setEditorError('No se pudo cargar el fondo. Reintenta la imagen.')})
    return()=>controller.abort()
  },[background,pageWidth,pageHeight,fabricReady])
  useEffect(()=>{
    const canvas=fabricRef.current,fc=fabricCoreRef.current;if(!canvas||!fc||!fabricReady)return
    canvas.isDrawingMode=activeTool==='pencil'
    if(canvas.isDrawingMode){const brush=new fc.PencilBrush(canvas);brush.color=brushColor;brush.width=brushWidth;canvas.freeDrawingBrush=brush}
    return()=>{canvas.isDrawingMode=false}
  },[activeTool,brushColor,brushWidth,fabricReady])
  const cancelEditorGesture=()=>{
    const canvas=fabricRef.current;if(!canvas)return
    canvas.__panActive=false;canvas.skipTargetFind=false;canvas.selection=true;canvas.defaultCursor='default'
    const drawing=drawingRef.current;if(drawing){canvas.remove(drawing.obj);drawingRef.current=null}
    if(canvas.isDrawingMode){canvas.isDrawingMode=false;(canvas as any)._isCurrentlyDrawing=false;canvas.clearContext(canvas.contextTop)}
    setDrawingTool(null);setActiveTool('select');setContextMenu(null)
    if(editingGroup){let target:any=editingGroup;target.set({interactive:false});while(target.parent){target=target.parent;target.set({interactive:false})}canvas.setActiveObject(target);setEditingGroup(null)}else canvas.discardActiveObject()
    canvas.requestRenderAll()
  }


  useEffect(()=>{const cancel=()=>{if(drawingRef.current||spaceHeldRef.current){spaceHeldRef.current=false;latestActionsRef.current.cancel?.()}};window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);return()=>{window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel)}},[])

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

  // All entry points execute this registry against the live Fabric selection.
  const getCommandState=():EditorCommandState=>{
    const canvas=fabricRef.current,objects=canvas?editorSelection(canvas):[],only=objects.length===1?objects[0]:null
    return {ready:fabricReady,busy:restoring||commandPending||uploading||!!historyRef.current?.busy||commandBusyRef.current||!!uploadAbortRef.current,saving,count:objects.length,objectCount:canvas?canvas.getObjects().filter(o=>isDocumentObject(o)&&o.visible&&o.selectable).length:0,locked:objects.some(isObjectLocked),allLocked:objects.length>0&&objects.every(isObjectLocked),image:!!only&&!!imageEditingTarget(only),group:!!only&&isInstance(only,'Group')&&!imageFrameChild(only),clipboard:clipboardRef.current.length>0,canUndo,canRedo,alignToPage}
  }
  const visibleCenter=()=>{
    const canvas=fabricRef.current,fc=fabricCoreRef.current;if(!canvas||!fc)return undefined
    return fc.util.transformPoint(new fc.Point(canvas.width/2,canvas.height/2),fc.util.invertTransform(canvas.viewportTransform))
  }
  const insertAtPoint=(kind:'text'|'rect',point:{x:number;y:number})=>{
    const canvas=fabricRef.current,fc=fabricCoreRef.current,mod=fabricModRef.current;if(!canvas||!fc||!mod)return
    setDrawingTool(null);setActiveTool('select')
    const object=kind==='text'?new mod.DynamicText('',{left:point.x,top:point.y,width:200,fontSize:11,fontFamily:'Arial',fill:'#000000',elementType:'text',elementName:'Texto',splitByGrapheme:true}):new fc.Rect({left:point.x,top:point.y,width:120,height:80,fill:'#e2e8f0',stroke:'#94a3b8',strokeWidth:1,rx:4,ry:4,originX:'left',originY:'top'})
    canvas.add(object);canvas.setActiveObject(object);canvas.requestRenderAll();pushHistory()
    if(kind==='text')requestAnimationFrame(()=>{if(canvas===fabricRef.current)(object as any).enterEditing()})
  }
  const commandHandlers:EditorCommandHandlers={
    save:()=>{const canvas=fabricRef.current;if(canvas)flushSync(()=>commitFocusedEditorDraft(canvas,surfaceRef.current));return handleSave()},
    undo:handleUndo,redo:handleRedo,
    select:()=>{setActiveTool('select');setDrawingTool(null)},hand:()=>{setActiveTool('hand');setDrawingTool(null)},
    text:({point})=>point?insertAtPoint('text',point):addTextElement(),
    rect:({point})=>point?insertAtPoint('rect',point):addRectElement(),
    circle:addCircleElement,triangle:addTriangleElement,line:addLineElement,pencil:()=>{setDrawingTool(null);setActiveTool('pencil')},
    image:({point})=>{imageInsertPointRef.current=point;fileInputRef.current?.click()},
    copy:copySelected,paste:({point})=>pasteClipboard(point),duplicate:duplicateSelected,group:groupSelected,ungroup:ungroupSelected,
    front:bringToFront,back:sendToBack,forward:bringForward,backward:sendBackward,lock:toggleLock,delete:deleteSelected,
    crop:()=>{const only=fabricRef.current?.getActiveObject();if(!only)return;const target=imageEditingTarget(only);if(!target)return;setImageEditorTarget({...target,point:{x:Math.max(8,(surfaceRef.current?.getBoundingClientRect().right||600)-420),y:(surfaceRef.current?.getBoundingClientRect().top||0)+80}})},
    replace:()=>{imageReplaceTargetRef.current=fabricRef.current?.getActiveObject()||null;replaceImageInputRef.current?.click()},
    alignTarget:()=>setAlignToPage(value=>!value),
    alignLeft:()=>handleAlign('left'),alignCenterH:()=>handleAlign('center-h'),alignRight:()=>handleAlign('right'),alignTop:()=>handleAlign('top'),alignCenterV:()=>handleAlign('center-v'),alignBottom:()=>handleAlign('bottom'),
    distributeH:()=>{if(fabricRef.current){distributeEditorSelection(fabricRef.current,'x');pushHistory()}},
    distributeV:()=>{if(fabricRef.current){distributeEditorSelection(fabricRef.current,'y');pushHistory()}},
    selectAll:()=>{const canvas=fabricRef.current,fc=fabricCoreRef.current;if(!canvas||!fc)return;const objects=canvas.getObjects().filter(o=>isDocumentObject(o)&&o.selectable&&o.visible);canvas.discardActiveObject();if(objects.length)canvas.setActiveObject(objects.length===1?objects[0]:new fc.ActiveSelection(objects,{canvas}));canvas.requestRenderAll()},
    fit:()=>{const canvas=fabricRef.current,mod=fabricModRef.current;if(canvas&&mod)setZoom(mod.zoomToFit(canvas))},
    zoomIn:handleZoomIn,zoomOut:handleZoomOut,zoom100:()=>{const canvas=fabricRef.current,fc=fabricCoreRef.current;if(canvas&&fc){canvas.zoomToPoint(new fc.Point(canvas.width/2,canvas.height/2),1);setZoom(1)}},
    grid:()=>setShowGrid(value=>!value),rulers:()=>setShowRulers(value=>!value),margins:()=>setShowMargins(value=>!value),
    export:()=>setShowExportMenu(true),saveCopy:()=>handleSave(true),deleteTemplate:()=>setDeleteConfirm(true),cancel:cancelEditorGesture,
  }
  const runCommand=(id:EditorCommandId,invocation:EditorCommandInvocation={})=>executeEditorCommand(id,getCommandState(),commandHandlers,invocation)
  const commandState=getCommandState()
  const command=(id:EditorCommandId)=>resolveEditorCommand(id,commandState)
  latestActionsRef.current={command:runCommand,changed:()=>{refreshObjectList();reconcileDirty()},cancel:cancelEditorGesture}

  // ─── Loading ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-600">Cargando editor...</p>
        </div>
      </div>
    )
  }

  if (!template) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-50">
        <div className="space-y-3 text-center"><p role="alert" className="text-slate-600">{editorError||'Plantilla no encontrada'}</p><button className="min-h-11 rounded-xl border px-4" onClick={()=>setLoadNonce(n=>n+1)}>Reintentar</button><button className="min-h-11 rounded-xl px-4 text-emerald-700" onClick={()=>router.push('/dashboard/documents')}>Volver a plantillas</button></div>
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
    <EditorDesignProvider canvas={fabricRef.current}><div ref={surfaceRef} className="clarin-document-editor relative flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 text-slate-800">
      {/* Hidden elements to pass state to canvas afterRender */}
      <div id="__showGrid" data-show={String(showGrid)} data-size={String(gridSize)} className="hidden" />

      <header className="z-20 flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <button aria-label="Volver a plantillas" title="Volver a plantillas" onClick={()=>requestLeave('/dashboard/documents')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-slate-100"><ArrowLeft className="h-5 w-5"/></button>
        <div className="min-w-36 flex-1">
          <input aria-label="Nombre de la plantilla" maxLength={200} value={templateName} onChange={e=>setTemplateName(e.target.value)} className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold outline-none hover:border-slate-200 focus:border-emerald-500"/>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 text-xs text-slate-500"><span>{pageWidth} × {pageHeight} mm</span><span aria-live="polite">{!fabricReady?(imageLoadError||editorError?'Carga incompleta':'Cargando recursos…'):saving?'Guardando…':dirty?'Cambios sin guardar':saveMessage||'Todos los cambios guardados'}</span></p>
        </div>
        <div className="flex items-center gap-1">
          <button aria-label="Deshacer" title="Deshacer (Ctrl+Z)" disabled={command('undo').disabled} onClick={()=>void runCommand('undo')} className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-slate-100 disabled:opacity-30"><Undo2 className="h-4 w-4"/></button>
          <button aria-label="Rehacer" title="Rehacer (Ctrl+Mayús+Z)" disabled={command('redo').disabled} onClick={()=>void runCommand('redo')} className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-slate-100 disabled:opacity-30"><Redo2 className="h-4 w-4"/></button>
          <button disabled={command('export').disabled} onClick={()=>runCommand('export')} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-40"><Download className="h-4 w-4"/><span className="hidden sm:inline">Exportar</span></button>
          <button disabled={command('save').disabled} onClick={()=>void runCommand('save')} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><Save className="h-4 w-4"/>{saving?'Guardando…':'Guardar'}</button>
          <button aria-label="Más acciones" title="Más acciones" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setContextMenu({x:r.right-288,y:r.bottom+6,documentActions:true})}} className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-slate-100"><MoreHorizontal className="h-5 w-5"/></button>
        </div>
      </header>
      {imageLoadError&&<DocumentResourceAlert error={imageLoadError} onRetry={()=>setLoadNonce(n=>n+1)}/>}
      {editorError&&<div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800"><AlertCircle className="h-4 w-4 shrink-0"/><span className="flex-1">{editorError}</span>{!fabricReady&&<button className="min-h-11 rounded-lg border border-rose-200 px-3" onClick={()=>setLoadNonce(n=>n+1)}>Reintentar</button>}{fabricReady&&<button aria-label="Cerrar aviso" className="h-11 w-11" onClick={()=>setEditorError('')}><X className="mx-auto h-4 w-4"/></button>}</div>}
      {conflict&&<div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"><span className="flex-1">Otra sesión ha actualizado esta plantilla. Conserva tus cambios como una copia o carga la versión del servidor.</span><button className="min-h-11 rounded-xl border border-amber-300 px-3" onClick={()=>void handleSave(true)}>Guardar como copia</button><button className="min-h-11 rounded-xl border border-amber-300 px-3" onClick={()=>setLeaveTarget('reload')}>Cargar versión actual</button></div>}
      <div role="toolbar" aria-label="Vista del documento" data-document-toolbar className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-1">
        <div className="flex shrink-0 items-center rounded-xl border border-slate-200">
          <button title="Alejar" aria-label="Alejar" disabled={command('zoomOut').disabled} onClick={()=>runCommand('zoomOut')} className="h-11 w-10"><ZoomOut className="mx-auto h-4 w-4"/></button>
          <button title="Restablecer zoom al 100%" disabled={command('zoom100').disabled} onClick={()=>runCommand('zoom100')} className="min-h-11 min-w-14 text-xs font-medium">{zoomPercent}%</button>
          <button title="Acercar" aria-label="Acercar" disabled={command('zoomIn').disabled} onClick={()=>runCommand('zoomIn')} className="h-11 w-10"><ZoomIn className="mx-auto h-4 w-4"/></button>
        </div>
        <button aria-label="Ajustar página" disabled={command('fit').disabled} onClick={()=>runCommand('fit')} className="min-h-11 shrink-0 whitespace-nowrap rounded-xl px-2 text-xs hover:bg-slate-100">{surfaceWidth<640?'Ajustar':'Ajustar página'}</button>
        {(surfaceWidth>=640||editingGroup)&&<div data-editor-context-hint className={surfaceWidth<640?'order-last basis-full text-xs text-slate-500':'min-w-0 flex-1 text-xs text-slate-500'}>{editingGroup?<button onClick={cancelEditorGesture} className="min-h-11 text-emerald-700">← Salir del grupo</button>:activeTool==='pencil'?'Dibujo libre · Esc para terminar':drawingTool?'Arrastra para dibujar · Mayús mantiene proporción':activeTool==='text'?'Haz clic o arrastra un área para escribir':hasSelection?selectedObjects.length+' seleccionado'+(selectedObjects.length===1?'':'s'):'Selecciona un objeto o inserta uno desde la barra'}</div>}
        <button title={panelOpen?'Ocultar panel':'Mostrar panel'} aria-label={panelOpen?'Ocultar panel':'Mostrar panel'} aria-expanded={panelOpen} onClick={()=>setPanelOpen(v=>!v)} className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-slate-100">{panelOpen?<PanelRightClose className="h-5 w-5"/>:<PanelRightOpen className="h-5 w-5"/>}</button>
      </div>
      {/* ─── Main Area ───────────────────────────────────────────────── */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* ─── Left Toolbar ─────────────────────────────────────────── */}
        <div className="w-14 overflow-y-auto bg-white border-r border-slate-200 flex flex-col items-center py-2 gap-1 flex-shrink-0 z-10">
          {(['select','hand','text','rect','circle','triangle','pencil','line'] as const).map(id=>{
            const action=command(id),label=(action.toolbarLabel||action.label)+(action.shortcut?' ('+action.shortcut+')':'')
            return <button key={id} onClick={()=>runCommand(id)} title={label} aria-label={label} disabled={action.disabled} className={'p-2 rounded-lg transition disabled:opacity-40 '+(activeTool===id?'bg-emerald-50 text-emerald-700':'text-slate-600 hover:text-slate-800 hover:bg-slate-100')}><EditorCommandIcon name={action.icon}/></button>
          })}

          {/* Image upload */}
          <button onClick={()=>runCommand('image')} disabled={command('image').disabled} title="Subir imagen" className="p-2 rounded-lg text-slate-600 hover:text-slate-800 hover:bg-slate-100 transition">
            <ImagePlus className="w-4 h-4" />
          </button>
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={handleImageUpload} />
          <input ref={replaceImageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={handleReplaceImageInput} />

          {/* Table */}
          <div className="relative">
            <button
              ref={tableButtonRef}
              onClick={() => { setShowTablePicker(!showTablePicker); setShowDynamicFields(false) }}
              title="Tabla"
              className={`p-2 rounded-lg transition ${showTablePicker ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:text-slate-800 hover:bg-slate-100'}`}
            >
              <Table2 className="w-4 h-4" />
            </button>
            {showTablePicker && (
              <EditorPopover anchor={tableButtonRef.current} label="Insertar tabla" width={320} onClose={()=>setShowTablePicker(false)}>
                <div className="p-2">
                  <p className="text-xs font-semibold text-slate-600 mb-2">Insertar tabla</p>
                  <div className="grid grid-cols-6 gap-1 mb-2">
                  {Array.from({ length: 36 }, (_, i) => {
                    const row = Math.floor(i / 6) + 1
                    const col = (i % 6) + 1
                    const isActive = row <= tableHover.rows && col <= tableHover.cols
                    return (
                      <button
                        key={i}
                        aria-label={row+" filas por "+col+" columnas"} className={`w-11 h-11 border rounded-sm transition ${isActive ? 'bg-emerald-50 border-emerald-500' : 'bg-slate-50 border-slate-200 hover:border-slate-400'}`}
                        onMouseEnter={() => setTableHover({ rows: row, cols: col })}
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                        onClick={() => addTable(row, col)}
                      />
                    )
                  })}
                </div>
                <p className="text-[10px] text-center text-slate-600">
                  {tableHover.rows > 0 ? `${tableHover.rows} × ${tableHover.cols}` : 'Selecciona tamaño'}
                </p>
                </div>
              </EditorPopover>
            )}
          </div>

          {/* Dynamic fields */}
          <div className="relative">
            <button
              ref={dynamicFieldsBtnRef}
              onClick={() => { setShowDynamicFields(!showDynamicFields); setShowTablePicker(false) }}
              title="Campos dinámicos"
              className={`p-2 rounded-lg transition ${showDynamicFields ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:text-slate-800 hover:bg-slate-100'}`}
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

          <hr className="w-6 border-slate-200 my-1" />

          {/* View toggles */}
          <button disabled={command('grid').disabled} onClick={()=>runCommand('grid')} title="Grilla" className={`p-2 rounded-lg transition ${showGrid ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:text-slate-800 hover:bg-slate-100'}`}>
            <Grid3X3 className="w-4 h-4" />
          </button>
          <button disabled={command('rulers').disabled} onClick={()=>runCommand('rulers')} title="Reglas" className={`p-2 rounded-lg transition ${showRulers ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:text-slate-800 hover:bg-slate-100'}`}>
            <Ruler className="w-4 h-4" />
          </button>
          <button disabled={command('margins').disabled} onClick={()=>runCommand('margins')} title="Márgenes" className={`p-2 rounded-lg transition ${showMargins ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:text-slate-800 hover:bg-slate-100'}`}>
            <FlipVertical2 className="w-4 h-4" />
          </button>

          <hr className="w-6 border-slate-200 my-1" />

          {hasSelection&&<>
            {commandState.count>1&&<button title={command('alignTarget').label} aria-label={command('alignTarget').label} disabled={command('alignTarget').disabled} onClick={()=>runCommand('alignTarget')} className="p-2 text-[10px] text-emerald-700 disabled:opacity-40">{alignToPage?'Pág.':'Selec.'}</button>}
            {(['alignLeft','alignCenterH','alignRight','alignTop','alignCenterV','alignBottom',...(commandState.count>=3?['distributeH','distributeV'] as const:[])] as const).map(id=>{const action=command(id);return <button key={id} aria-label={action.label} title={action.label+(commandState.count===1?' en página':'')} disabled={action.disabled} onClick={()=>runCommand(id)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40"><EditorCommandIcon name={action.icon}/></button>})}
            <hr className="my-1 w-6 border-slate-200"/>
            {(['lock',...(commandState.count>1?['group'] as const:commandState.group?['ungroup'] as const:[]),'duplicate','delete'] as const).map(id=>{const action=command(id);return <button key={id} aria-label={action.label} title={action.label+(action.shortcut?' ('+action.shortcut+')':'')} disabled={action.disabled} onClick={()=>void runCommand(id)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40"><EditorCommandIcon name={action.icon}/></button>})}
          </>}

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
                className="absolute top-0 left-0 right-0 h-5 bg-white border-b border-slate-200 z-10 flex items-end cursor-row-resize select-none"
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
                className="absolute top-5 left-0 bottom-0 w-5 bg-white border-r border-slate-200 z-10 cursor-col-resize select-none"
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
              <div className="absolute top-0 left-0 w-5 h-5 bg-white border-r border-b border-slate-200 z-20"
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
            {dragOverTarget && (() => {
              const canvas = fabricRef.current
              const vpt = canvas?.viewportTransform
              if (!canvas) return null
              const target = dragOverTarget
              if (!target) return null
              const scene = target.getBoundingRect()
              const b={left:scene.left*zoom+(vpt?.[4]||0),top:scene.top*zoom+(vpt?.[5]||0),width:scene.width*zoom,height:scene.height*zoom}
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
                    {Math.round(d.distance/2*10)/10} mm
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
              const scene = obj.getBoundingRect()
              const b={left:scene.left*zoom+vpt[4],top:scene.top*zoom+vpt[5],width:scene.width*zoom,height:scene.height*zoom}
              // Position above the textbox (or below if no space)
              const toolbarH = 52
              let top = b.top - toolbarH - 4
              if (top < 4) top = b.top + b.height + 4
              const left = Math.min(canvas.width-150,Math.max(150,b.left+b.width/2))
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
              const btn = "h-7 w-7 flex items-center justify-center rounded-md text-slate-800 hover:bg-slate-100 transition disabled:opacity-40 disabled:cursor-not-allowed"
              const activeBtn = "bg-emerald-600 text-white hover:bg-emerald-500"

              return (
                <div
                  className="absolute flex items-center gap-0.5 px-1.5 py-1 rounded-lg bg-white/95 backdrop-blur-sm border border-slate-200 shadow-2xl"
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
                  <div className="w-28"><EditorColorPicker label="Color del texto seleccionado" value={obj.getSelectionStyles(...getSel(),true)?.[0]?.fill||obj.fill} onChange={setFill} allowNone={false}/></div>
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

        </div>

        {/* ─── Right Panel ──────────────────────────────────────────── */}
        <>{panelOpen&&<aside aria-label="Propiedades y capas" className={'flex min-h-0 w-72 max-w-[calc(100%-56px)] flex-shrink-0 flex-col overflow-hidden border-l border-slate-200 bg-white '+(surfaceWidth<900?'absolute inset-y-0 right-0 z-30 shadow-2xl':'z-10')}>
          {/* Tabs */}
          <div className="flex border-b border-slate-200">
            <button
              onClick={() => setRightTab('properties')}
              className={`flex-1 py-2.5 text-xs font-medium transition ${rightTab === 'properties' ? 'text-emerald-700 border-b-2 border-emerald-500' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Propiedades
            </button>
            <button
              onClick={() => setRightTab('layers')}
              className={`flex-1 py-2.5 text-xs font-medium transition ${rightTab === 'layers' ? 'text-emerald-700 border-b-2 border-emerald-500' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Capas ({allObjects.length})
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {rightTab === 'properties' ? (
              selectedObj ? (
                <><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{(selectedObj as any).elementName||'Objeto'}</span><button onClick={()=>runCommand('lock')} disabled={command('lock').disabled} className="min-h-11 rounded-lg px-2 text-xs text-slate-600">{isObjectLocked(selectedObj)?'Desbloquear':'Bloquear'}</button></div><fieldset disabled={isObjectLocked(selectedObj)} className="space-y-4 disabled:opacity-60"><PropertiesContent key={(selectedObj as any).objectId}
                  selectedObj={selectedObj}
                  updateProp={updateProp}
                  pushHistory={pushHistory}
                  isInstance={isInstance}
                  fabricRef={fabricRef}
                  fileInputRef={fileInputRef}
                  replaceImageInputRef={replaceImageInputRef}
                  onCommand={runCommand}
                  SYSTEM_FONTS={SYSTEM_FONTS}
                  GOOGLE_FONTS={GOOGLE_FONTS}
                  bringForward={()=>runCommand('forward')}
                  sendBackward={()=>runCommand('backward')}
                  bringToFront={()=>runCommand('front')}
                  sendToBack={()=>runCommand('back')}
                  copiedFieldFormatRef={copiedFieldFormatRef}
                /></fieldset></>
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
                      documentSettingsRef.current={...documentSettingsRef.current,pageWidth:w,pageHeight:h}
                      setPageWidth(w)
                      setPageHeight(h)
                      pushHistory()
                    }
                  }}
                />
              )
            ) : (
              <EditorLayers objects={allObjects} selected={selectedObjects} canvas={fabricRef.current} onChange={pushHistory} onEditGroup={setEditingGroup}/>
            )}
          </div>
        </aside>}</>
      </div>

      {contextMenu&&<EditorCommandMenu state={commandState} point={contextMenu} documentActions={!!contextMenu.documentActions} onClose={()=>setContextMenu(null)} onCommand={id=>{void runCommand(id,{point:contextMenu.scene||visibleCenter()})}}/>}
      {imageEditorTarget&&<ImageDraft image={imageEditorTarget.image} frame={imageEditorTarget.frame} canvas={fabricRef.current} anchor={null} point={imageEditorTarget.point} onClose={()=>setImageEditorTarget(null)} onCommit={pushHistory}/>}
      {showExportMenu&&fabricRef.current&&<DocumentExportDialog canvas={fabricRef.current} templateName={templateName} pageWidth={pageWidth} pageHeight={pageHeight} onClose={()=>setShowExportMenu(false)}/>}
      {leaveTarget&&<EditorConfirmDialog title="Tienes cambios sin guardar" onCancel={()=>{pendingNavigationRef.current=null;setLeaveTarget(null)}} actions={<><button className="min-h-11 rounded-xl border px-3" onClick={()=>{pendingNavigationRef.current=null;setLeaveTarget(null)}}>Seguir editando</button><button className="min-h-11 rounded-xl border border-rose-200 px-3 text-rose-700" onClick={()=>{const target=leaveTarget;continueLeave(target)}}>Descartar cambios</button><button disabled={saving} className="min-h-11 rounded-xl bg-emerald-600 px-3 text-white disabled:opacity-50" onClick={async()=>{if(await handleSave()){const target=leaveTarget;continueLeave(target)}}}>Guardar y continuar</button></>}>Guarda esta versión antes de salir o descarta tus cambios para continuar.</EditorConfirmDialog>}
      {deleteConfirm&&<EditorConfirmDialog title="Eliminar esta plantilla" onCancel={()=>setDeleteConfirm(false)} actions={<><button className="min-h-11 rounded-xl border px-3" onClick={()=>setDeleteConfirm(false)}>Cancelar</button><button disabled={deleting} className="min-h-11 rounded-xl bg-rose-600 px-3 text-white disabled:opacity-50" onClick={()=>void handleDeleteTemplate()}>{deleting?'Eliminando…':'Eliminar plantilla'}</button></>}>La plantilla se eliminará de la biblioteca. Los documentos que ya exportaste se conservan.</EditorConfirmDialog>}
      {(restoring||commandPending)&&<div role="status" className="absolute inset-0 z-50 flex items-center justify-center bg-white/70 text-sm text-slate-600">{restoring?'Restaurando cambios…':'Preparando elementos…'}</div>}
      {uploading&&<div role="status" className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-2xl border bg-white px-4 py-2 text-sm shadow-lg">Preparando imagen…<button className="min-h-11 text-emerald-700" onClick={()=>{uploadAbortRef.current?.abort();setUploading(false)}}>Cancelar</button></div>}
      {activeTool==='pencil'&&<div className="absolute bottom-4 left-20 z-20 flex max-w-[calc(100%-120px)] items-center gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-lg"><EditorColorPicker value={brushColor} onChange={setBrushColor} label="Color del pincel" allowNone={false}/><label className="shrink-0 text-xs">Grosor<input aria-label="Grosor del pincel" type="number" min=".5" max="100" step=".5" value={brushWidth} onChange={e=>setBrushWidth(Math.max(.5,Math.min(100,Number(e.target.value)||.5)))} className="ml-2 h-11 w-16 rounded-xl border px-2"/></label></div>}
      <style jsx global>{'.clarin-document-editor button:not([data-user-guide]){min-height:36px}.clarin-document-editor input[type=number],.clarin-document-editor select{min-height:36px}.clarin-document-editor button:focus-visible,.clarin-document-editor input:focus-visible{outline:2px solid #10b981;outline-offset:2px}@media(pointer:coarse){.clarin-document-editor button,.clarin-document-editor input,.clarin-document-editor select{min-height:44px}}'}</style>
    </div></EditorDesignProvider>
  )
}


// ─── Properties Panel Sub-Component ─────────────────────────────────────────

function PropertiesContent({
  selectedObj, updateProp, pushHistory, isInstance, fabricRef, fileInputRef, replaceImageInputRef, onCommand,
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
  onCommand:(id:EditorCommandId)=>unknown
  SYSTEM_FONTS: string[]
  GOOGLE_FONTS: string[]
  bringForward: () => void
  sendBackward: () => void
  bringToFront: () => void
  sendToBack: () => void
  copiedFieldFormatRef: React.MutableRefObject<import('@/lib/dynamicFieldFormat').FieldFormat | null>
}) {
  const obj=selectedObj as any
  const isText=isInstance(obj,'DynamicText')||isInstance(obj,'FabricText')
  const isDynamic=isInstance(obj,'DynamicText')&&obj.isDynamic&&!!obj.fieldName
  const framedImage=imageFrameChild(selectedObj)
  const isImage=isInstance(obj,'FabricImage')||!!framedImage
  const isLine=isInstance(obj,'Line')||obj.type.toLowerCase()==='path'
  const [linked,setLinked]=useState(true)
  const position=selectedObj.getXY()
  const setPosition=(axis:'x'|'y',value:number)=>{if(isObjectLocked(selectedObj))return;const point=selectedObj.getXY();point[axis]=value*2;selectedObj.setXY(point);selectedObj.setCoords();fabricRef.current?.requestRenderAll();pushHistory()}
  const setSize=(axis:'x'|'y',value:number)=>{if(isObjectLocked(selectedObj))return;const factor=value*2/(axis==='x'?selectedObj.getScaledWidth():selectedObj.getScaledHeight());selectedObj.set(axis==='x'?{scaleX:selectedObj.scaleX*factor,...(linked?{scaleY:selectedObj.scaleY*factor}:{})}:{scaleY:selectedObj.scaleY*factor,...(linked?{scaleX:selectedObj.scaleX*factor}:{})});selectedObj.setCoords();fabricRef.current?.requestRenderAll();pushHistory()}
  const heading='text-xs font-semibold text-slate-600'
  const fonts=[...SYSTEM_FONTS,...GOOGLE_FONTS]
  return <>
    <section className="space-y-2"><h3 className={heading}>Posición y tamaño <span className="font-normal text-slate-400">mm</span></h3>
      <div className="grid grid-cols-2 gap-2"><EditorNumberField label="X" value={position.x/2} onCommit={v=>setPosition('x',v)}/><EditorNumberField label="Y" value={position.y/2} onCommit={v=>setPosition('y',v)}/><EditorNumberField label="Ancho" min={.1} value={selectedObj.getScaledWidth()/2} onCommit={v=>setSize('x',v)}/><EditorNumberField label="Alto" min={.1} value={selectedObj.getScaledHeight()/2} onCommit={v=>setSize('y',v)}/></div>
      <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={linked} onChange={e=>setLinked(e.target.checked)} className="accent-emerald-600"/>Mantener proporción</label>
      <EditorNumberField label="Rotación (°)" value={obj.angle||0} onCommit={v=>updateProp('angle',v%360)}/>
    </section>
    {isText&&<section className="space-y-3 border-t border-slate-200 pt-4"><h3 className={heading}>Tipografía</h3><EditorFontPicker value={obj.fontFamily||'Arial'} fonts={fonts} onChange={v=>updateProp('fontFamily',v)}/>
      <div className="grid grid-cols-2 gap-2"><EditorNumberField label="Tamaño" min={1} max={500} value={obj.fontSize||16} onCommit={v=>updateProp('fontSize',v)}/><EditorNumberField label="Interlineado" min={.5} max={5} step={.1} value={obj.lineHeight||1.2} onCommit={v=>updateProp('lineHeight',v)}/></div>
      <div className="flex flex-wrap gap-1">{[{label:'Negrita',icon:Bold,active:obj.fontWeight==='bold',run:()=>updateProp('fontWeight',obj.fontWeight==='bold'?'normal':'bold')},{label:'Cursiva',icon:Italic,active:obj.fontStyle==='italic',run:()=>updateProp('fontStyle',obj.fontStyle==='italic'?'normal':'italic')},{label:'Subrayado',icon:Underline,active:obj.underline,run:()=>updateProp('underline',!obj.underline)}].map(({label,icon:Icon,active,run})=><button key={label} title={label} aria-label={label} aria-pressed={!!active} onClick={run} className={'flex h-11 w-11 items-center justify-center rounded-xl border '+(active?'border-emerald-300 bg-emerald-50 text-emerald-700':'border-slate-200')}><Icon className="h-4 w-4"/></button>)}</div>
      <div className="grid grid-cols-3 gap-1">{['left','center','right'].map((align,i)=><button key={align} aria-label={['Alinear texto a la izquierda','Centrar texto','Alinear texto a la derecha'][i]} aria-pressed={obj.textAlign===align} onClick={()=>updateProp('textAlign',align)} className={'flex min-h-11 items-center justify-center rounded-xl border '+(obj.textAlign===align?'border-emerald-300 bg-emerald-50 text-emerald-700':'border-slate-200')}>{align==='left'?<AlignLeft className="h-4 w-4"/>:align==='center'?<AlignCenter className="h-4 w-4"/>:<AlignRight className="h-4 w-4"/>}</button>)}</div>
      <EditorColorPicker label="Color del texto" value={obj.fill} onChange={v=>updateProp('fill',v)} allowNone={false}/>
      <EditorNumberField label="Espaciado entre letras" min={-200} max={1000} value={obj.charSpacing||0} onCommit={v=>updateProp('charSpacing',v)}/>
    </section>}
    {isDynamic&&<section className="border-t border-slate-200 pt-4"><DynamicFormatSection objs={[obj]} fabricRef={fabricRef} pushHistory={pushHistory} copiedFieldFormatRef={copiedFieldFormatRef}/></section>}
    {!isImage&&<section className="space-y-3 border-t border-slate-200 pt-4"><h3 className={heading}>{isText?'Contorno':'Apariencia'}</h3>{!isText&&!isLine&&<EditorColorPicker label="Relleno" value={obj.fill} onChange={v=>updateProp('fill',v)}/>}<EditorColorPicker label="Color del contorno" value={obj.stroke||'transparent'} onChange={v=>updateProp('stroke',v)}/><EditorNumberField label="Grosor del contorno" min={0} max={100} step={.25} value={obj.strokeWidth||0} onCommit={v=>updateProp('strokeWidth',v)}/>{isInstance(obj,'Rect')&&<EditorNumberField label="Radio de las esquinas" min={0} max={200} value={obj.rx||0} onCommit={v=>{selectedObj.set({rx:v,ry:v} as any);fabricRef.current?.requestRenderAll();pushHistory()}}/>}</section>}
    {isImage&&<section className="space-y-3 border-t border-slate-200 pt-4"><h3 className={heading}>Imagen</h3><EditorImageControls image={framedImage||obj} frame={framedImage?obj:undefined} canvas={fabricRef.current} onCommit={pushHistory} onCrop={()=>onCommand('crop')}/><button onClick={()=>onCommand('replace')} className="min-h-11 w-full rounded-xl border border-dashed border-slate-300 px-3 text-sm hover:border-emerald-500">Reemplazar imagen</button><p className="text-xs leading-relaxed text-slate-500">El reemplazo conserva la posición y el marco sin deformar la imagen.</p></section>}
    <section className="space-y-3 border-t border-slate-200 pt-4"><EditorNumberField label="Opacidad (%)" min={0} max={100} value={(obj.opacity??1)*100} onCommit={v=>updateProp('opacity',v/100)}/><ShadowControl selectedObj={selectedObj} updateProp={updateProp}/></section>
    <section className="space-y-2 border-t border-slate-200 pt-4"><h3 className={heading}>Orden</h3><div className="grid grid-cols-2 gap-2">{[{label:'Al frente',run:bringToFront},{label:'Al fondo',run:sendToBack},{label:'Subir una capa',run:bringForward},{label:'Bajar una capa',run:sendBackward}].map(({label,run})=><button key={label} onClick={run} className="min-h-11 rounded-xl border border-slate-200 text-xs hover:bg-slate-50">{label}</button>)}</div></section>
  </>
}

function EditorNumberField({label,value,onCommit,min=-100000,max=100000,step=.1}:{label:string;value:number;onCommit:(value:number)=>void;min?:number;max?:number;step?:number}){
  const [draft,setDraft]=useState(String(Math.round(value*100)/100)),[invalid,setInvalid]=useState(false),cancelBlur=useRef(false)
  useEffect(()=>{setDraft(String(Math.round(value*100)/100));setInvalid(false)},[value])
  const commit=()=>{if(cancelBlur.current){cancelBlur.current=false;return}const next=Number(draft);if(!draft.trim()||!Number.isFinite(next)||next<min||next>max){setInvalid(true);return}setInvalid(false);if(next!==value)onCommit(next)}
  return <label className="block text-xs text-slate-500">{label}<input aria-label={label} aria-invalid={invalid} type="number" min={min} max={max} step={step} value={draft} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){cancelBlur.current=true;setDraft(String(Math.round(value*100)/100));setInvalid(false);e.currentTarget.blur()}}} className={'mt-1 h-11 w-full rounded-xl border bg-white px-3 text-sm text-slate-800 outline-none focus:border-emerald-500 '+(invalid?'border-rose-500':'border-slate-200')}/>{invalid&&<span className="mt-1 block text-rose-600">Introduce un valor entre {min} y {max}.</span>}</label>
}

// ─── Shadow Control Sub-Component ───────────────────────────────────────────

function ShadowControl({ selectedObj, updateProp }: { selectedObj: FabricObject; updateProp: (prop: string, value: any) => void }) {
  // Dynamic import Shadow constructor
  const toggleShadow = async () => {
    const { Shadow } = await import('@/lib/fabric/runtime')
    if (selectedObj.shadow) {
      updateProp('shadow', null)
    } else {
      updateProp('shadow', new Shadow({ offsetX: 2, offsetY: 2, blur: 4, color: 'rgba(0,0,0,0.25)' }))
    }
  }

  const updateShadowProp = async (prop: string, value: number) => {
    const { Shadow } = await import('@/lib/fabric/runtime')
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
        <label className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Sombra</label>
        <button onClick={toggleShadow}
          className={`text-[10px] px-2 py-0.5 rounded ${shadow ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-600'}`}>
          {shadow ? 'ON' : 'OFF'}
        </button>
      </div>
      {shadow && (
        <div className="mt-1.5 space-y-1">
          {[{ label: 'X', prop: 'offsetX' }, { label: 'Y', prop: 'offsetY' }, { label: 'Blur', prop: 'blur' }].map(({ label, prop }) => (
            <div key={prop} className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-500 w-8">{label}</span>
              <input type="number" value={shadow[prop] ?? 0} onChange={e => updateShadowProp(prop, Number(e.target.value))}
                className="flex-1 px-2 py-1 text-xs text-slate-900 bg-slate-50 border border-slate-200 rounded focus:bg-white focus:border-emerald-500 outline-none" />
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
  bgFileInputRef: React.RefObject<HTMLInputElement | null>
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
  return <div className="space-y-5">
    <section className="space-y-3"><h3 className="text-xs font-semibold text-slate-600">Tamaño de página</h3>
      <div className="grid grid-cols-2 gap-2">{Object.entries(PAGE_SIZES).filter(([key])=>key!=='custom').map(([key,cfg])=><button key={key} onClick={()=>onPageResize(pageWidth>pageHeight?cfg.h:cfg.w,pageWidth>pageHeight?cfg.w:cfg.h)} className={'min-h-11 rounded-xl border px-2 text-xs '+((pageWidth===cfg.w&&pageHeight===cfg.h)||(pageWidth===cfg.h&&pageHeight===cfg.w)?'border-emerald-300 bg-emerald-50 text-emerald-800':'border-slate-200 hover:bg-slate-50')}>{cfg.label}</button>)}</div>
      <div className="grid grid-cols-2 gap-2"><EditorNumberField label="Ancho (mm)" min={10} max={2000} value={pageWidth} onCommit={v=>onPageResize(v,pageHeight)}/><EditorNumberField label="Alto (mm)" min={10} max={2000} value={pageHeight} onCommit={v=>onPageResize(pageWidth,v)}/></div>
      <button onClick={()=>onPageResize(pageHeight,pageWidth)} className="min-h-11 w-full rounded-xl border border-slate-200 text-xs">Cambiar orientación</button>
    </section>
    <section className="space-y-3 border-t border-slate-200 pt-4"><h3 className="text-xs font-semibold text-slate-600">Fondo de página</h3><EditorColorPicker label="Color de página" value={background.color} onChange={handleBgColorChange} allowNone={false}/>
      {background.imageUrl?<div className="flex items-center gap-2"><img src={background.imageUrl} alt="Fondo de página" className="h-12 w-16 rounded-lg border object-cover"/><button onClick={()=>bgFileInputRef.current?.click()} className="min-h-11 text-xs text-emerald-700">Cambiar</button><button onClick={()=>setBackground(prev=>({...prev,imageUrl:undefined}))} className="min-h-11 text-xs text-rose-700">Quitar</button></div>:<button onClick={()=>bgFileInputRef.current?.click()} className="min-h-11 w-full rounded-xl border border-dashed border-slate-300 text-xs hover:border-emerald-500">Añadir imagen de fondo</button>}
      <input ref={bgFileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={handleBgImageUpload}/>
    </section>
    <section className="space-y-3 border-t border-slate-200 pt-4"><h3 className="text-xs font-semibold text-slate-600">Ayudas de diseño</h3>
      {[{label:'Cuadrícula',value:showGrid,change:setShowGrid},{label:'Reglas',value:showRulers,change:setShowRulers},{label:'Márgenes',value:showMargins,change:setShowMargins}].map(({label,value,change})=><label key={label} className="flex min-h-11 items-center justify-between gap-3 text-sm text-slate-700">{label}<input type="checkbox" checked={value} onChange={e=>change(e.target.checked)} className="h-4 w-4 accent-emerald-600"/></label>)}
      {showGrid&&<label className="block text-xs text-slate-500">Separación de cuadrícula<select aria-label="Separación de cuadrícula" value={gridSize} onChange={e=>setGridSize(Number(e.target.value))} className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3">{GRID_SIZES.map(size=><option key={size} value={size}>{size/2} mm</option>)}</select></label>}
      {showMargins&&<EditorNumberField label="Margen (mm)" min={1} max={Math.max(1,Math.min(pageWidth,pageHeight)/2-1)} value={marginSize} onCommit={setMarginSize}/>}
      <EditorColorPicker label="Color del área de trabajo" value={pasteboardColor} onChange={onPasteboardColorChange} allowNone={false}/>
      <p className="text-xs leading-relaxed text-slate-500">Las ayudas y el área de trabajo no aparecen en la exportación. Arrastra desde una regla para crear una guía; doble clic sobre la guía para quitarla.</p>
    </section>
    <p className="text-center text-xs text-slate-400">{allObjects.length} elementos en la página</p>
  </div>
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
  const {fill:allHaveFill,stroke:allHaveStroke}=selectionPaintCapabilities(selectedObjects)

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
    if(selectedObjects.some(isObjectLocked))return
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
      const sx=b.left,sy=b.top,sw=b.width,sh=b.height
      minX = Math.min(minX, sx)
      minY = Math.min(minY, sy)
      maxX = Math.max(maxX, sx + sw)
      maxY = Math.max(maxY, sy + sh)
    })
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY }
  })()

  const opacity = shared(o => o.opacity ?? 1)
  const angle = shared(o => Math.round(o.angle ?? 0))
  const fill = allHaveFill ? shared(o => o.fill ?? '') : null
  const stroke = allHaveStroke ? shared(o => o.stroke ?? '') : null
  const strokeWidth = allHaveStroke ? shared(o => o.strokeWidth ?? 0) : null
  const fontSize = allText ? shared(o => o.fontSize ?? 16) : null
  const fontFamily = allText ? shared(o => o.fontFamily ?? 'Arial') : null
  const fontWeight = allText ? shared(o => o.fontWeight ?? 'normal') : null
  const fontStyle = allText ? shared(o => o.fontStyle ?? 'normal') : null
  const underline = allText ? shared(o => Boolean(o.underline)) : null
  const textAlign = allText ? shared(o => o.textAlign ?? 'left') : null

  const inputCls = "w-full px-2 py-1 text-xs text-slate-900 bg-slate-50 border border-slate-200 rounded focus:bg-white focus:border-emerald-500 outline-none"
  const mixedPH = '—'

  return (
    <>
      <div className="flex items-center gap-2 px-1">
        <div className="w-7 h-7 rounded-md bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center text-emerald-700 text-[11px] font-bold">{count}</div>
        <div>
          <p className="text-xs font-semibold text-slate-900">Selección múltiple</p>
          <p className="text-[10px] text-slate-500">{count} objetos</p>
        </div>
      </div>

      <hr className="border-slate-200" />

      {/* Bounding box (read-only) */}
      <div>
        <label className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Posición y tamaño (mm)</label>
        <div className="grid grid-cols-2 gap-1.5 mt-1">
          <div>
            <span className="text-[10px] text-slate-500">X</span>
            <input type="number" readOnly value={Math.round(bbox.left/2)} className={inputCls + ' opacity-60 cursor-default'} />
          </div>
          <div>
            <span className="text-[10px] text-slate-500">Y</span>
            <input type="number" readOnly value={Math.round(bbox.top/2)} className={inputCls + ' opacity-60 cursor-default'} />
          </div>
          <div>
            <span className="text-[10px] text-slate-500">Ancho</span>
            <input type="number" readOnly value={Math.round(bbox.width/2)} className={inputCls + ' opacity-60 cursor-default'} />
          </div>
          <div>
            <span className="text-[10px] text-slate-500">Alto</span>
            <input type="number" readOnly value={Math.round(bbox.height/2)} className={inputCls + ' opacity-60 cursor-default'} />
          </div>
        </div>
      </div>

      <hr className="border-slate-200" />

      {/* Rotation + Opacity */}
      <div>
        <label className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Apariencia</label>
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
          <hr className="border-slate-200" />
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Relleno</label>
            <div className="flex items-center gap-2 mt-1">
              <EditorColorPicker label="Relleno de selección" mixed={fill===null} value={fill} onChange={v=>writeAll('fill',v)}/>

            </div>
          </div>
        </>
      )}

      {/* Stroke (shared) */}
      {allHaveStroke && (
        <>
          <hr className="border-slate-200" />
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Borde</label>
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              <EditorColorPicker label="Contorno de selección" mixed={stroke===null} value={stroke} onChange={v=>writeAll('stroke',v)}/>
              <input
                aria-label="Grosor del contorno de selección" type="number" min={0} max={50} step={0.25}
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
          <hr className="border-slate-200" />
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Texto</label>
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
                <EditorColorPicker label="Relleno de selección" mixed={fill===null} value={fill} onChange={v=>writeAll('fill',v)}/>
              </div>
            </div>
            <div className="flex items-center gap-1 mt-2">
              <button
                onClick={() => writeAll('fontWeight', fontWeight === 'bold' ? 'normal' : 'bold')}
                className={`flex-1 px-2 py-1 text-xs rounded border ${fontWeight === 'bold' ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                title={fontWeight === null ? 'Negrita (mixto)' : 'Negrita'}
              ><strong>B</strong></button>
              <button
                onClick={() => writeAll('fontStyle', fontStyle === 'italic' ? 'normal' : 'italic')}
                className={`flex-1 px-2 py-1 text-xs rounded border ${fontStyle === 'italic' ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                title={fontStyle === null ? 'Cursiva (mixto)' : 'Cursiva'}
              ><em>I</em></button>
              <button
                onClick={() => writeAll('underline', !underline)}
                className={`flex-1 px-2 py-1 text-xs rounded border ${underline === true ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                title={underline === null ? 'Subrayado (mixto)' : 'Subrayado'}
              ><u>U</u></button>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1.5">
              {(['left', 'center', 'right', 'justify'] as const).map(a => (
                <button
                  key={a}
                  onClick={() => writeAll('textAlign', a)}
                  className={`px-2 py-1 text-[10px] rounded border ${textAlign === a ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                >{a}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Dynamic-field format (shared) */}
      {allDynamicField && (
        <>
          <hr className="border-slate-200" />
          <DynamicFormatSection
            objs={selectedObjects as any[]}
            fabricRef={fabricRef}
            pushHistory={pushHistory}
            copiedFieldFormatRef={copiedFieldFormatRef}
          />
        </>
      )}

      <hr className="border-slate-200" />
      <p className="text-[10px] text-slate-500 px-1">
        Los valores marcados con <span className="font-mono text-slate-600">—</span> tienen valores distintos en los objetos seleccionados. Editar aplica a todos.
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

  const selCls = "w-full px-2 py-1 text-xs text-slate-900 bg-slate-50 border border-slate-200 rounded focus:bg-white focus:border-emerald-500 outline-none"
  const inputCls = selCls

  const canPaste = copiedFieldFormatRef.current != null

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">
          Formato {mixed && <span className="text-amber-400 normal-case font-normal">(mixto)</span>}
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { copiedFieldFormatRef.current = { ...fmt }; force() }}
            disabled={mixed}
            title={mixed ? 'No se puede copiar un formato mixto' : 'Copiar formato'}
            className="p-1 rounded bg-slate-50 border border-slate-200 text-slate-700 hover:text-emerald-700 hover:border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
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
            className="p-1 rounded bg-slate-50 border border-slate-200 text-slate-700 hover:text-emerald-700 hover:border-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
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

        <div className="mt-2 p-2 rounded bg-[#14141c] border border-slate-200">
          <span className="text-[9px] text-slate-500 uppercase tracking-wider">Vista previa</span>
          <div className="text-xs text-emerald-300 font-mono break-all mt-0.5">{preview || '(vacío)'}</div>
        </div>
      </div>
    </div>
  )
}
