import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
// Run: node scripts/offline/qa-conflict-dialog.mjs. Requires root/frontend npm ci and Playwright Chromium.
// Tests the actual dialog and CSS with a synthetic runtime hook; it does not test app grants or server persistence.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = join(root, 'frontend');
const output = join(root, '.runtime', 'qa', 'offline-conflict-dialog');
await mkdir(output, { recursive: true });
const require = createRequire(join(frontend, 'package.json'));
const { build } = require('esbuild');
const { chromium } = createRequire(join(root, 'package.json'))('@playwright/test');
const component = join(frontend, 'src/components/offline-v5/OfflineConflictDialog.tsx');
const cssPath = join(output, 'dialog.css');
const cssBuild = spawnSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-i', 'src/app/globals.css', '-o', cssPath, '--content', component], { cwd: frontend, encoding: 'utf8', timeout: 60000 });
if (cssBuild.status !== 0) throw new Error(cssBuild.stderr || 'Tailwind build failed');
const compiled = await build({
  stdin: { contents: `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import Dialog from ${JSON.stringify(component)};
  function App(){const [open,setOpen]=useState(false);return <main><button id="launcher" onClick={()=>setOpen(true)}>Revisar conflictos</button>{open&&<Dialog onClose={()=>setOpen(false)}/>}</main>};createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: frontend },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', tsconfig: join(frontend, 'tsconfig.json'),
  plugins: [{name:'synthetic-runtime-only',setup(builder){
    builder.onResolve({filter:/ClarinRuntimeProvider$/},()=>({path:'qa-runtime',namespace:'qa'}));
    builder.onLoad({filter:/.*/,namespace:'qa'},()=>({loader:'js',contents:`
      window.qaDecisions=[];window.qaFail=false;
      const long='Texto extenso para comprobar la lectura y el scroll en la misma ventana. '.repeat(30);
      window.qaItems=[{operation_id:'qa-1',action:'tasks.update',status:'conflict',fields:['title','description'],server_version:3,
        local:{title:'Mi título local',description:long},server:{title:'Título del servidor',description:'Descripción del servidor'},
        operation:{action:'tasks.update',payload:{title:'Mi título local',description:long}},
        optimistic_entity:{entity_id:'qa-task',entity_type:'task',value:{id:'qa-task',title:'Mi título local'}}}];
      const conflicts=async()=>window.qaItems;
      const resolveConflict=async decision=>{if(window.qaFail)throw new Error('Fallo de prueba: decisión conservada');window.qaDecisions.push(decision);window.qaItems=window.qaItems.filter(item=>item.operation_id!==decision.operation_id)};
      const snapshot={userId:'qa-user',accountId:'qa-account',conflictCount:1};
      export function useClarinRuntime(){return {snapshot,conflicts,resolveConflict}};
    `}));
  }}],
});
const css = await readFile(cssPath,'utf8');
const script = compiled.outputFiles[0].text;
let probeHits=0;
const server=createServer((request,response)=>{
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) { response.writeHead(403); response.end(); return; }
  if(request.url==='/probe'){probeHits++;response.end('online');return;}
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script>${script}</script>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[];
try{
  for(const viewport of [{width:1440,height:900},{width:375,height:667}]){
    const context=await browser.newContext({viewport});const page=await context.newPage();
    await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:' + port ? route.continue() : route.abort('blockedbyclient'));
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}`);await page.locator('#launcher').click();
    const dialog=page.getByRole('dialog',{name:'Revisar cambios sin sincronizar'});
    await dialog.waitFor();await page.getByText('Mi título local',{exact:true}).waitFor();
    await context.setOffline(true);
    const offline=await page.evaluate(async()=>{try{await fetch('/probe');return false}catch{return true}});
    if(!offline||probeHits)throw new Error('Network was not blocked');
    const geometry=await dialog.evaluate(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,modal:node.matches(':modal')}});
    if(!geometry.modal||geometry.x<0||geometry.y<0||geometry.x+geometry.width>viewport.width+1||geometry.y+geometry.height>viewport.height+1||geometry.scrollWidth>geometry.clientWidth+1)throw new Error('Dialog outside viewport '+JSON.stringify(geometry));
    const save=page.getByRole('button',{name:'Guardar selección'});
    if(await save.isEnabled())throw new Error('Missing field decisions were accepted');
    const groups=page.getByRole('group');
    await groups.nth(0).getByRole('radio',{name:/Mi cambio local/}).check();
    if(await save.isEnabled())throw new Error('Partial decision was accepted');
    await groups.nth(1).getByRole('radio',{name:/Versión del servidor/}).check();
    await page.evaluate(()=>window.qaFail=true);await save.click();
    await page.getByRole('alert').filter({hasText:'Fallo de prueba'}).waitFor();
    const alertBox=await page.getByRole('alert').boundingBox();
    if(!alertBox||alertBox.y<geometry.y||alertBox.y+alertBox.height>geometry.y+geometry.height)throw new Error('Save failure is clipped outside the dialog');
    if(!await groups.nth(0).getByRole('radio',{name:/Mi cambio local/}).isChecked())throw new Error('Failure lost choice');
    await page.screenshot({path:join(output, String(viewport.width) + '.png'),fullPage:true});
    await page.evaluate(()=>window.qaFail=false);await save.click();
    await page.getByText(/No quedan conflictos/).waitFor();
    const decisions=await page.evaluate(()=>window.qaDecisions);
    if(JSON.stringify(decisions)!==JSON.stringify([{operation_id:'qa-1',choice:'fields',fields:{title:'local',description:'server'}}]))throw new Error('Unexpected decision '+JSON.stringify(decisions));
    await page.keyboard.press('Escape');
    if(await page.locator('dialog').count())throw new Error('Escape did not dismiss');
    if(!await page.locator('#launcher').evaluate(node=>node===document.activeElement))throw new Error('Focus was not restored');
    if(errors.length)throw new Error('Browser errors '+errors.join(','));
    results.push({viewport,geometry,offline,probeHits,decision:decisions[0],focusRestored:true,errorVisible:true});await context.close();
  }
  await writeFile(join(output, 'result.json'),JSON.stringify({passed:true,scope:'Real component + generated Tailwind CSS; synthetic runtime hook. No app/server persistence exercised.',results},null,2));
  console.log(JSON.stringify({passed:true,results}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
