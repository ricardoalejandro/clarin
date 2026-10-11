import type {StaticCanvas} from './runtime'
/** Blob encoding does not fetch data: URLs, which a strict CSP correctly blocks. */
export async function createDocumentThumbnail(canvas:StaticCanvas,pageWidth:number):Promise<Blob>{
 const raster=canvas.toCanvasElement(Math.min(1,320/pageWidth))
 try{return await new Promise<Blob>((resolve,reject)=>raster.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo crear la miniatura.')),'image/jpeg',.72))}
 finally{raster.width=0;raster.height=0}
}
