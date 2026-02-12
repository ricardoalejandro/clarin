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
}

export default function DeviceSelector({
  devices,
  selectedDeviceIds,
  onDeviceChange,
  mode = 'multi',
  placeholder = 'Todos los dispositivos'
}: DeviceSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
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
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-lg hover:border-green-500 focus:ring-2 focus:ring-green-500 focus:border-transparent min-w-[200px]"
      >
        <Smartphone className="w-4 h-4 text-green-600" />
        <span className="flex-1 text-left text-sm font-medium text-gray-800 truncate">{getDisplayText()}</span>
        <ChevronDown className={`w-4 h-4 text-gray-600 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
          {mode === 'multi' && (
            <div
              onClick={handleSelectAll}
              className="px-3 py-2.5 cursor-pointer hover:bg-green-50 border-b border-gray-200 flex items-center justify-between"
            >
              <span className="text-sm font-semibold text-gray-800">Todos los dispositivos</span>
              {selectedDeviceIds.length === 0 || selectedDeviceIds.length === connectedDevices.length ? (
                <Check className="w-5 h-5 text-green-600" />
              ) : null}
            </div>
          )}
          
          <div className="max-h-48 overflow-y-auto">
            {connectedDevices.map(device => (
              <div
                key={device.id}
                onClick={() => handleToggle(device.id)}
                className={`px-3 py-2.5 cursor-pointer hover:bg-green-50 flex items-center justify-between ${selectedDeviceIds.includes(device.id) ? 'bg-green-50' : ''}`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-green-500 rounded-full flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{device.name}</p>
                    {device.phone && (
                      <p className="text-xs font-medium text-gray-600">{device.phone}</p>
                    )}
                  </div>
                </div>
                {selectedDeviceIds.includes(device.id) && (
                  <Check className="w-5 h-5 text-green-600" />
                )}
              </div>
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
