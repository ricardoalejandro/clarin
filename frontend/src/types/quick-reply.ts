export type QuickReplyKind = 'all' | 'text' | 'media'

export interface QuickReplyAttachment {
  id?: string
  quick_reply_id?: string
  account_id?: string
  media_asset_id?: string | null
  media_url: string
  media_type: string
  media_filename: string
  caption: string
  position: number
}

export interface QuickReply {
  items?: QuickReplyItem[]
  id: string
  account_id?: string
  shortcut: string
  title: string
  body: string
  media_url?: string
  media_type?: string
  media_filename?: string
  attachments: QuickReplyAttachment[]
  created_at?: string
  updated_at: string
}

export interface QuickReplyPage {
  success: boolean
  quick_replies: QuickReply[]
  total: number
  has_more: boolean
  next_cursor: string
  code?: string
  error?: string
}

export interface QuickReplyMutationResponse {
  success: boolean
  quick_reply?: QuickReply
  code?: string
  error?: string
}

export interface QuickReplyRealtimePayload {
  action: 'created' | 'updated' | 'deleted'
  quick_reply?: QuickReply
  quick_reply_id?: string
}

export interface PendingQuickReplyAttachment extends QuickReplyAttachment {
  sendTempId?: string
}

export interface QuickReplyComposerDraft {
  items?: QuickReplyPreparedItem[]
  allAttachments?: QuickReplyAttachment[]
  throughMessageId?: string
  started?: boolean
  replyId: string
  shortcut: string
  attachments: PendingQuickReplyAttachment[]
  totalAttachments: number
  sentAttachments: number
  bodyTempId?: string
  error?: string
}

export interface QuickReplyItem {
  id: string
  type: 'text' | 'media'
  text?: string
  attachment_id?: string
}

export interface QuickReplyPreparedItem extends QuickReplyItem {
  operationId: string
  payload?: Record<string, unknown>
  sendTempId?: string
  sent?: boolean
}
