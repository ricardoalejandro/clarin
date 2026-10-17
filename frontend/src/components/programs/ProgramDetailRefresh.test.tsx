import { useState } from 'react'
import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import ProgramDetailPage from '@/app/dashboard/programs/[id]/page'
const fixture=vi.hoisted(()=>({id:'program-A',account:'account',width:1100,offline:false,reset:vi.fn(),api:vi.fn(),wsCallback:null as null|((message:unknown)=>void),router:{push:vi.fn(),replace:vi.fn()},resolveOld:null as null|((r:any)=>void),delay:false}))
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
vi.mock('@/components/ObservationHistoryModal',()=>({default:()=>null}))
vi.mock('@/components/ContactPhotoPreview',()=>({default:()=>null}))
vi.mock('@/components/contact-details/ContactDetailSurface',()=>({default:()=>null}))
vi.mock('@/components/crm-detail/CrmDetailWorkspace',()=>({default:()=>null}))
vi.mock('@/components/operational-window/OperationalOverlayBoundary',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramParticipantAttendanceSection',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramParticipantEnrollmentDate',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramParticipantOutcomeDate',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramAcademicConfigPanel',()=>({default:({onDirtyChange,suspended}:{onDirtyChange:(dirty:boolean)=>void;suspended:boolean})=>{
const [draft,setDraft]=useState('')
return <div data-testid="retained-academic" data-suspended={String(suspended)}><input aria-label="Academic draft" value={draft} onChange={event=>{setDraft(event.target.value);onDirtyChange(Boolean(event.target.value))}}/></div>
}}))
vi.mock('@/components/programs/ProgramSurveyPanel',()=>({default:()=>null}))
vi.mock('@/components/programs/SessionTopicField',()=>({default:()=>null,normalizedSessionTopics:()=>[],pendingActiveCourseTopics:()=>[]}))
vi.mock('@/components/programs/SessionObservationPanel',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramSettingsDialog',()=>({ProgramSettingsDialog:()=>null}))
vi.mock('@/components/programs/ProgramAttendanceRoster',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramAttendanceSearchBar',()=>({default:()=>null}))
const health=(id:string)=>({program_id:id,as_of_date:'2026-10-08',active_count:1,health:'healthy',attendance_rate:id==='program-A'?100:0,participants:[{participant_id:id+'-participant',contact_id:id+'-contact',name:'Participant '+id,phone:'',status:'active',enrolled_at:'2026-01-01',attendance_rate:id==='program-A'?100:0,eligible_sessions:1,marked_sessions:1,health:'healthy',reasons:[],present:1,absent:0,late:0}]})
beforeEach(()=>{
fixture.id='program-A';fixture.account='account';fixture.width=1100;fixture.offline=false;fixture.reset.mockReset();fixture.delay=false;fixture.resolveOld=null;fixture.api.mockReset()
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
describe('program canonical refresh',()=>{
it('refreshes enrollment counts and outcome controls together with the health roster',async()=>{
const normalAPI=fixture.api.getMockImplementation()!
let remoteEnrollment=false
fixture.api.mockImplementation(async(endpoint:string)=>{
if(endpoint.endsWith('/participants')&&!remoteEnrollment)return {success:true,data:[]}
if(endpoint.endsWith('/health'))return {success:true,data:{success:true,health:remoteEnrollment?health('program-A'):{...health('program-A'),active_count:0,participants:[]}}}
return normalAPI(endpoint)
})
render(<ProgramDetailPage/>);expect(await screen.findByText('Sin inscritos para evaluar')).toBeInTheDocument()
remoteEnrollment=true;fireEvent.click(screen.getByRole('button',{name:'Actualizar'}))
expect(await screen.findByText('Participant program-A')).toBeInTheDocument()
expect(screen.getByRole('button',{name:'Participantes (1)'})).toBeInTheDocument()
fireEvent.click(screen.getByTitle('Retirar del programa'))
expect(screen.getByText('Retirar y conservar historial')).toBeInTheDocument()
expect(fixture.api.mock.calls.filter(([endpoint])=>String(endpoint).endsWith('/participants')).length).toBeGreaterThan(1)
})
it('aborts an old refresh and keeps the new program roster after navigation',async()=>{
const view=render(<ProgramDetailPage/>);expect(await screen.findByText('Participant program-A')).toBeInTheDocument()
fixture.delay=true;fireEvent.click(screen.getByRole('button',{name:'Actualizar'}));
expect(screen.getByText('Participant program-A')).toBeInTheDocument();
expect(screen.getByRole('button',{name:'Actualizar'})).toBeDisabled();
await waitFor(()=>expect(fixture.resolveOld).not.toBeNull())
fixture.id='program-B';fixture.delay=false;view.rerender(<ProgramDetailPage/>);
expect(await screen.findByText('Group program-B')).toBeInTheDocument()
await act(async()=>fixture.resolveOld!({success:true,data:{success:true,health:health('program-A')}}))
expect(screen.getByText('Group program-B')).toBeInTheDocument()
expect(screen.queryByText('Participant program-A')).not.toBeInTheDocument()
expect(screen.getByText('Participant program-B')).toBeInTheDocument()
const oldCalls=fixture.api.mock.calls.filter(([endpoint])=>String(endpoint).includes('program-A'))
expect(oldCalls.some(([,options])=>options?.signal?.aborted)).toBe(true)
})
it('retains loaded data and exposes retry after a roster refresh fails', async () => {
  render(<ProgramDetailPage/>);
  expect(await screen.findByText('Participant program-A')).toBeInTheDocument();
  const normalAPI=fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async(endpoint:string)=>endpoint.endsWith('/participants')
    ? {success:false,status:503,error:'Participantes temporalmente no disponibles'} : normalAPI(endpoint));
  fireEvent.click(screen.getByRole('button',{name:'Actualizar'}));
  expect(await screen.findByText(/Participantes temporalmente no disponibles/)).toBeInTheDocument();
  expect(screen.getByText('Participant program-A')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Participantes (1)'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Reintentar'})).toBeInTheDocument();
});

it('renders missing attendance as Sin datos and a dash instead of a measured zero', async () => {
  const normalAPI=fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async(endpoint:string)=>endpoint.endsWith('/health')
    ? {success:true,data:{success:true,health:{...health('program-A'),health:'no_data',attendance_rate:null,
      participants:[{...health('program-A').participants[0],health:'no_data',attendance_rate:null,marked_sessions:0,present:0}]}}}
    : normalAPI(endpoint));
  render(<ProgramDetailPage/>);
  expect(await screen.findByText('Participant program-A')).toBeInTheDocument();
  expect(screen.getAllByText('Sin datos').length).toBeGreaterThan(0);
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  expect(screen.queryByText('0%')).not.toBeInTheDocument();
});

it('ignores an in-flight refresh when the runtime changes account in the same route', async () => {
  const view=render(<ProgramDetailPage/>);
  expect(await screen.findByText('Participant program-A')).toBeInTheDocument();
  fixture.delay=true;
  fireEvent.click(screen.getByRole('button',{name:'Actualizar'}));
  await waitFor(()=>expect(fixture.resolveOld).not.toBeNull());
  const normalAPI=fixture.api.getMockImplementation()!;
  fixture.delay=false;
  fixture.account='account-b';
  fixture.api.mockImplementation(async(endpoint:string)=>{
    const response=await normalAPI(endpoint);
    if(endpoint.endsWith('/health'))return {...response,data:{success:true,health:{...health('program-A'),participants:[{...health('program-A').participants[0],name:'Participant account-b'}]}}};
    if(endpoint.endsWith('/participants'))return {...response,data:response.data.map((participant:any)=>({...participant,contact_name:'Participant account-b'}))};
    if(endpoint==='/api/programs/program-A')return {...response,data:{...response.data,account_id:'account-b',name:'Group account-b'}};
    return response;
  });
  view.rerender(<ProgramDetailPage/>);
  expect(await screen.findByText('Participant account-b')).toBeInTheDocument();
  await act(async()=>fixture.resolveOld!({success:true,data:{success:true,health:health('program-A')}}));
  expect(screen.getByText('Group account-b')).toBeInTheDocument();
  expect(screen.queryByText('Participant program-A')).not.toBeInTheDocument();
});

it('aborts a contact realtime refresh and rejects its old program context', async () => {
  const normalAPI=fixture.api.getMockImplementation()!;
  let resolveContact!: (response:unknown)=>void;
  let contactSignal:AbortSignal|undefined;
  fixture.api.mockImplementation(async(endpoint:string, options?:RequestInit)=>{
    if(endpoint.startsWith('/api/contact-profiles/')){
      contactSignal=options?.signal as AbortSignal;
      return new Promise(resolve=>{resolveContact=resolve});
    }
    const response=await normalAPI(endpoint);
    if(endpoint.endsWith('/participants'))return {...response,data:response.data.map((participant:any)=>({...participant,contact_id:'shared-contact'}))};
    if(endpoint.endsWith('/health'))return {...response,data:{success:true,health:{...response.data.health,participants:response.data.health.participants.map((participant:any)=>({...participant,contact_id:'shared-contact'}))}}};
    return response;
  });
  const view=render(<ProgramDetailPage/>);
  expect(await screen.findByText('Participant program-A')).toBeInTheDocument();
  // The roster can commit before its passive contact-context effect. Finish
  // the initial mocked request/effect cycle before delivering the event once.
  await act(async () => {});
  act(()=>fixture.wsCallback!({event:'contact_update',data:{contact_id:'shared-contact',account_id:'foreign-account'}}));
  expect(contactSignal).toBeUndefined();
  act(()=>fixture.wsCallback!({event:'contact_update',data:{contact_id:'shared-contact',account_id:'account'}}));
  await waitFor(()=>expect(contactSignal).toBeDefined());
  fixture.id='program-B';view.rerender(<ProgramDetailPage/>);
  expect(await screen.findByText('Participant program-B')).toBeInTheDocument();
  expect(contactSignal?.aborted).toBe(true);
  await act(async()=>resolveContact({success:true,data:{success:true,contact:{id:'shared-contact',account_id:'account',name:'Stale contact from A'}}}));
  expect(screen.getByText('Participant program-B')).toBeInTheDocument();
  expect(screen.queryByText('Stale contact from A')).not.toBeInTheDocument();
});

it.each(['failed health', 'concurrent enrollment'])('keeps roster, metrics and actions together after %s', async reason => {
  render(<ProgramDetailPage/>);
  expect(await screen.findByText('Participant program-A')).toBeInTheDocument();
  const normalAPI=fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async(endpoint:string)=>{
    if(endpoint.endsWith('/participants'))return {success:true,data:[]};
    if(endpoint.endsWith('/health')&&reason==='failed health')return {success:false,status:503,error:'Salud temporalmente no disponible'};
    return normalAPI(endpoint);
  });
  fireEvent.click(screen.getByRole('button',{name:'Actualizar'}));
  expect(await screen.findByText(reason==='failed health' ? /Salud temporalmente no disponible/ : /Los participantes cambiaron/)).toBeInTheDocument();
  expect(screen.getByText('Participant program-A')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Participantes (1)'})).toBeInTheDocument();
  fireEvent.click(screen.getByTitle('Retirar del programa'));
  expect(screen.getByText('Retirar y conservar historial')).toBeInTheDocument();
});

})


describe('Program mobile workspace',()=>{
  it('continues the shared Sessions section when widening without paused desktop work',async()=>{
    fixture.width=522
    const view=render(<ProgramDetailPage/>);
    expect(await screen.findByText('Participant program-A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab',{name:'Sesiones'}))
    fixture.width=1100;view.rerender(<ProgramDetailPage/>);
    expect(screen.getByText('Sesiones y Asistencia')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Participantes (1)'}))
    expect(screen.getByText('Participant program-A')).toBeInTheDocument()
  })

  it.each([false,true])('offers only Participants and Sessions with offline=%s',async offline=>{
    fixture.width=522;fixture.offline=offline
    render(<ProgramDetailPage/>);
    expect(await screen.findByText('Participant program-A')).toBeInTheDocument()
    const sections=screen.getByRole('tablist',{name:'Secciones del programa'})
    expect(sections.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(screen.getByRole('tab',{name:'Participantes'})).toBeInTheDocument()
    expect(screen.queryByRole('button',{name:/Exportar participantes/})).not.toBeInTheDocument()
    expect(screen.queryByRole('button',{name:/Agregar/})).not.toBeInTheDocument()
    expect(screen.queryByRole('button',{name:/Plan e instructores|Estadísticas|Encuestas/})).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab',{name:'Sesiones'}))
    expect(screen.getByText('Sesiones y Asistencia')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab',{name:'Participantes'}))
    expect(screen.getByText('Participant program-A')).toBeInTheDocument()
  })

  it('does not reintroduce enrollment in an empty mobile roster',async()=>{
    fixture.width=522
    const normalAPI=fixture.api.getMockImplementation()!
    fixture.api.mockImplementation(async(endpoint:string)=>{
      if(endpoint.endsWith('/participants'))return {success:true,data:[]}
      if(endpoint.endsWith('/health'))return {success:true,data:{success:true,health:{...health('program-A'),active_count:0,participants:[]}}}
      return normalAPI(endpoint)
    })
    render(<ProgramDetailPage/>);
    expect(await screen.findByText('Sin inscritos para evaluar')).toBeInTheDocument()
    expect(screen.getByText('Puedes agregar participantes desde la vista de escritorio.')).toBeInTheDocument()
    expect(screen.queryByRole('button',{name:/Agregar/})).not.toBeInTheDocument()
  })

  it('suspends desktop Plan without losing its draft when mobile tabs change',async()=>{
    const view=render(<ProgramDetailPage/>);
    expect(await screen.findByText('Group program-A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Plan e instructores'}))
    fireEvent.change(screen.getByLabelText('Academic draft'),{target:{value:'Unsaved plan'}})
    const original=screen.getByTestId('retained-academic')
    fixture.width=522;view.rerender(<ProgramDetailPage/>);
    expect(screen.queryByRole('textbox',{name:'Academic draft'})).not.toBeInTheDocument()
    expect(original).toHaveAttribute('data-suspended','true')
    fireEvent.click(screen.getByRole('tab',{name:'Sesiones'}))
    expect(screen.getByText('Sesiones y Asistencia')).toBeInTheDocument()
    expect(screen.queryByText(/Si cambias de sección, se perderán/)).not.toBeInTheDocument()
    fixture.width=1100;view.rerender(<ProgramDetailPage/>);
    expect(screen.getByLabelText('Academic draft')).toHaveValue('Unsaved plan')
    expect(screen.getByTestId('retained-academic')).toBe(original)
    expect(fixture.api.mock.calls.some(([,options])=>options?.method==='PUT'||options?.method==='POST')).toBe(false)
  })

  it('keeps enrollment open and preserves its draft through resize and mobile Escape',async()=>{
    const view=render(<ProgramDetailPage/>);
    expect(await screen.findByText('Participant program-A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Agregar'}))
    fireEvent.change(screen.getByLabelText('Enrollment draft'),{target:{value:'Chosen contact'}})
    fixture.width=522;view.rerender(<ProgramDetailPage/>);
    expect(screen.queryByRole('textbox',{name:'Enrollment draft'})).not.toBeInTheDocument()
    fireEvent.keyDown(window,{key:'Escape'})
    fixture.width=1100;view.rerender(<ProgramDetailPage/>);
    expect(screen.getByLabelText('Enrollment draft')).toHaveValue('Chosen contact')
  })

  it('drops a suspended draft when the account changes',async()=>{
    const view=render(<ProgramDetailPage/>);
    expect(await screen.findByText('Group program-A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Plan e instructores'}))
    fireEvent.change(screen.getByLabelText('Academic draft'),{target:{value:'Private account A draft'}})
    fixture.width=522;view.rerender(<ProgramDetailPage/>);
    fixture.account='account-b';view.rerender(<ProgramDetailPage/>);
    expect(await screen.findByText('Participant program-A')).toBeInTheDocument()
    fixture.width=1100;view.rerender(<ProgramDetailPage/>);
    fireEvent.click(screen.getByRole('button',{name:'Plan e instructores'}))
    expect(screen.getByLabelText('Academic draft')).toHaveValue('')
  })
})


describe('Program suspended statistics',()=>{
  it('aborts a hidden stats read and rejects JSON completing after cancellation',async()=>{
    let oldJson!:(value:unknown)=>void
    let newJson!:(value:unknown)=>void
    let oldSignal:AbortSignal|undefined
    let count=0
    const normalFetch=vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async(input,options)=>{
      if(String(input).includes('/attendance-stats')){
        count+=1
        if(count===1)oldSignal=options?.signal as AbortSignal
        return {ok:true,json:()=>new Promise(resolve=>{if(count===1)oldJson=resolve;else newJson=resolve})} as Response
      }
      return normalFetch(input,options)
    })
    const view=render(<ProgramDetailPage/>);
    expect(await screen.findByText('Group program-A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Estadísticas'}))
    await waitFor(()=>expect(oldJson).toBeTypeOf('function'))
    fixture.width=522;view.rerender(<ProgramDetailPage/>);
    expect(oldSignal?.aborted).toBe(true)
    await act(async()=>oldJson({success:true,session_stats:[],participant_stats:[{participant_id:'stale',name:'Stale stats participant',marked_sessions:1,present:1,rate:100}]}))
    fixture.width=1100;view.rerender(<ProgramDetailPage/>);
    await waitFor(()=>expect(newJson).toBeTypeOf('function'))
    expect(screen.queryByText('Stale stats participant')).not.toBeInTheDocument()
    await act(async()=>newJson({success:true,session_stats:[],participant_stats:[]}))
    expect(await screen.findByText('Sin datos de asistencia')).toBeInTheDocument()
  })
})


describe('Program responsive compatibility',()=>{
  it('preserves enrollment from an empty legacy mobile roster without desktop-only guidance',async()=>{
    const normalAPI=fixture.api.getMockImplementation()!
    fixture.api.mockImplementation(async(endpoint:string)=>{
      if(endpoint.endsWith('/participants'))return {success:true,data:[]}
      const response=await normalAPI(endpoint)
      return endpoint==='/api/programs/program-A'?{...response,data:{...response.data,type:'event'}}:response
    })
    const view=render(<ProgramDetailPage/>);
    expect(await screen.findByText('Group program-A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Participantes (0)'}))
    fixture.width=522;view.rerender(<ProgramDetailPage/>);
    expect(screen.getByText('Sin participantes')).toBeInTheDocument()
    expect(screen.queryByText('Puedes agregar participantes desde la vista de escritorio.')).not.toBeInTheDocument()
    const addButtons=screen.getAllByRole('button',{name:'Agregar participantes'})
    expect(addButtons).toHaveLength(2)
    fireEvent.click(addButtons[1])
    expect(screen.getByLabelText('Enrollment draft')).toBeInTheDocument()
  })

  it('keeps a tablet in desktop mode while only the visual viewport is reduced by its keyboard',async()=>{
    fixture.width=900
    vi.stubGlobal('innerHeight',800)
    vi.stubGlobal('visualViewport',Object.assign(new EventTarget(),{height:430,width:900,offsetTop:0,offsetLeft:0}))
    window.matchMedia=vi.fn(()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()})) as any
    render(<ProgramDetailPage/>);
    expect(await screen.findByRole('button',{name:'Plan e instructores'})).toBeInTheDocument()
    expect(screen.queryByRole('tablist',{name:'Secciones del programa'})).not.toBeInTheDocument()
    expect(screen.getByRole('button',{name:'Exportar participantes filtrados a Excel'})).toBeInTheDocument()
  })

  it('preserves legacy event-shaped Program controls independently of the new class policy',async()=>{
    const normalAPI=fixture.api.getMockImplementation()!
    fixture.api.mockImplementation(async(endpoint:string)=>{
      const response=await normalAPI(endpoint)
      return endpoint==='/api/programs/program-A'?{...response,data:{...response.data,type:'event'}}:response
    })
    const view=render(<ProgramDetailPage/>);
    expect(await screen.findByText('Group program-A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:'Participantes (1)'}))
    fixture.width=522;view.rerender(<ProgramDetailPage/>);
    expect(screen.getByRole('button',{name:'Agregar participantes'})).toBeInTheDocument()
    expect(screen.getByRole('button',{name:'Exportar participantes filtrados a Excel'})).toBeInTheDocument()
    expect(screen.getByRole('button',{name:/Cambiar sección/})).toBeInTheDocument()
  })
})
