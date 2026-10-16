import {expect,test,type Page} from '@playwright/test'
import {labAttachmentText,labIDs,labLogin,startOfflineModuleLab} from './fixtures/offline-v5-module-lab'

let lab:Awaited<ReturnType<typeof startOfflineModuleLab>>
test.beforeAll(async()=>{lab=await startOfflineModuleLab()})
test.afterAll(async()=>{await lab?.close()})

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

test('canonical modules save and reopen an encrypted prepared copy with the network disconnected',async({page,context})=>{
  test.setTimeout(300_000)
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  const cdp=await context.newCDPSession(page)
  const {targetInfo}=await cdp.send('Target.getTargetInfo')
  await cdp.send('Browser.grantPermissions',{origin:lab.origin,permissions:['durableStorage'],browserContextId:targetInfo.browserContextId})
  await page.goto(lab.origin+'/qa-prepare')
  expect(await page.evaluate(async()=>await navigator.storage.persist())).toBe(true)
  expect(await page.evaluate(async()=>await navigator.storage.persisted())).toBe(true)
  await page.evaluate(async({grant,password})=>{await (window as any).__qaClient.prepare(grant,password)},{grant:labIDs.grant,password:labLogin.password})
  expect(lab.apiCalls).toContain(`POST /api/offline/v5/grants/${labIDs.grant}/prepare`)
  // A first installation controls the next navigation, as in an ordinary reopen.
  await page.goto(lab.origin+'/login',{waitUntil:'domcontentloaded'})
  await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true)
  // Both browser emulation and a disconnected HTTP authority: no route.fulfill,
  // IndexedDB seeding, alternate component, or intercepted offline response.
  await context.setOffline(true);lab.cutNetwork()
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
  expect(JSON.stringify(await scene())).toContain('Pizarra persistente sin red')
  // Chromium can still issue ServiceWorker update/login probes while its page
  // context is offline. The HTTP authority destroys every such connection.
  // Permit only those explicit login/update probes, never module or asset IO.
  const probes=new Set(['GET /login','GET /sw.js','GET /api/public/security-config','POST /api/auth/login'])
  expect(lab.disconnectedRequests.filter(request=>!probes.has(request))).toEqual([])
  expect(errors).toEqual([])
  await test.info().attach('offline-module-evidence',{body:Buffer.from(JSON.stringify({modules:['tasks','programs','contacts','whiteboards'],preparedAttachment:'archivo-preparado.txt',browserOffline:await page.evaluate(()=>!navigator.onLine),rejectedNetworkProbes:lab.disconnectedRequests,pageErrors:errors},null,2)),contentType:'application/json'})
  await test.info().attach('canonical-whiteboard-after-offline-reload',{body:await page.screenshot(),contentType:'image/png'})
})
