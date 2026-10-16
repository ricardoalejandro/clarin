import {expect,test,type Browser,type BrowserContext,type Page} from '@playwright/test'
import {labAttachmentText,labIDs,labLogin,startOfflineModuleLab} from './fixtures/offline-v5-module-lab'

let lab:Awaited<ReturnType<typeof startOfflineModuleLab>>
let stopNetworkObservation:(()=>Promise<void>)|undefined
let networkEvidence:(()=>unknown)|undefined
test.beforeAll(async()=>{lab=await startOfflineModuleLab()})
test.afterAll(async()=>{await lab?.close()})
test.afterEach(async({page})=>{if(networkEvidence)await test.info().attach('offline-network-observation',{body:Buffer.from(JSON.stringify(networkEvidence(),null,2)),contentType:'application/json'});if(test.info().status!=='passed')await test.info().attach('offline-failure-state',{body:Buffer.from(JSON.stringify(await page.evaluate(async()=>({online:navigator.onLine,registrations:(await navigator.serviceWorker.getRegistrations()).map(reg=>({scope:reg.scope,active:reg.active?.scriptURL})),databases:await indexedDB.databases(),cacheNames:await caches.keys()})).catch(error=>({error:String(error)})),null,2)),contentType:'application/json'});await stopNetworkObservation?.();stopNetworkObservation=undefined;networkEvidence=undefined})

async function observeNetwork(browser:Browser,context:BrowserContext) {
  let disconnected=false,sequence=0
  const requests:Array<{method:string;url:string;owner:string}>=[]
  const sockets:Array<{url:string;owner:string}>=[]
  const errors:string[]=[],workerKinds=new Set<string>(),sessions=new Map<string,string>()
  const pending=new Map<number,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  context.on('request',request=>{if(disconnected)requests.push({method:request.method(),url:request.url(),owner:request.serviceWorker()?'service_worker':'page_or_shared_worker'})})
  const observePage=(page:Page)=>page.on('websocket',socket=>{if(disconnected)sockets.push({url:socket.url(),owner:'page'})})
  context.pages().forEach(observePage);context.on('page',observePage)
  const observer=await browser.newBrowserCDPSession()
  observer.on('Target.receivedMessageFromTarget',event=>{
    const message=JSON.parse(event.message)
    if(message.id&&pending.has(message.id)) {const command=pending.get(message.id)!;clearTimeout(command.timer);pending.delete(message.id);if(message.error)command.reject(new Error(message.error.message));else command.resolve()}
    if(disconnected&&message.method==='Network.requestWillBeSent')requests.push({method:message.params.request.method,url:message.params.request.url,owner:sessions.get(event.sessionId)||'worker'})
    if(disconnected&&message.method==='Network.webSocketCreated')sockets.push({url:message.params.url,owner:sessions.get(event.sessionId)||'worker'})
  })
  const command=(sessionId:string,method:string)=>new Promise<void>((resolve,reject)=>{
    const id=++sequence
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Worker network observation timed out: ${method}`))},10_000)
    pending.set(id,{resolve,reject,timer})
    void observer.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method})}).catch(error=>{clearTimeout(timer);pending.delete(id);reject(error)})
  })
  const targets=new Set<string>(),setups:Promise<void>[]=[]
  const attach=(target:{targetId:string;type:string})=>{
    // Debugger attachment changes a SharedWorker's lifetime across navigation.
    // Observe its HTTP through BrowserContext without pinning that worker alive.
    // Worker WebSocket coverage is deliberately limited to service/dedicated workers.
    if(!['service_worker','worker'].includes(target.type)||targets.has(target.targetId))return
    targets.add(target.targetId)
    setups.push((async()=>{try{const {sessionId}=await observer.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});sessions.set(sessionId,target.type);await command(sessionId,'Network.enable');workerKinds.add(target.type)}catch(error){errors.push(String(error))}})())
  }
  observer.on('Target.targetCreated',event=>attach(event.targetInfo))
  // BrowserContext records worker HTTP requests. Per-target CDP additionally
  // observes worker WebSockets; finish attachment before cutting the network.
  await observer.send('Target.setDiscoverTargets',{discover:true})
  for(const target of (await observer.send('Target.getTargets')).targetInfos)attach(target)
  stopNetworkObservation=async()=>{await observer.detach();for(const value of pending.values())clearTimeout(value.timer);pending.clear()}
  return {requests,sockets,errors,workerKinds,ready:()=>Promise.all(setups),cut(){disconnected=true}}
}

async function unlock(page:Page) {
  await page.getByPlaceholder('usuario o correo').fill(labLogin.username)
  await page.getByPlaceholder('tu contraseña').fill(labLogin.password)
  const offline=page.getByRole('button',{name:'Entrar en modo offline',exact:true})
  if(!await offline.isVisible()) {
    // The ordinary login intentionally reveals a username-scoped copy only
    // after the user's online attempt fails. Exercise that same user flow.
    await page.getByRole('button',{name:'Iniciar sesión',exact:true}).click()
    const cancel=page.getByRole('button',{name:'Cancelar y elegir modo offline',exact:true})
    await expect(offline.or(cancel)).toBeVisible()
    if(await cancel.isVisible()) {
      await cancel.click()
    }
  }
  // Cancelling reauthentication clears the password after its async worker ack.
  // Wait for that mode transition before entering the password for local unlock.
  await expect(offline).toBeVisible()
  await expect(offline).toBeEnabled()
  await page.getByPlaceholder('tu contraseña').fill(labLogin.password)
  await offline.click()
  await expect(page).toHaveURL(/\/dashboard/)
}
async function navigate(page:Page,module:string) {
  await page.locator(`a[href="/dashboard/${module}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${module}`))
}
async function reopen(page:Page,module:string) {
  await page.reload({waitUntil:'domcontentloaded'})
  await unlock(page)
  await navigate(page,module)
}
async function readPreparedAttachment(page:Page) {
  await page.getByText('archivo-preparado.txt',{exact:true}).click()
  const viewer=page.getByRole('dialog',{name:'Vista previa de archivo-preparado.txt',exact:true})
  await expect(viewer.locator('pre')).toHaveText(labAttachmentText)
  await viewer.getByRole('button',{name:'Cerrar',exact:true}).click()
}
async function assertPreparedFonts(page:Page) {
  await page.getByTestId('toolbar-text').check({force:true})
  const showFonts=page.getByTestId('font-family-show-fonts')
  await expect(showFonts).toHaveAttribute('aria-label','Más fuentes · 32')
  await expect(showFonts).toBeEnabled()
  await expect(page.getByText(/Preparando fuentes|fuentes? no pud/)).toHaveCount(0)
  await showFonts.click()
  const options=page.locator('.dropdown-menu.fonts button.dropdown-menu-item')
  await expect(options).toHaveCount(32)
  await expect(page.locator('.dropdown-menu.fonts [aria-label*="Fuente no disponible"]')).toHaveCount(0)
  await expect(page.locator('.dropdown-menu.fonts button.dropdown-menu-item:disabled')).toHaveCount(0)
  const families=await options.locator('.dropdown-menu-item__text').evaluateAll(elements=>elements.map(element=>getComputedStyle(element).fontFamily.split(',')[0].replace(/^['"]|['"]$/g,'')))
  expect(new Set(families).size).toBe(32)
  await expect.poll(()=>page.evaluate(expected=>expected.filter(family=>family!=='Helvetica').every(family=>{const faces=Array.from(document.fonts).filter(face=>face.family.replace(/^['"]|['"]$/g,'')===family);return faces.length>0&&faces.every(face=>face.status==='loaded')}),families)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('.dropdown-menu.fonts')).not.toBeVisible()
  // Used fonts legitimately move into the recent-font group after editing.
  return families.sort()
}

test('canonical modules save and reopen an encrypted prepared copy with the network disconnected',async({page,context,browser})=>{
  test.setTimeout(300_000)
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  const network=await observeNetwork(browser,context)
  networkEvidence=()=>({requests:network.requests,sockets:network.sockets,workerKinds:[...network.workerKinds],observationErrors:network.errors,pageErrors:errors,rejectedNetworkProbes:lab.disconnectedRequests})
  const cdp=await context.newCDPSession(page)
  const {targetInfo}=await cdp.send('Target.getTargetInfo')
  await cdp.send('Browser.grantPermissions',{origin:lab.origin,permissions:['durableStorage'],browserContextId:targetInfo.browserContextId})
  await page.goto(lab.origin+'/qa-prepare')
  expect(await page.evaluate(async()=>await navigator.storage.persist())).toBe(true)
  expect(await page.evaluate(async()=>await navigator.storage.persisted())).toBe(true)
  await page.evaluate(async({grant,password})=>{await (window as any).__qaClient.prepare(grant,password)},{grant:labIDs.grant,password:labLogin.password})
  expect(await page.evaluate(async username=>(window as any).__qaClient.hasPreparedCopyForUsername(username),labLogin.username)).toBe(true)
  expect(lab.apiCalls).toContain(`POST /api/offline/v5/grants/${labIDs.grant}/prepare`)
  // A first installation controls the next navigation, as in an ordinary reopen.
  await page.goto(lab.origin+'/login',{waitUntil:'domcontentloaded'})
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true)
  // Both browser emulation and a disconnected HTTP authority: no route.fulfill,
  // IndexedDB seeding, alternate component, or intercepted offline response.
  await network.ready()
  await context.setOffline(true);lab.cutNetwork();network.cut()
  await page.goto(lab.origin+'/login',{waitUntil:'domcontentloaded'})
  await unlock(page)

  await navigate(page,'tasks')
  await page.getByText('Tarea QA offline',{exact:true}).first().click()
  const detail=page.getByLabel('Detalle de tarea',{exact:true})
  await expect(detail).toBeVisible()
  const taskTitle=page.getByLabel('Título de la tarea',{exact:true})
  await taskTitle.fill('Tarea persistente sin red')
  await taskTitle.press('Enter')
  await expect.poll(async()=>JSON.stringify(await page.evaluate(async(id)=>await (await fetch(`/api/tasks/${id}`)).json(),labIDs.task))).toContain('Tarea persistente sin red')
  await readPreparedAttachment(page)
  await reopen(page,'tasks')
  await page.getByText('Tarea persistente sin red',{exact:true}).first().click()
  await expect(page.getByLabel('Título de la tarea',{exact:true})).toHaveValue('Tarea persistente sin red')
  await readPreparedAttachment(page)
  await page.keyboard.press('Escape')

  await navigate(page,'programs')
  await page.getByText('Programa QA offline',{exact:true}).first().click()
  await expect(page.getByText('Programa QA offline',{exact:true}).first()).toBeVisible()
  await page.getByRole('button',{name:'Sesiones (1)',exact:true}).click()
  await page.getByRole('button',{name:'Asistencia',exact:true}).click()
  const attendance=page.getByRole('dialog',{name:'Tomar asistencia',exact:true})
  await expect(attendance.getByText('Contacto QA offline',{exact:true}).filter({visible:true})).toBeVisible()
  await attendance.getByRole('button',{name:'Presente: Contacto QA offline',exact:true}).click()
  await attendance.getByRole('button',{name:'Guardar Asistencia',exact:true}).click()
  await expect(attendance).not.toBeVisible()
  await reopen(page,'programs')
  await page.getByText('Programa QA offline',{exact:true}).first().click()
  await page.getByRole('button',{name:'Sesiones (1)',exact:true}).click()
  await page.getByRole('button',{name:'Asistencia',exact:true}).click()
  await expect(attendance.getByRole('button',{name:'Presente: Contacto QA offline',exact:true})).toHaveAttribute('aria-pressed','true')
  await attendance.getByRole('button',{name:'Cerrar asistencia',exact:true}).click()
  await navigate(page,'contacts')
  await page.getByText('Contacto QA offline',{exact:true}).first().click()
  await page.getByRole('button',{name:'Editar',exact:true}).first().click()
  const name=page.getByPlaceholder('Nombre que verá el equipo')
  await expect(name).toBeVisible()
  await name.fill('Contacto QA modificado offline')
  await page.getByRole('button',{name:'Guardar contacto',exact:true}).click()
  await expect(page.getByText('Contacto QA modificado offline',{exact:true}).first()).toBeVisible()
  await reopen(page,'contacts')
  await expect(page.getByText('Contacto QA modificado offline',{exact:true}).first()).toBeVisible()
  await navigate(page,'whiteboards')
  await page.getByText('Pizarra QA offline',{exact:true}).first().click()
  await expect(page.locator('canvas.interactive')).toBeVisible()
  const preparedFontFamilies=await assertPreparedFonts(page)
  const surface=await page.locator('.whiteboard-editor-shell .excalidraw').first().boundingBox()
  expect(surface).not.toBeNull()
  await page.getByTestId('toolbar-text').check({force:true})
  await page.mouse.click(surface!.x+surface!.width*.55,surface!.y+surface!.height*.4)
  await page.keyboard.insertText('Pizarra persistente sin red');await page.keyboard.press('Control+Enter')
  await expect(page.getByLabel('Guardado en Clarin')).toBeVisible()
  const scene=()=>page.evaluate(async(id)=>await (await fetch(`/api/whiteboards/${id}/scene`)).json(),labIDs.board)
  await expect.poll(async()=>JSON.stringify(await scene())).toContain('Pizarra persistente sin red')
  await reopen(page,'whiteboards')
  await page.getByText('Pizarra QA offline',{exact:true}).first().click()
  await expect(page.locator('canvas.interactive')).toBeVisible()
  expect(await assertPreparedFonts(page)).toEqual(preparedFontFamilies)
  expect(JSON.stringify(await scene())).toContain('Pizarra persistente sin red')
  // Chromium can still issue ServiceWorker update/login probes while its page
  // context is offline. The HTTP authority destroys every such connection.
  // Permit only those explicit login/update probes, never module or asset IO.
  const probes=new Set(['GET /login','GET /sw.js','GET /api/public/security-config','POST /api/auth/login'])
  expect(lab.disconnectedRequests.filter(request=>!probes.has(request))).toEqual([])
  expect(network.requests.filter(request=>/^https?:/.test(request.url)&&new URL(request.url).origin!==lab.origin)).toEqual([])
  expect(network.sockets).toEqual([])
  expect(network.errors).toEqual([])
  expect([...network.workerKinds]).toEqual(expect.arrayContaining(['service_worker']))
  expect(errors).toEqual([])
  await test.info().attach('offline-module-evidence',{body:Buffer.from(JSON.stringify({modules:['tasks','programs','contacts','whiteboards'],preparedAttachment:'archivo-preparado.txt',preparedFontFamilies,browserOffline:await page.evaluate(()=>!navigator.onLine),rejectedNetworkProbes:lab.disconnectedRequests,observedRequests:network.requests,observedWebSockets:network.sockets,observedWorkerKinds:[...network.workerKinds],pageErrors:errors},null,2)),contentType:'application/json'})
  await test.info().attach('canonical-whiteboard-after-offline-reload',{body:await page.screenshot(),contentType:'image/png'})
})
