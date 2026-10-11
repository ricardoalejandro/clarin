'use client'
import {useRef,useState} from 'react'
import EditorPopover from './EditorPopover'
import {useDebouncedValue,SEARCH_DEBOUNCE_MS} from '@/lib/useDebouncedValue'
export default function EditorFontPicker({value,fonts,onChange}:{value:string;fonts:string[];onChange:(font:string)=>void}){
 const ref=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false),[query,setQuery]=useState('')
 const [settled,setSettled]=useDebouncedValue(query,SEARCH_DEBOUNCE_MS)
 return <><button ref={ref} type="button" onClick={()=>setOpen(v=>!v)} aria-label="Fuente" aria-expanded={open} className="min-h-11 w-full truncate rounded-xl border border-slate-200 bg-white px-3 text-left text-sm" style={{fontFamily:value}}>{value}</button>{open&&<EditorPopover label="Elegir fuente" anchor={ref.current} onClose={()=>setOpen(false)}><input aria-label="Buscar fuente" value={query} onChange={e=>{setQuery(e.target.value);if(!e.target.value)setSettled('')}} placeholder="Buscar fuente…" className="mb-2 h-11 w-full rounded-xl border border-slate-200 px-3"/><div className="max-h-72 overflow-y-auto" role="listbox" aria-label="Fuentes">{fonts.filter(f=>f.toLowerCase().includes(settled.toLowerCase())).map(f=><button key={f} role="option" aria-selected={f===value} onClick={()=>{onChange(f);setOpen(false)}} className="min-h-11 w-full rounded-lg px-3 text-left hover:bg-emerald-50" style={{fontFamily:f}}>{f}{f===value?' ✓':''}</button>)}</div></EditorPopover>}</>
}
