// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { filterOfflineTasks, offlineTaskAgenda, offlineTaskCommentPage, offlineTaskDataset, offlineTaskGantt, offlineTaskPage, offlineTaskSummary, type OfflineTaskRow } from './taskQueries'
import { offlineTaskMutationInput } from './taskMutationInput'
import type { OfflineV5Snapshot } from './types'

const now = Date.parse('2026-10-16T12:00:00Z')
const task = (id: string, extra: OfflineTaskRow = {}): OfflineTaskRow => ({ id, title: id, list_id: 'list-a', environment_id: 'env-a', folder_id: 'folder-a', status: 'pending', status_id: 'open', status_category: 'active', sort_order: 1024, priority: 'urgent', type: 'call', assigned_to: 'ada', created_by: 'ada', starred: true, created_at: '2026-10-16T04:00:00Z', ...extra })
const query = (text: string) => new URLSearchParams(text)
const ids = (rows: OfflineTaskRow[]) => rows.map(row => row.id)

describe('prepared Work query parity', () => {
  it('opens the latest comment page and pages backward without reversing reading order', () => {
    const comments = [task('old', { created_at: '2026-10-10T00:00:00Z' }), task('new-a', { created_at: '2026-10-11T00:00:00Z' }), task('new-b', { created_at: '2026-10-11T00:00:00Z' })]
    const newest = offlineTaskCommentPage(comments, 0, 2)
    expect(ids(newest.comments)).toEqual(['new-a', 'new-b'])
    expect(newest).toMatchObject({ has_more: true, next_offset: 2 })
    expect(offlineTaskCommentPage(comments, 2, 2)).toMatchObject({ comments: [{ id: 'old' }], has_more: false, next_offset: 3 })
  })
  it('combines all filter families with AND and choices within a field with OR', () => {
    const matching = task('match', { collaborator_ids: [], collaborators: [{ user_id: 'bea' }], subtask_count: 1, comment_count: 2, attachment_count: 1, dependency_count: 1 })
    const candidates = [matching, task('closed', { status: 'completed', status_id: 'done', status_category: 'done' }), task('other-owner', { assigned_to: 'bea' }), task('other-folder', { folder_id: 'elsewhere' })]
    expect(ids(filterOfflineTasks(candidates, query('include_closed=false&folder_id=folder-a&environment_id=env-a&assigned_to_ids=ada,other&collaborator_ids=bea&priorities=high,urgent&types=call&creator_ids=ada&starred=true&has_subtasks=true&has_comments=true&has_attachments=true&has_dependencies=true'), now))).toEqual(['match'])
    expect(filterOfflineTasks(candidates, query('assigned_to=nobody'), now)).toEqual([])
    expect(ids(filterOfflineTasks(candidates, query('include_closed=false&status_ids=done'), now))).toEqual(['closed'])
  })

  it('uses Lima calendar dates and inclusive to dates, and excludes closed overdue tasks', () => {
    const tasks = [task('lima-yesterday', { due_at: '2026-10-16T04:59:00Z' }), task('today', { due_at: '2026-10-16T05:00:00Z' }), task('no-date'), task('closed', { due_at: '2026-10-16T05:00:00Z', status_category: 'done' })]
    expect(ids(filterOfflineTasks(tasks, query('due=today'), now))).toEqual(['today', 'closed'])
    expect(ids(filterOfflineTasks(tasks, query('due=overdue'), now))).toEqual(['lima-yesterday', 'today'])
    expect(ids(filterOfflineTasks(tasks, query('due=no_date'), now))).toEqual(['no-date'])
    expect(ids(filterOfflineTasks(tasks, query('from=2026-10-15&to=2026-10-15'), now))).toEqual(['lima-yesterday'])
    expect(ids(filterOfflineTasks(tasks, query('created_from=2026-10-16'), now))).toEqual([])
    expect(ids(filterOfflineTasks(tasks, query('created_to=2026-10-15'), now))).toEqual(ids(tasks))
  })

  it('respects parents, contextual relations, direct shares and search', () => {
    const tasks = [task('root', { contact_id: 'contact-a', direct_shared: true, description: 'Descripción útil' }), task('child', { parent_task_id: 'root', contact_id: 'contact-a' })]
    expect(ids(filterOfflineTasks(tasks, query('contact_id=contact-a&shared_with_me=true&search=ÚTIL'), now))).toEqual(['root'])
    expect(ids(filterOfflineTasks(tasks, query('parent_task_id=root'), now))).toEqual(['child'])
    expect(ids(filterOfflineTasks(tasks, query('include_subtasks=true'), now))).toEqual(['root', 'child'])
    expect(filterOfflineTasks(tasks, query('event_id=other'), now)).toEqual([])
  })

  it('keeps stable keyset pagination when an earlier row is removed, and binds cursors to scope', () => {
    const tasks = ['a', 'b', 'c', 'd'].map((id, index) => task(id, { sort_order: index }))
    const first = offlineTaskPage(tasks, new URL('https://test/api/tasks?list_id=list-a&limit=2'))
    expect(ids(first.items)).toEqual(['a', 'b'])
    const nextURL = new URL('https://test/api/tasks?list_id=list-a&limit=2'); nextURL.searchParams.set('cursor', first.next_cursor!)
    expect(ids(offlineTaskPage(tasks.slice(1), nextURL).items)).toEqual(['c', 'd'])
    expect(offlineTaskPage(tasks.slice(0, 2), nextURL)).toMatchObject({ items: [], total: 2, next_cursor: null })
    nextURL.searchParams.set('list_id', 'other')
    expect(() => offlineTaskPage(tasks, nextURL)).toThrow(/otra consulta/)
    expect(offlineTaskPage([], new URL('https://test/api/tasks'))).toEqual({ items: [], total: 0, next_cursor: null })
    expect(offlineTaskPage(Array.from({length: 250}, (_, index) => task(String(index))), new URL('https://test/api/tasks?limit=999')).items).toHaveLength(200)
  })

  it('preserves actual folders and canonical status/owner data with prepared-only counters', () => {
    const snapshot = { root_resource_id: 'list-a', root_selection_id: 'selection-a', payload: {
      list: { id: 'list-a', name: 'Preparada', environment_id: 'env-a', folder_id: 'folder-a' }, environment: { id: 'env-a', name: 'General' }, folder: { id: 'folder-a', environment_id: 'env-a', name: 'Carpeta real' },
      tasks: [task('a'), task('b', { status_id: 'done', status_category: 'done', status: 'completed' }), task('child', { parent_task_id: 'a', status_id: 'done', status_category: 'done' })], statuses: [{ id: 'open', name: 'En curso', category: 'active' }, { id: 'done', name: 'Listo', category: 'done' }], users: [{id:'ada', display_name:'Ada'}], dependencies: [],
    } } as unknown as OfflineV5Snapshot
    const data = offlineTaskDataset([snapshot], [])
    expect(data.folders[0]).toMatchObject({ name: 'Carpeta real', icon:'folder', task_count:2, open_task_count:1, lists:[{id:'list-a'}] })
    expect(data.tasks[0]).toMatchObject({ environment_id:'env-a', assigned_to_name:'Ada', status_detail:{name:'En curso'}, subtask_count:1 })
    expect(data.environments[0]).toMatchObject({task_count:2, folder_count:1, list_count:1})
  })

  it('calculates summary over the full filtered set and does not treat cancelled as done', () => {
    const summary = offlineTaskSummary([task('a', { progress:50, due_at:'2026-10-16T10:00:00Z' }), task('b', { status_category:'done', status:'completed', progress:0 }), task('c', { status_category:'cancelled', progress:0 })], now)
    expect(summary).toMatchObject({ total:3, done:1, active:1, overdue:1, progress:75, owners:1 })
  })

  it('matches critical-path duration/lag behavior and omits unscheduled or unavailable endpoints', () => {
    const tasks = [task('a', {start_at:'2026-10-16T00:00:00Z',due_at:'2026-10-16T01:00:00Z'}), task('b', {start_at:'2026-10-16T01:00:00Z',due_at:'2026-10-16T03:00:00Z'}), task('c', {start_at:'2026-10-16T00:00:00Z',due_at:'2026-10-16T00:30:00Z'}), task('no-start', {due_at:'2026-10-16T12:00:00Z'})]
    const result = offlineTaskGantt(tasks,[{id:'ab',predecessor_task_id:'a',successor_task_id:'b',lag_minutes:30},{id:'hidden',predecessor_task_id:'hidden',successor_task_id:'b'}])
    expect(result).toMatchObject({ critical_task_ids:['a','b'],slack_minutes:{a:0,b:0,c:180},scheduled_count:3,unscheduled_count:1,total_count:4 })
    expect(result.dependencies).toHaveLength(1)
  })

  it('pages actual calendar intervals and declares unavailable event data explicitly', () => {
    const tasks = [task('spanning',{start_at:'2026-10-15T00:00:00Z',due_at:'2026-10-17T00:00:00Z'}),task('end-exclusive',{start_at:'2026-10-15T00:00:00Z',due_at:'2026-10-16T00:00:00Z'}),task('instant',{due_at:'2026-10-16T00:00:00Z'}),task('undated')]
    const result=offlineTaskAgenda(tasks,new URL('https://test/api/tasks/agenda?from=2026-10-16T00:00:00Z&to=2026-10-17T00:00:00Z&sources=tasks,events'))
    expect(result.items.map(item=>item.key)).toEqual(['task:spanning','task:instant'])
    expect(result.offline_sources).toEqual({available:['tasks'],unavailable:['events']})
    expect(()=>offlineTaskAgenda(tasks,new URL('https://test/api/tasks/agenda?from=bad&to=bad'))).toThrow(/rango/)
  })
})

describe('canonical task editor payload boundary', () => {
  it('accepts known neutral defaults and normalizes cleared dates without pretending to save unknown fields', () => {
    const prepared = offlineTaskMutationInput({title:'Nueva',list_id:'list-a',assigned_to:'ada',status_id:'open',type:'call',color:null,start_at:'',due_at:'',collaborator_ids:[],progress:0,manual_progress:0,progress_mode:'manual',is_milestone:false,recurrence_rule:'',reminder_minutes:0,confirm_grants:false})
    expect(prepared.unsupported).toEqual([])
    expect(prepared.payload).toMatchObject({title:'Nueva',assigned_to:'ada',status_id:'open',type:'call',start_at:null,due_at:null})
    expect(prepared.payload).not.toHaveProperty('collaborator_ids')
    expect(offlineTaskMutationInput({title:'Nueva',collaborator_ids:['bea'],recurrence_rule:'weekly',confirm_grants:true}).unsupported).toEqual(['collaborator_ids','recurrence_rule','confirm_grants'])
  })

  it('rejects hidden partial writes while permitting unchanged unsupported fields in a full edit', () => {
    const current = task('a', {recurrence_rule:'weekly',reminder_minutes:10,collaborators:[{user_id:'bea'}]})
    expect(offlineTaskMutationInput({title:'Editada',list_id:'list-a',recurrence_rule:'weekly',reminder_minutes:10,collaborator_ids:['bea'],confirm_grants:false},current)).toEqual({payload:{title:'Editada'},unsupported:[]})
    expect(offlineTaskMutationInput({title:'Editada',list_id:'elsewhere',collaborator_ids:[]},current).unsupported).toEqual(['list_id','collaborator_ids'])
  })
})
