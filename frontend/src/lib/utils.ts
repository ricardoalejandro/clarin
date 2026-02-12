import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPhoneNumber(phone: string): string {
  if (!phone) return ''
  // Remove non-digits
  const digits = phone.replace(/\D/g, '')
  // Format as international
  if (digits.length >= 10) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
  }
  return phone
}

export function getInitials(name: string): string {
  if (!name) return '?'
  const parts = name.trim().split(' ')
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

export function truncate(str: string, length: number): string {
  if (!str || str.length <= length) return str
  return str.slice(0, length) + '...'
}

export function formatJid(jid: string): string {
  if (!jid) return ''
  // Remove @s.whatsapp.net or @g.us suffix
  return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, ' (grupo)')
}

export function isGroupJid(jid: string): boolean {
  return jid?.endsWith('@g.us') || false
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function copyToClipboard(text: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(text)
  }
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 11)
}
