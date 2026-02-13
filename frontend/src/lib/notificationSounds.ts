// Notification sound generator using Web Audio API
// Generates sounds programmatically — no audio files needed

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext()
  }
  return audioContext
}

// Resume audio context (required after user interaction)
export function resumeAudioContext() {
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume()
  }
}

type SoundType = 'none' | 'tone1' | 'tone2' | 'tone3' | 'tone4' | 'whatsapp'

export const SOUND_OPTIONS: { value: SoundType; label: string; description: string }[] = [
  { value: 'none', label: 'Silencio', description: 'Sin sonido' },
  { value: 'tone1', label: 'Tono 1', description: 'Beep simple' },
  { value: 'tone2', label: 'Tono 2', description: 'Doble tono ascendente' },
  { value: 'tone3', label: 'Tono 3', description: 'Campanilla suave' },
  { value: 'tone4', label: 'Tono 4', description: 'Triple ding' },
  { value: 'whatsapp', label: 'WhatsApp', description: 'Estilo WhatsApp' },
]

// Simple beep
function playTone1(ctx: AudioContext, volume: number) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.frequency.value = 880
  osc.type = 'sine'
  gain.gain.setValueAtTime(volume * 0.3, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + 0.3)
}

// Two-tone ascending
function playTone2(ctx: AudioContext, volume: number) {
  const t = ctx.currentTime
  // First tone
  const osc1 = ctx.createOscillator()
  const gain1 = ctx.createGain()
  osc1.connect(gain1)
  gain1.connect(ctx.destination)
  osc1.frequency.value = 660
  osc1.type = 'sine'
  gain1.gain.setValueAtTime(volume * 0.25, t)
  gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc1.start(t)
  osc1.stop(t + 0.15)
  // Second tone
  const osc2 = ctx.createOscillator()
  const gain2 = ctx.createGain()
  osc2.connect(gain2)
  gain2.connect(ctx.destination)
  osc2.frequency.value = 880
  osc2.type = 'sine'
  gain2.gain.setValueAtTime(volume * 0.3, t + 0.12)
  gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
  osc2.start(t + 0.12)
  osc2.stop(t + 0.35)
}

// Soft chime
function playTone3(ctx: AudioContext, volume: number) {
  const t = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.frequency.setValueAtTime(1200, t)
  osc.frequency.exponentialRampToValueAtTime(800, t + 0.4)
  osc.type = 'sine'
  gain.gain.setValueAtTime(volume * 0.2, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
  osc.start(t)
  osc.stop(t + 0.5)
}

// Triple ding
function playTone4(ctx: AudioContext, volume: number) {
  const t = ctx.currentTime
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 1047
    osc.type = 'sine'
    const start = t + i * 0.12
    gain.gain.setValueAtTime(volume * 0.2, start)
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.1)
    osc.start(start)
    osc.stop(start + 0.1)
  }
}

// WhatsApp-like pop sound
function playWhatsApp(ctx: AudioContext, volume: number) {
  const t = ctx.currentTime
  // Pop
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.frequency.setValueAtTime(500, t)
  osc.frequency.exponentialRampToValueAtTime(1600, t + 0.03)
  osc.frequency.exponentialRampToValueAtTime(800, t + 0.08)
  osc.type = 'sine'
  gain.gain.setValueAtTime(volume * 0.35, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.start(t)
  osc.stop(t + 0.15)
  // Short tail
  const osc2 = ctx.createOscillator()
  const gain2 = ctx.createGain()
  osc2.connect(gain2)
  gain2.connect(ctx.destination)
  osc2.frequency.value = 1200
  osc2.type = 'sine'
  gain2.gain.setValueAtTime(volume * 0.1, t + 0.05)
  gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
  osc2.start(t + 0.05)
  osc2.stop(t + 0.2)
}

export function playNotificationSound(soundType: SoundType, volume: number = 0.5) {
  if (soundType === 'none') return
  try {
    const ctx = getAudioContext()
    if (ctx.state === 'suspended') {
      ctx.resume()
    }
    switch (soundType) {
      case 'tone1': playTone1(ctx, volume); break
      case 'tone2': playTone2(ctx, volume); break
      case 'tone3': playTone3(ctx, volume); break
      case 'tone4': playTone4(ctx, volume); break
      case 'whatsapp': playWhatsApp(ctx, volume); break
    }
  } catch (e) {
    console.warn('Failed to play notification sound:', e)
  }
}

// --- Notification Settings per Account ---

export interface NotificationSettings {
  sound_enabled: boolean
  sound_type: SoundType
  sound_volume: number
  browser_notifications: boolean
  show_preview: boolean
}

const DEFAULT_SETTINGS: NotificationSettings = {
  sound_enabled: false,
  sound_type: 'none',
  sound_volume: 0.5,
  browser_notifications: false,
  show_preview: true,
}

function storageKey(accountId: string): string {
  return `clarin_notif_${accountId}`
}

export function getNotificationSettings(accountId: string): NotificationSettings {
  try {
    const raw = localStorage.getItem(storageKey(accountId))
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

export function saveNotificationSettings(accountId: string, settings: NotificationSettings) {
  localStorage.setItem(storageKey(accountId), JSON.stringify(settings))
}

// --- Browser Notification helpers ---

export function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return Promise.resolve('denied' as NotificationPermission)
  if (Notification.permission === 'granted') return Promise.resolve('granted')
  if (Notification.permission === 'denied') return Promise.resolve('denied')
  return Notification.requestPermission()
}

export function showBrowserNotification(
  title: string,
  body: string,
  onClick?: () => void,
) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const notification = new Notification(title, {
    body,
    icon: '/favicon.ico',
    tag: 'clarin-message',
  } as NotificationOptions)
  notification.onclick = () => {
    window.focus()
    onClick?.()
    notification.close()
  }
  setTimeout(() => notification.close(), 6000)
}
