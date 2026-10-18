import { forwardRef, useImperativeHandle, useState, type ReactNode } from 'react'
import { act,cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import ProgramDetailPage from '@/app/dashboard/programs/[id]/page'
const fixture=vi.hoisted(()=>({id:'program-A',account:'account',width:1100,offline:false,reset:vi.fn(),api:vi.fn(),contactCanClose:vi.fn(()=>true),wsCallback:null as null|((message:unknown)=>void),router:{push:vi.fn(),replace:vi.fn()},resolveOld:null as null|((r:any)=>void),delay:false}))
vi.mock('next/navigation',()=>({useParams:()=>({id:fixture.id}),useRouter:()=>fixture.router}))
vi.mock('@/lib/api',()=>({api:fixture.api,subscribeWebSocket:(callback:(message:unknown)=>void)=>{fixture.wsCallback=callback;return ()=>{fixture.wsCallback=null}}}))
vi.mock('@/lib/offlineCanonicalRoute',()=>({canonicalResourceID:(x:string)=>x}))
vi.mock('@/components/offline-v5/ClarinRuntimeProvider',()=>({useClarinRuntime:()=>({isOffline:fixture.offline,requireOnline:()=>true,snapshot:{accountId:fixture.account}})}))
vi.mock('@/components/responsive/useContainerWidth',()=>({useContainerWidth:()=>({ref:{current:null},width:fixture.width})}))
vi.mock('@/hooks/useWhatsAppChatLauncher',()=>({default:()=>({pending:false,error:'',reset:fixture.reset,close:vi.fn(),open:vi.fn()})}))
vi.mock('@/components/ContactSelector',()=>({default:({open,suspended}:{open:boolean;suspended:boolean})=>{
const [query,setQuery]=useState('')
return open?<div hidden={suspended} data-testid="retained-enrollment"><input aria-label="Enrollment draft" value={query} onChange={event=>setQuery(event.target.value)}/></div>:null
}}))
vi.mock('@/components/CreateCampaignModal',()=>({default:()=>null}))
vi.mock('@/components/chat/ChatPanel',()=>({default:()=>null}))
vi.mock('@/components/WhatsAppDevicePicker',()=>({default:()=>null}))
vi.mock('@/components/ContactPhotoPreview',()=>({default:()=>null}))
vi.mock('@/components/contact-details/ContactDetailSurface',()=>({default:forwardRef(function ContactMock({readOnly,onClose,contextContent}:{readOnly?:boolean;onClose:()=>void;contextContent?:ReactNode},ref){
  const [draft,setDraft]=useState('')
  useImperativeHandle(ref,()=>({canClose:fixture.contactCanClose,requestClose:()=>{if(!fixture.contactCanClose())return false;onClose();return true}}))
  return <div data-testid="retained-contact"><input hidden={readOnly} aria-label="Contact draft" value={draft} onChange={event=>setDraft(event.target.value)}/><button type="button" onClick={()=>{if(fixture.contactCanClose())onClose()}}>Cerrar contacto de prueba</button>{contextContent}</div>
})}))
vi.mock('@/components/crm-detail/CrmDetailWorkspace',()=>({default:({detail}:{detail:ReactNode})=>detail}))
vi.mock('@/components/operational-window/OperationalOverlayBoundary',()=>({default:({children}:{children:ReactNode})=>children}))
vi.mock('@/components/programs/ProgramParticipantAttendanceSection',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramParticipantEnrollmentDate',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramParticipantOutcomeDate',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramAcademicConfigPanel',()=>({default:({onDirtyChange,suspended}:{onDirtyChange:(dirty:boolean)=>void;suspended:boolean})=>{
const [draft,setDraft]=useState('')
return <div data-testid="retained-academic" data-suspended={String(suspended)}><input aria-label="Academic draft" value={draft} onChange={event=>{setDraft(event.target.value);onDirtyChange(Boolean(event.target.value))}}/></div>
}}))
vi.mock('@/components/programs/ProgramSurveyPanel',()=>({default:()=>null}))
vi.mock('@/components/programs/SessionTopicField',()=>({default:({onChange}:{onChange:(topics:unknown[])=>void})=><button type="button" onClick={()=>onChange([{kind:'free',title:'Tema de prueba'}])}>Elegir tema de prueba</button>,normalizedSessionTopics:()=>[],pendingActiveCourseTopics:()=>[]}))
vi.mock('@/components/programs/ProgramSettingsDialog',()=>({ProgramSettingsDialog:()=>null}))
const health=(id:string)=>({program_id:id,as_of_date:'2026-10-08',active_count:1,health:'healthy',attendance_rate:id==='program-A'?100:0,participants:[{participant_id:id+'-participant',contact_id:id+'-contact',name:'Participant '+id,phone:'',status:'active',enrolled_at:'2026-01-01',attendance_rate:id==='program-A'?100:0,eligible_sessions:1,marked_sessions:1,health:'healthy',reasons:[],present:1,absent:0,late:0}]})
beforeEach(()=>{
fixture.id='program-A';fixture.account='account';fixture.width=1100;fixture.offline=false;fixture.reset.mockReset();fixture.contactCanClose.mockReset().mockReturnValue(true);fixture.delay=false;fixture.resolveOld=null;fixture.api.mockReset()
window.matchMedia=vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})) as any
vi.stubGlobal('ResizeObserver',class{observe(){} unobserve(){} disconnect(){}})
vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({success:true,user:{id:'actor',account_id:'account',permissions:[]},devices:[]})})))
fixture.api.mockImplementation(async(endpoint:string)=>{
const id=endpoint.includes('program-B')?'program-B':'program-A'
if(endpoint.endsWith('/health')){
if(fixture.delay&&id==='program-A')return new Promise(resolve=>{fixture.resolveOld=resolve})
return {success:true,data:{success:true,health:health(id)}}
}
if(endpoint.endsWith('/participants'))return {success:true,data:[{id:id+'-participant',program_id:id,contact_id:id+'-contact',contact_name:'Participant '+id,status:'active',enrolled_at:'2026-01-01'}]}
if(endpoint.endsWith('/sessions'))return {success:true,data:[]}
if(endpoint.endsWith('/goals'))return {success:true,data:{success:true,goals:{attendance_goal_percent:80,transfer_goal_percent:70}}}
if(endpoint.endsWith('/academic-config'))return {success:true,data:{courses:[],instructors:[]}}
return {success:true,data:{id,account_id:fixture.account,type:'course',status:'active',name:'Group '+id,updated_at:'2026-10-08T10:00:00Z',health_view_columns:['attendance','health']}}
})
})
afterEach(()=>{cleanup();vi.unstubAllGlobals()})

const session = { id: 'session-1', program_id: 'program-A', date: '2026-10-18', title: 'Sesión de prueba', topics: [], location: 'Sala principal', start_time: '10:00', end_time: '11:00' }
const attendanceRoster = [
  { participant_id: 'ana', contact_id: 'contact-ana', contact_name: 'Ana Torres', participation_status: 'active', enrolled_at: '2026-01-01', attendance_status: '', observation_count: 0, observation_preview: [] },
  { participant_id: 'bruno', contact_id: 'contact-bruno', contact_name: 'Bruno Ruiz', participation_status: 'active', enrolled_at: '2026-01-01', attendance_status: '', observation_count: 0, observation_preview: [] },
]

async function openAttendanceExperience() {
  fixture.width = 536
  vi.stubGlobal('IntersectionObserver', class { observe(){} unobserve(){} disconnect(){} })
  const normalAPI = fixture.api.getMockImplementation()!
  fixture.api.mockImplementation(async (endpoint: string, options?: RequestInit) => {
    if (endpoint.endsWith('/sessions') && !options?.method) return { success: true, data: [session] }
    if (endpoint.endsWith('/roster')) return { success: true, data: { success: true, roster: attendanceRoster } }
    if (endpoint.endsWith('/observations') && options?.method === 'POST') return { success: true, data: { success: true, observation: { id: 'note', notes: JSON.parse(String(options.body)).notes, created_at: '2026-10-18T12:00:00Z', updated_at: '2026-10-18T12:00:00Z', is_pinned: false } } }
    if (endpoint.endsWith('/observations') || endpoint.endsWith('/attendance-observations')) return { success: true, data: { success: true, observations: [] } }
    if (endpoint.endsWith('/attendance/batch')) return { success: true, data: { success: true } }
    return normalAPI(endpoint, options)
  })
  const view = render(<ProgramDetailPage/> )
  await screen.findByText('Group program-A')
  fireEvent.click(screen.getByRole('tab', { name: 'Sesiones' }))
  fireEvent.click(screen.getByRole('button', { name: 'Asistencia' }))
  await screen.findAllByRole('button', { name: 'Presente: Ana Torres' })
  return view
}

describe('attendance context, search and pending comments', () => {
  it('starts mobile details collapsed and hides them immediately while participant results wait exactly 500 ms', async () => {
    await openAttendanceExperience()
    expect(screen.getByRole('button', { name: 'Detalles' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('heading', { name: 'Comentarios generales' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Borrador de sesión' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Presente: Bruno Ruiz' })[0])
    vi.useFakeTimers()
    try {
      fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar participante por nombre o teléfono' }), { target: { value: 'ana' } })
      expect(screen.queryByRole('heading', { name: 'Comentarios generales' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Detalles' })).not.toBeInTheDocument()
      expect(document.getElementById('program-attendance-session-details')).toHaveAttribute('inert')
      await act(async () => { vi.advanceTimersByTime(499) })
      expect(screen.getAllByRole('button', { name: 'Presente: Bruno Ruiz' })[0]).toHaveAttribute('aria-pressed', 'true')
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(screen.queryByRole('button', { name: 'Presente: Bruno Ruiz' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda de asistencia' }))
      expect(screen.getByRole('textbox')).toHaveValue('Borrador de sesión')
      expect(screen.getByRole('button', { name: 'Detalles' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getAllByRole('button', { name: 'Presente: Bruno Ruiz' })[0]).toHaveAttribute('aria-pressed', 'true')
    } finally { vi.useRealTimers() }
  }, 15000)

  it('protects a comment-only draft even while its details are collapsed', async () => {
    await openAttendanceExperience()
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Aún no enviado' } })
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar asistencia' }))
    expect(screen.getByRole('alertdialog', { name: 'Confirmar acción' })).toHaveTextContent('comentario de sesión sin guardar')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }))
    expect(screen.getByRole('textbox')).toHaveValue('Aún no enviado')
    expect(fixture.api.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0)
  })

  it('saves attendance once, leaves a separate comment pending and lets the user review and explicitly send it', async () => {
    await openAttendanceExperience()
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Comentario separado' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Presente: Ana Torres' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar Asistencia' }))
    await screen.findByText('Asistencia guardada; tienes un comentario pendiente.')
    expect(screen.getByRole('button', { name: 'Guardar Asistencia' })).toBeDisabled()
    expect(fixture.api.mock.calls.filter(([, options]) => options?.method)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Revisar comentario' }))
    expect(screen.getByRole('textbox')).toHaveValue('Comentario separado')
    fireEvent.click(within(screen.getByRole('textbox').closest('section')!).getByRole('button', { name: 'Añadir' }))
    await screen.findByText('Asistencia y comentario guardados.')
    expect(fixture.api.mock.calls.filter(([endpoint]) => endpoint.endsWith('/attendance/batch'))).toHaveLength(1)
    expect(fixture.api.mock.calls.filter(([endpoint, options]) => endpoint.endsWith('/observations') && options?.method === 'POST')).toHaveLength(1)
  })

  it('retains marks and the comment through a save conflict and an explicit retry', async () => {
    await openAttendanceExperience()
    const normalAPI = fixture.api.getMockImplementation()!
    let attempt = 0
    fixture.api.mockImplementation(async (endpoint: string, options?: RequestInit) => {
      if (endpoint.endsWith('/attendance/batch') && attempt++ === 0) return { success: false, status: 409, data: { code: 'attendance_conflict', conflicts: [{ participant_id: 'ana', current_status: 'late' }] } }
      return normalAPI(endpoint, options)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Borrador conservado' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Presente: Ana Torres' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Guardar Asistencia' }))
    const dialog = await screen.findByRole('dialog', { name: 'La asistencia cambió en otra sesión' })
    const retry = within(dialog).getByRole('button', { name: 'Guardar mi revisión' })
    fireEvent.click(retry)
    await screen.findByText('Asistencia guardada; tienes un comentario pendiente.')
    expect(screen.getByRole('textbox')).toHaveValue('Borrador conservado')
    const saves = fixture.api.mock.calls.filter(([endpoint]) => endpoint.endsWith('/attendance/batch'))
    expect(saves).toHaveLength(2)
    expect(JSON.parse(saves[1][1].body).records).toEqual([{ participant_id: 'ana', status: 'present', expected_status: 'late' }])
  })

  it('opens Añadir directly into the participant composer and keeps that intention during refresh', async () => {
    await openAttendanceExperience()
    fireEvent.click(screen.getAllByRole('button', { name: 'Añadir observación de asistencia de Ana Torres' })[0])
    const modal = await screen.findByRole('dialog', { name: 'Observaciones de asistencia' })
    expect(within(modal).getByRole('textbox')).toBeInTheDocument()
    await waitFor(() => expect(fixture.api.mock.calls.some(([path]) => path.endsWith('/attendance-observations'))).toBe(true))
    expect(within(modal).getByRole('textbox')).toBeInTheDocument()
  })
})
