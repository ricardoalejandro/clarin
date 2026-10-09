import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
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
 it('removes a chat after its last matching reaction is removed',async()=>{
  let matches=true;
  const fetchMock=vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);
   if(url.startsWith('/api/chats?'))return Promise.resolve(json({success:true,chats:!url.includes('has_reaction')||matches?[chat]:[],total:!url.includes('has_reaction')||matches?1:0}));
   if(url==='/api/me')return Promise.resolve(json({success:true,user:{id:'user-audit',account_id:'account-audit'}}));
   return Promise.resolve(json({success:true,devices:[]}));
  });
  vi.stubGlobal('fetch',fetchMock);render(<ChatsPage/>);
  await screen.findByText('Nombre filtro QA');fireEvent.click(screen.getByTestId('filter-reaction-toggle'));
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
   const url=String(input);if(url.startsWith('/api/chats?')) {const params=new URL(url,'http://test.invalid').searchParams;pages.push(url);const offset=Number(params.get('offset')||0);return Promise.resolve(json({success:true,chats:canonical.slice(offset,offset+50),total:canonical.length}))}
   return Promise.resolve(json({success:true,devices:[]}));
  }));
  render(<ChatsPage/>);await screen.findByText('Nombre000');
  const scroller=screen.getByText('Nombre000').closest('.overflow-y-auto')!;fireEvent.scroll(scroller);
  const tail=await screen.findByText('Nombre099');canonical=rows.slice(1);
  await act(async()=>{emit('contact_update',{contact_id:'audit'});await new Promise(r=>setTimeout(r,450))});
  expect(screen.queryByText('Nombre000')).toBeNull();expect(screen.getByText('Nombre099')).toBe(tail);
  expect(pages.slice(-2).map(url=>new URL(url,'http://test.invalid').searchParams.get('offset'))).toEqual(['0','50']);
  expect(pages.every(url=>new URL(url,'http://test.invalid').searchParams.get('limit')==='50')).toBe(true);
 });
 it.each([{chat_ids:[chat.id]},{all:true}])('removes a remotely deleted chat and rejects a stale HTTP row: %j',async(payload)=>{
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>Promise.resolve(json(String(input).startsWith('/api/chats?')?{success:true,chats:[chat],total:1}:{success:true,devices:[]}))));
  render(<ChatsPage/>);await screen.findByText('Nombre filtro QA');
  await act(async()=>{emit('chat_deleted',payload);emit('chat_deleted',payload);await new Promise(r=>setTimeout(r,450))});
  expect(screen.queryByText('Nombre filtro QA')).toBeNull();
 });
});
