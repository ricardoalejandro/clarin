import { Chat } from '@/types/chat'

// Clean synced names that start with dots/punctuation
export const cleanName = (name?: string | null) => name?.replace(/^[\s.\u00b7\u2022\-]+/, '').trim() || ''

// Format JID or contact phone for human-readable display
export const formatPhone = (jid: string, contactPhone?: string): string => {
  // For @lid JIDs, check if contactPhone is the real resolved phone or the meaningless lid number
  if (jid.endsWith('@lid')) {
    const lidUser = jid.replace('@lid', '')
    // If contact phone is same as lid user, it's meaningless
    if (!contactPhone || contactPhone === lidUser) {
      return ''
    }
    // Contact has a real resolved phone, show it
    return contactPhone.startsWith('+') ? contactPhone : '+' + contactPhone
  }

  // For standard JIDs, use the user part (phone number)
  const userParam = jid.split('@')[0]

  // If we have a contact phone and it's different/better, use it
  if (contactPhone && contactPhone !== userParam) {
    return contactPhone.startsWith('+') ? contactPhone : '+' + contactPhone
  }

  return '+' + userParam
}

// Get the best display name for a chat
// Priority: custom_name (CRM) → contact_name (WhatsApp address book) → chat.name (push_name) → phone
export const getChatDisplayName = (chat: Chat): string => {
  const cn = cleanName(chat.contact_custom_name)
  if (cn) return cn
  const nm = cleanName(chat.contact_name)
  if (nm) return nm
  const pn = cleanName(chat.name)
  if (pn) return pn
  return formatPhone(chat.jid, chat.contact_phone) || chat.jid
}

// WhatsApp-style date label for message separators
export const getDateLabel = (timestamp: string): string => {
  const d = new Date(timestamp)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())

  const diff = (today.getTime() - msgDay.getTime()) / (1000 * 60 * 60 * 24)

  if (diff < 1) return 'HOY'
  if (diff < 2) return 'AYER'
  if (diff < 7) return d.toLocaleDateString('es', { weekday: 'long' }).toUpperCase()
  return d.toLocaleDateString('es', { day: 'numeric', month: 'numeric', year: 'numeric' })
}
