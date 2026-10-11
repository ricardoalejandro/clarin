import {isolatedNativeLogin} from './helpers/isolated-native-login'
import {test,expect,type Page} from '@playwright/test'
import {readFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
const enabled=process.env.CLARIN_TEMPLATES_BROWSER_QA==='1'
const base=process.env.PLAYWRIGHT_BASE_URL||'http://localhost:13001'
const manifest=process.env.CLARIN_STORAGE_UI_QA_MANIFEST||resolve('work/storage-templates-qa/fixture.private.json')
const evidence=process.env.CLARIN_TEMPLATES_QA_EVIDENCE_DIR||resolve('work/storage-templates-qa/evidence')
let actor:{username:string;password:string}
async function login(page:Page){await isolatedNativeLogin(page,base,actor)}
async function create(page:Page){
 const response=await page.request.post(base+'/api/document-templates',{data:{name:'Interacciones de diseño QA',description:'',canvas_json:{},page_width:210,page_height:140,page_orientation:'landscape'}})
 expect(response.status()).toBe(201);const id=(await response.json()).template.id
 await page.goto(base+'/dashboard/documents/'+id);await expect(page.getByRole('button',{name:'Guardar',exact:true})).toBeEnabled();return id
}
async function save(page:Page,id:string){const result=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/document-templates/'+id&&r.request().method()==='PUT');await page.getByRole('button',{name:'Guardar',exact:true}).click();const response=await result;expect(response.status()).toBe(200);return (await response.json()).template}
async function clear(page:Page,id:string){const current=await page.request.get(base+'/api/document-templates/'+id);if(current.ok()){const template=(await current.json()).template;await page.request.delete(base+'/api/document-templates/'+id+'?expected_revision='+template.revision)}}
async function canvasPoint(page:Page){const box=await page.locator('canvas.upper-canvas').boundingBox();if(!box)throw new Error('Canvas not measured');return {x:box.x+box.width*.4,y:box.y+box.height*.45}}
test.describe('Native template object interactions',()=>{
 test.skip(!enabled,'requires isolated local API/database/storage')
 test.beforeAll(()=>{if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Only isolated loopback browser QA');actor=JSON.parse(readFileSync(manifest,'utf8')).actors.admin_a;mkdirSync(evidence,{recursive:true})})
 test('uploads raster, cancels crop, preserves frame with contain and saves filters canonically',async({page})=>{
  await login(page);const id=await create(page)
  try{
   const data=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=200;c.height=120;const x=c.getContext('2d')!;x.fillStyle='#059669';x.fillRect(0,0,100,120);x.fillStyle='#FACC15';x.fillRect(100,0,100,120);return c.toDataURL('image/png').split(',')[1]})
   const uploaded=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/document-templates/assets'&&r.request().method()==='POST')
   await page.locator('input[type=file]').first().setInputFiles({name:'editor-test.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')})
   expect((await uploaded).status()).toBe(200);await expect(page.getByRole('button',{name:'Recortar y ajustar',exact:true})).toBeVisible()
   const before=await save(page,id),original=before.canvas_json.fabricJson.objects[0]
   expect(before.thumbnail_url).toMatch(/\/api\/media\/file\//);await expect(page.getByText('Cambios guardados. La miniatura se actualizará al volver a guardar.')).toHaveCount(0)
   await page.getByRole('button',{name:'Más acciones',exact:true}).click()
   let menu=page.getByRole('menu',{name:'Acciones de la plantilla'})
   await expect(menu.getByRole('menuitem',{name:'Reemplazar imagen',exact:true})).toBeEnabled()
   await menu.getByRole('menuitem',{name:'Recortar y ajustar',exact:true}).click()
   let dialog=page.getByRole('dialog',{name:'Editar imagen',exact:true});await dialog.getByRole('button',{name:'1:1',exact:true}).click()
   await dialog.getByRole('slider',{name:'Brillo',exact:true}).focus();await page.keyboard.press('ArrowRight')
   await dialog.getByRole('button',{name:'Cancelar',exact:true}).click()
   const cancelled=await save(page,id);expect(cancelled.canvas_json.fabricJson.objects[0]).toEqual(original)
   await page.getByRole('button',{name:'Recortar y ajustar',exact:true}).click();dialog=page.getByRole('dialog',{name:'Editar imagen',exact:true})
   await dialog.getByRole('button',{name:'1:1',exact:true}).click();await dialog.getByRole('button',{name:'Encajar en marco',exact:true}).click()
   await dialog.getByRole('slider',{name:'Brillo',exact:true}).focus();await page.keyboard.press('ArrowRight')
   await dialog.getByRole('button',{name:'Aplicar',exact:true}).click()
   const changed=await save(page,id),group=changed.canvas_json.fabricJson.objects[0],image=group.objects.find((o:any)=>String(o.type).toLowerCase()==='image')
   expect(group.elementType).toBe('image-frame');expect(group.width).toBeCloseTo(original.width);expect(group.height).toBeCloseTo(original.height);expect(image.scaleX).toBeCloseTo(image.scaleY);expect(image.filters.find((f:any)=>f.type==='Brightness').brightness).toBeGreaterThan(0)
   // The context command keeps the image-frame semantics after a contain crop.
   await page.getByRole('button',{name:'Más acciones',exact:true}).click()
   menu=page.getByRole('menu',{name:'Acciones de la plantilla'})
   await expect(menu.getByRole('menuitem',{name:'Recortar y ajustar',exact:true})).toBeEnabled()
   const replacementData=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=90;c.height=270;const x=c.getContext('2d')!;x.fillStyle='#2563EB';x.fillRect(0,0,90,135);x.fillStyle='#DB2777';x.fillRect(0,135,90,135);return c.toDataURL('image/png').split(',')[1]})
   const chooser=page.waitForEvent('filechooser'),replacementUpload=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/document-templates/assets'&&r.request().method()==='POST')
   await menu.getByRole('menuitem',{name:'Reemplazar imagen',exact:true}).click()
   await (await chooser).setFiles({name:'replacement.png',mimeType:'image/png',buffer:Buffer.from(replacementData,'base64')})
   expect((await replacementUpload).status()).toBe(200)
   await expect(page.getByRole('button',{name:'Guardar',exact:true})).toBeEnabled()
   const replaced=await save(page,id),replacementFrame=replaced.canvas_json.fabricJson.objects[0],replacementImage=replacementFrame.objects.find((o:any)=>String(o.type).toLowerCase()==='image')
   expect(replaced.canvas_json.fabricJson.objects).toHaveLength(1)
   expect(replacementFrame.elementType).toBe('image-frame');expect(replacementFrame.imageFit).toBe('contain')
   for(const key of ['left','top','width','height','angle','scaleX','scaleY'])expect(replacementFrame[key]).toBeCloseTo(group[key])
   expect(replacementImage.filters).toEqual(image.filters)
   expect(replacementImage.src).not.toBe(image.src)
   expect(replacementImage.scaleX).toBeCloseTo(replacementImage.scaleY)
   expect(replacementImage.width/replacementImage.height).toBeCloseTo(90/270)
   await page.reload();await expect(page.getByRole('button',{name:'Guardar',exact:true})).toBeEnabled();await page.screenshot({path:resolve(evidence,'templates-image-frame.png')})
  }finally{await clear(page,id)}
 })
 test('draws freehand, applies a palette color and restores it with complete history',async({page})=>{
  await login(page);const id=await create(page)
  try{
   await page.getByRole('button',{name:'Dibujo libre (B)',exact:true}).click();const p=await canvasPoint(page)
   await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+80,p.y+50,{steps:12});await page.mouse.move(p.x+150,p.y+10,{steps:12});await page.mouse.up();await page.keyboard.press('Escape')
   await page.locator('canvas.upper-canvas').click({position:{x:8,y:8}});await page.keyboard.press('Control+a')
   await page.getByRole('button',{name:'Color del contorno',exact:true}).click();const picker=page.getByRole('dialog',{name:'Color del contorno',exact:true})
   await picker.getByRole('button',{name:'#D97706',exact:true}).click()
   const colored=await save(page,id),path=colored.canvas_json.fabricJson.objects.find((o:any)=>String(o.type).toLowerCase()==='path');expect(path.stroke).toBe('#D97706')
   await page.getByRole('button',{name:'Deshacer',exact:true}).click();const undone=await save(page,id);expect(undone.canvas_json.fabricJson.objects.find((o:any)=>String(o.type).toLowerCase()==='path').stroke).not.toBe('#D97706')
   await page.getByRole('button',{name:'Rehacer',exact:true}).click();const redone=await save(page,id);expect(redone.canvas_json.fabricJson.objects.find((o:any)=>String(o.type).toLowerCase()==='path').stroke).toBe('#D97706')
  }finally{await clear(page,id)}
 })
 test('protects browser Back without losing the draft or rewriting history entries',async({page})=>{
  await login(page)
  // Same-document SPA entry is required: a full page.goto would use beforeunload.
  await page.goto(base+'/dashboard/documents')
  await page.getByRole('button',{name:'Nueva plantilla',exact:true}).click()
  const createDialog=page.getByRole('dialog',{name:'Nueva plantilla',exact:true})
  await createDialog.getByLabel('Nombre',{exact:true}).fill('Interacciones de diseño QA')
  await createDialog.getByRole('button',{name:'Crear y diseñar',exact:true}).click()
  await page.waitForURL(/\/dashboard\/documents\/[^/]+$/);const id=page.url().split('/').pop()!
  try{
   await expect(page.getByRole('button',{name:'Guardar',exact:true})).toBeEnabled()
   const name=page.getByRole('textbox',{name:'Nombre de la plantilla'});await name.fill('Borrador que debe sobrevivir')
   const before=await page.evaluate(()=>({length:history.length,state:JSON.stringify(history.state)}))
   await page.evaluate(()=>history.back())
   const dialog=page.getByRole('dialog',{name:'Tienes cambios sin guardar',exact:true});await expect(dialog).toBeVisible()
   await dialog.getByRole('button',{name:'Seguir editando',exact:true}).click()
   await expect(name).toHaveValue('Borrador que debe sobrevivir')
   expect(await page.evaluate(()=>({length:history.length,state:JSON.stringify(history.state)}))).toEqual(before)
   await page.evaluate(()=>history.back());await expect(dialog).toBeVisible()
   await dialog.getByRole('button',{name:'Guardar y continuar',exact:true}).click()
   await expect(page.getByRole('heading',{name:'Plantillas',exact:true})).toBeVisible()
   const canonical=await page.request.get(base+'/api/document-templates/'+id);expect((await canonical.json()).template.name).toBe('Borrador que debe sobrevivir')
  }finally{await clear(page,id)}
 })
 test('clamps native right-click menus to each corner and cancels a provisional shape',async({page})=>{
  await login(page);const id=await create(page)
  try{
   if(await page.getByRole('button',{name:'Ocultar panel',exact:true}).isVisible())await page.getByRole('button',{name:'Ocultar panel',exact:true}).click()
   const canvas=page.locator('canvas.upper-canvas'),box=(await canvas.boundingBox())!
   for(const point of [{x:3,y:3},{x:box.width-3,y:3},{x:3,y:box.height-3},{x:box.width-3,y:box.height-3}]){
    await canvas.click({button:'right',position:point});const menu=page.getByRole('menu',{name:'Acciones de la plantilla'});await expect(menu).toBeVisible();const rect=(await menu.boundingBox())!,view=page.viewportSize()!
    await expect(menu.getByRole('menuitem')).toHaveCount(4)
    await expect(menu.getByRole('menuitem',{name:'Ajustar página',exact:true})).toBeEnabled()
    await expect(menu.getByRole('menuitem',{name:'Eliminar plantilla…',exact:true})).toHaveCount(0)
    await expect(menu.locator('button:disabled')).toHaveCount(0)
    expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.y).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(view.width);expect(rect.y+rect.height).toBeLessThanOrEqual(view.height)
    await page.keyboard.press('ArrowDown');await expect(menu.locator('[role="menuitem"]:focus')).toHaveCount(1)
    if(point.x>box.width/2&&point.y>box.height/2)await page.screenshot({path:resolve(evidence,'templates-context-menu.png')})
    await page.keyboard.press('Escape');await expect(menu).toHaveCount(0)
   }
   await page.getByTitle('Restablecer zoom al 100%',{exact:true}).click()
   await canvas.click({button:'right',position:{x:40,y:40}})
   await page.getByRole('menuitem',{name:'Ajustar página',exact:true}).click()
   await expect(page.getByTitle('Restablecer zoom al 100%',{exact:true})).not.toHaveText('100%')
   await canvas.click({button:'right',position:{x:box.width*.4,y:box.height*.45}})
   await page.getByRole('menuitem',{name:/^Insertar rectángulo/}).click()
   // A context insertion happens immediately at the scene point; no second click.
   const inserted=await save(page,id);expect(inserted.canvas_json.fabricJson.objects).toHaveLength(1)
   await canvas.click({position:{x:8,y:8}})
   await page.getByRole('button',{name:'Más acciones',exact:true}).click()
   await page.getByRole('menuitem',{name:/^Seleccionar todo/}).click()
   await expect(page.getByRole('button',{name:'Duplicar',exact:true})).toBeEnabled()
   await page.getByRole('button',{name:'Deshacer',exact:true}).click()
   await page.getByRole('button',{name:'Rectángulo (R)',exact:true}).click();const p=await canvasPoint(page);await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+80,p.y+60);await page.keyboard.press('Escape');await page.mouse.up()
   const saved=await save(page,id);expect(saved.canvas_json.fabricJson.objects).toHaveLength(0)
  }finally{await clear(page,id)}
 })
})
