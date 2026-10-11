import { describe, expect, it } from 'vitest'
import { DocumentImageLoadError, documentImageIssueReasonLabel, documentImageResourceName } from './resourceErrors'

describe('document image diagnostics', () => {
  it('keeps useful Unicode filenames and removes legacy IDs, origin, account and credentials', () => {
    const source = 'https://user:password@example.invalid/api/media/file/account/document-images/360d18a9-b9cf-4fa1-a7bb-8d75ac478bdf_NA_logo_Escuela%20de%20Filosof%C3%ADa.png?access=secret&token=hidden#private'
    expect(documentImageResourceName(source)).toBe('NA_logo_Escuela de Filosofía.png')
    expect(documentImageResourceName('/api/media/file/account/document-images/20e56c6c-5ce7-4c3e-85fd-ede422f6d23e_Logo%20CATM%20(2).png')).toBe('Logo CATM (2).png')
  })

  it('does not display machine IDs, embedded content, query escapes or malformed URLs', () => {
    const hash = 'a'.repeat(64)
    expect(documentImageResourceName(`/api/media/file/account/media/png/${hash}-360d18a9-b9cf-4fa1-a7bb-8d75ac478bdf.png`)).toBe('Imagen')
    expect(documentImageResourceName('data:image/png;base64,private')).toBe('Imagen incrustada')
    expect(documentImageResourceName('blob:https://example.invalid/private-id')).toBe('Imagen local')
    expect(documentImageResourceName('/folder/logo.png%3Ftoken%3Dprivate')).toBe('logo.png')
    expect(documentImageResourceName('http://[invalid')).toBe('Imagen')
    expect(documentImageResourceName('/folder/%E0%A4.png')).toBe('Imagen')
  })

  it('bounds filenames and removes control or misleading direction characters', () => {
    expect(documentImageResourceName('/folder/Logo%E2%80%AE%0A%20%20azul.png')).toBe('Logo azul.png')
    const name = documentImageResourceName(`${'🎨'.repeat(120)}.png`)
    expect(Array.from(name)).toHaveLength(100)
    expect(name.endsWith('…')).toBe(true)
  })

  it('bounds and freezes safe issues without claiming all failures were found', () => {
    const error = new DocumentImageLoadError(Array.from({ length: 12 }, (_, index) => ({
      name: `/api/media/file/account/logo-${index}.png?token=private`, reason: 'unavailable' as const,
    })))
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('DocumentImageLoadError')
    expect(error.issues).toHaveLength(8)
    expect(error.incomplete).toBe(true)
    expect(Object.isFrozen(error.issues)).toBe(true)
    expect(Object.isFrozen(error.issues[0])).toBe(true)
    expect(JSON.stringify(error)).not.toMatch(/token|private|\/api\/|account/)
    expect(error.message).not.toMatch(/12|8|eliminad|borrad/)
  })

  it('offers controlled labels without asserting why a 404 happened', () => {
    expect(documentImageIssueReasonLabel('unavailable')).toBe('El archivo no está disponible o no tienes acceso desde esta cuenta.')
    expect(documentImageIssueReasonLabel('unauthorized')).toContain('sesión')
    expect(documentImageIssueReasonLabel('forbidden')).toContain('permiso')
    expect(documentImageIssueReasonLabel('timeout')).toContain('tardó')
    expect(documentImageIssueReasonLabel('load-failed')).toBe('No se pudo leer la imagen. Revisa la conexión o el archivo.')
  })
})
