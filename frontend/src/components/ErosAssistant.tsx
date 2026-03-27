'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { Send, X, Minimize2, Maximize2, Sparkles, MessageSquarePlus, Trash2, FileSpreadsheet, FileText, Settings, Key, ExternalLink, Loader2, CheckCircle2, XCircle, Menu, BarChart3, Download, ChevronsUpDown } from 'lucide-react'
import ErosCat, { CatMood } from './ErosCat'
import ErosChart, { parseChartBlocks, type ChartConfig } from './ErosChart'

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

export default function ErosAssistant({ isOpenProp = false, onClose }: { isOpenProp?: boolean; onClose?: () => void }) {
  const [isMobile, setIsMobile] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null)
  const [catMood, setCatMood] = useState<CatMood>('idle')
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [progressText, setProgressText] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [showSidebar, setShowSidebar] = useState(false)
  const [erosConfigured, setErosConfigured] = useState<boolean | null>(null) // null = loading
  const [showConfig, setShowConfig] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState('')
  const [configSuccess, setConfigSuccess] = useState(false)
  const [configStep, setConfigStep] = useState<'key' | 'model' | 'custom'>('key')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [customRole, setCustomRole] = useState('')
  const [customInstructions, setCustomInstructions] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [mobileVH, setMobileVH] = useState<number | null>(null)
  const [maximizedChart, setMaximizedChart] = useState<ChartConfig | null>(null)
  const [isInputExpanded, setIsInputExpanded] = useState(false)
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const inputHistoryIndex = useRef<number>(-1)
  const inputDraft = useRef<string>('')
  const headerMoods: CatMood[] = ['idle', 'winking', 'playing_ball', 'curious', 'dancing', 'jumping', 'love', 'pawing', 'walking']
  const [headerMoodIdx, setHeaderMoodIdx] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const chatPanelRef = useRef<HTMLDivElement>(null)
  const pathname = usePathname()

  // Sync isOpen with prop from layout
  useEffect(() => {
    setIsOpen(isOpenProp)
  }, [isOpenProp])

  // Mobile detection
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Adjust inner layout when mobile keyboard opens/closes
  useEffect(() => {
    if (!isMobile || !isOpen) { setMobileVH(null); return }
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      // Use visualViewport height to shrink panel when keyboard is open
      const vh = vv.height
      const fullH = window.innerHeight
      // Only set mobileVH when keyboard is actually open (viewport noticeably smaller)
      if (fullH - vh > 100) {
        setMobileVH(vh)
      } else {
        setMobileVH(null)
      }
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
    onResize()
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [isMobile, isOpen])

  // Cycle header cat mood for playful animations
  useEffect(() => {
    if (!isOpen || isLoading) return
    const interval = setInterval(() => {
      setHeaderMoodIdx(prev => (prev + 1) % headerMoods.length)
    }, 3000)
    return () => clearInterval(interval)
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

  // Global Escape key handler for Eros panel
  useEffect(() => {
    if (!isOpen) return
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Don't handle if textarea has focus (handleKeyDown handles it)
      if (document.activeElement === inputRef.current) return
      e.preventDefault()
      if (maximizedChart) { setMaximizedChart(null); return }
      if (isMaximized) { setIsMaximized(false); return }
      onClose?.()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [isOpen, isMaximized, maximizedChart, onClose])

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

  // Check if user has configured their API key
  useEffect(() => {
    const checkConfig = async () => {
      try {
        const res = await fetch('/api/ai/config', { headers: getAuthHeaders() })
        const data = await res.json()
        setErosConfigured(data.success && data.has_key)
        if (data.model) setSelectedModel(data.model)
        if (data.role) setCustomRole(data.role)
        if (data.instructions) setCustomInstructions(data.instructions)
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
    if (!key.startsWith('sk-')) {
      setConfigError('La API key debe comenzar con sk-')
      return
    }
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
      // Key valid — fetch available models
      setModelsLoading(true)
      const modelsRes = await fetch('/api/ai/models', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ api_key: key }),
      })
      const modelsData = await modelsRes.json()
      if (modelsData.success && modelsData.models?.length > 0) {
        setAvailableModels(modelsData.models)
        if (!selectedModel || !modelsData.models.includes(selectedModel)) {
          setSelectedModel(modelsData.models.includes('gpt-4.1-nano') ? 'gpt-4.1-nano' : modelsData.models[0])
        }
      }
      setModelsLoading(false)
      // Save the key immediately
      await fetch('/api/ai/config', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ groq_api_key: key, model: selectedModel, role: customRole, instructions: customInstructions }),
      })
      setErosConfigured(true)
      setConfigStep('model')
    } catch {
      setConfigError('Error de conexión. Intenta de nuevo.')
    } finally {
      setConfigLoading(false)
      setModelsLoading(false)
    }
  }

  const handleSaveConfig = async () => {
    setConfigLoading(true)
    setConfigError('')
    try {
      const key = apiKeyInput.trim() || undefined
      const res = await fetch('/api/ai/config', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          groq_api_key: key ?? '',
          model: selectedModel,
          role: customRole,
          instructions: customInstructions,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setConfigSuccess(true)
        setTimeout(() => {
          setShowConfig(false)
          setConfigSuccess(false)
          setConfigStep('key')
          setCatMood('greeting')
          setTimeout(() => setCatMood('idle'), 2000)
        }, 1000)
      } else {
        setConfigError('No se pudo guardar la configuración.')
      }
    } catch {
      setConfigError('Error de conexión.')
    } finally {
      setConfigLoading(false)
    }
  }

  const handleOpenConfigPanel = async () => {
    setShowConfig(true)
    setConfigError('')
    setConfigSuccess(false)
    if (erosConfigured) {
      setConfigStep('model')
      // Load models if not already loaded
      if (availableModels.length === 0) {
        try {
          const keyRes = await fetch('/api/ai/config', { headers: getAuthHeaders() })
          const keyData = await keyRes.json()
          if (keyData.has_key) {
            // We need to pass the key to fetch models — but we don't expose it
            // Instead try fetching with the stored key by loading from backend
            setModelsLoading(true)
            // The stored key is used server-side, we need a different approach
            // Let's use the current stored key indirectly — we'll call handleSaveApiKey with empty
            setModelsLoading(false)
          }
        } catch { /* ignore */ }
      }
    } else {
      setConfigStep('key')
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
    setInputHistory(prev => [...prev, msg])
    inputHistoryIndex.current = -1
    inputDraft.current = ''
    setIsLoading(true)
    setCatMood('thinking')

    try {
      const history = [...messages, userMsg].slice(-20).map(m => ({
        ...m,
        content: m.role === 'assistant'
          ? m.content.replace(/<chart>[\s\S]*?<\/chart>/g, '[gráfico]').replace(/^\|.*\|$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 800)
          : m.content.slice(0, 800)
      }))

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
        setLastFailedMessage(null)
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
      } else if (data.error === 'chat_limit_reached') {
        setCatMood('idle')
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: '¡Miau! 😿 Has alcanzado el límite de **50 conversaciones**. Elimina alguna conversación antigua desde el historial para poder iniciar una nueva.',
        }])
      } else if (data.rate_limited) {
        setCatMood('idle')
        setLastFailedMessage(msg)
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.error || '¡Miau! 😿 Estoy procesando muchas consultas. Dame unos segunditos 🐾',
        }])
      } else {
        setCatMood('idle')
        setLastFailedMessage(msg)
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.error || 'Lo siento, hubo un error. Intenta de nuevo 😿',
        }])
      }
    } catch {
      setCatMood('idle')
      setLastFailedMessage(msg)
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

  const retryLastMessage = useCallback(() => {
    if (!lastFailedMessage || isLoading) return
    // Remove the last error message from assistant
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant') return prev.slice(0, -1)
      return prev
    })
    // Remove the last user message too (sendMessage will re-add it)
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'user') return prev.slice(0, -1)
      return prev
    })
    setInput(lastFailedMessage)
    setLastFailedMessage(null)
    setTimeout(() => {
      // Trigger send after state update
      const sendBtn = document.querySelector('[data-eros-send]') as HTMLButtonElement
      sendBtn?.click()
    }, 100)
  }, [lastFailedMessage, isLoading])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (maximizedChart) { setMaximizedChart(null); return }
      if (isMaximized) { setIsMaximized(false); return }
      setIsOpen(false)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    } else if (e.key === 'ArrowUp' && inputHistory.length > 0) {
      // Only navigate history if cursor is at the start or input is empty
      const textarea = inputRef.current
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        e.preventDefault()
        if (inputHistoryIndex.current === -1) {
          inputDraft.current = input
          inputHistoryIndex.current = inputHistory.length - 1
        } else if (inputHistoryIndex.current > 0) {
          inputHistoryIndex.current -= 1
        }
        setInput(inputHistory[inputHistoryIndex.current])
      }
    } else if (e.key === 'ArrowDown' && inputHistoryIndex.current !== -1) {
      const textarea = inputRef.current
      const atEnd = textarea && textarea.selectionStart === textarea.value.length
      if (atEnd) {
        e.preventDefault()
        if (inputHistoryIndex.current < inputHistory.length - 1) {
          inputHistoryIndex.current += 1
          setInput(inputHistory[inputHistoryIndex.current])
        } else {
          inputHistoryIndex.current = -1
          setInput(inputDraft.current)
        }
      }
    }
  }

  const exportAsTxt = () => {
    if (messages.length === 0) return
    const lines = messages.map(m => {
      const label = m.role === 'user' ? 'Tú' : 'Eros'
      // Strip chart tags and clean up for text
      const clean = m.content
        .replace(/<chart>[\s\S]*?<\/chart>/g, '[Gráfico]')
        .replace(/```[\s\S]*?```/g, '[Código]')
        .trim()
      return `[${label}]\n${clean}\n`
    })
    const header = `═══════════════════════════════════════\n  Conversación con Eros — Clarin CRM\n  ${new Date().toLocaleString('es-PE')}\n═══════════════════════════════════════\n\n`
    const text = header + lines.join('\n─────────────────────────────────────\n\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `eros_conversacion_${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportAsPdf = async () => {
    if (messages.length === 0) return
    try {
      const jsPDF = (await import('jspdf')).default
      const html2canvas = (await import('html2canvas')).default
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageW = pdf.internal.pageSize.getWidth()
      const margin = 15

      // Header
      pdf.setFillColor(5, 150, 105) // emerald-600
      pdf.rect(0, 0, pageW, 28, 'F')
      pdf.setTextColor(255, 255, 255)
      pdf.setFontSize(16)
      pdf.setFont('helvetica', 'bold')
      pdf.text('Eros — Clarin CRM', margin, 14)
      pdf.setFontSize(9)
      pdf.setFont('helvetica', 'normal')
      pdf.text(`Conversación exportada el ${new Date().toLocaleString('es-PE')}`, margin, 22)

      let y = 38

      for (const msg of messages) {
        const isUser = msg.role === 'user'
        const label = isUser ? 'Tú' : 'Eros'
        const { segments } = parseChartBlocks(msg.content)

        // Check page break
        if (y > 260) { pdf.addPage(); y = 15 }

        // Role label
        pdf.setFontSize(8)
        pdf.setFont('helvetica', 'bold')
        pdf.setTextColor(isUser ? 5 : 71, isUser ? 150 : 85, isUser ? 105 : 105)
        pdf.text(label, margin, y)
        y += 5

        for (const seg of segments) {
          if (seg.type === 'chart' && seg.config) {
            // Render chart to canvas then to PDF
            const tempDiv = document.createElement('div')
            tempDiv.style.cssText = 'position:fixed;left:-9999px;top:0;width:500px;height:300px;background:white;'
            document.body.appendChild(tempDiv)
            const { createRoot } = await import('react-dom/client')
            const React = await import('react')
            const ErosChartMod = (await import('./ErosChart')).default
            const root = createRoot(tempDiv)
            root.render(React.createElement(ErosChartMod, { config: seg.config, compact: false }))
            // Wait for chart to render
            await new Promise(r => setTimeout(r, 800))
            try {
              const canvas = await html2canvas(tempDiv, { scale: 2, useCORS: true, backgroundColor: '#ffffff' })
              const imgData = canvas.toDataURL('image/png')
              const imgW = pageW - margin * 2
              const imgH = (canvas.height / canvas.width) * imgW
              if (y + imgH > 280) { pdf.addPage(); y = 15 }
              pdf.addImage(imgData, 'PNG', margin, y, imgW, imgH)
              y += imgH + 5
            } catch { /* chart render failed, skip */ }
            root.unmount()
            document.body.removeChild(tempDiv)
          } else {
            // Text content
            const clean = seg.content.replace(/<[^>]+>/g, '').trim()
            if (!clean) continue
            pdf.setFontSize(10)
            pdf.setFont('helvetica', 'normal')
            pdf.setTextColor(51, 65, 85) // slate-700
            const lines = pdf.splitTextToSize(clean, pageW - margin * 2)
            for (const line of lines) {
              if (y > 280) { pdf.addPage(); y = 15 }
              pdf.text(line, margin, y)
              y += 4.5
            }
          }
        }
        y += 6
      }

      // Footer
      const pageCount = pdf.getNumberOfPages()
      for (let i = 1; i <= pageCount; i++) {
        pdf.setPage(i)
        pdf.setFontSize(7)
        pdf.setTextColor(148, 163, 184) // slate-400
        pdf.text(`Clarin CRM — Página ${i} de ${pageCount}`, pageW / 2, 290, { align: 'center' })
      }

      pdf.save(`eros_conversacion_${new Date().toISOString().slice(0, 10)}.pdf`)
    } catch (err) {
      console.error('PDF export error:', err)
    }
  }

  const toggleOpen = () => {
    if (isOpen && onClose) {
      onClose()
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


  // Render assistant message with chart blocks support
  const renderAssistantMessage = (text: string, msgIndex: number) => {
    // Strip leaked tool call JSON from AI response (defense in depth)
    const cleanText = text.replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"parameters"\s*:\s*\{[^}]*\}\s*\}/g, '').trim()
    const { segments } = parseChartBlocks(cleanText || text)
    if (segments.length === 1 && segments[0].type === 'text') {
      return formatResponse(text)
    }
    return segments.map((seg, i) => {
      if (seg.type === 'chart' && seg.config) {
        return (
          <div key={`chart-${i}`} className="my-2">
            <button
              onClick={() => setMaximizedChart(seg.config!)}
              className="group flex items-center gap-2.5 w-full px-4 py-3 rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200/60 hover:border-emerald-300 hover:from-emerald-100 hover:to-teal-100 transition-all duration-200 active:scale-[0.98]"
            >
              <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-500/10 group-hover:bg-emerald-500/20 transition-colors">
                <BarChart3 size={18} className="text-emerald-600" />
              </div>
              <div className="flex-1 text-left">
                <span className="text-sm font-medium text-emerald-700 block">Ver gráfico{seg.config.title ? `: ${seg.config.title}` : ''}</span>
                <span className="text-[11px] text-emerald-500/80">
                  {seg.config.type === 'pie' ? 'Gráfico circular' : seg.config.type === 'bar' ? 'Gráfico de barras' : seg.config.type === 'line' ? 'Gráfico de líneas' : seg.config.type === 'area' ? 'Gráfico de área' : seg.config.type === 'radar' ? 'Gráfico radar' : seg.config.type === 'scatter' ? 'Dispersión' : seg.config.type === 'heatmap' ? 'Mapa de calor' : seg.config.type === 'gauge' ? 'Indicador' : seg.config.type === 'stacked' ? 'Barras apiladas' : 'Gráfico'}
                  {' · Toca para visualizar'}
                </span>
              </div>
              <Sparkles size={14} className="text-emerald-400 group-hover:text-emerald-500 transition-colors" />
            </button>
          </div>
        )
      }
      return <div key={`text-${i}`}>{formatResponse(seg.content)}</div>
    })
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

  // --- UNIFIED RENDER ---
  if (!isOpen) return null

  // Determine container style based on mode
  const isFullscreen = isMobile && !isMaximized
  const isMaximizedView = isMaximized

  return (
    <>
      {/* Backdrop — maximized or mobile */}
      {(isMaximizedView || isFullscreen) && (
        <div
          className="fixed inset-0 bg-black/30 z-[55] transition-opacity"
          onClick={() => { if (isMaximizedView) setIsMaximized(false); else onClose?.() }}
        />
      )}

      <div
        ref={chatPanelRef}
        className={`fixed z-[56] bg-white flex flex-col overflow-hidden transition-all duration-300 ease-in-out ${
          isMaximizedView
            ? 'inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[95vw] sm:max-w-[1100px] sm:h-[90vh] rounded-2xl shadow-2xl border border-slate-200'
            : isFullscreen
              ? 'inset-0 rounded-none'
              : 'top-14 right-4 w-[420px] h-[550px] rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.18)] border border-slate-200/60 ring-1 ring-black/5'
        }`}
        style={isFullscreen ? { height: mobileVH ? `${mobileVH}px` : '100dvh' } : undefined}
      >
        {/* Conversation history drawer */}
        {showSidebar && (
          <>
            <div className="fixed inset-0 bg-black/20 z-[61]" onClick={() => setShowSidebar(false)} />
            <div
              className="fixed inset-y-0 left-0 w-72 z-[62] shadow-xl border-r border-slate-200 flex flex-col bg-slate-50"
              style={{ animation: 'eros-drawer-slide 0.25s ease-out both' }}
            >
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
          </>
        )}

        {/* Header */}
        <div className={`bg-gradient-to-r from-emerald-600 to-emerald-500 px-3 flex items-center gap-2.5 shrink-0 ${
          isFullscreen ? 'py-3 pt-[max(0.75rem,env(safe-area-inset-top))]' : 'py-2.5'
        } ${!isFullscreen && !isMaximizedView ? 'rounded-t-2xl' : ''}`}>
          <button
            onClick={() => setShowSidebar(prev => !prev)}
            className="p-1 hover:bg-white/20 rounded-lg transition-colors"
            title="Historial"
          >
            <Menu size={16} className="text-white" />
          </button>
          <div
            className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center overflow-hidden shrink-0"
            style={{ animation: 'eros-header-bounce 3s ease-in-out infinite' }}
          >
            <ErosCat mood={isLoading ? catMood : headerMoods[headerMoodIdx]} size={26} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-white font-semibold text-sm leading-tight">Eros</h3>
            <p className="text-emerald-100/80 text-[11px] truncate">
              {isLoading ? 'Pensando...' : conversationId ? 'Chat activo' : 'Asistente de IA'}
            </p>
          </div>
          <div className="flex items-center gap-0.5">
            {erosConfigured && messages.length > 0 && (
              <div className="relative group/export">
                <button
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                  title="Exportar"
                >
                  <Download size={14} className="text-white/80" />
                </button>
                <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-xl border border-slate-200 py-1 hidden group-hover/export:block z-10 min-w-[120px]">
                  <button
                    onClick={exportAsTxt}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <FileText size={12} className="text-slate-500" /> TXT
                  </button>
                  <button
                    onClick={exportAsPdf}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <FileSpreadsheet size={12} className="text-emerald-500" /> PDF
                  </button>
                </div>
              </div>
            )}
            {erosConfigured && (
              <button
                onClick={handleOpenConfigPanel}
                className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                title="Configuración"
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
              onClick={() => onClose?.()}
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
            <div className="h-0.5 bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all duration-1000 ease-out"
                style={{ width: `${loadingProgress}%` }}
              />
            </div>
            <div className="text-center py-0.5 bg-emerald-50/50">
              <span className="text-[10px] text-emerald-600 animate-pulse">{progressText}</span>
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0 eros-dot-bg eros-scroll-area bg-gradient-to-b from-slate-50 to-slate-100/80">
          {/* Not configured */}
          {erosConfigured === false && !showConfig && (
            <div className="flex flex-col items-center justify-center h-full text-center py-6 gap-3">
              <ErosCat mood="sleeping" size={isMaximizedView || isFullscreen ? 100 : 72} />
              <div>
                <p className="text-slate-700 font-medium text-sm">Eros está dormido 😴</p>
                <p className="text-slate-500 text-xs mt-1.5 max-w-[250px] leading-relaxed">
                  Para despertar a Eros necesitas una API key de OpenAI.
                </p>
              </div>
              <button
                onClick={() => { setShowConfig(true); setConfigError(''); setConfigSuccess(false); setConfigStep('key') }}
                className="mt-2 flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl hover:bg-emerald-600 transition-all active:scale-95 shadow-sm"
              >
                <Key size={14} /> Despertar a Eros
              </button>
            </div>
          )}

          {/* Config screen */}
          {showConfig && (
            <div className="flex flex-col h-full py-4 gap-3 px-3 overflow-y-auto">
              <div className="flex flex-col items-center gap-2 shrink-0">
                <ErosCat mood={configSuccess ? 'happy' : 'curious'} size={isMaximizedView || isFullscreen ? 70 : 48} />
              </div>

              {/* Step: API Key */}
              {configStep === 'key' && (
                <div className="flex flex-col items-center gap-3">
                  <div className="text-center">
                    <p className="text-slate-700 font-medium text-sm">Configurar API Key</p>
                    <p className="text-slate-500 text-xs mt-1 max-w-[280px] leading-relaxed">
                      Ingresa tu key de{' '}
                      <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer"
                        className="text-emerald-600 hover:text-emerald-700 underline inline-flex items-center gap-0.5">
                        OpenAI <ExternalLink size={10} />
                      </a>
                    </p>
                  </div>
                  <div className="w-full max-w-[300px] space-y-2">
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => { setApiKeyInput(e.target.value); setConfigError('') }}
                      placeholder="sk-..."
                      className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all"
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSaveApiKey() }}
                      disabled={configLoading}
                    />
                    {configError && (
                      <div className="flex items-start gap-1.5 text-red-600 text-xs bg-red-50 px-2.5 py-2 rounded-lg">
                        <XCircle size={12} className="shrink-0 mt-0.5" /><span>{configError}</span>
                      </div>
                    )}
                    <button
                      onClick={handleSaveApiKey}
                      disabled={!apiKeyInput.trim() || configLoading}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500 text-white text-sm font-medium rounded-xl hover:bg-emerald-600 disabled:opacity-40 transition-all active:scale-[0.98] shadow-sm"
                    >
                      {configLoading ? <><Loader2 size={14} className="animate-spin" /> Validando...</> : <><Key size={14} /> Validar y conectar</>}
                    </button>
                    <button
                      onClick={() => { setShowConfig(false); setConfigError(''); setApiKeyInput('') }}
                      className="w-full px-3 py-2 text-xs text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              {/* Step: Model + Custom Config */}
              {configStep === 'model' && (
                <div className="flex flex-col gap-3 w-full">
                  <div className="text-center">
                    <p className="text-slate-700 font-medium text-sm">Configuración de Eros</p>
                    <p className="text-slate-500 text-[11px] mt-0.5">Modelo, personalidad e instrucciones</p>
                  </div>

                  {/* Model selector */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-600">Modelo OpenAI</label>
                    {modelsLoading ? (
                      <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-slate-400 bg-slate-50 rounded-xl border border-slate-200">
                        <Loader2 size={12} className="animate-spin" /> Cargando modelos...
                      </div>
                    ) : availableModels.length > 0 ? (
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 bg-white transition-all"
                      >
                        {availableModels.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        placeholder="gpt-4.1-nano"
                        className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all"
                      />
                    )}
                  </div>

                  {/* Custom Role */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-600">Rol / Personalidad <span className="text-slate-400 font-normal">(opcional)</span></label>
                    <textarea
                      value={customRole}
                      onChange={(e) => setCustomRole(e.target.value)}
                      placeholder="Ej: Eres un experto en marketing digital especializado en redes sociales..."
                      rows={2}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all resize-none"
                    />
                  </div>

                  {/* Custom Instructions */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-600">Instrucciones adicionales <span className="text-slate-400 font-normal">(opcional)</span></label>
                    <textarea
                      value={customInstructions}
                      onChange={(e) => setCustomInstructions(e.target.value)}
                      placeholder="Ej: Siempre responde en formato de lista, prioriza datos de ventas..."
                      rows={3}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all resize-none"
                    />
                  </div>

                  {configError && (
                    <div className="flex items-start gap-1.5 text-red-600 text-xs bg-red-50 px-2.5 py-2 rounded-lg">
                      <XCircle size={12} className="shrink-0 mt-0.5" /><span>{configError}</span>
                    </div>
                  )}
                  {configSuccess && (
                    <div className="flex items-center gap-1.5 text-emerald-600 text-xs bg-emerald-50 px-2.5 py-2 rounded-lg">
                      <CheckCircle2 size={12} /><span>¡Configuración guardada! 🎉</span>
                    </div>
                  )}

                  <button
                    onClick={handleSaveConfig}
                    disabled={configLoading || configSuccess}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500 text-white text-sm font-medium rounded-xl hover:bg-emerald-600 disabled:opacity-40 transition-all active:scale-[0.98] shadow-sm"
                  >
                    {configLoading ? <><Loader2 size={14} className="animate-spin" /> Guardando...</> : <><CheckCircle2 size={14} /> Guardar configuración</>}
                  </button>

                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfigStep('key')}
                      className="flex-1 px-3 py-2 text-xs text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
                    >
                      Cambiar key
                    </button>
                    <button onClick={handleDisconnectKey} className="flex-1 px-3 py-2 text-xs text-red-600 bg-red-50 rounded-xl hover:bg-red-100 transition-colors">
                      Desconectar
                    </button>
                    <button
                      onClick={() => { setShowConfig(false); setConfigError(''); setConfigStep('key') }}
                      className="flex-1 px-3 py-2 text-xs text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
                    >
                      Volver
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Chat area */}
          {erosConfigured && !showConfig && (<>
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center py-8 gap-3">
                <ErosCat mood="greeting" size={isMaximizedView || isFullscreen ? 100 : 64} />
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
                <div className={`flex flex-col ${isMaximizedView || isFullscreen ? 'max-w-[75%]' : 'max-w-[85%]'}`}>
                  <div
                    className={`px-3 py-2 rounded-2xl leading-relaxed text-[13px] ${
                      msg.role === 'user'
                        ? 'bg-emerald-500 text-white rounded-br-sm'
                        : 'bg-white text-slate-800 rounded-bl-sm shadow-sm border border-slate-100'
                    }`}
                    style={{ animation: 'eros-slide-in 0.2s ease-out both' }}
                  >
                    {msg.role === 'assistant' ? renderAssistantMessage(msg.content, i) : msg.content}
                  </div>
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
                    <ErosCat mood={catMood} size={isMaximizedView || isFullscreen ? 72 : 48} />
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

        {/* Maximized Chart Overlay */}
        {maximizedChart && (
          <div className="absolute inset-0 z-[70] bg-white flex flex-col" style={{ animation: 'eros-bounce-in 0.2s ease-out both' }}>
            <div className="px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-emerald-50 to-slate-50 flex items-center justify-between shrink-0">
              <h4 className="text-sm font-semibold text-slate-700 truncate">{maximizedChart.title || 'Gráfico'}</h4>
              <button
                onClick={() => setMaximizedChart(null)}
                className="p-1.5 hover:bg-slate-200 rounded-lg transition-colors text-slate-500 hover:text-slate-700 shrink-0"
                title="Cerrar gráfico"
              >
                <Minimize2 size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-2">
              <ErosChart config={maximizedChart} />
            </div>
          </div>
        )}

        {/* Input */}
        <div className={`border-t border-slate-200 p-2.5 bg-white shrink-0 ${
          isFullscreen ? 'pb-[max(0.625rem,env(safe-area-inset-bottom))]' : ''
        } ${!isFullscreen && !isMaximizedView ? 'rounded-b-2xl' : ''}`}>
          <div className="flex gap-2 items-end">
            <div className="flex-1 min-w-0 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  const ta = e.target
                  ta.style.height = 'auto'
                  const maxH = isInputExpanded ? 200 : 80
                  ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px'
                }}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                  if (isMobile) {
                    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 350)
                  }
                }}
                placeholder={erosConfigured ? "Escribe tu pregunta..." : "Configura tu API key..."}
                rows={isInputExpanded ? 4 : 1}
                className={`w-full resize-none rounded-xl border border-slate-200 px-3 py-2 pr-8 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all ${isInputExpanded ? 'max-h-[200px]' : 'max-h-[80px]'}`}
                style={{ minHeight: isInputExpanded ? '100px' : '38px' }}
                disabled={isLoading || !erosConfigured || showConfig}
              />
              <button
                onClick={() => {
                  setIsInputExpanded(prev => !prev)
                  setTimeout(() => {
                    if (inputRef.current) {
                      const ta = inputRef.current
                      ta.style.height = 'auto'
                      const maxH = !isInputExpanded ? 200 : 80
                      ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px'
                      ta.focus()
                    }
                  }, 50)
                }}
                className="absolute top-1.5 right-1.5 p-0.5 rounded text-slate-300 hover:text-emerald-500 hover:bg-emerald-50/80 transition-colors"
                title={isInputExpanded ? 'Reducir campo' : 'Ampliar campo'}
                type="button"
              >
                <ChevronsUpDown size={12} />
              </button>
            </div>
            <button
              onClick={sendMessage}
              data-eros-send
              disabled={!input.trim() || isLoading}
              className="p-2 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:hover:bg-emerald-500 transition-all shrink-0 active:scale-95"
            >
              <Send size={16} />
            </button>
          </div>
          {lastFailedMessage && !isLoading && (
            <button
              onClick={retryLastMessage}
              className="mt-1.5 w-full text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg py-1 transition-colors flex items-center justify-center gap-1.5"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
              Reintentar
            </button>
          )}
        </div>
      </div>
    </>
  )
}
