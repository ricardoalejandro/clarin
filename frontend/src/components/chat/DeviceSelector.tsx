'use client'

import { useState, useRef, useEffect, useLayoutEffect, useCallback, useId, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Smartphone, Check } from 'lucide-react'
import type { Device } from '@/types/chat'
import { OPERATIONAL_OVERLAY_LAYERS, useOperationalOverlayPortal, useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'
import { chatDeviceMenuPosition, chatDeviceSelectionLabel, chatHistoryDevices } from './chatDeviceSelection'

interface DeviceSelectorProps {
  devices: Device[]
  selectedDeviceIds: string[]
  onDeviceChange: (ids: string[]) => void
  mode?: 'single' | 'multi'
  placeholder?: string
  className?: string
  compact?: boolean
}

export default function DeviceSelector({ devices, selectedDeviceIds, onDeviceChange, mode = 'multi', placeholder = 'Todos los dispositivos', className = '', compact = false }: DeviceSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const portal = useOperationalOverlayPortal()
  const menuId = useId()
  const available = chatHistoryDevices(devices)
  const optionCount = available.length + (mode === 'multi' ? 1 : 0)
  useOperationalOverlayRegistration(isOpen, `chat-devices:${menuId}`)

  const close = useCallback((restoreFocus = true) => {
    setIsOpen(false)
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true })
  }, [])

  const choose = (index: number) => {
    if (mode === 'multi' && index === 0) {
      onDeviceChange([])
      close()
      return
    }
    const device = available[index - (mode === 'multi' ? 1 : 0)]
    if (!device) return
    if (mode === 'single') {
      onDeviceChange([device.id])
      close()
    } else {
      onDeviceChange(selectedDeviceIds.includes(device.id)
        ? selectedDeviceIds.filter(id => id !== device.id)
        : [...selectedDeviceIds, device.id])
    }
  }

  useLayoutEffect(() => {
    if (!isOpen) return
    const positionMenu = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      setPosition(chatDeviceMenuPosition(rect, {
        left: viewport?.offsetLeft || 0,
        top: viewport?.offsetTop || 0,
        width: viewport?.width || window.innerWidth,
        height: viewport?.height || window.innerHeight,
      }, Math.min(360, Math.max(64, optionCount * 64))))
    }
    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    window.visualViewport?.addEventListener('resize', positionMenu)
    window.visualViewport?.addEventListener('scroll', positionMenu)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
      window.visualViewport?.removeEventListener('resize', positionMenu)
      window.visualViewport?.removeEventListener('scroll', positionMenu)
    }
  }, [isOpen, optionCount])

  useLayoutEffect(() => {
    if (!isOpen) return
    const safeIndex = Math.min(activeIndex, Math.max(0, optionCount - 1))
    if (safeIndex !== activeIndex) setActiveIndex(safeIndex)
    const option = menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${safeIndex}"]`)
    if (option) {
      option.focus({ preventScroll: true })
      option.scrollIntoView?.({ block: 'nearest' })
    } else menuRef.current?.focus()
  }, [activeIndex, isOpen, optionCount])

  useEffect(() => {
    if (!isOpen) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [close, isOpen])

  const open = (last = false) => {
    const selectedIndex = available.findIndex(device => selectedDeviceIds.includes(device.id))
    setActiveIndex(last ? Math.max(0, optionCount - 1) : selectedIndex < 0 ? 0 : selectedIndex + (mode === 'multi' ? 1 : 0))
    setIsOpen(true)
  }

  return <div className={`min-w-0 ${className}`}>
    <button ref={triggerRef} type="button" onClick={() => isOpen ? close() : open()} onKeyDown={event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      open(event.key === 'ArrowUp')
    }} className={`flex h-11 w-full min-w-0 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 transition-colors hover:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${compact ? 'sm:h-10' : ''}`} aria-haspopup="listbox" aria-expanded={isOpen} aria-controls={isOpen ? menuId : undefined}>
      <Smartphone className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-slate-700">{chatDeviceSelectionLabel(available, selectedDeviceIds, placeholder)}</span>
      <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform duration-150 motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`} aria-hidden />
    </button>
    {isOpen && typeof document !== 'undefined' && createPortal(<div ref={menuRef} id={menuId} tabIndex={-1} role="listbox" aria-label="Dispositivos" aria-multiselectable={mode === 'multi'} className="pointer-events-auto fixed overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl shadow-slate-900/10 outline-none" style={{ ...position, zIndex: OPERATIONAL_OVERLAY_LAYERS.picker }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      // Let the browser continue Tab order from the invoking control, since
      // the portaled options themselves live at the end of the document.
      if (event.key === 'Tab') { close(); return }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(activeIndex); return }
      const next = event.key === 'ArrowDown' ? Math.min(optionCount - 1, activeIndex + 1) : event.key === 'ArrowUp' ? Math.max(0, activeIndex - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? optionCount - 1 : undefined
      if (next !== undefined) { event.preventDefault(); setActiveIndex(Math.max(0, next)) }
    }}>
      {mode === 'multi' && <button type="button" role="option" tabIndex={activeIndex === 0 ? 0 : -1} data-option-index={0} aria-selected={selectedDeviceIds.length === 0} onFocus={() => setActiveIndex(0)} onClick={() => choose(0)} className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border-b border-slate-100 px-3 py-2.5 text-left hover:bg-emerald-50 focus:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500">
        <span><span className="block text-sm font-semibold text-slate-800">Todos los dispositivos</span><span className="block text-xs text-slate-500">Incluye historial sin dispositivo</span></span>
        {!selectedDeviceIds.length && <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />}
      </button>}
      {available.map((device, index) => {
        const optionIndex = index + (mode === 'multi' ? 1 : 0)
        const selected = selectedDeviceIds.includes(device.id)
        return <button key={device.id} type="button" role="option" tabIndex={activeIndex === optionIndex ? 0 : -1} data-option-index={optionIndex} aria-label={device.name} aria-describedby={`${menuId}-${device.id}-status`} aria-selected={selected} onFocus={() => setActiveIndex(optionIndex)} onClick={() => choose(optionIndex)} className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-emerald-50 focus:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${selected ? 'bg-emerald-50' : ''}`}>
          <span className="flex min-w-0 items-center gap-3"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${device.status === 'connected' ? 'bg-emerald-500' : 'bg-slate-400'}`} aria-hidden /><span className="min-w-0"><span className="block truncate text-sm font-semibold text-slate-800">{device.name}</span><span id={`${menuId}-${device.id}-status`} className="block truncate text-xs text-slate-500">{device.status === 'connected' ? 'Conectado' : 'Sin conexión · historial'}{device.phone ? ` · ${device.phone}` : ''}</span></span></span>
          {selected && <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />}
        </button>
      })}
      {!available.length && <p className="px-3 py-4 text-center text-sm text-slate-500">No hay dispositivos de WhatsApp Web disponibles</p>}
    </div>, portal || document.body)}
  </div>
}
