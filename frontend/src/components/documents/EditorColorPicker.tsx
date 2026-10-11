'use client'
import {useEffect,useRef,useState} from 'react'
import {Check,Palette,X,Pipette} from 'lucide-react'
import {useEditorDesign} from './EditorDesignContext'
import EditorPopover from './EditorPopover'
import {normalizeEditorColor} from '@/lib/fabric/editorModel'
const COLORS=['#FFFFFF','#0F172A','#475569','#94A3B8','#E2E8F0','#059669','#10B981','#2563EB','#0EA5E9','#7C3AED','#DB2777','#DC2626','#EA580C','#D97706','#FACC15','#92400E']
export default function EditorColorPicker({value,onChange,label='Color',allowNone=true}:{value:unknown;onChange:(color:string)=>void;label?:string;allowNone?:boolean}){
 const anchor=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false),[draft,setDraft]=useState(''),[error,setError]=useState('')
 const design=useEditorDesign()
 const documentColors:string[]=[]
 const collect=(objects:any[])=>{for(const object of objects){for(const value of [object.fill,object.stroke,...(object.fill?.colorStops||[]).map((stop:any)=>stop.color)]){const color=normalizeEditorColor(value);if(color&&!documentColors.includes(color))documentColors.push(color)}if(object.getObjects)collect(object.getObjects())}}
 if(open&&design.canvas)collect(design.canvas.getObjects())
 const normalized=normalizeEditorColor(value),none=value==='transparent'||value===''
 useEffect(()=>{setDraft(normalized||'#FFFFFF');setError('')},[normalized,open])
 const choose=(color:string)=>{design.remember(color);onChange(color);setOpen(false)}
 const apply=()=>{const color=normalizeEditorColor(draft);if(!color){setError('Usa un color hexadecimal de 6 dígitos, por ejemplo #059669.');return}choose(color)}
 return <><button ref={anchor} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(v=>!v)} className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 text-left text-xs text-slate-700 hover:border-emerald-400">
 <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-slate-300" style={{background:normalized||'#F8FAFC'}}>{none?<X className="h-4 w-4"/>:!normalized?<Palette className="h-4 w-4"/>:null}</span>
 <span className="min-w-0 truncate">{normalized|| (none?'Sin relleno':'Degradado existente')}</span></button>
 {open&&<EditorPopover anchor={anchor.current} label={label} onClose={()=>setOpen(false)}><div className="space-y-3 p-2">
 <p className="font-semibold">{label}</p><div className="grid grid-cols-5 gap-1">{COLORS.map(color=><button key={color} aria-label={color} title={color} className="flex h-11 w-11 items-center justify-center rounded-md border border-slate-200" style={{background:color}} onClick={()=>choose(color)}>{color===normalized&&<Check className="h-4 w-4" style={{color:['#FFFFFF','#FACC15','#E2E8F0'].includes(color)?'#0F172A':'#FFFFFF'}}/>}</button>)}</div>
 {[{title:'En este documento',colors:documentColors.slice(0,15)},{title:'Recientes',colors:design.recent}].filter(section=>section.colors.length).map(section=><section key={section.title}><p className="mb-2 text-xs text-slate-500">{section.title}</p><div className="grid grid-cols-5 gap-1">{section.colors.map(color=><button key={color} aria-label={section.title+' '+color} title={color} className="h-11 w-11 rounded-lg border border-slate-200" style={{background:color}} onClick={()=>choose(color)}/>)}</div></section>)}
 {design.canvas&&<button className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-200 px-3 text-xs" onClick={()=>{setOpen(false);design.pick(choose)}}><Pipette className="h-4 w-4"/>Tomar color del lienzo</button>}
 <label className="block text-xs text-slate-500">Color personalizado<div className="mt-1 flex gap-2"><input aria-label="Color visual" type="color" value={normalizeEditorColor(draft)||'#FFFFFF'} onChange={e=>setDraft(e.target.value.toUpperCase())} className="h-11 w-12 rounded-lg border border-slate-200"/><input aria-label="Color hexadecimal" value={draft} onChange={e=>{setDraft(e.target.value);setError('')}} onKeyDown={e=>{if(e.key==='Enter')apply()}} className="h-11 min-w-0 flex-1 rounded-lg border border-slate-200 px-2 font-mono uppercase" maxLength={7}/></div></label>
 <div className="grid grid-cols-3 gap-2" aria-label="Vista previa de contraste">{['#FFFFFF','#0F172A','#ECFDF5'].map(bg=><div key={bg} className="rounded-lg border p-2 text-center font-bold" style={{background:bg,color:normalizeEditorColor(draft)||'#000000'}}>Aa</div>)}</div>
 {error&&<p role="alert" className="text-xs text-rose-700">{error}</p>}<div className="flex gap-2">{allowNone&&<button className="min-h-11 flex-1 rounded-xl border border-slate-200" onClick={()=>choose('transparent')}>Sin relleno</button>}<button onClick={apply} className="min-h-11 flex-1 rounded-xl bg-emerald-600 px-3 text-white">Aplicar</button></div>
 </div></EditorPopover>}</>
}
