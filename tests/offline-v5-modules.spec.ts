import {expect,test,type Page} from '@playwright/test'
import {labIDs,labLogin,startOfflineModuleLab} from './fixtures/offline-v5-module-lab'

let lab:Awaited<ReturnType<typeof startOfflineModuleLab>>
test.beforeAll(async()=>{lab=await startOfflineModuleLab()})
test.afterAll(async()=>{await lab?.close()})

async function unlock(page:Page) {
  await page.getByPlaceholder('usuario o correo').fill(labLogin.username)
  await page.getByPlaceholder('tu contraseña').fill(labLogin.password)
  await page.getByRole('button',{name:'Entrar en modo offline',exact:true}).click()
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

test('canonical modules save and reopen an encrypted prepared copy with the network disconnected',async({page,context})=>{
  test.setTimeout(300_000)
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto(lab.origin+'/qa-prepare')
  await page.evaluate(async({grant,password})=>{await (window as any).__qaClient.prepare(grant,password)},{grant:labIDs.grant,password:labLogin.password})
  expect(lab.apiCalls).toContain(`POST /api/offline/v5/grants/${labIDs.grant}/prepare`)
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
  await reopen(page,'tasks')
  await page.getByText('Tarea persistente sin red',{exact:true}).first().click()
  await expect(page.getByLabel('Título de la tarea',{exact:true})).toHaveValue('Tarea persistente sin red')
  await page.keyboard.press('Escape')

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

  await navigate(page,'programs')
  await page.getByText('Programa QA offline',{exact:true}).first().click()
  await expect(page.getByText('Programa QA offline',{exact:true}).first()).toBeVisible()
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
  expect(lab.networkCalls()).toBe(0)
  expect(errors).toEqual([])
})
