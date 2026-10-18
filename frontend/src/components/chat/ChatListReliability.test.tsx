import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const socket=vi.hoisted(()=>({listeners:new Set<(x:unknown)=>void>(),setActive:vi.fn()}));
vi.mock('@/lib/api',()=>({subscribeWebSocket:vi.fn((listener:(x:unknown)=>void)=>{socket.listeners.add(listener);return ()=>socket.listeners.delete(listener)})}));
vi.mock('@/components/chat/ChatMobileChromeContext',()=>({announceChatConversationActive:vi.fn(),useChatMobileChrome:()=>({setConversationActive:socket.setActive})}));
vi.mock('@/components/chat/DeviceSelector',()=>({default:()=>null}));
vi.mock('@/components/chat/NewChatModal',()=>({default:()=>null}));
vi.mock('@/components/chat/OwnStatusesCenter',()=>({default:()=>null}));
vi.mock('@/components/chat/ContactPanel',()=>({default:()=>null}));
vi.mock('@/components/chat/ChatPanel',()=>({default:()=>null}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,getItemKey}:{count:number;getItemKey:(index:number)=>string})=>({getTotalSize:()=>count*80,getVirtualItems:()=>Array.from({length:count},(_,index)=>({index,key:getItemKey(index),start:index*80,size:80,end:(index+1)*80})),measureElement:vi.fn()})}));
import ChatsPage from '@/app/dashboard/chats/page';
const chat={id:'chat-audit',name:'Nombre filtro QA',contact_name:'Nombre filtro QA',jid:'51999990001@s.whatsapp.net',device_id:'device-audit',last_message:'Audit',last_message_at:'2026-10-07T00:00:00Z',unread_count:0,state_version:1,needs_reply:false};
function json(body:unknown){return {ok:true,status:200,json:()=>Promise.resolve(body)} as Response};
function emit(event:string,data:unknown){socket.listeners.forEach(l=>l({event,data}))};
describe('Chat list canonical membership',()=>{
 beforeEach(()=>{localStorage.clear();localStorage.setItem('token','synthetic-audit-token');socket.listeners.clear();vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:1440,height:900,top:0,bottom:900,left:0,right:1440,x:0,y:0,toJSON(){}})});
 afterEach(()=>{cleanup();vi.unstubAllGlobals();socket.listeners.clear()});
 it('keeps unread counts and inbox filters without repeated pending labels on rows',async()=>{
  const rows=[
   {...chat,id:'pending-read',name:'Pendiente ya leído',contact_name:'Pendiente ya leído',needs_reply:true,waiting_since:'2026-10-01T12:00:00Z'},
   {...chat,id:'pending-unread',name:'Pendiente sin leer',contact_name:'Pendiente sin leer',needs_reply:true,unread_count:3,waiting_since:'2026-10-02T12:00:00Z'},
   {...chat,id:'attended',name:'Conversación atendida',contact_name:'Conversación atendida'},
  ];
  const requests:URLSearchParams[]=[];
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);
   if(url.startsWith('/api/chats?')){
    const params=new URL(url,'http://test.invalid').searchParams;requests.push(params);
    const visible=params.has('pending_only')?rows.filter(row=>row.needs_reply):params.has('unread_only')?rows.filter(row=>row.unread_count>0):rows;
    return Promise.resolve(json({success:true,chats:visible,total:visible.length}));
   }
   return Promise.resolve(json({success:true,devices:[]}));
  }));
  render(<ChatsPage/>);
  const unread=await screen.findByRole('button',{name:'Conversación con Pendiente sin leer'});
  expect(within(unread).getByText('3')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Conversación con Pendiente ya leído'})).toBeInTheDocument();
  expect(screen.queryByText('Leído · pendiente')).not.toBeInTheDocument();
  expect(screen.queryByText('Pendiente de atención')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/^Pendientes$/}));
  await waitFor(()=>expect(requests.at(-1)?.get('pending_only')).toBe('true'));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Conversación con Conversación atendida'})).not.toBeInTheDocument());
  expect(screen.getByRole('button',{name:/^Pendientes$/})).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('button',{name:'Conversación con Pendiente ya leído'})).toBeInTheDocument();
  expect(within(screen.getByRole('button',{name:'Conversación con Pendiente sin leer'})).getByText('3')).toBeInTheDocument();
  expect(screen.queryByText('Leído · pendiente')).not.toBeInTheDocument();
  expect(screen.queryByText('Pendiente de atención')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/^No leídos$/}));
  await waitFor(()=>expect(requests.at(-1)?.get('unread_only')).toBe('true'));
  expect(requests.at(-1)?.has('pending_only')).toBe(false);
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Conversación con Pendiente ya leído'})).not.toBeInTheDocument());
  expect(within(screen.getByRole('button',{name:'Conversación con Pendiente sin leer'})).getByText('3')).toBeInTheDocument();
 });
 it('leaves pending mode for groups and keeps unread filtering available',async()=>{
  const requests:URLSearchParams[]=[];
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);
   if(url.startsWith('/api/chats?')) {requests.push(new URL(url,'http://test.invalid').searchParams);return Promise.resolve(json({success:true,chats:[chat],total:1}))}
   return Promise.resolve(json({success:true,devices:[]}));
  }));
  render(<ChatsPage/>);
  await screen.findByText('Nombre filtro QA');
  const pending=screen.getByRole('button',{name:'Pendientes'});
  fireEvent.click(pending);
  await waitFor(()=>expect(requests.at(-1)?.get('pending_only')).toBe('true'));
  fireEvent.click(screen.getByRole('button',{name:/^Tipo de conversación:/}));
  fireEvent.click(screen.getByRole('menuitemradio',{name:'Grupos'}));
  await waitFor(()=>expect(requests.at(-1)?.get('kind')).toBe('group'));
  expect(requests.at(-1)?.has('pending_only')).toBe(false);
  expect(requests.some(params=>params.get('kind')==='group'&&params.has('pending_only'))).toBe(false);
  expect(pending).toBeDisabled();
  expect(pending).toHaveAccessibleDescription('Los grupos no generan pendientes.');
  const inbox=screen.getByRole('group',{name:'Vista de la bandeja'});
  expect(within(inbox).getByRole('button',{name:'Todos'})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(within(inbox).getByRole('button',{name:'No leídos'}));
  await waitFor(()=>expect(requests.at(-1)?.get('unread_only')).toBe('true'));
  expect(requests.at(-1)?.get('kind')).toBe('group');
  fireEvent.click(screen.getByRole('button',{name:'Abrir filtros de chats'}));
  fireEvent.click(screen.getByTestId('mobile-filter-reaction-toggle'));
  expect(screen.getByRole('button',{name:'Otros'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Mi número'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Cancelar'}));
  fireEvent.click(screen.getByRole('button',{name:/^Tipo de conversación:/}));
  fireEvent.click(screen.getByRole('menuitemradio',{name:'Individuales'}));
  expect(pending).toBeEnabled();
  expect(screen.queryByText('Los grupos no generan pendientes.')).not.toBeInTheDocument();
 });
 it.each([false,true])('honors the group discovery capability in secondary actions: %s',async(capability)=>{
  const fetchMock=vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);
   if(url==='/api/devices') return Promise.resolve(json({success:true,devices:[{id:'device-audit',name:'Canal QA',status:'connected',provider:'whatsapp_web',runtime_capabilities:{can_list_groups:capability}}]}));
   return Promise.resolve(json(url.startsWith('/api/chats?')?{success:true,chats:[chat],total:1}:{success:true,synced:1}));
  });
  vi.stubGlobal('fetch',fetchMock);render(<ChatsPage/>);await screen.findByText('Nombre filtro QA');
  expect(screen.queryByRole('menuitem',{name:/Actualizar grupos de WhatsApp/})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Más acciones de chats'}));
  const sync=screen.getByRole('menuitem',{name:/Actualizar grupos de WhatsApp/});
  if(!capability){expect(sync).toBeDisabled();expect(sync).toHaveAccessibleDescription('La sincronización de grupos no está disponible para estos dispositivos.');return}
  expect(sync).toBeEnabled();fireEvent.click(sync);
  await waitFor(()=>expect(fetchMock.mock.calls.some(([input])=>String(input)==='/api/devices/device-audit/groups/sync')).toBe(true));
 });
 it('removes a chat after its last matching reaction is removed',async()=>{
  let matches=true;
  const fetchMock=vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);
   if(url.startsWith('/api/chats?'))return Promise.resolve(json({success:true,chats:!url.includes('has_reaction')||matches?[chat]:[],total:!url.includes('has_reaction')||matches?1:0}));
   if(url==='/api/me')return Promise.resolve(json({success:true,user:{id:'user-audit',account_id:'account-audit'}}));
   return Promise.resolve(json({success:true,devices:[]}));
  });
  vi.stubGlobal('fetch',fetchMock);render(<ChatsPage/>);
  await screen.findByText('Nombre filtro QA');
  expect(screen.queryByText('Con reacción')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Abrir filtros de chats'}));
  fireEvent.click(screen.getByTestId('mobile-filter-reaction-toggle'));
  fireEvent.click(screen.getByRole('button',{name:'Aplicar'}));
  await waitFor(()=>expect(fetchMock.mock.calls.some(([url])=>String(url).includes('has_reaction=true'))).toBe(true));
  const calls=fetchMock.mock.calls.length;matches=false;
  await act(async()=>{emit('chat_update',{chat_id:chat.id,unread_count:0,needs_reply:false,waiting_since:null,state_version:1});emit('message_reaction',{chat_id:chat.id,target_message_id:'provider-audit',removed:true,emoji:'',is_from_me:false,timestamp:'2026-10-08T00:00:00Z'});await new Promise(r=>setTimeout(r,450))});
  expect(screen.queryByText('Nombre filtro QA')).toBeNull();expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
 });
 it('removes a chat excluded by the canonical search snapshot',async()=>{
  let matches=true;let reconciliations=0;
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);if(url.startsWith('/api/chats?')) {reconciliations++;return Promise.resolve(json({success:true,chats:matches?[chat]:[],total:matches?1:0}))}
   if(url==='/api/me')return Promise.resolve(json({success:true,user:{id:'user-audit',account_id:'account-audit'}}));
   return Promise.resolve(json({success:true,devices:[]}));
  }));
  render(<ChatsPage/>);await screen.findByText('Nombre filtro QA');
  fireEvent.change(screen.getByPlaceholderText('Buscar chats...'),{target:{value:'Nombre filtro'}});
  await act(async()=>{await new Promise(r=>setTimeout(r,650))});
  const calls=reconciliations;matches=false;
  await act(async()=>{emit('contact_update',{contact_id:'contact-audit',name:'Nombre nuevo'});await new Promise(r=>setTimeout(r,450))});
  expect(reconciliations).toBe(calls+1);expect(screen.queryByText('Nombre filtro QA')).toBeNull();
 });
});

describe('Chat list loaded window and remote deletion',()=>{
 beforeEach(()=>{localStorage.clear();socket.listeners.clear();vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:1440,height:900,top:0,bottom:900,left:0,right:1440,x:0,y:0,toJSON(){}})});
 afterEach(()=>{cleanup();vi.unstubAllGlobals();socket.listeners.clear()});
 it('revalidates all loaded pages in bounded requests and preserves retained row nodes',async()=>{
  const rows=Array.from({length:100},(_,index)=>({...chat,id:`chat-${index}`,name:`Nombre${String(index).padStart(3,'0')}`,contact_name:`Nombre${String(index).padStart(3,'0')}`}));
  let canonical=rows;const pages:string[]=[];
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);if(url.startsWith('/api/chats?')) {const params=new URL(url,'http://test.invalid').searchParams;pages.push(url);const offset=Number(params.get('cursor')||0);return Promise.resolve(json({success:true,chats:canonical.slice(offset,offset+50),total:canonical.length,next_cursor:offset+50<canonical.length?String(offset+50):''}))}
   return Promise.resolve(json({success:true,devices:[]}));
  }));
  render(<ChatsPage/>);await screen.findByText('Nombre000');
  const scroller=screen.getByText('Nombre000').closest('.overflow-y-auto')!;fireEvent.scroll(scroller);
  const tail=await screen.findByText('Nombre099');canonical=rows.slice(1);
  await act(async()=>{emit('contact_update',{contact_id:'audit'});await new Promise(r=>setTimeout(r,450))});
  expect(screen.queryByText('Nombre000')).toBeNull();expect(screen.getByText('Nombre099')).toBe(tail);
  expect(pages.slice(-2).map(url=>new URL(url,'http://test.invalid').searchParams.get('cursor'))).toEqual([null,'50']);
  expect(pages.every(url=>new URL(url,'http://test.invalid').searchParams.get('limit')==='50')).toBe(true);
 }, 15000);
 it.each([{chat_ids:[chat.id]},{all:true}])('removes a remotely deleted chat and rejects a stale HTTP row: %j',async(payload)=>{
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>Promise.resolve(json(String(input).startsWith('/api/chats?')?{success:true,chats:[chat],total:1}:{success:true,devices:[]}))));
  render(<ChatsPage/>);await screen.findByText('Nombre filtro QA');
  await act(async()=>{emit('chat_deleted',payload);emit('chat_deleted',payload);await new Promise(r=>setTimeout(r,450))});
  expect(screen.queryByText('Nombre filtro QA')).toBeNull();
 });
});
