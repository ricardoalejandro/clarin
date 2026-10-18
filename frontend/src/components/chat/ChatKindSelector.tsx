'use client'
import { useRef, useState } from 'react'
import { Check, ChevronDown, MessageCircle, UserRound, Users } from 'lucide-react'
import ConversationMenu from './ConversationMenu'

type Kind = 'all' | 'direct' | 'group'
const options = [
  { value: 'all' as const, label: 'Todos los chats', short: 'Tipo', icon: MessageCircle },
  { value: 'direct' as const, label: 'Individuales', short: 'Individuales', icon: UserRound },
  { value: 'group' as const, label: 'Grupos', short: 'Grupos', icon: Users },
]

export default function ChatKindSelector({ value, onChange }: { value: Kind; onChange: (value: Kind) => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const selected = options.find(option => option.value === value) || options[0]
  const Icon = selected.icon
  return <>
    <button ref={anchor} type="button" aria-label={'Tipo de conversación: ' + selected.label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(current => !current)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }} className={'inline-flex h-11 min-w-0 max-w-[118px] shrink-0 items-center justify-center gap-1 rounded-lg px-1.5 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:h-9 ' + (value === 'all' ? 'text-slate-600 hover:bg-slate-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100')}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="truncate">{selected.short}</span><ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
    </button>
    {open && <ConversationMenu anchor={anchor} label="Tipo de conversación" onClose={() => setOpen(false)}>
      {options.map(option => { const OptionIcon = option.icon; return <button key={option.value} type="button" role="menuitemradio" aria-checked={value === option.value} onClick={() => { onChange(option.value); setOpen(false); anchor.current?.focus() }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-slate-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"><OptionIcon className="h-4 w-4 text-slate-500" aria-hidden /><span className="flex-1">{option.label}</span>{value === option.value && <Check className="h-4 w-4 text-emerald-600" aria-hidden />}</button> })}
    </ConversationMenu>}
  </>
}
