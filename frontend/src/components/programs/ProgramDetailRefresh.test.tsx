import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import ProgramDetailPage from '@/app/dashboard/programs/[id]/page'
const fixture=vi.hoisted(()=>({id:'program-A',account:'account',api:vi.fn(),wsCallback:null as null|((message:unknown)=>void),router:{push:vi.fn(),replace:vi.fn()},resolveOld:null as null|((r:any)=>void),delay:false}))
vi.mock('next/navigation',()=>({useParams:()=>({id:fixture.id}),useRouter:()=>fixture.router}))
vi.mock('@/lib/api',()=>({api:fixture.api,subscribeWebSocket:(callback:(message:unknown)=>void)=>{fixture.wsCallback=callback;return ()=>{fixture.wsCallback=null}}}))
vi.mock('@/lib/offlineCanonicalRoute',()=>({canonicalResourceID:(x:string)=>x}))
vi.mock('@/components/offline-v5/ClarinRuntimeProvider',()=>({useClarinRuntime:()=>({isOffline:false,requireOnline:()=>true,snapshot:{accountId:fixture.account}})}))
vi.mock('@/components/responsive/useContainerWidth',()=>({useContainerWidth:()=>({ref:{current:null},width:1100})}))
vi.mock('@/hooks/useWhatsAppChatLauncher',()=>({default:()=>({pending:false,error:'',reset:vi.fn(),close:vi.fn(),open:vi.fn()})}))
vi.mock('@/components/ContactSelector',()=>({default:()=>null}))
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
vi.mock('@/components/programs/ProgramAcademicConfigPanel',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramSurveyPanel',()=>({default:()=>null}))
vi.mock('@/components/programs/SessionTopicField',()=>({default:()=>null,normalizedSessionTopics:()=>[],pendingActiveCourseTopics:()=>[]}))
vi.mock('@/components/programs/SessionObservationPanel',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramSettingsDialog',()=>({ProgramSettingsDialog:()=>null}))
vi.mock('@/components/programs/ProgramAttendanceRoster',()=>({default:()=>null}))
vi.mock('@/components/programs/ProgramAttendanceSearchBar',()=>({default:()=>null}))
const health=(id:string)=>({program_id:id,as_of_date:'2026-10-08',active_count:1,health:'healthy',attendance_rate:id==='program-A'?100:0,participants:[{participant_id:id+'-participant',contact_id:id+'-contact',name:'Participant '+id,phone:'',status:'active',enrolled_at:'2026-01-01',attendance_rate:id==='program-A'?100:0,eligible_sessions:1,marked_sessions:1,health:'healthy',reasons:[],present:1,absent:0,late:0}]})
beforeEach(()=>{
fixture.id='program-A';fixture.account='account';fixture.delay=false;fixture.resolveOld=null;fixture.api.mockReset()
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
return {success:true,data:{id,account_id:'account',type:'course',status:'active',name:'Group '+id,updated_at:'2026-10-08T10:00:00Z',health_view_columns:['attendance','health']}}
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
