import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat, Device } from '@/types/chat'

const websocket = vi.hoisted(() => ({ listeners: new Set<(data: unknown) => void>() }))

vi.mock('@/lib/api', () => ({
  subscribeWebSocket: vi.fn((listener: (data: unknown) => void) => {
    websocket.listeners.add(listener)
    return () => { websocket.listeners.delete(listener) }
  }),
}))

vi.mock('@/components/WhatsAppTextInput', async () => {
  const { forwardRef, useEffect, useImperativeHandle, useRef } = await import('react')
  return {
    default: forwardRef<unknown, { placeholder?: string; value?: string; onChange?: (value: string) => void }>(function MockWhatsAppTextInput({ placeholder, value = '', onChange }, ref) {
      const input = useRef<HTMLTextAreaElement>(null)
      useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), clear: () => { if (input.current) input.current.value = '' } }), [])
      useEffect(() => { if (input.current) input.current.value = value }, [value])
      return <div data-testid="chat-composer">{placeholder}<textarea ref={input} aria-label="Draft test editor" onChange={event => onChange?.(event.target.value)} /></div>
    }),
  }
})
vi.mock('@/components/chat/MessageBubble', () => ({
  default: ({ message, onDocumentClick, onReact, onSelect, onRetry }: { message: { body?: string; quoted_body?: string; status?: string; is_revoked?: boolean; reactions?: Array<{ emoji: string; is_from_me: boolean }> }; onDocumentClick?: (document: { sessionId: string; src: string; filename: string; mimeType: string; size: number }) => void; onReact?: (message: unknown, emoji: string) => void; onSelect?: (message: unknown) => void; onRetry?: (message: unknown) => void }) => (
    <div data-testid="message-bubble">
      <span data-testid="message-body">{message.body}</span><span>{message.quoted_body}</span><span data-testid="message-status">{message.status}</span><span data-testid="message-revoked">{String(message.is_revoked)}</span>
      <span data-testid="own-reaction">{message.reactions?.find(reaction => reaction.is_from_me)?.emoji || ''}</span>
      <span data-testid="contact-reaction">{message.reactions?.find(reaction => !reaction.is_from_me)?.emoji || ''}</span>
      <button type="button" onClick={() => onRetry?.(message)} disabled={!onRetry}>Reintentar mensaje simulado</button><button type="button" onClick={() => onReact?.(message, '👍')} disabled={!onReact}>Reaccionar con 👍</button>
      {onDocumentClick && <button type="button" onClick={() => onDocumentClick({ sessionId: 'document-session-1', src: '/api/media/document.pdf', filename: 'Documento QA.pdf', mimeType: 'application/pdf', size: 2048 })}>Abrir documento simulado</button>}
      {onSelect && <button type="button" onClick={() => onSelect(message)}>Seleccionar mensaje</button>}
    </div>
  ),
}))
vi.mock('@/components/chat/EmojiPicker', () => ({ default: () => null }))
vi.mock('@/components/chat/StickerPicker', () => ({ default: ({onStickerSelect}: {onStickerSelect:(url:string)=>void}) => <button onClick={()=>onStickerSelect('/api/media/file/account-audit/saved.webp')}>Enviar sticker guardado simulado</button> }))
vi.mock('@/components/chat/MobileComposerAccessory', () => ({ default: () => null }))
vi.mock('@/components/chat/ContactPanel', () => ({ default: () => null }))
vi.mock('@/components/chat/ForwardMessageModal', () => ({ default: () => null }))
vi.mock('@/components/chat/MessageInfoDialog', () => ({ default: () => null }))
vi.mock('@/components/chat/QuickReplyPicker', () => ({ default: () => null }))
vi.mock('@/components/chat/ImageViewer', () => ({ default: () => null }))
vi.mock('@/components/chat/ChatDocumentViewer', () => ({
  default: ({ document, onClose }: { document: { filename: string }; onClose: () => void }) => (
    <div role="dialog" aria-label={`Vista previa de ${document.filename}`}>
      <button type="button" onClick={onClose}>Cerrar documento simulado</button>
    </div>
  ),
}))
vi.mock('@/components/ContactSelector', () => ({ default: () => null }))

import ChatPanel from '@/components/chat/ChatPanel'


const chat: Chat = {
  id: 'chat-1',
  jid: '51999999999@s.whatsapp.net',
  name: 'Contacto QA',
  device_id: 'device-1',
  last_message: 'Hola',
  last_message_at: '2026-08-13T10:00:00Z',
  unread_count: 0,
}

function device(status: string): Device {
  const connected = status === 'connected'
  return {
    id: 'device-1',
    name: 'WhatsApp principal',
    status,
    provider: 'whatsapp_web',
    runtime_capabilities: {
      can_start_chat: connected,
      can_check_whatsapp: connected,
      can_send_reaction: connected,
      can_send_sticker: connected,
      can_send_animated_sticker: false,
      can_publish_status: false,
      can_sync_own_status: false,
    },
  }
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}


function emit(event: string, data: unknown) { websocket.listeners.forEach(listener => listener({event,data})) }
const saved = {id:'row-1',message_id:'provider-1',chat_id:'chat-1',device_id:'device-1',body:'Texto antes de edición',is_from_me:true,is_read:true,status:'sent',message_type:'text',timestamp:'2026-10-07T00:00:00Z',is_revoked:false};
function panel() { return <ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} /> }
describe('Chat canonical reconciliation', () => {
 beforeEach(()=>{localStorage.setItem('token','synthetic-audit-token');websocket.listeners.clear()});
 afterEach(()=>{cleanup();vi.unstubAllGlobals();websocket.listeners.clear()});
 it('accepts canonical content/revocation and newer delivery state on history refresh',async()=>{
  let history=[saved]; let gets=0;
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);
   if(url==='/api/chats/chat-1') return Promise.resolve(jsonResponse({success:true,chat,device:device('connected')}));
   if(url.startsWith('/api/chats/chat-1/messages')) {gets++;return Promise.resolve(jsonResponse({success:true,messages:history}))}
   return Promise.resolve(jsonResponse({success:true,stickers:[],quick_replies:[]}));
  }));
  render(panel()); await screen.findByText(saved.body);await screen.findByTestId('chat-composer');await waitFor(()=>expect(websocket.listeners.size).toBeGreaterThan(0));
  history=[{...saved,body:'Texto canónico nuevo',status:'read',is_revoked:true}];
  await act(async()=>emit('history_sync_complete',{chat_id:'chat-1',messages_saved:1,finished:true}));
  await waitFor(()=>expect(gets).toBe(2));
  expect(screen.getByTestId('message-body')).toBeEmptyDOMElement();
  expect(screen.queryByText('Texto canónico nuevo')).toBeNull();
  expect(screen.getByTestId('message-status')).toHaveTextContent('read');
  expect(screen.getByTestId('message-revoked')).toHaveTextContent('true');
 });
 it('keeps read receipts when the send HTTP result arrives after realtime',async()=>{
  let resolveSend!:(r:Response)=>void;
  const sendResponse=new Promise<Response>(r=>resolveSend=r);
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);
   if(url==='/api/chats/chat-1') return Promise.resolve(jsonResponse({success:true,chat,device:device('connected')}));
   if(url==='/api/messages/send') return sendResponse;
   return Promise.resolve(jsonResponse({success:true,messages:[],stickers:[],quick_replies:[]}));
  }));
  render(panel());
  fireEvent.change(await screen.findByRole('textbox',{name:'Draft test editor'}),{target:{value:'Mensaje de carrera'}});
  fireEvent.click(screen.getByRole('button',{name:'Enviar mensaje'}));
  const canonical={...saved,body:'Mensaje de carrera',timestamp:new Date().toISOString()};
  await act(async()=>emit('message_sent',{chat_id:'chat-1',message:canonical}));
  await act(async()=>emit('message_status',{chat_jid:chat.jid,message_ids:[canonical.message_id],status:'read',timestamp:'2026-10-07T01:00:00Z'}));
  expect(screen.getByTestId('message-status')).toHaveTextContent('read');
  await act(async()=>resolveSend(jsonResponse({success:true,message:canonical})));
  expect(screen.getByTestId('message-status')).toHaveTextContent('read');
 });
 it('orders out-of-order realtime messages chronologically',async()=>{
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>Promise.resolve(jsonResponse(String(input)==='/api/chats/chat-1'?{success:true,chat,device:device('connected')}:{success:true,messages:[],stickers:[],quick_replies:[]}))));
  render(panel()); await screen.findByTestId('chat-composer');
  await act(async()=>emit('message_sent',{chat_id:'chat-1',message:{...saved,id:'newer',message_id:'provider-newer',body:'Más nuevo',timestamp:'2026-10-07T12:00:00Z'}}));
  await act(async()=>emit('message_sent',{chat_id:'chat-1',message:{...saved,id:'older',message_id:'provider-older',body:'Más antiguo',timestamp:'2026-10-07T11:00:00Z'}}));
  expect(screen.getAllByTestId('message-body').map(el=>el.textContent)).toEqual(['Más antiguo','Más nuevo']);
 });
});

describe('Chat recoverable errors',()=>{
 beforeEach(()=>{localStorage.setItem('token','synthetic-audit-token');websocket.listeners.clear()});
 afterEach(()=>{cleanup();vi.unstubAllGlobals();websocket.listeners.clear()});
 it('retries a saved sticker using its existing URL',async()=>{
  let sends=0;
  const fetchMock=vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);
   if(url==='/api/chats/chat-1')return Promise.resolve(jsonResponse({success:true,chat,device:device('connected')}));
   if(url==='/api/messages/send'){sends++;return Promise.resolve(sends===1?jsonResponse({success:false,error:'Desconexión simulada'},false,502):jsonResponse({success:true,message:{...saved,body:'',message_type:'sticker',media_url:'/api/media/file/account-audit/saved.webp'}}))}
   return Promise.resolve(jsonResponse({success:true,messages:[],stickers:['/api/media/file/account-audit/saved.webp'],quick_replies:[]}));
  });
  vi.stubGlobal('fetch',fetchMock);vi.spyOn(console,'error').mockImplementation(()=>{});
  render(panel());fireEvent.click(await screen.findByText('Enviar sticker guardado simulado'));
  await screen.findByText('Desconexión simulada');
  expect(screen.getByTestId('message-status')).toHaveTextContent('failed');
  const sendCount=fetchMock.mock.calls.filter(([url])=>String(url)==='/api/messages/send').length;
  fireEvent.click(screen.getByText('Reintentar mensaje simulado'));
  await waitFor(()=>expect(screen.getByTestId('message-status')).toHaveTextContent('sent'));
  expect(fetchMock.mock.calls.filter(([url])=>String(url)==='/api/messages/send')).toHaveLength(sendCount+1);
 });
 it('reports a failed history load and recovers through explicit retry',async()=>{
  let failed=true;vi.spyOn(console,'error').mockImplementation(()=>{});
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{
   const url=String(input);
   if(url==='/api/chats/chat-1')return Promise.resolve(jsonResponse({success:true,chat,device:device('connected')}));
   if(url.startsWith('/api/chats/chat-1/messages'))return Promise.resolve(failed?jsonResponse({success:false,error:'Historial no disponible'},false,500):jsonResponse({success:true,messages:[saved]}));
   return Promise.resolve(jsonResponse({success:true,stickers:[],quick_replies:[]}));
  }));
  render(panel());await screen.findByTestId('chat-composer');
  expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0);
  expect(await screen.findByRole('alert')).toHaveTextContent('Historial no disponible');
  failed=false;fireEvent.click(screen.getByRole('button',{name:'Reintentar historial'}));
  await screen.findByText(saved.body);expect(screen.queryByRole('alert')).toBeNull();
 });
});

describe('Chat deletion while the channel is disconnected',()=>{
 afterEach(()=>{cleanup();vi.unstubAllGlobals();websocket.listeners.clear()});
 it.each([{chat_ids:['chat-1']},{all:true}])('closes the chat and removes its cached messages for %j',async(payload)=>{
  vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>Promise.resolve(jsonResponse(String(input)==='/api/chats/chat-1'?{success:true,chat,device:device('disconnected')}:{success:true,messages:[saved],stickers:[],quick_replies:[]}))));
  const close=vi.fn();render(<ChatPanel chatId="chat-1" deviceId="device-1" initialChat={chat} onClose={close}/>);
  await screen.findByText(saved.body);await waitFor(()=>expect(websocket.listeners.size).toBeGreaterThan(0));
  await act(async()=>emit('chat_deleted',payload));
  expect(close).toHaveBeenCalledTimes(1);expect(screen.queryByText(saved.body)).toBeNull();expect(screen.getByText('Chat no encontrado')).toBeTruthy();
 });
});
