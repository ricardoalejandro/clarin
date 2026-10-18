import { Chat } from '@/types/chat'
import { isGroupChat } from './chatGroups'
import { orderInbox } from './chatInbox'

// Clean synced names that start with dots/punctuation
export const cleanName = (name?: string | null) => name?.replace(/^[\s.\u00b7\u2022\-]+/, '').trim() || ''

export const isPendingChatIdentity = (chat: Pick<Chat, 'jid' | 'identity_pending'>): boolean => (
  chat.identity_pending === true || chat.jid.toLowerCase().endsWith('@lid')
)

// Format JID or contact phone for human-readable display
export const formatPhone = (jid: string, contactPhone?: string): string => {
  if (jid.endsWith('@g.us')) return ''
  if (jid.endsWith('@g.us')) return ''
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
  if (isGroupChat(chat)) return cleanName(chat.group?.subject) || cleanName(chat.name) || 'Grupo de WhatsApp'
  if (isGroupChat(chat)) return cleanName(chat.group?.subject) || cleanName(chat.name) || 'Grupo de WhatsApp'
  const cn = cleanName(chat.contact_custom_name)
  if (cn) return cn
  const nm = cleanName(chat.contact_name)
  if (nm) return nm
  const pn = cleanName(chat.name)
  if (pn) return pn
  return formatPhone(chat.jid, chat.contact_phone) || (isPendingChatIdentity(chat) ? 'Contacto de WhatsApp' : chat.jid)
}

export type ChatIdentityReconciliation = {
  source_chat_id: string
  canonical_chat: Chat
}

export const mergeReconciledChatIdentity = (current: Chat[], reconciliation: ChatIdentityReconciliation): Chat => {
  const local = current.filter(chat => chat.id === reconciliation.source_chat_id || chat.id === reconciliation.canonical_chat.id)
  const pinned = local.filter(chat => chat.is_pinned)
  const pinnedAt = pinned.map(chat => chat.pinned_at).filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null
  // Identity broadcasts contain account-level identity, never the current actor's pin projection.
  return { ...reconciliation.canonical_chat, is_pinned: pinned.length > 0, pinned_at: pinnedAt, pin_version: Math.max(0, ...local.map(chat => chat.pin_version || 0)) }
}

export const reconcileChatIdentity = (current: Chat[], reconciliation: ChatIdentityReconciliation): Chat[] => {
  const { source_chat_id: sourceChatId, canonical_chat: canonicalChat } = reconciliation
  if (!sourceChatId || !canonicalChat?.id) return current
  const next = current.filter(chat => chat.id !== sourceChatId && chat.id !== canonicalChat.id)
  next.push(mergeReconciledChatIdentity(current, reconciliation))
  return orderInbox(next, 'all')
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
