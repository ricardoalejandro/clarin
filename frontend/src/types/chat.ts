export interface Device {
  id: string
  name: string
  phone?: string
  status: string
}

export interface Reaction {
  id: string
  target_message_id: string
  sender_jid: string
  sender_name?: string
  emoji: string
  is_from_me: boolean
}

export interface PollOption {
  id: string
  name: string
  vote_count: number
}

export interface PollVote {
  id: string
  voter_jid: string
  selected_names: string[]
}

export interface Message {
  id: string
  message_id: string
  from_jid?: string
  from_name?: string
  body?: string
  message_type?: string
  media_url?: string
  media_type?: string
  media_mimetype?: string
  media_filename?: string
  media_size?: number
  is_from_me: boolean
  is_read: boolean
  status: string
  timestamp: string
  quoted_message_id?: string
  quoted_body?: string
  quoted_sender?: string
  reactions?: Reaction[]
  poll_question?: string
  poll_options?: PollOption[]
  poll_votes?: PollVote[]
  poll_max_selections?: number
}

export interface Chat {
  id: string
  jid: string
  name: string
  device_id?: string
  last_message: string
  last_message_at: string
  unread_count: number
  device_name?: string
  device_phone?: string
  contact_phone?: string
  contact_avatar_url?: string
  contact_custom_name?: string
  contact_name?: string
}
