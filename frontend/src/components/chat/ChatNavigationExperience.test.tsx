import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const socket=vi.hoisted(()=>({listeners:new Set<(x:unknown)=>void>(),setActive:vi.fn()}));
vi.mock('@/lib/api',()=>({subscribeWebSocket:vi.fn((listener:(x:unknown)=>void)=>{socket.listeners.add(listener);return ()=>socket.listeners.delete(listener)})}));
vi.mock('@/components/chat/ChatMobileChromeContext',()=>({announceChatConversationActive:vi.fn(),useChatMobileChrome:()=>({setConversationActive:socket.setActive})}));
vi.mock('@/components/chat/DeviceSelector',()=>({default:()=>null}));
vi.mock('@/components/chat/NewChatModal',()=>({default:({isOpen,onClose,onChatCreated}:any)=>isOpen?<button onClick={()=>{onChatCreated('chat-created');onClose()}}>Crear QA</button>:null}));
vi.mock('@/components/chat/OwnStatusesCenter',()=>({default:()=>null}));
vi.mock('@/components/chat/ContactPanel',()=>({default:()=>null}));
vi.mock('@/components/chat/ChatPanel',()=>({default:({chatId,onNext,onRead,onClose,onContactInfoToggle}:any)=><section aria-label="Panel de prueba"><span>{chatId}</span><button onClick={onNext}>Siguiente QA</button><button onClick={onClose}>Volver QA</button><button onClick={()=>onContactInfoToggle(true)}>Detalles QA</button><button onClick={()=>onRead(chatId,0,{chat_id:chatId,unread_count:0,needs_reply:true,state_version:3})}>Leer QA</button></section>}));
vi.mock('@tanstack/react-virtual',()=>({useVirtualizer:({count,getItemKey}:{count:number;getItemKey:(index:number)=>string})=>({getTotalSize:()=>count*80,getVirtualItems:()=>Array.from({length:count},(_,index)=>({index,key:getItemKey(index),start:index*80,size:80,end:(index+1)*80})),measureElement:vi.fn()})}));
import ChatsPage from '@/app/dashboard/chats/page';
const chat={id:'chat-audit',name:'Nombre filtro QA',contact_name:'Nombre filtro QA',jid:'51999990001@s.whatsapp.net',device_id:'device-audit',last_message:'Audit',last_message_at:'2026-10-07T00:00:00Z',unread_count:0,state_version:1,needs_reply:false};
function json(body:unknown){return {ok:true,status:200,json:()=>Promise.resolve(body)} as Response};
function emit(event:string,data:unknown){socket.listeners.forEach(l=>l({event,data}))};

const pendingA={...chat,id:'chat-a',name:'Persona A',contact_name:'Persona A',needs_reply:true,unread_count:1,waiting_since:'2026-10-01T12:00:00Z'};
const pendingB={...pendingA,id:'chat-b',name:'Persona B',contact_name:'Persona B',waiting_since:'2026-10-02T12:00:00Z'};
describe('Android navigation and staged filters',()=>{
 beforeEach(()=>{localStorage.clear();window.history.replaceState({},'', '/dashboard/chats');socket.listeners.clear();vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:375,height:800,top:0,bottom:800,left:0,right:375,x:0,y:0,toJSON(){}})});
 afterEach(()=>{cleanup();vi.unstubAllGlobals();socket.listeners.clear()});
 function install(next?:(url:string)=>Promise<Response>|undefined){
  const requests:string[]=[];
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);requests.push(url);const result=next?.(url);if(result)return result;
   if(url.startsWith('/api/chats?'))return Promise.resolve(json({success:true,chats:[pendingA,pendingB],total:2}));
   if(url==='/api/chats/chat-a')return Promise.resolve(json({success:true,chat:pendingA}));
   return Promise.resolve(json({success:true,devices:[]}));
  }));return requests;
 }
 it('does not query while editing filters; Cancel preserves applied state and Apply commits once',async()=>{
  const requests=install();render(<ChatsPage/>);await screen.findByText('Persona A');
  fireEvent.click(screen.getByRole('button',{name:'Abrir filtros de chats'}));const before=requests.filter(url=>url.startsWith('/api/chats?')).length;
  fireEvent.click(screen.getByTestId('mobile-filter-reaction-toggle'));await act(async()=>{await new Promise(r=>setTimeout(r,20))});
  expect(requests.filter(url=>url.startsWith('/api/chats?'))).toHaveLength(before);
  fireEvent.click(screen.getByText('Cancelar'));await act(async()=>{await new Promise(r=>setTimeout(r,20))});
  expect(requests.filter(url=>url.startsWith('/api/chats?'))).toHaveLength(before);
  fireEvent.click(screen.getByRole('button',{name:'Abrir filtros de chats'}));fireEvent.click(screen.getByTestId('mobile-filter-reaction-toggle'));fireEvent.click(screen.getByText('Aplicar'));
  await waitFor(()=>expect(requests.filter(url=>url.startsWith('/api/chats?'))).toHaveLength(before+1));
  expect(requests.filter(url=>url.startsWith('/api/chats?')).at(-1)).toContain('has_reaction=true');
 });
 it('replaces the conversation history when advancing and restores it even outside the current filtered list',async()=>{
  install();render(<ChatsPage/>);fireEvent.click(await screen.findByRole('button',{name:'Conversación con Persona A'}));
  expect(window.history.state.clarinChatId).toBe('chat-a');
  fireEvent.click(screen.getByText('Siguiente QA'));await waitFor(()=>expect(window.history.state.clarinChatId).toBe('chat-b'));
  fireEvent.click(screen.getByText('Detalles QA'));expect(window.history.state.clarinChatSurface).toBe('details');
  await act(async()=>{window.history.back();await new Promise(r=>setTimeout(r,20))});
  expect(window.history.state.clarinChatId).toBe('chat-b');expect(screen.getByLabelText('Panel de prueba')).toHaveTextContent('chat-b');
 });
 it('ignores a next-pending request completed after Back',async()=>{
  let finish!:(response:Response)=>void;let hold=false;
  install(url=>url.startsWith('/api/chats?')&&hold?new Promise<Response>(resolve=>{finish=resolve}):undefined);
  render(<ChatsPage/>);fireEvent.click(await screen.findByRole('button',{name:'Conversación con Persona A'}));hold=true;fireEvent.click(screen.getByText('Siguiente QA'));
  fireEvent.click(screen.getByText('Volver QA'));await waitFor(()=>expect(window.history.state.clarinChatId).toBeUndefined());await act(async()=>{finish(json({success:true,chats:[pendingB],total:1}))});
  expect(window.history.state.clarinChatId).toBeUndefined();expect(screen.getByLabelText('Panel de prueba')).toHaveTextContent('chat-a');expect(screen.getByLabelText('Panel de prueba').parentElement).toHaveClass('hidden');
 });
 it('builds a Back-to-list entry for a direct link in an empty inbox',async()=>{
  window.history.replaceState({},'', '/dashboard/chats?open=chat-a');install(url=>url.startsWith('/api/chats?')?Promise.resolve(json({success:true,chats:[],total:0})):undefined);
  render(<ChatsPage/>);await waitFor(()=>expect(window.history.state.clarinChatId).toBe('chat-a'));
  expect(screen.getByLabelText('Panel de prueba')).toHaveTextContent('chat-a');
  fireEvent.click(screen.getByText('Volver QA'));await act(async()=>{await new Promise(r=>setTimeout(r,20))});expect(window.history.state.clarinChatId).toBeUndefined();
 });
 it('ignores a pending Next response when details have been opened',async()=>{
  let finish!:(response:Response)=>void;let hold=false;
  install(url=>url.startsWith('/api/chats?')&&hold?new Promise<Response>(resolve=>{finish=resolve}):undefined);
  render(<ChatsPage/>);fireEvent.click(await screen.findByRole('button',{name:'Conversación con Persona A'}));hold=true;fireEvent.click(screen.getByText('Siguiente QA'));
  fireEvent.click(screen.getByText('Detalles QA'));await act(async()=>{finish(json({success:true,chats:[pendingB],total:1}))});
  expect(window.history.state.clarinChatSurface).toBe('details');expect(screen.getByLabelText('Panel de prueba')).toHaveTextContent('chat-a');
 });
 it('keeps the same panel mounted when closing and reopening on desktop',async()=>{
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({width:1440,height:900,top:0,bottom:900,left:0,right:1440,x:0,y:0,toJSON(){}});
  install();render(<ChatsPage/>);fireEvent.click(await screen.findByRole('button',{name:'Conversación con Persona A'}));
  const panel=screen.getByLabelText('Panel de prueba');fireEvent.click(screen.getByText('Volver QA'));
  expect(panel.parentElement).toHaveClass('hidden');expect(screen.getByText('Selecciona una conversación')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Conversación con Persona A'}));expect(screen.getByLabelText('Panel de prueba')).toBe(panel);expect(panel.parentElement).not.toHaveClass('hidden');
 });
 it('does not reopen a newly created chat after the user selects another conversation',async()=>{
  let finish!:(response:Response)=>void;
  install(url=>url==='/api/chats/chat-created'?new Promise<Response>(resolve=>{finish=resolve}):undefined);
  render(<ChatsPage/>);await screen.findByRole('button',{name:'Conversación con Persona A'});
  fireEvent.click(screen.getByRole('button',{name:'Nuevo chat'}));fireEvent.click(screen.getByText('Crear QA'));
  fireEvent.click(screen.getByRole('button',{name:'Conversación con Persona A'}));
  await act(async()=>{finish(json({success:true,chat:{...pendingB,id:'chat-created'}}))});
  expect(screen.getByLabelText('Panel de prueba')).toHaveTextContent('chat-a');
 });
});
