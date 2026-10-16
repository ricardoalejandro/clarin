// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OfflineV5RouteAdapter } from './routeAdapter'
import type { OfflineV5Engine } from './engine'
import type { OfflineV5MutationInput } from './types'

function harness() {
  const task = {id:'task-a',account_id:'account-a',list_id:'list-a',title:'Original',status:'pending',status_id:'open',status_category:'active',assigned_to:'ada',type:'call',version:4,priority:'urgent',starred:true}
  const snapshot = {root_selection_id:'selection-a',root_resource_id:'list-a',payload:{list:{id:'list-a',environment_id:'env-a',folder_id:'folder-a',name:'Lista real'},folder:{id:'folder-a',environment_id:'env-a',name:'Carpeta real'},environment:{id:'env-a',name:'Entorno real'},tasks:[task,{...task,id:'closed',status:'completed',status_category:'done',status_id:'done',assigned_to:'bea',starred:false}],statuses:[{id:'open',name:'En curso',category:'active'},{id:'done',name:'Lista',category:'done'}],users:[{id:'ada',display_name:'Ada'},{id:'bea',display_name:'Bea'}]}}
  const session = {identity:{user_id:'ada',account_id:'account-a'},manifest:{capabilities:[]},metadata:{actor:{username:'ada'}}}
  const queueMutation = vi.fn(async (_port:string,_generation:number,input:OfflineV5MutationInput) => ({operation_id:input.operation_id || 'op',state:'queued',entity:{value:input.optimistic_value}}))
  const engine = {origin:'https://test',checkedSession:async()=>session,sessions:{require:()=>session},aggregates:async()=>[snapshot],overlays:async()=>[],queueMutation}
  const adapter = new OfflineV5RouteAdapter(engine as unknown as OfflineV5Engine)
  const request = async (path:string,method='GET',body?:unknown) => {const response=await adapter.request('port',1,{url:`https://test${path}`,method,headers:[],body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:JSON.parse(response.body!)} }
  return {request,queueMutation}
}

describe('existing Work UI through the offline transport', () => {
  it('answers filtered collection, hierarchy, summary and Gantt using canonical contracts', async () => {
    const {request}=harness()
    expect((await request('/api/tasks?environment_id=env-a&include_closed=false&assigned_to_ids=ada&starred=true')).data).toMatchObject({tasks:[{id:'task-a'}],total:1})
    expect((await request('/api/tasks/environments/env-a/lists')).data.lists).toEqual([])
    expect((await request('/api/tasks/environments/env-a/lists?folder_id=folder-a')).data.lists).toHaveLength(1)
    expect((await request('/api/tasks/environments/env-a/folders')).data.folders[0]).toMatchObject({name:'Carpeta real',lists:[{id:'list-a'}]})
    expect((await request('/api/tasks/summary?environment_id=env-a')).data.summary).toMatchObject({total:2,done:1,active:1})
    expect((await request('/api/tasks/gantt?environment_id=env-a')).data).toMatchObject({tasks:[],unscheduled_count:2})
  })

  it('never returns a successful partial edit and captures the old base for conflict resolution', async () => {
    const {request,queueMutation}=harness()
    expect((await request('/api/tasks/task-a','PUT',{title:'Would be misleading',collaborator_ids:['unknown'],version:4})).status).toBe(503)
    expect(queueMutation).not.toHaveBeenCalled()
    const moved = await request('/api/tasks/task-a','PUT',{list_id:'another-list',title:'Would move',version:4})
    expect(moved.status).toBe(503)
    expect(moved.data.error).toBe('online_required')
    expect(queueMutation).not.toHaveBeenCalled()
    const result=await request('/api/tasks/task-a','PUT',{title:'Nueva',assigned_to:'bea',color:'#112233',version:4,confirm_grants:false})
    expect(result.data.task).toMatchObject({title:'Nueva',assigned_to:'bea',color:'#112233'})
    expect(queueMutation.mock.calls[0][2]).toMatchObject({action:'tasks.update',base_version:4,base:{title:'Original'},payload:{title:'Nueva',assigned_to:'bea',color:'#112233'}})
  })

  it('routes starring and canonical subtask creation through the durable queue', async () => {
    const {request,queueMutation}=harness()
    expect((await request('/api/tasks/task-a/star','POST',{})).data).toMatchObject({starred:false,task:{starred:false}})
    const child=await request('/api/tasks/task-a/children','POST',{title:'Hija',status_id:'open',assigned_to:'ada',due_at:'',confirm_grants:false})
    expect(child.status).toBe(201)
    expect(child.data.task).toMatchObject({parent_task_id:'task-a',list_id:'list-a',environment_id:'env-a',due_at:null})
    expect(queueMutation.mock.calls[1][2]).toMatchObject({action:'tasks.create',payload:{title:'Hija',parent_task_id:'task-a',assigned_to:'ada',status_id:'open',due_at:null}})
  })
})
