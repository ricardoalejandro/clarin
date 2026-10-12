'use client'

import TagPicker, { type TagPickerItem } from '@/components/tags/TagPicker'
import type { ContactProfileAvailableTag, ContactProfileContext } from '@/types/contact-profile'
interface Props {
  contactId: string
  context: ContactProfileContext
  selected: ContactProfileAvailableTag[]
  canCreate: boolean
  disabled?: boolean
  showSelected?: boolean
  onChange: (tags: ContactProfileAvailableTag[]) => void
  onCreatingChange?: (creating: boolean) => void
}
export default function ContactTagEditor(props: Props) {
  return <TagPicker {...props} onChange={(tags: TagPickerItem[]) => props.onChange(tags as ContactProfileAvailableTag[])} />
}
