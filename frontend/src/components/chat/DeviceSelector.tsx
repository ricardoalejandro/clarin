'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Smartphone, Check } from 'lucide-react'

interface Device {
  id: string
  name: string
  phone?: string
  status: string
}

interface DeviceSelectorProps {
  devices: Device[]
  selectedDeviceIds: string[]
  onDeviceChange: (ids: string[]) => void
  mode?: 'single' | 'multi'
  placeholder?: string
  className?: string
}

export default function DeviceSelector({
  devices,
  selectedDeviceIds,
  onDeviceChange,
  mode = 'multi',
  placeholder = 'Todos los dispositivos',
  className = '',
}: DeviceSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setIsOpen(false) }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [])

  const connectedDevices = devices.filter(d => d.status === 'connected')

  const handleToggle = (deviceId: string) => {
    if (mode === 'single') {
      onDeviceChange([deviceId])
      setIsOpen(false)
    } else {
      if (selectedDeviceIds.includes(deviceId)) {
        onDeviceChange(selectedDeviceIds.filter(id => id !== deviceId))
      } else {
        onDeviceChange([...selectedDeviceIds, deviceId])
      }
    }
  }

  const handleSelectAll = () => {
    if (selectedDeviceIds.length === connectedDevices.length) {
      onDeviceChange([])
    } else {
      onDeviceChange(connectedDevices.map(d => d.id))
    }
  }

  const getDisplayText = () => {
    if (selectedDeviceIds.length === 0) {
      return placeholder
    }
    if (selectedDeviceIds.length === connectedDevices.length) {
      return placeholder
    }
    if (selectedDeviceIds.length === 1) {
      const device = connectedDevices.find(d => d.id === selectedDeviceIds[0])
      return device?.name || 'Dispositivo'
    }
    return `${selectedDeviceIds.length} dispositivos`
  }

  return (
    <div className={`relative min-w-0 ${className}`} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-11 w-full min-w-0 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 transition hover:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <Smartphone className="h-4 w-4 shrink-0 text-emerald-600" />
        <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-slate-700">{getDisplayText()}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div role="listbox" aria-label="Dispositivos" className="absolute left-0 right-0 top-full z-50 mt-1 min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10">
          {mode === 'multi' && (
            <button
              type="button"
              onClick={handleSelectAll}
              className="flex min-h-11 w-full items-center justify-between border-b border-slate-200 px-3 py-2.5 text-left hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
            >
              <span className="min-w-0 truncate text-sm font-semibold text-slate-800">Todos los dispositivos</span>
              {selectedDeviceIds.length === 0 || selectedDeviceIds.length === connectedDevices.length ? (
                <Check className="h-5 w-5 shrink-0 text-emerald-600" />
              ) : null}
            </button>
          )}

          <div className="max-h-48 overflow-y-auto">
            {connectedDevices.map(device => (
              <button
                type="button"
                role="option"
                aria-selected={selectedDeviceIds.includes(device.id)}
                key={device.id}
                onClick={() => handleToggle(device.id)}
                className={`flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${selectedDeviceIds.includes(device.id) ? 'bg-emerald-50' : ''}`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-emerald-500" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-800">{device.name}</p>
                    {device.phone && (
                      <p className="truncate text-xs font-medium text-slate-500">{device.phone}</p>
                    )}
                  </div>
                </div>
                {selectedDeviceIds.includes(device.id) && (
                  <Check className="h-5 w-5 shrink-0 text-emerald-600" />
                )}
              </button>
            ))}
          </div>

          {connectedDevices.length === 0 && (
            <div className="px-3 py-4 text-center text-sm font-medium text-gray-600">
              No hay dispositivos conectados
            </div>
          )}
        </div>
      )}
    </div>
  )
}
