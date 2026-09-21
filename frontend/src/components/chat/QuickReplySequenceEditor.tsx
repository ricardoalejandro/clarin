'use client'

import { useEffect, useRef, useState } from 'react'
import { DndContext, closestCenter, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, Copy, Eye, GripVertical, Paperclip, Plus, Trash2 } from 'lucide-react'
import WhatsAppTextInput, { type WhatsAppTextInputHandle } from '@/components/WhatsAppTextInput'
import EmojiPicker from './EmojiPicker'
import { renderFormattedText } from '@/lib/whatsappFormat'
import type { QuickReplyAttachment, QuickReplyItem } from '@/types/quick-reply'
import { moveQuickReplyItem } from '@/utils/quickReplies'

export function QuickReplySequencePreview({ items, attachments }: { items: QuickReplyItem[]; attachments: QuickReplyAttachment[] }) {
  return <div style={{ backgroundImage: "url('/whatsapp-chat-background.png')" }} className="bg-repeat flex min-h-48 flex-col items-end gap-2 rounded-2xl bg-[#efeae2] p-3" aria-label="Vista previa de los mensajes">
    {items.map(item => {
      const media = attachments.find(attachment => attachment.id === item.attachment_id)
      const text = item.type === 'text' ? item.text : media?.caption
      return <div key={item.id} className="w-fit max-w-full overflow-hidden rounded-xl bg-[#d9fdd3] text-[13px] leading-5 text-slate-800 shadow-sm">
        {media?.media_type === 'image' && <img src={media.media_url} alt={media.media_filename} className="max-h-64 w-full object-contain" />}
        {media?.media_type === 'video' && <video src={media.media_url} controls preload="metadata" className="max-h-64 w-full" />}
        {media && !['image', 'video'].includes(media.media_type) && <div className="flex items-center gap-2 p-3"><Paperclip className="h-4 w-4 shrink-0" /><span className="break-all">{media.media_filename}</span></div>}
        {text && <div className="whitespace-pre-wrap break-words px-3 py-2">{renderFormattedText(text)}</div>}
        {!text && !media && <p className="px-3 py-2 text-slate-500">Escribe un mensaje…</p>}
      </div>
    })}
  </div>
}

function MessageBlock({ item, attachment, index, count, disabled, duplicateDisabled, onText, onCaption, onMove, onRemove, onDuplicate }: {
  item: QuickReplyItem; attachment?: QuickReplyAttachment; index: number; count: number; disabled: boolean; duplicateDisabled: boolean
  onText: (text: string) => void; onCaption: (text: string) => void; onMove: (direction: number) => void; onRemove: () => void; onDuplicate: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled })
  const input = useRef<WhatsAppTextInputHandle>(null)
  const captionSupported = attachment && ['image', 'video', 'document'].includes(attachment.media_type)
  return <section ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`rounded-xl border bg-white ${isDragging ? 'z-10 border-emerald-400 opacity-60 shadow-lg' : 'border-slate-200'}`} aria-label={`Mensaje ${index + 1}`}>
    <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-2 py-1">
      <button type="button" {...attributes} {...listeners} disabled={disabled} aria-label={`Ordenar mensaje ${index + 1}`} className="flex h-11 w-11 touch-none items-center justify-center rounded-lg text-slate-400 enabled:cursor-grab active:cursor-grabbing"><GripVertical className="h-4 w-4" /></button>
      <span className="min-w-0 flex-1 text-xs font-semibold text-slate-600">{index + 1}. {item.type === 'text' ? 'Texto' : attachment?.media_type === 'image' ? 'Imagen con pie' : 'Archivo'}</span>
      <button type="button" disabled={disabled || index === 0} onClick={() => onMove(-1)} aria-label="Subir mensaje" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-25"><ArrowUp className="h-4 w-4" /></button>
      <button type="button" disabled={disabled || index === count - 1} onClick={() => onMove(1)} aria-label="Bajar mensaje" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-25"><ArrowDown className="h-4 w-4" /></button>
      {<button type="button" disabled={disabled || duplicateDisabled || count >= 20} onClick={onDuplicate} aria-label="Duplicar mensaje" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"><Copy className="h-4 w-4" /></button>}
      <button type="button" disabled={disabled} onClick={onRemove} aria-label={`Eliminar mensaje ${index + 1}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
    </div>
    {attachment && <div className="flex items-center gap-3 px-3 pt-3">
      {attachment.media_type === 'image' ? <img src={attachment.media_url} alt="" className="h-14 w-16 rounded-lg object-contain bg-slate-50" /> : <Paperclip className="h-5 w-5 shrink-0 text-slate-400" />}
      <p className="min-w-0 break-all text-xs text-slate-600">{attachment.media_filename}</p>
    </div>}
    {(item.type === 'text' || captionSupported) && <div className="p-3">
      <WhatsAppTextInput ref={input} value={item.type === 'text' ? item.text || '' : attachment?.caption || ''} onChange={item.type === 'text' ? onText : onCaption} disabled={disabled} placeholder={item.type === 'text' ? 'Escribe este mensaje…' : 'Escribe el pie: se enviará unido al archivo…'} rows={3} formatToolbarPlacement="outside" className="min-h-24 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
      <div className="mt-1 flex items-center gap-2"><EmojiPicker onEmojiSelect={emoji => { if (!disabled) input.current?.insertAtCaret(emoji) }} buttonClassName="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100" /><span className="text-[11px] text-slate-400">Selecciona texto para aplicar formato.</span></div>
    </div>}
    {attachment && !captionSupported && <p className="p-3 text-[11px] text-slate-500">Este formato no admite pie. Añade un mensaje de texto separado.</p>}
  </section>
}

export default function QuickReplySequenceEditor({ items, attachments, onChange, onRemoveAttachment, disabled = false, compact = false }: {
  items: QuickReplyItem[]; attachments: QuickReplyAttachment[]
  onChange: (items: QuickReplyItem[], attachments: QuickReplyAttachment[]) => void
  onRemoveAttachment: (id: string) => void; disabled?: boolean; compact?: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  const [preview, setPreview] = useState(false)
  useEffect(() => { if (!container.current) return; const observer = new ResizeObserver(entries => setWide(entries[0].contentRect.width >= 720)); observer.observe(container.current); return () => observer.disconnect() }, [])
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 520, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, scrollBehavior: 'auto' }))
  const change = (next: QuickReplyItem[]) => onChange(next, attachments)
  return <div ref={container} className="space-y-3">
    <div className="flex items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-slate-800">Mensajes y orden de envío</h4><p className="mt-0.5 text-xs text-slate-500">Cada bloque es un mensaje. La imagen conserva su pie.</p></div>{(!wide || compact) && <button type="button" onClick={() => setPreview(!preview)} aria-pressed={preview} className="flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"><Eye className="h-4 w-4" />{preview ? 'Editar' : 'Vista previa'}</button>}</div>
    <div className={wide && !compact ? 'grid grid-cols-2 items-start gap-4' : ''}>
      {(!preview || (wide && !compact)) && <div className="space-y-3">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => { if (over && !disabled) change(moveQuickReplyItem(items, items.findIndex(item => item.id === active.id), items.findIndex(item => item.id === over.id))) }}>
          <SortableContext items={items.map(item => item.id)} strategy={verticalListSortingStrategy}>
            {items.map((item, index) => <MessageBlock key={item.id} item={item} attachment={attachments.find(attachment => attachment.id === item.attachment_id)} index={index} count={items.length} disabled={disabled} duplicateDisabled={item.type === 'media' && attachments.length >= 5}
              onText={text => change(items.map(row => row.id === item.id ? { ...row, text } : row))}
              onCaption={caption => onChange(items, attachments.map(row => row.id === item.attachment_id ? { ...row, caption } : row))}
              onMove={direction => change(moveQuickReplyItem(items, index, index + direction))}
              onRemove={() => item.type === 'media' ? onRemoveAttachment(item.attachment_id!) : change(items.filter(row => row.id !== item.id))}
              onDuplicate={() => { const next = [...items]; const attachment = attachments.find(row => row.id === item.attachment_id); if (item.type === 'media' && (!attachment || attachments.length >= 5)) return; const id = crypto.randomUUID(); next.splice(index + 1, 0, { ...item, id: crypto.randomUUID(), ...(attachment ? { attachment_id: id } : {}) }); onChange(next, attachment ? [...attachments, { ...attachment, id, position: attachments.length }] : attachments) }} />)}
          </SortableContext>
        </DndContext>
        <button type="button" disabled={disabled || items.length >= 20} onClick={() => change([...items, { id: crypto.randomUUID(), type: 'text', text: '' }])} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-dashed border-slate-300 px-3 text-xs font-semibold text-slate-600 hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-40"><Plus className="h-4 w-4" />Añadir texto</button>
      </div>}
      {((wide && !compact) || preview) && <QuickReplySequencePreview items={items} attachments={attachments} />}
    </div>
  </div>
}
