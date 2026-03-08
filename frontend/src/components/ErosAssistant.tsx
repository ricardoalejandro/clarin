'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { Send, X, Minimize2, Maximize2, Sparkles, MessageSquarePlus, Trash2, ChevronLeft, FileSpreadsheet, FileText, Settings, Key, ExternalLink, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import ErosCat, { CatMood } from './ErosCat'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface Conversation {
  id: string
  title: string
  created_at: string
  updated_at: string
  messages?: ChatMessage[]
}

const waitingMoods: CatMood[] = [
  'playing_ball', 'sleeping', 'stretching', 'washing', 'chasing_tail',
  'looking_left', 'looking_right', 'yawning', 'pawing', 'jumping',
  'winking', 'curious', 'excited', 'love', 'studying',
  'fishing', 'dancing', 'meowing', 'stargazing', 'walking', 'walking_ball'
]

const waitingCaptions: Partial<Record<CatMood, string>> = {
  'thinking': '🤔 Pensando...',
  'playing_ball': '🧶 Jugando mientras pienso...',
  'sleeping': '😴 Descansando un momento...',
  'stretching': '🐱 Estirándome un poco...',
  'washing': '🐾 Lavándome las patitas...',
  'chasing_tail': '🌀 Persiguiendo mi colita...',
  'looking_left': '👀 Buscando por aquí...',
  'looking_right': '👀 Mirando por allá...',
  'yawning': '🥱 Bostezando un poquito...',
  'pawing': '🐾 Revisando datos...',
  'jumping': '🦘 Saltando de alegría...',
  'winking': '😉 Guiñándote el ojo...',
  'curious': '🔍 Investigando a fondo...',
  'excited': '⚡ ¡Encontré algo!',
  'love': '💕 Me encanta ayudarte...',
  'studying': '📚 Estudiando los datos...',
  'fishing': '🎣 Pescando información...',
  'dancing': '💃 Bailando mientras proceso...',
  'meowing': '🐱 ¡Miau! Casi listo...',
  'stargazing': '✨ Contemplando las estrellas...',
  'walking': '🐾 Caminando por aquí...',
  'walking_ball': '⚽ Paseando con mi bolita...',
}

const progressTexts = [
  'Pensando...', 'Procesando...', 'Formulando respuesta...',
  'Un momento...', 'Casi listo...',
]

export default function ErosAssistant() {
  const [isOpen, setIsOpen] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [catMood, setCatMood] = useState<CatMood>('idle')
  const [showGreeting, setShowGreeting] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [progressText, setProgressText] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [showSidebar, setShowSidebar] = useState(false)
  const [isWandering, setIsWandering] = useState(false)
  const [erosConfigured, setErosConfigured] = useState<boolean | null>(null) // null = loading
  const [showConfig, setShowConfig] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState('')
  const [configSuccess, setConfigSuccess] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pathname = usePathname()

  // Show greeting bubble after 3 seconds on first mount
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!isOpen) {
        setShowGreeting(true)
        setCatMood('greeting')
      }
    }, 3000)
    const hideTimer = setTimeout(() => {
      setShowGreeting(false)
      setCatMood('idle')
    }, 9000)
    return () => {
      clearTimeout(timer)
      clearTimeout(hideTimer)
    }
  }, [])

  // Random idle wandering — cat walks around the floating button
  useEffect(() => {
    if (isOpen || isLoading) return
    const wanderMoods: CatMood[] = ['walking', 'walking_ball', 'walking', 'walking']
    const schedule = () => {
      const delay = 15000 + Math.random() * 20000 // 15-35 seconds
      return setTimeout(() => {
        if (isOpen || isLoading) return
        const mood = wanderMoods[Math.floor(Math.random() * wanderMoods.length)]
        setCatMood(mood)
        setIsWandering(true)
        setTimeout(() => {
          setIsWandering(false)
          setCatMood('idle')
        }, 4000)
      }, delay)
    }
    const timer = schedule()
    const interval = setInterval(() => {
      if (!isOpen && !isLoading) {
        const mood = wanderMoods[Math.floor(Math.random() * wanderMoods.length)]
        setCatMood(mood)
        setIsWandering(true)
        setTimeout(() => {
          setIsWandering(false)
          setCatMood('idle')
        }, 4000)
      }
    }, 20000 + Math.random() * 15000)
    return () => {
      clearTimeout(timer)
      clearInterval(interval)
    }
  }, [isOpen, isLoading])

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen])

  // Rotate moods during loading
  useEffect(() => {
    if (!isLoading) return
    const interval = setInterval(() => {
      const mood = waitingMoods[Math.floor(Math.random() * waitingMoods.length)]
      setCatMood(mood)
    }, 3500)
    return () => clearInterval(interval)
  }, [isLoading])

  // Fake progress bar during loading
  useEffect(() => {
    if (!isLoading) {
      setLoadingProgress(0)
      return
    }
    setLoadingProgress(5)
    const steps = [
      { target: 40, duration: 1500 },
      { target: 65, duration: 3000 },
      { target: 80, duration: 5000 },
      { target: 90, duration: 8000 },
      { target: 95, duration: 15000 },
    ]
    const timers: ReturnType<typeof setTimeout>[] = []
    let elapsed = 0
    for (const step of steps) {
      elapsed += step.duration
      timers.push(setTimeout(() => setLoadingProgress(step.target), elapsed))
    }
    return () => timers.forEach(t => clearTimeout(t))
  }, [isLoading])

  // Rotate progress text
  useEffect(() => {
    if (!isLoading) return
    let idx = 0
    setProgressText(progressTexts[0])
    const interval = setInterval(() => {
      idx = (idx + 1) % progressTexts.length
      setProgressText(progressTexts[idx])
    }, 3000)
    return () => clearInterval(interval)
  }, [isLoading])

  // Load conversations when opened
  useEffect(() => {
    if (isOpen) loadConversations()
  }, [isOpen])

  const getAuthHeaders = () => {
    const token = localStorage.getItem('token')
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    }
  }

  // Check if user has configured their Groq API key
  useEffect(() => {
    const checkConfig = async () => {
      try {
        const res = await fetch('/api/ai/config', { headers: getAuthHeaders() })
        const data = await res.json()
        setErosConfigured(data.success && data.has_key)
      } catch {
        setErosConfigured(false)
      }
    }
    checkConfig()
  }, [])

  const loadConversations = async () => {
    try {
      const res = await fetch('/api/ai/conversations', { headers: getAuthHeaders() })
      const data = await res.json()
      if (data.success) setConversations(data.conversations || [])
    } catch { /* ignore */ }
  }

  const loadConversation = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/conversations/${id}`, { headers: getAuthHeaders() })
      const data = await res.json()
      if (data.success && data.conversation) {
        setConversationId(id)
        setMessages(data.conversation.messages?.map((m: { role: string; content: string }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })) || [])
        setShowSidebar(false)
      }
    } catch { /* ignore */ }
  }

  const deleteConversation = async (id: string) => {
    try {
      await fetch(`/api/ai/conversations/${id}`, { method: 'DELETE', headers: getAuthHeaders() })
      setConversations(prev => prev.filter(c => c.id !== id))
      if (conversationId === id) {
        setConversationId(null)
        setMessages([])
      }
    } catch { /* ignore */ }
  }

  const startNewChat = () => {
    setConversationId(null)
    setMessages([])
    setShowSidebar(false)
    setShowConfig(false)
    setCatMood('greeting')
    setTimeout(() => setCatMood('idle'), 2000)
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  const handleSaveApiKey = async () => {
    const key = apiKeyInput.trim()
    if (!key) return
    setConfigLoading(true)
    setConfigError('')
    setConfigSuccess(false)
    try {
      // Validate first
      const valRes = await fetch('/api/ai/config/validate', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ groq_api_key: key }),
      })
      const valData = await valRes.json()
      if (!valData.valid) {
        setConfigError(valData.error || 'API key inválida. Verifica que sea correcta.')
        return
      }
      // Save
      const saveRes = await fetch('/api/ai/config', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ groq_api_key: key }),
      })
      const saveData = await saveRes.json()
      if (saveData.success) {
        setConfigSuccess(true)
        setErosConfigured(true)
        setApiKeyInput('')
        setTimeout(() => {
          setShowConfig(false)
          setConfigSuccess(false)
          setCatMood('greeting')
          setTimeout(() => setCatMood('idle'), 2000)
        }, 1500)
      } else {
        setConfigError('No se pudo guardar la key. Intenta de nuevo.')
      }
    } catch {
      setConfigError('Error de conexión. Intenta de nuevo.')
    } finally {
      setConfigLoading(false)
    }
  }

  const handleDisconnectKey = async () => {
    try {
      await fetch('/api/ai/config', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ groq_api_key: '' }),
      })
      setErosConfigured(false)
      setShowConfig(false)
      setConversationId(null)
      setMessages([])
    } catch { /* ignore */ }
  }

  const sendMessage = useCallback(async () => {
    const msg = input.trim()
    if (!msg || isLoading) return

    const userMsg: ChatMessage = { role: 'user', content: msg }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsLoading(true)
    setCatMood('thinking')

    try {
      const history = [...messages, userMsg].slice(-20)

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          message: msg,
          history,
          current_page: pathname,
          conversation_id: conversationId || '',
        }),
      })

      const data = await res.json()

      if (data.success && data.response) {
        setCatMood('happy')
        setMessages(prev => [...prev, { role: 'assistant', content: data.response }])
        // Save conversation_id from response (auto-created if new)
        if (data.conversation_id && !conversationId) {
          setConversationId(data.conversation_id)
          loadConversations()
        }
      } else if (data.error === 'no_key_configured') {
        setErosConfigured(false)
        setCatMood('sleeping')
        setMessages(prev => prev.slice(0, -1)) // Remove the user message
      } else {
        setCatMood('idle')
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.error || 'Lo siento, hubo un error. Intenta de nuevo 😿',
        }])
      }
    } catch {
      setCatMood('idle')
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'No pude conectarme al servidor. Intenta de nuevo 😿',
      }])
    } finally {
      setIsLoading(false)
      setLoadingProgress(100)
      setTimeout(() => {
        setCatMood('idle')
        setLoadingProgress(0)
      }, 3000)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [input, isLoading, messages, pathname, conversationId])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const toggleOpen = () => {
    setIsOpen(prev => !prev)
    setShowGreeting(false)
    if (!isOpen) {
      setCatMood('greeting')
      setTimeout(() => setCatMood('idle'), 2000)
    }
  }

  // Handle export requests detected in messages
  const handleExport = async (format: 'excel' | 'word', content: string) => {
    try {
      // Extract table data from markdown in the message
      const lines = content.split('\n').filter(l => l.trim().startsWith('|'))
      if (lines.length < 2) return

      const headers = lines[0].split('|').filter(c => c.trim()).map(c => c.trim())
      const dataRows = lines.slice(1).filter(l => !l.match(/^\|[\s-|]+\|$/))

      if (format === 'excel') {
        const xlsxMod = await import('xlsx')
        const XLSX = xlsxMod.default || xlsxMod
        const fileSaver = await import('file-saver')
        const saveAs = fileSaver.saveAs || fileSaver.default?.saveAs
        const rows = dataRows.map(row => {
          const cells = row.split('|').filter(c => c.trim()).map(c => c.trim())
          const obj: Record<string, string> = {}
          headers.forEach((h, i) => { obj[h] = cells[i] || '' })
          return obj
        })
        const ws = XLSX.utils.json_to_sheet(rows)
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, 'Reporte')
        const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
        saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'reporte_eros.xlsx')
      } else {
        const fileSaver = await import('file-saver')
        const saveAs = fileSaver.saveAs || fileSaver.default?.saveAs
        let html = '\ufeff<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><style>table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#10b981;color:white}body{font-family:Calibri,Arial,sans-serif}</style></head><body>'
        html += '<h2>Reporte Eros - Clarin CRM</h2>'
        html += '<table><thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>'
        dataRows.forEach(row => {
          const cells = row.split('|').filter(c => c.trim()).map(c => c.trim())
          html += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>'
        })
        html += '</tbody></table></body></html>'
        const blob = new Blob([html], { type: 'application/msword;charset=utf-8' })
        saveAs(blob, 'reporte_eros.doc')
      }
    } catch (err) {
      console.error('Export error:', err)
      alert('Error al exportar. Intenta de nuevo.')
    }
  }

  // Check if message contains table data (for showing export buttons)
  const hasTableData = (content: string) => {
    const lines = content.split('\n').filter(l => l.trim().startsWith('|'))
    return lines.length >= 3
  }

  // Format markdown-like response (bold, lists, tables)
  const formatResponse = (text: string) => {
    const lines = text.split('\n')
    const result: JSX.Element[] = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]

      // Detect table: lines starting with |
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const tableLines: string[] = []
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          tableLines.push(lines[i])
          i++
        }

        // Parse table
        if (tableLines.length >= 2) {
          const headerCells = tableLines[0].split('|').filter(c => c.trim()).map(c => c.trim())
          const dataLines = tableLines.filter((_, idx) => {
            if (idx === 0) return false
            return !tableLines[idx].match(/^\s*\|[\s-:]+\|\s*$/)
          })

          result.push(
            <div key={`table-${i}`} className="overflow-x-auto my-2 rounded-lg border border-slate-200">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-emerald-500 text-white">
                    {headerCells.map((h, j) => (
                      <th key={j} className="px-3 py-2 text-left font-semibold whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataLines.map((row, ri) => {
                    const cells = row.split('|').filter(c => c.trim()).map(c => c.trim())
                    return (
                      <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                        {cells.map((cell, ci) => (
                          <td key={ci} className="px-3 py-1.5 border-t border-slate-100 whitespace-nowrap">{cell}</td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
          continue
        }
      }

      // Parse inline formatting: bold **text**, italic *text*
      const parseInline = (text: string) => {
        // First split bold, then italic within each segment
        return text.split(/(\*\*[^*]+\*\*)/g).flatMap((seg, j) => {
          if (seg.startsWith('**') && seg.endsWith('**')) {
            return [<strong key={`b${j}`} className="font-semibold">{seg.slice(2, -2)}</strong>]
          }
          // Split italic *text* (single asterisk, not double)
          return seg.split(/(\*[^*]+\*)/g).map((sub, k) => {
            if (sub.startsWith('*') && sub.endsWith('*') && sub.length > 2) {
              return <em key={`i${j}-${k}`} className="italic text-slate-600">{sub.slice(1, -1)}</em>
            }
            return sub
          })
        })
      }
      const parts = parseInline(line)

      // Bullet points (-, •, *)
      const bulletMatch = line.match(/^(\s*)[\-•\*]\s+(.*)/)
      if (bulletMatch) {
        const indent = Math.min(Math.floor(bulletMatch[1].length / 2), 3)
        result.push(
          <div key={i} className="flex gap-1.5" style={{ marginLeft: `${indent * 12 + 4}px` }}>
            <span className="text-emerald-500 shrink-0 mt-0.5">•</span>
            <span>{parseInline(bulletMatch[2])}</span>
          </div>
        )
        i++
        continue
      }

      // Numbered lists
      const numMatch = line.trim().match(/^(\d+)\.\s+(.*)/)
      if (numMatch) {
        result.push(
          <div key={i} className="flex gap-1.5 ml-1">
            <span className="text-emerald-600 font-medium shrink-0">{numMatch[1]}.</span>
            <span>{parseInline(numMatch[2])}</span>
          </div>
        )
        i++
        continue
      }

      // Heading-like lines (###)
      const headingMatch = line.match(/^#{1,3}\s+(.*)/)
      if (headingMatch) {
        result.push(<div key={i} className="font-semibold text-slate-800 mt-1">{parseInline(headingMatch[1])}</div>)
        i++
        continue
      }

      result.push(<div key={i}>{parts}{line === '' && <br />}</div>)
      i++
    }

    return result
  }

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `hace ${mins}m`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `hace ${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `hace ${days}d`
    return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' })
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2">
      {/* Backdrop when maximized */}
      {isOpen && isMaximized && (
        <div
          className="fixed inset-0 bg-black/30 z-[55] transition-opacity"
          onClick={() => setIsMaximized(false)}
        />
      )}

      {/* Chat Panel */}
      {isOpen && (
        <div
          className={`bg-white rounded-2xl shadow-2xl border border-slate-200 flex overflow-hidden transition-all duration-300 ${
            isMaximized
              ? 'fixed inset-0 m-auto w-[95vw] max-w-[1100px] h-[90vh] z-[60]'
              : 'w-[340px] max-h-[520px] flex-col'
          }`}
          style={{ animation: 'eros-bounce-in 0.3s ease-out both' }}
        >
          {/* Sidebar - only in maximized mode */}
          {isMaximized && showSidebar && (
            <div className="w-64 border-r border-slate-200 flex flex-col bg-slate-50 shrink-0">
              <div className="p-3 border-b border-slate-200 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-700">Historial</h4>
                <button
                  onClick={startNewChat}
                  className="p-1.5 hover:bg-emerald-50 rounded-lg transition-colors text-emerald-600"
                  title="Nuevo chat"
                >
                  <MessageSquarePlus size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {conversations.map(conv => (
                  <div
                    key={conv.id}
                    className={`group px-3 py-2.5 cursor-pointer border-b border-slate-100 hover:bg-white transition-colors ${
                      conversationId === conv.id ? 'bg-emerald-50 border-l-2 border-l-emerald-500' : ''
                    }`}
                    onClick={() => loadConversation(conv.id)}
                  >
                    <p className="text-xs font-medium text-slate-700 truncate">{conv.title || 'Sin título'}</p>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-slate-400">{formatDate(conv.updated_at)}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id) }}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-50 rounded text-slate-400 hover:text-red-500 transition-all"
                        title="Eliminar"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
                {conversations.length === 0 && (
                  <div className="p-4 text-center text-xs text-slate-400">
                    Sin conversaciones aún
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Main chat area */}
          <div className={`flex flex-col flex-1 min-w-0 ${!isMaximized ? '' : ''}`}>
            {/* Header */}
            <div className="bg-gradient-to-r from-emerald-600 to-emerald-500 px-4 py-3 flex items-center gap-3 shrink-0">
              {isMaximized && (
                <button
                  onClick={() => setShowSidebar(prev => !prev)}
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                  title={showSidebar ? 'Ocultar historial' : 'Ver historial'}
                >
                  <ChevronLeft size={16} className={`text-white transition-transform ${showSidebar ? '' : 'rotate-180'}`} />
                </button>
              )}
              <div className="w-9 h-9 bg-white/20 rounded-full flex items-center justify-center">
                <ErosCat mood={catMood} size={isMaximized ? 40 : 28} />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-white font-semibold text-sm leading-tight">Eros</h3>
                <p className="text-emerald-100 text-xs">Asistente IA de Clarin</p>
              </div>
              <div className="flex gap-1">
                {erosConfigured && (
                  <button
                    onClick={() => { setShowConfig(prev => !prev); setConfigError(''); setConfigSuccess(false) }}
                    className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                    title="Configuración de IA"
                  >
                    <Settings size={14} className="text-white/80" />
                  </button>
                )}
                <button
                  onClick={startNewChat}
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                  title="Nuevo chat"
                >
                  <Sparkles size={14} className="text-white/80" />
                </button>
                <button
                  onClick={() => setIsMaximized(prev => !prev)}
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                  title={isMaximized ? 'Restaurar' : 'Maximizar'}
                >
                  {isMaximized ? <Minimize2 size={14} className="text-white/80" /> : <Maximize2 size={14} className="text-white/80" />}
                </button>
                <button
                  onClick={() => { setIsOpen(false); setIsMaximized(false) }}
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                  title="Cerrar"
                >
                  <X size={14} className="text-white/80" />
                </button>
              </div>
            </div>

            {/* Progress Bar */}
            {isLoading && (
              <div className="shrink-0">
                <div className="h-1 bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all duration-1000 ease-out"
                    style={{ width: `${loadingProgress}%` }}
                  />
                </div>
                <div className="text-center py-1 bg-emerald-50/50">
                  <span className="text-[11px] text-emerald-600 animate-pulse">{progressText}</span>
                </div>
              </div>
            )}

            {/* Messages */}
            <div className={`flex-1 overflow-y-auto p-3 space-y-3 min-h-[200px] bg-slate-50/50 ${
              isMaximized ? '' : 'max-h-[360px]'
            }`}>
              {/* Sleeping screen — no API key configured */}
              {erosConfigured === false && !showConfig && (
                <div className="flex flex-col items-center justify-center h-full text-center py-6 gap-3">
                  <ErosCat mood="sleeping" size={isMaximized ? 100 : 72} />
                  <div>
                    <p className="text-slate-700 font-medium text-sm">Eros está dormido 😴</p>
                    <p className="text-slate-500 text-xs mt-1.5 max-w-[250px] leading-relaxed">
                      Para despertar a Eros necesitas una API key de Groq (es gratis).
                    </p>
                  </div>
                  <button
                    onClick={() => { setShowConfig(true); setConfigError(''); setConfigSuccess(false) }}
                    className="mt-2 flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl hover:bg-emerald-600 transition-all active:scale-95 shadow-sm"
                  >
                    <Key size={14} />
                    Despertar a Eros
                  </button>
                </div>
              )}

              {/* Config screen — enter API key */}
              {showConfig && (
                <div className="flex flex-col items-center justify-center h-full py-4 gap-3 px-2">
                  <ErosCat mood={configSuccess ? 'happy' : 'curious'} size={isMaximized ? 80 : 56} />
                  <div className="text-center">
                    <p className="text-slate-700 font-medium text-sm">
                      {erosConfigured ? 'Configuración de API Key' : 'Configurar Groq API Key'}
                    </p>
                    <p className="text-slate-500 text-xs mt-1 max-w-[260px] leading-relaxed">
                      Obtén tu key gratis en{' '}
                      <a
                        href="https://console.groq.com/keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-emerald-600 hover:text-emerald-700 underline inline-flex items-center gap-0.5"
                      >
                        console.groq.com <ExternalLink size={10} />
                      </a>
                    </p>
                  </div>

                  <div className="w-full max-w-[280px] space-y-2">
                    <div className="relative">
                      <input
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => { setApiKeyInput(e.target.value); setConfigError('') }}
                        placeholder="gsk_xxxxxxxxxxxxxxxx"
                        className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all pr-10"
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSaveApiKey() }}
                        disabled={configLoading || configSuccess}
                      />
                      {configSuccess && (
                        <CheckCircle2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500" />
                      )}
                    </div>

                    {configError && (
                      <div className="flex items-start gap-1.5 text-red-600 text-xs bg-red-50 px-2.5 py-2 rounded-lg">
                        <XCircle size={12} className="shrink-0 mt-0.5" />
                        <span>{configError}</span>
                      </div>
                    )}

                    {configSuccess && (
                      <div className="flex items-center gap-1.5 text-emerald-600 text-xs bg-emerald-50 px-2.5 py-2 rounded-lg">
                        <CheckCircle2 size={12} />
                        <span>¡Key válida! Eros está despierto 🎉</span>
                      </div>
                    )}

                    <button
                      onClick={handleSaveApiKey}
                      disabled={!apiKeyInput.trim() || configLoading || configSuccess}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500 text-white text-sm font-medium rounded-xl hover:bg-emerald-600 disabled:opacity-40 disabled:hover:bg-emerald-500 transition-all active:scale-[0.98] shadow-sm"
                    >
                      {configLoading ? (
                        <><Loader2 size={14} className="animate-spin" /> Validando...</>
                      ) : (
                        <><Key size={14} /> Conectar</>
                      )}
                    </button>

                    <div className="flex gap-2">
                      {erosConfigured && (
                        <button
                          onClick={handleDisconnectKey}
                          className="flex-1 px-3 py-2 text-xs text-red-600 bg-red-50 rounded-xl hover:bg-red-100 transition-colors"
                        >
                          Desconectar
                        </button>
                      )}
                      <button
                        onClick={() => { setShowConfig(false); setConfigError(''); setApiKeyInput('') }}
                        className="flex-1 px-3 py-2 text-xs text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
                      >
                        {erosConfigured ? 'Volver' : 'Cancelar'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Normal chat area — only when configured and not in config screen */}
              {erosConfigured && !showConfig && (<>
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center py-8 gap-3">
                  <ErosCat mood="greeting" size={isMaximized ? 100 : 64} />
                  <div>
                    <p className="text-slate-700 font-medium text-sm">¡Hola! Soy Eros 🐱</p>
                    <p className="text-slate-500 text-xs mt-1 max-w-[220px]">
                      Tu asistente de IA. Pregúntame sobre tus leads, campañas, estadísticas o estrategias.
                    </p>
                  </div>
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`flex flex-col max-w-[85%] ${isMaximized ? 'max-w-[75%]' : ''}`}>
                    <div
                      className={`px-3 py-2 rounded-2xl leading-relaxed ${
                        isMaximized ? 'text-sm' : 'text-[13px]'
                      } ${
                        msg.role === 'user'
                          ? 'bg-emerald-500 text-white rounded-br-sm'
                          : 'bg-white text-slate-800 rounded-bl-sm shadow-sm border border-slate-100'
                      }`}
                      style={{ animation: 'eros-slide-in 0.2s ease-out both' }}
                    >
                      {msg.role === 'assistant' ? formatResponse(msg.content) : msg.content}
                    </div>
                    {/* Export buttons for assistant messages with table data */}
                    {msg.role === 'assistant' && hasTableData(msg.content) && (
                      <div className="flex gap-1.5 mt-1.5 ml-1">
                        <button
                          onClick={() => handleExport('excel', msg.content)}
                          className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 transition-colors"
                        >
                          <FileSpreadsheet size={12} /> Excel
                        </button>
                        <button
                          onClick={() => handleExport('word', msg.content)}
                          className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition-colors"
                        >
                          <FileText size={12} /> Word
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-white text-slate-500 px-3 py-3 rounded-2xl rounded-bl-sm shadow-sm border border-slate-100">
                    <div className="flex items-center gap-3">
                      <ErosCat mood={catMood} size={isMaximized ? 72 : 48} />
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-slate-600 font-medium">
                          {waitingCaptions[catMood] || '🐱 Procesando...'}
                        </span>
                        <span className="inline-flex gap-1.5 items-center">
                          <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
              </>)}
            </div>

            {/* Input */}
            <div className="border-t border-slate-200 p-3 bg-white shrink-0">
              <div className="flex gap-2 items-end">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={erosConfigured ? "Escribe tu pregunta..." : "Configura tu API key para chatear..."}
                  rows={isMaximized ? 2 : 1}
                  className="flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all max-h-[80px]"
                  style={{ minHeight: isMaximized ? '52px' : '36px' }}
                  disabled={isLoading || !erosConfigured || showConfig}
                />
                <button
                  onClick={sendMessage}
                  disabled={!input.trim() || isLoading}
                  className="p-2 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:hover:bg-emerald-500 transition-all shrink-0 active:scale-95"
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Greeting Bubble */}
      {showGreeting && !isOpen && erosConfigured && (
        <div
          className="bg-white rounded-2xl rounded-br-sm shadow-lg border border-slate-200 px-3.5 py-2 text-sm text-slate-700 max-w-[200px] mr-2 cursor-pointer"
          style={{ animation: 'eros-slide-in 0.3s ease-out both' }}
          onClick={toggleOpen}
        >
          ¡Hola! ¿Necesitas ayuda? 🐱
        </div>
      )}

      {/* Floating Cat Button */}
      <button
        onClick={toggleOpen}
        className={`group relative w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-300 hover:scale-110 active:scale-95 ${
          isOpen
            ? 'bg-emerald-600 hover:bg-emerald-700'
            : 'bg-white hover:shadow-xl border border-slate-200'
        }`}
        style={{
          animation: !isOpen && isWandering ? 'eros-wander 4s ease-in-out both' : undefined,
        }}
        title="Eros — Asistente IA"
      >
        {isOpen ? (
          <X size={20} className="text-white" />
        ) : (
          <ErosCat mood={erosConfigured === false ? 'sleeping' : catMood} size={40} />
        )}

        {/* Pulse ring when not open */}
        {!isOpen && (
          <span className="absolute inset-0 rounded-full border-2 border-emerald-400 animate-ping opacity-20 pointer-events-none" />
        )}
      </button>
    </div>
  )
}
