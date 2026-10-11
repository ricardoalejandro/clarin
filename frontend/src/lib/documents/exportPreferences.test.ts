import { beforeEach, expect, it } from 'vitest'
import { normalizeExportPreference, readExportPreference, saveExportPreference } from './exportPreferences'
beforeEach(() => localStorage.clear())
it('defaults to lossless print and scopes preferences by account, actor and format', () => {
 expect(readExportPreference('account:user', 'pdf')).toEqual({profile:'print',dpi:300,quality:.95,transparent:false})
 saveExportPreference('account:user','png',{profile:'custom',dpi:240,quality:.9,transparent:true})
 expect(readExportPreference('account:user','png')).toEqual({profile:'custom',dpi:240,quality:.9,transparent:true})
 for(const [identity,format] of [['other:user','png'],['account:other','png'],['account:user','pdf']] as const) expect(readExportPreference(identity,format).profile).toBe('print')
})
it('rejects malformed settings and bounds custom resolutions and quality',()=>{
 expect(normalizeExportPreference({profile:'oops',dpi:10})).toMatchObject({profile:'print',dpi:300})
 expect(normalizeExportPreference({profile:'custom',dpi:9000,quality:-5})).toMatchObject({dpi:600,quality:.1})
 localStorage.setItem('clarin:document-export:v1:a:pdf','broken')
 expect(readExportPreference('a','pdf').profile).toBe('print')
})
