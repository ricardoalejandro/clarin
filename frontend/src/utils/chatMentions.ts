import type { ChatMention } from '@/types/chat'
export interface MentionRange extends ChatMention { start: number; end: number; label: string }
export interface MentionDraft { text: string; mentions: MentionRange[] }
export function reconcileMentionRanges(before: string, after: string, mentions: MentionRange[], format = false): MentionRange[] {
  if (before === after) return mentions
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let oldEnd = before.length, newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
  const delta = newEnd - oldEnd
  return mentions.flatMap(mention => {
    if (before.slice(mention.start, mention.end) !== mention.label) return []
    if (mention.end <= start) return [mention]
    if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
    if (format) {
      const region = after.slice(start, newEnd)
      const offset = region.indexOf(mention.label)
      if (offset >= 0 && region.indexOf(mention.label, offset + 1) < 0) return [{ ...mention, start: start + offset, end: start + offset + mention.label.length }]
    }
    return []
  }).filter(mention => after.slice(mention.start, mention.end) === mention.label)
}
export function mentionQuery(text: string, caret: number): { start: number; end: number; query: string } | null {
  const prefix = text.slice(0, caret)
  const match = /(?:^|[\s(])@([^@\n]{0,80})$/.exec(prefix)
  if (!match) return null
  return { start: caret - match[1].length - 1, end: caret, query: match[1] }
}
export function insertMention(draft: MentionDraft, range: { start: number; end: number }, member: ChatMention): MentionDraft {
  const label = `@${member.name || member.jid.split('@')[0]}`
  const text = draft.text.slice(0, range.start) + label + ' ' + draft.text.slice(range.end)
  return { text, mentions: [...reconcileMentionRanges(draft.text, text, draft.mentions), { ...member, label, start: range.start, end: range.start + label.length }].sort((a, b) => a.start - b.start) }
}
export function serializeMentions(text: string, ranges: MentionRange[]): { body: string; mentions: ChatMention[] } {
  const valid = ranges.filter(mention => text.slice(mention.start, mention.end) === mention.label).sort((a, b) => a.start - b.start)
  let body = text
  for (const mention of [...valid].reverse()) body = body.slice(0, mention.start) + `@${mention.jid.split('@')[0]}` + body.slice(mention.end)
  const mentions = [...new Map(valid.map(({ jid, name }) => [jid, { jid, name }])).values()]
  return { body, mentions }
}
export function hydrateMentions(body: string, mentions: ChatMention[] = []): MentionDraft {
  let text = body; const ranges: MentionRange[] = []
  // A provider token is unambiguous; plain display-name text never becomes a mention by inference.
  const byUser = new Map(mentions.map(item => [item.jid.split('@')[0], item]))
  text = body.replace(/@([0-9]+)(?![0-9])/g, (token, user: string, offset: number) => {
    const member = byUser.get(user); if (!member) return token
    const label = `@${member.name || user}`
    const shift = ranges.reduce((sum, row) => sum + row.label.length - (`@${row.jid.split('@')[0]}`).length, 0)
    ranges.push({ ...member, label, start: offset + shift, end: offset + shift + label.length }); return label
  })
  return { text, mentions: ranges }
}
