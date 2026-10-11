import { beforeEach, expect, it } from 'vitest'
import { normalizeExportPreference, readExportPreference, saveExportPreference } from './exportPreferences'
beforeEach(() => localStorage.clear())
it('starts images balanced and PDF in lossless print', () => {
 expect(readExportPreference('account:user', 'pdf')).toEqual({profile:'print',dpi:300,quality:.95,transparent:false})
 for (const format of ['png','jpeg'] as const) expect(readExportPreference('account:user',format)).toEqual({profile:'balanced',dpi:150,quality:.85,transparent:false})
})
it('scopes deliberate preferences by account, actor and format', () => {
 saveExportPreference('account:user','png',{profile:'custom',dpi:240,quality:.9,transparent:true})
 expect(readExportPreference('account:user','png')).toEqual({profile:'custom',dpi:240,quality:.9,transparent:true})
 for(const identity of ['other:user','account:other']) expect(readExportPreference(identity,'png').profile).toBe('balanced')
 expect(readExportPreference('account:user','pdf').profile).toBe('print')
 expect(readExportPreference('account:user','jpeg').profile).toBe('balanced')
 saveExportPreference('account:user','jpeg',{profile:'print',dpi:300,quality:.95,transparent:false})
 expect(readExportPreference('account:user','jpeg').profile).toBe('print')
})
it('rejects malformed settings using the format default and bounds custom settings',()=>{
 expect(normalizeExportPreference({profile:'oops',dpi:10})).toMatchObject({profile:'print',dpi:300})
 expect(normalizeExportPreference({profile:'oops',dpi:10},'png')).toMatchObject({profile:'balanced',dpi:150})
 expect(normalizeExportPreference({profile:'custom',dpi:9000,quality:-5})).toMatchObject({dpi:600,quality:.1})
 for (const format of ['pdf','png','jpeg'] as const) {
  localStorage.setItem(`clarin:document-export:v1:a:${format}`,'broken')
  expect(readExportPreference('a',format).profile).toBe(format==='pdf'?'print':'balanced')
 }
})
