import {test, expect, type Page} from '@playwright/test'
import {readFileSync, mkdirSync} from 'node:fs'
import {resolve} from 'node:path'

const enabled=process.env.CLARIN_TEMPLATES_BROWSER_QA==='1'
const base=process.env.PLAYWRIGHT_BASE_URL||'http://localhost:13001'
const manifest=process.env.CLARIN_STORAGE_UI_QA_MANIFEST||resolve('work/storage-templates-qa/fixture.private.json')
const evidence=process.env.CLARIN_TEMPLATES_QA_EVIDENCE_DIR||resolve('work/storage-templates-qa/evidence')
let actor:{username:string;password:string}, templateID=''
const errors=new WeakMap<Page,string[]>()
async function login(page:Page){
 const ready=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/public/security-config')
 await page.goto(base+'/login'); expect((await ready).status()).toBe(200)
 await page.getByPlaceholder('usuario o correo').fill(actor.username)
 try{await page.getByPlaceholder('tu contraseña').fill(actor.password)}catch{throw new Error('Unable to fill private QA login')}
 const signed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'&&r.request().method()==='POST')
 await page.getByRole('button',{name:'Iniciar sesión',exact:true}).click();expect((await signed).status()).toBe(200)
 await page.waitForURL(/\/dashboard(?:\/|$|\?)/)
}
async function editor(page:Page){await page.goto(base+'/dashboard/documents/'+templateID);await expect(page.getByRole('button',{name:'Guardar',exact:true})).toBeEnabled();await expect(page.locator('canvas.upper-canvas')).toBeVisible()}
async function save(page:Page){const result=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/document-templates/'+templateID&&r.request().method()==='PUT');await page.getByRole('button',{name:'Guardar',exact:true}).click();const r=await result;expect(r.status()).toBe(200);return (await r.json()).template}
async function capture(page:Page,name:string){await page.screenshot({path:resolve(evidence,name),fullPage:true})}
async function addRect(page:Page,dx=0){await page.getByRole('button',{name:'Rectángulo (R)',exact:true}).click();const box=await page.locator('canvas.upper-canvas').boundingBox();if(!box)throw new Error('Canvas not measured');await page.mouse.click(box.x+box.width/2+dx,box.y+box.height/2);await expect(page.getByRole('button',{name:'Deshacer',exact:true})).toBeEnabled()}

test.describe('Templates full native acceptance',()=>{
 test.skip(!enabled,'requires isolated local API, database and storage fixture')
 test.describe.configure({mode:'serial'})
 test.beforeAll(()=>{if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Only isolated loopback browser QA');actor=JSON.parse(readFileSync(manifest,'utf8')).actors.admin_a;mkdirSync(evidence,{recursive:true})})
 test.beforeEach(async({page})=>{const e:string[]=[];errors.set(page,e);page.on('pageerror',error=>e.push(error.message));await login(page)})
 test.afterEach(async({page})=>{expect(errors.get(page)||[],'uncaught browser errors').toEqual([])})
 test('creates through the library, inserts objects, saves grouping and restores a canonical document',async({page})=>{
  await page.goto(base+'/dashboard/documents');await expect(page.getByRole('heading',{name:'Plantillas',exact:true})).toBeVisible();await capture(page,'templates-library.png')
  await page.getByRole('button',{name:'Nueva plantilla',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Nueva plantilla',exact:true})
  await dialog.getByLabel('Nombre',{exact:true}).fill('Calidad de diseño — QA')
  await dialog.getByRole('button',{name:'Ficha',exact:false}).click()
  await dialog.getByRole('button',{name:'Crear y diseñar',exact:true}).click()
  await page.waitForURL(/\/dashboard\/documents\/[^/]+$/);templateID=page.url().split('/').pop()!
  await expect(page.getByRole('button',{name:'Guardar',exact:true})).toBeEnabled();await addRect(page,-70);await addRect(page,70)
  await page.keyboard.press('Escape');await page.locator('canvas.upper-canvas').click({position:{x:8,y:8}})
  await page.keyboard.press('Control+a');await page.keyboard.press('Control+g')
  const grouped=await save(page);const objects=grouped.canvas_json.fabricJson.objects
  expect(objects.filter((o:any)=>String(o.type).toLowerCase()==='group')).toHaveLength(1)
  expect(objects.find((o:any)=>String(o.type).toLowerCase()==='group').objects).toHaveLength(2)
  await page.reload();await expect(page.getByRole('button',{name:'Guardar',exact:true})).toBeEnabled();await capture(page,'templates-editor-group.png')
  await page.locator('canvas.upper-canvas').click({position:{x:8,y:8}});await page.keyboard.press('Control+a');await page.keyboard.press('Control+Shift+g')
  const separate=await save(page);expect(separate.canvas_json.fabricJson.objects).toHaveLength(2)
 })
 test('exports the exact prepared PNG, JPEG and lossless PDF with selected resolution',async({page})=>{
  await editor(page);await page.getByRole('button',{name:'Exportar',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Exportar documento',exact:true})
  await expect(dialog.getByRole('button',{name:/Impresión/})).toHaveAttribute('aria-pressed','true')
  for(const format of ['PDF','PNG','JPEG']){
   await dialog.getByRole('button',{name:format,exact:true}).click()
   await expect(dialog.getByRole('img',{name:'Vista previa del archivo exportado'})).toBeVisible()
   await expect(dialog.getByText(/KiB · tamaño exacto/)).toBeVisible()
   await expect(dialog.getByRole('button',{name:'Descargar',exact:true})).toBeEnabled()
   if(format==='PDF')await expect(dialog.getByText('PDF con imagen sin pérdida para impresión.')).toBeVisible()
   const download=page.waitForEvent('download');await dialog.getByRole('button',{name:'Descargar',exact:true}).click();const file=await download
   const path=resolve(evidence,'template-'+format.toLowerCase()+'.'+(format==='JPEG'?'jpg':format.toLowerCase()));await file.saveAs(path)
   const bytes=readFileSync(path);expect(bytes.length).toBeGreaterThan(100)
   if(format==='PDF'){expect(bytes.subarray(0,5).toString()).toBe('%PDF-');expect(bytes.includes(Buffer.from('/DCTDecode'))).toBe(false)}
   if(format==='PNG')expect([...bytes.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10])
   if(format==='JPEG')expect([...bytes.subarray(0,2)]).toEqual([255,216])
  }
  await dialog.getByRole('button',{name:'Personalizado',exact:true}).click();await dialog.getByLabel('Resolución personalizada').fill('96');await dialog.getByLabel('Resolución personalizada').press('Tab')
  await expect(dialog.getByRole('button',{name:'Descargar',exact:true})).toBeEnabled();await capture(page,'templates-export.png')
  await dialog.getByRole('button',{name:'Cerrar',exact:true}).click()
  await page.getByRole('button',{name:'Exportar',exact:true}).click();await page.getByRole('dialog',{name:'Exportar documento'}).getByRole('button',{name:'JPEG',exact:true}).click()
  await expect(page.getByLabel('Resolución personalizada')).toHaveValue('96')
 })
 test('keeps menus inside each measured viewport and preserves deliberate zoom on panel changes',async({page})=>{
  await editor(page)
  for(const width of [320,375,768,1024,1280,1440]){
   await page.setViewportSize({width,height:948})
   await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
   await page.getByRole('button',{name:'Más acciones',exact:true}).click();const menu=page.getByRole('menu');await expect(menu).toBeVisible()
   const box=await menu.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);expect(box!.y+box!.height).toBeLessThanOrEqual(949)
   await page.keyboard.press('Escape');await expect(menu).toHaveCount(0)
   if(width===375||width===1440)await capture(page,`templates-editor-${width}.png`)
  }
  await page.getByTitle('Restablecer zoom al 100%',{exact:true}).click()
  const toggle=page.getByRole('button',{name:/^(Ocultar|Mostrar) panel$/});await toggle.click();await expect(page.getByTitle('Restablecer zoom al 100%',{exact:true})).toHaveText('100%')
 })
 test('reports conflicting saves without losing the draft and can preserve it as a copy',async({page,context})=>{
  await editor(page);const second=await context.newPage();await editor(second)
  await page.getByRole('textbox',{name:'Nombre de la plantilla'}).fill('Versión de la primera sesión');await save(page)
  await second.getByRole('textbox',{name:'Nombre de la plantilla'}).fill('Borrador de la segunda sesión')
  const failed=second.waitForResponse(r=>new URL(r.url()).pathname==='/api/document-templates/'+templateID&&r.request().method()==='PUT');await second.getByRole('button',{name:'Guardar',exact:true}).click();expect((await failed).status()).toBe(409)
  await expect(second.getByRole('textbox',{name:'Nombre de la plantilla'})).toHaveValue('Borrador de la segunda sesión')
  await expect(second.getByRole('button',{name:'Guardar como copia',exact:true})).toBeVisible();await capture(second,'templates-save-conflict.png')
  const copied=second.waitForResponse(r=>new URL(r.url()).pathname==='/api/document-templates'&&r.request().method()==='POST');await second.getByRole('button',{name:'Guardar como copia',exact:true}).click();expect((await copied).status()).toBe(201)
  await second.close()
 })
})
