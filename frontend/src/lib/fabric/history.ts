import type { Canvas } from 'fabric'
import { HISTORY_LIMIT, CUSTOM_PROPS } from './constants'

interface HistoryAdapter {
  capture?: () => unknown
  restore?: (snapshot:any) => Promise<void>
  onChange?: () => void
}
export class CanvasHistory {
  private stack:string[]=[]
  private index=-1
  private locked=false
  constructor(private canvas:Canvas,private adapter:HistoryAdapter={}) {}
  save():void {
    if(this.locked) return
    const json=JSON.stringify(this.adapter.capture?this.adapter.capture():this.canvas.toObject(CUSTOM_PROPS))
    if(this.stack[this.index]===json) return
    this.stack=this.stack.slice(0,this.index+1)
    this.stack.push(json)
    if(this.stack.length>HISTORY_LIMIT)this.stack.shift()
    this.index=this.stack.length-1
    this.adapter.onChange?.()
  }
  init():void {this.stack=[];this.index=-1;this.save()}
  get canUndo(){return !this.locked&&this.index>0}
  get canRedo(){return !this.locked&&this.index<this.stack.length-1}
  get busy(){return this.locked}
  async undo(){if(this.canUndo)await this.restore(this.index-1)}
  async redo(){if(this.canRedo)await this.restore(this.index+1)}
  private async restore(next:number):Promise<void> {
    const state=this.stack[next];if(!state||this.locked)return
    this.locked=true
    try {
      if(this.adapter.restore)await this.adapter.restore(JSON.parse(state))
      else {
        await this.canvas.loadFromJSON(state)
        for(const obj of this.canvas.getObjects())if((obj as any).__isPage){
          obj.set({selectable:false,evented:false,hasControls:false,lockMovementX:true,lockMovementY:true,hoverCursor:'default'})
          this.canvas.__pageRect=obj as any;this.canvas.sendObjectToBack(obj);break
        }
      }
      this.index=next
      this.canvas.requestRenderAll()
    } finally {this.locked=false;this.adapter.onChange?.()}
  }
  lock(){this.locked=true}
  unlock(){this.locked=false}
  clear(){this.stack=[];this.index=-1}
}
