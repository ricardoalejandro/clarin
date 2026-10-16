import { createServer, type Server } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, resolve, sep } from 'node:path'
import { isolatedOfflineQAOrigin, isolatedOfflineQARoot } from '../../scripts/offline/isolated-qa-guard.mjs'

// Synthetic HTTP authority, real browser crypto/storage/worker and original
// production UI artifacts. This deliberately is not a PostgreSQL end-to-end test.
export const labIDs = Object.fromEntries(['account','user','grant','list','environment','workflow','open','done','task','contact','program','board'].map((name, index) => [name, `80000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]))
export const labLogin = { username: 'offline.module.qa', password: 'Local-Offline-QA-2026' }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const access = { level:'edit', can_view:true, can_edit:true, can_comment:true, can_delete:false, can_manage_access:false }
const readAccess = { ...access, level:'view', can_edit:false, can_comment:false }
const types: Record<string,string> = {'.html':'text/html; charset=utf-8','.rsc':'text/x-component; charset=utf-8','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.webmanifest':'application/manifest+json'}

export async function startOfflineModuleLab() {
  const origin = isolatedOfflineQAOrigin(process.env.OFFLINE_QA_ORIGIN)
  const root = isolatedOfflineQARoot(resolve(__dirname, '../..')), frontend = resolve(root,'frontend')
  const requireFrontend = createRequire(resolve(frontend,'package.json'))
  const {build} = requireFrontend('esbuild')
  const {generateKeyPair, exportJWK, SignJWT} = requireFrontend('jose')
  const shell = JSON.parse(await readFile(resolve(frontend,'public/offline-v5/manifest.json'),'utf8'))
  // Runtime build identity must match the compiled Next pages and SharedWorker.
  const buildID = shell.build_id
  const signer = await generateKeyPair('ES256'), publicKey = {...await exportJWK(signer.publicKey),kid:'isolated-module-qa',alg:'ES256',use:'sig'}
  const swBundle = await build({entryPoints:[resolve(frontend,'src/app/sw.js/route.ts')],bundle:true,write:false,platform:'node',format:'cjs',tsconfig:resolve(frontend,'tsconfig.json'),define:{'process.env.NEXT_PUBLIC_BUILD_VERSION':JSON.stringify(buildID)}})
  const swModule = {exports:{} as {GET:()=>Response}}
  new Function('module','exports',swBundle.outputFiles[0].text)(swModule,swModule.exports)
  const workerSource = await swModule.exports.GET().text()
  const bootstrap = await build({stdin:{contents:`import {browserOfflineV5Client} from './src/offline-v5/client'; window.__qaClient=browserOfflineV5Client();`,resolveDir:frontend,sourcefile:'qa-bootstrap.ts'},bundle:true,write:false,platform:'browser',format:'iife',tsconfig:resolve(frontend,'tsconfig.json'),define:{'process.env.NEXT_PUBLIC_BUILD_VERSION':JSON.stringify(buildID),'process.env.NODE_ENV':'"production"'}})
  const actions: Record<string,string[]> = {tasks:['read','create','update','complete','reopen','comments.create'],contacts:['read','update','observations.create'],programs:['read','update','sessions.upsert','attendance.set','observations.create','goals.update'],whiteboards:['read','scene.update']}
  const roots = [['tasks','task_list',labIDs.list],['contacts','contact',labIDs.contact],['programs','program',labIDs.program],['whiteboards','whiteboard',labIDs.board]].map(([module,resource_type,resource_id],index)=>({selection_id:`81000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,module,resource_type,resource_id}))
  let browserID = '', unavailable = false, forbiddenNetworkCalls = 0
  const apiCalls: string[] = []
  async function prepareBundle() {
    const now = new Date().toISOString(), expires = new Date(Date.now()+23*3600_000).toISOString(), manifestID=randomUUID()
    const statuses = [{id:labIDs.open,workflow_id:labIDs.workflow,name:'Pendiente',category:'not_started',color:'#64748B',sort_order:0,is_default:true},{id:labIDs.done,workflow_id:labIDs.workflow,name:'Finalizada',category:'done',color:'#10B981',sort_order:1,is_default:true}]
    const contact = {id:labIDs.contact,account_id:labIDs.account,name:'Contacto QA offline',phone:'51900000001',email:'offline@example.test',company:'',notes:'Nota inicial',custom_fields:{},tags:[],phones:[],created_at:now,updated_at:now,version:1}
    const payloads = [
      {list:{id:labIDs.list,account_id:labIDs.account,environment_id:labIDs.environment,workflow_id:labIDs.workflow,name:'Lista QA offline',color:'#10B981',icon:'list',sort_order:0,is_default:true,permissions:access,capabilities:access,lifecycle:'active'},environment:{id:labIDs.environment,account_id:labIDs.account,name:'Entorno QA offline',is_default:true,color:'#10B981',icon:'layers',sort_order:0,permissions:readAccess,capabilities:readAccess,lifecycle:'active'},statuses,users:[{id:labIDs.user,username:labLogin.username,display_name:'Persona QA'}],tasks:[{id:labIDs.task,account_id:labIDs.account,list_id:labIDs.list,title:'Tarea QA offline',description:'Descripción original',type:'reminder',priority:'medium',status:'pending',status_id:labIDs.open,status_category:'not_started',status_detail:statuses[0],assigned_to:labIDs.user,created_by:labIDs.user,collaborators:[],version:1,sort_order:1024,progress:0,manual_progress:0,progress_mode:'manual',is_milestone:false,permissions:access,capabilities:access,created_at:now,updated_at:now}],comments:[],activity:[],attachments:[],dependencies:[]},
      {contact,phones:[],tags:[],custom_fields:[],observations:[],opportunities:[],capabilities:{can_view:true,can_edit:true,can_observe:true}},
      {program:{id:labIDs.program,account_id:labIDs.account,name:'Programa QA offline',description:'Programa sintético',type:'group',status:'active',color:'#10B981',version:1,created_at:now,updated_at:now},participants:[],sessions:[],attendances:[],observations:[],courses:[],goals:{attendance_goal_percent:80,transfer_goal_percent:70},health:{participant_count:0,active_count:0,attendance_rate:null,participants:[]},capabilities:{can_view:true,can_edit:true}},
      {whiteboard:{id:labIDs.board,account_id:labIDs.account,name:'Pizarra QA offline',title:'Pizarra QA offline',engine:'excalidraw',version:1,sequence:1,scene_schema_version:'excalidraw',editor_version:'0.18.1-clarin.8',scene:{type:'excalidraw',version:2,source:'clarin',elements:[],appState:{viewBackgroundColor:'#ffffff'},files:{}},created_at:now,updated_at:now},permissions:{can_view:true,can_edit:true},asset_transport:{embedded:false,local_encrypted:true,blob_sync_enabled:false},referenced_assets:[]},
    ]
    const snapshots = roots.map((item,index)=>{const payload=payloads[index],payload_json=JSON.stringify(payload);return {protocol_version:5,manifest_id:manifestID,manifest_revision:1,selection_id:item.selection_id,root_selection_id:item.selection_id,root_resource_id:item.resource_id,module:item.module,resource_type:item.resource_type,resource_id:item.resource_id,head_version:1,dependency:false,tombstone:false,payload,payload_json,content_hash:sha(payload_json)}})
    const signed = {protocol_version:5,id:manifestID,revision:1,browser_profile_id:browserID,grant_id:labIDs.grant,user_id:labIDs.user,account_id:labIDs.account,username:labLogin.username,account_name:'Cuenta sintética offline',selection_revision:1,selection_digest:sha(JSON.stringify(roots)),credential_epoch:1,authority_epoch:1,grant_revision:1,roots,dependencies:[{root_selection_id:roots[0].selection_id,module:'tasks',resource_type:'task',resource_id:labIDs.task},{root_selection_id:roots[0].selection_id,module:'tasks',resource_type:'task_user',resource_id:labIDs.user}],capabilities:roots.flatMap(item=>actions[item.module].map(action=>({action:`${item.module}.${action}`,selection_id:item.selection_id,root_resource_id:item.resource_id,resource_type:item.resource_type,resource_id:item.resource_id}))),entity_versions:[],chunk_hashes:snapshots.map(item=>({selection_id:item.selection_id,head_version:item.head_version,content_hash:item.content_hash})),issued_at:now,expires_at:expires,max_storage_bytes:16*1024*1024}
    const canonical=JSON.stringify(signed),digest=sha(canonical),seconds=Math.floor(Date.now()/1000)
    const lease=await new SignJWT({version:4,browser_profile_id:browserID,grant_id:labIDs.grant,user_id:labIDs.user,account_id:labIDs.account,selection_revision:1,selection_digest:digest}).setProtectedHeader({alg:'ES256',kid:publicKey.kid,typ:'clarin-offline-v4-lease+jwt'}).setIssuer('clarin-offline-v4').setAudience(origin).setIssuedAt(seconds).setExpirationTime(seconds+23*3600).sign(signer.privateKey)
    return {manifest:{...signed,digest,canonical_json:Buffer.from(canonical).toString('base64url')},snapshots,lease,signer_public_keys:{keys:[publicKey]},server_time:now}
  }
  const server: Server = createServer(async(req,res)=>{
    if(unavailable){forbiddenNetworkCalls++;req.socket.destroy();return}
    try {
      const url=new URL(req.url||'/',origin)
      const send=(body:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Clarin-Response':'1'});res.end(JSON.stringify(body))}
      if(url.pathname==='/qa-bootstrap.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(bootstrap.outputFiles[0].text);return}
      if(url.pathname==='/qa-prepare'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Isolated offline preparation</title><script src="/qa-bootstrap.js"></script>');return}
      if(url.pathname==='/sw.js'){res.writeHead(200,{'Content-Type':'application/javascript','Service-Worker-Allowed':'/','Cache-Control':'no-store'});res.end(workerSource);return}
      if(url.pathname==='/offline-v5/manifest.json'){send({...shell,app_origin:origin});return}
      if(url.pathname.startsWith('/api/')) {
        apiCalls.push(`${req.method} ${url.pathname}`)
        let body='';for await(const bytes of req)body+=bytes
        const input=body?JSON.parse(body):{}
        if(url.pathname==='/api/offline/v5/grants'){browserID=url.searchParams.get('browser_profile_id')||'';send({items:[{grant_id:labIDs.grant,browser_profile_id:browserID,user_id:labIDs.user,account_id:labIDs.account,username:labLogin.username,account_name:'Cuenta sintética offline',state:'active',selection_revision:1}]});return}
        if(url.pathname==='/api/offline/v5/grants/status'){send({active_grant_ids:[labIDs.grant]});return}
        if(url.pathname.endsWith('/challenge')){send({challenge_id:randomUUID(),nonce:randomUUID(),expires_at:new Date(Date.now()+120_000).toISOString()});return}
        if(url.pathname.endsWith('/keys')){if(input.password!==labLogin.password){send({error:'offline_reauthentication_failed'},401);return}send({ok:true});return}
        if(url.pathname.endsWith('/prepare')){send(await prepareBundle());return}
        if(url.pathname==='/api/config'){send({success:true,login_enabled:true,turnstile_enabled:false});return}
        if(url.pathname==='/api/me'){send({error:'unauthorized'},401);return}
        send({error:'isolated_fixture_route_not_implemented'},404);return
      }
      let pathname=url.pathname
      const route = pathname==='/login'||pathname==='/'?'login':pathname==='/dashboard'?'dashboard':pathname==='/dashboard/tasks'?'tasks':pathname==='/dashboard/contacts'?'contacts':pathname==='/dashboard/programs'?'programs':pathname==='/dashboard/whiteboards'?'whiteboards':pathname.startsWith('/dashboard/programs/')?'program_detail':pathname.startsWith('/dashboard/whiteboards/')?'whiteboard_detail':undefined
      if(route) pathname=shell.shell[route][url.searchParams.has('_rsc')?'flight':'document']
      const directory=pathname.startsWith('/_next/static/')?resolve(frontend,'.next/static'):resolve(frontend,'public')
      const file=resolve(directory,pathname.startsWith('/_next/static/')?pathname.slice(14):pathname.slice(1))
      if(!file.startsWith(directory+sep)){res.writeHead(403).end();return}
      const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(data)
    }catch(error){res.writeHead(404,{'Content-Type':'text/plain'}).end(String(error))}
  })
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(Number(new URL(origin).port),'127.0.0.1',done)})
  return {origin,apiCalls,cutNetwork(){unavailable=true;forbiddenNetworkCalls=0},networkCalls:()=>forbiddenNetworkCalls,close:()=>new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()))}
}
