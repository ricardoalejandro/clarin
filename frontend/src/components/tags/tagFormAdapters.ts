import type { TagPickerItem } from './TagPicker'
export const tagSelectionIds = (tags: TagPickerItem[]) => [...new Set(tags.map(tag => tag.id))]
export const importTagName = (tags: TagPickerItem[]) => tags[0]?.name || ''
export function automationTagId(data: Record<string, unknown>): string {
  if (typeof data.tag_id === 'string') return data.tag_id
  const config = data.config as { tag_id?: unknown } | undefined
  return typeof config?.tag_id === 'string' ? config.tag_id : ''
}
export function automationTagPatch(data: Record<string, unknown>, tagId: string) {
  return { ...data, tag_id: tagId, config: { ...(typeof data.config === 'object' && data.config ? data.config : {}), tag_id: tagId } }
}
