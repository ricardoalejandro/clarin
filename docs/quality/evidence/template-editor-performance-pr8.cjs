
const fs=require('fs');
const esbuild=require('/root/proyect/clarin/frontend/node_modules/esbuild');
const {chromium}=require('/root/proyect/clarin/node_modules/playwright');
(async()=>{
 const bundle=await esbuild.build({stdin:{contents:`
 import {Rect,Textbox} from '/root/proyect/clarin/frontend/src/lib/fabric/runtime.ts';
 import {createEditorCanvas,applyWheelPan} from '/root/proyect/clarin/frontend/src/lib/fabric/canvas.ts';
 import {createDocumentRenderSnapshot} from '/root/proyect/clarin/frontend/src/lib/fabric/editorSnapshot.ts';
 import {exportCanvasToBlob} from '/root/proyect/clarin/frontend/src/lib/fabric/export.ts';
 (window as any).runBenchmark=async(count:number)=>{
  const host=document.createElement('div');host.style.cssText='width:900px;height:650px';const el=document.createElement('canvas');host.append(el);document.body.append(host);
  const canvas=createEditorCanvas({canvasEl:el,containerEl:host,pageWidth:210,pageHeight:297,onZoomChange:()=>{},onSelectionChange:()=>{},onObjectModified:()=>{},onSnapGuides:()=>{},onDistanceLabels:()=>{}});
  canvas.renderOnAddRemove=false;const started=performance.now();
  for(let i=0;i<count;i++){const x=(i%20)*20,y=Math.floor(i/20)*10;canvas.add(i%4===0?new Textbox('Campo '+i,{left:x,top:y,width:36,fontSize:6}):new Rect({left:x,top:y,width:12,height:7,fill:i%2?'#059669':'#2563EB',strokeWidth:0}));}
  canvas.renderAll();const initialMs=performance.now()-started,measurements:any[]=[];
  for(const zoom of [.25,1,4]){canvas.setZoom(zoom);const samples:number[]=[];for(let i=0;i<24;i++){const t=performance.now();applyWheelPan(canvas,5,-3,false);canvas.renderAll();samples.push(performance.now()-t)}samples.sort((a,b)=>a-b);measurements.push({zoom,meanMs:+(samples.reduce((a,b)=>a+b,0)/samples.length).toFixed(2),p95Ms:+samples[Math.floor(samples.length*.95)].toFixed(2)});}
  const before=canvas.toObject(),startSnapshot=performance.now();const snapshot=await createDocumentRenderSnapshot(canvas,'page');const snapshotMs=performance.now()-startSnapshot;
  const startedExport=performance.now();const blob=await exportCanvasToBlob(canvas,{format:'png',dpi:96});const exportMs=performance.now()-startedExport;
  if(JSON.stringify(before)!==JSON.stringify(canvas.toObject()))throw new Error('Snapshot/export mutated scene');
  const result={count,initialMs:+initialMs.toFixed(2),measurements,snapshotMs:+snapshotMs.toFixed(2),exportMs:+exportMs.toFixed(2),exportBytes:blob.size,viewportUnchanged:true,objectCount:(snapshot.canvasJson.fabricJson as any).objects.length};
  await canvas.dispose();host.remove();return result;
 };`,loader:'ts',resolveDir:'/root/proyect/clarin/frontend'},bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',absWorkingDir:'/root/proyect/clarin/frontend',tsconfig:'/root/proyect/clarin/frontend/tsconfig.json',logLevel:'silent'});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1100,height:800}});
 await page.route('**/*',route=>route.fulfill({body:'',contentType:'text/css'}));
 await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 const results=[];for(const count of [30,200,1000])results.push(await page.evaluate(count=>window.runBenchmark(count),count));
 fs.writeFileSync('/tmp/clarin-editor-benchmark.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));await browser.close();
})().catch(error=>{console.error(error);process.exitCode=1});
