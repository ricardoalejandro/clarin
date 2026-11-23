import * as asn1 from 'asn1js'
import * as pki from 'pkijs'
import { CompactEncrypt, compactDecrypt, importPKCS8, importSPKI, SignJWT, jwtVerify } from 'jose'
import { CryptoInputError, decodeBase64, encodeBase64, encodeHex, generateAesKey, generateRsaKeys } from './cryptoOperations'

export type VaultKind = 'aes' | 'rsa' | 'ec' | 'certificate'
export interface KeyMaterial {
  kind: VaultKind
  algorithm: string
  secret?: string
  privateKey?: string
  publicKey?: string
  certificates: string[]
  requests?: string[]
  curve?: 'P-256' | 'P-384'
}
export interface VaultCandidate {
  kind: VaultKind
  algorithm: string
  bits?: number
  public_data: string
  material: string
  metadata: Record<string, unknown>
}
const MAX_BYTES = 1024 * 1024
const RSA_OID = '1.2.840.113549.1.1.1'
const EC_OID = '1.2.840.10045.2.1'
const curves = { '1.2.840.10045.3.1.7': 'P-256', '1.3.132.0.34': 'P-384' } as const
const bytes = (value: BufferSource) => new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
const buffer = (value: Uint8Array) => new Uint8Array(value).buffer
function engine() {
  if (!globalThis.crypto?.subtle) throw new CryptoInputError('Esta operación requiere HTTPS y Web Crypto.')
  pki.setEngine('clarin', new pki.CryptoEngine({ name: 'clarin', crypto: globalThis.crypto }))
  return globalThis.crypto.subtle
}
export function toPem(label: string, value: BufferSource) {
  const body = encodeBase64(bytes(value), 'base64').match(/.{1,64}/g)?.join('\n') || ''
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}
export function fromPem(source: string, label: string) {
  if (source.length > MAX_BYTES * 2) throw new CryptoInputError('El archivo de claves supera 1 MiB.')
  const expression = new RegExp(`^\\s*-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----\\s*$`)
  const match = expression.exec(source)
  if (!match) throw new CryptoInputError(`Se requiere PEM ${label}.`)
  return buffer(decodeBase64(match[1], 'base64', MAX_BYTES))
}
async function fingerprint(value: BufferSource) { return encodeHex(new Uint8Array(await engine().digest('SHA-256', value))) }
function nameOf(name: pki.RelativeDistinguishedNames) {
  const labels: Record<string, string> = { '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.10': 'O', '2.5.4.11': 'OU' }
  return name.typesAndValues.map(entry => `${labels[entry.type] || entry.type}=${String((entry.value as asn1.Utf8String).valueBlock.value)}`).join(', ')
}
async function certificateMetadata(cert: pki.Certificate) {
  const sanExtension = cert.extensions?.find(entry => entry.extnID === '2.5.29.17')
  const san = sanExtension ? pki.GeneralNames.fromBER(buffer(sanExtension.extnValue.valueBlock.valueHexView)) : undefined
  return {
    fingerprint: await fingerprint(cert.toSchema().toBER()), subject: nameOf(cert.subject), issuer: nameOf(cert.issuer),
    not_before: cert.notBefore.value.toISOString(), not_after: cert.notAfter.value.toISOString(),
    san: san instanceof pki.GeneralNames ? san.names.filter(name => name.type === 2 || name.type === 6).map(name => String(name.value)) : [],
    format: 'X.509',
  }
}
async function candidate(material: KeyMaterial, bits: number, extra: Record<string, unknown> = {}): Promise<VaultCandidate> {
  const visible = material.publicKey || material.certificates[0] || ''
  const publicBytes = visible ? fromPem(visible, material.publicKey ? 'PUBLIC KEY' : 'CERTIFICATE') : buffer(decodeBase64(material.secret || '', 'base64', 64))
  const key_usage = material.secret ? ['encrypt', 'decrypt'] : material.privateKey ? material.kind === 'rsa' ? ['sign', 'verify', 'encrypt', 'decrypt'] : ['sign', 'verify'] : material.kind === 'rsa' ? ['verify', 'encrypt'] : ['verify']
  return { kind: material.kind, algorithm: material.algorithm, ...(bits > 0 ? { bits } : {}), public_data: visible, material: JSON.stringify(material), metadata: { fingerprint: await fingerprint(publicBytes), key_usage, format: material.kind === 'aes' ? 'Base64' : 'PEM', ...extra } }
}
export async function generateVaultKey(kind: 'aes' | 'rsa' | 'ec', size: number | string): Promise<VaultCandidate> {
  const subtle = engine()
  if (kind === 'aes') {
    if (size !== 128 && size !== 256) throw new CryptoInputError('Elige AES-128 o AES-256.')
    return candidate({ kind, algorithm: 'AES-GCM', secret: await generateAesKey(size), certificates: [] }, size)
  }
  if (kind === 'rsa') {
    if (size !== 2048 && size !== 3072 && size !== 4096) throw new CryptoInputError('Elige RSA-2048, 3072 o 4096.')
    return candidate({ kind, algorithm: 'RSA', ...await generateRsaKeys(size), certificates: [] }, size)
  }
  if (size !== 'P-256' && size !== 'P-384') throw new CryptoInputError('Elige P-256 o P-384.')
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: size }, true, ['sign', 'verify'])
  return candidate({ kind, algorithm: 'ECDSA', curve: size, privateKey: toPem('PRIVATE KEY', await subtle.exportKey('pkcs8', pair.privateKey)), publicKey: toPem('PUBLIC KEY', await subtle.exportKey('spki', pair.publicKey)), certificates: [] }, size === 'P-256' ? 256 : 384, { curve: size })
}
async function importAsymmetric(data: ArrayBuffer, privateKey: boolean, certs: string[] = []) {
  const subtle = engine()
  const info = privateKey ? pki.PrivateKeyInfo.fromBER(data) : pki.PublicKeyInfo.fromBER(data)
  const identifier = info instanceof pki.PrivateKeyInfo ? info.privateKeyAlgorithm : info.algorithm
  const rsa = identifier.algorithmId === RSA_OID
  const curveOid = identifier.algorithmParams instanceof asn1.ObjectIdentifier ? identifier.algorithmParams.valueBlock.toString() : ''
  const curve = curves[curveOid as keyof typeof curves]
  if (!rsa && (identifier.algorithmId !== EC_OID || !curve)) throw new CryptoInputError('Solo se admiten RSA y curvas P-256/P-384.')
  const algorithm = rsa ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: curve! }
  const key = await subtle.importKey(privateKey ? 'pkcs8' : 'spki', data, algorithm, true, [privateKey ? 'sign' : 'verify'])
  const jwk = await subtle.exportKey('jwk', key)
  const publicJwk: JsonWebKey = { ...jwk, key_ops: ['verify'] }
  for (const property of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'] as const) delete publicJwk[property]
  const publicKey = privateKey ? await subtle.importKey('jwk', publicJwk, algorithm, true, ['verify']) : key
  const bits = rsa ? (publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength : curve === 'P-256' ? 256 : 384
  if (rsa && (bits < 2048 || bits > 4096)) throw new CryptoInputError('Se admiten claves RSA de 2048 a 4096 bits.')
  const material: KeyMaterial = { kind: rsa ? 'rsa' : 'ec', algorithm: rsa ? 'RSA' : 'ECDSA', publicKey: toPem('PUBLIC KEY', await subtle.exportKey('spki', publicKey)), certificates: certs }
  if (!rsa) material.curve = curve
  if (privateKey) material.privateKey = toPem('PRIVATE KEY', data)
  if (certs.length) {
    const matchingIndex = certs.findIndex(cert => {
      const certInfo = pki.Certificate.fromBER(fromPem(cert, 'CERTIFICATE')).subjectPublicKeyInfo.toSchema().toBER()
      return encodeBase64(new Uint8Array(certInfo), 'base64') === encodeBase64(new Uint8Array(fromPem(material.publicKey!, 'PUBLIC KEY')), 'base64')
    })
    if (matchingIndex < 0) throw new CryptoInputError('Ningún certificado corresponde a la clave privada importada.')
    if (matchingIndex > 0) certs.unshift(certs.splice(matchingIndex, 1)[0])
  }
  return candidate(material, bits, certs.length ? await certificateMetadata(pki.Certificate.fromBER(fromPem(certs[0], 'CERTIFICATE'))) : !rsa ? { curve } : {})
}
async function importCertificates(certificates: string[]) {
  const first = pki.Certificate.fromBER(fromPem(certificates[0], 'CERTIFICATE'))
  // Parse every certificate before claiming the entire collection was imported.
  for (const pem of certificates) pki.Certificate.fromBER(fromPem(pem, 'CERTIFICATE'))
  return candidate({ kind: 'certificate', algorithm: 'X.509', certificates, publicKey: toPem('PUBLIC KEY', first.subjectPublicKeyInfo.toSchema().toBER()) }, 0, await certificateMetadata(first))
}
export async function importVaultFile(data: ArrayBuffer, filename: string, password = ''): Promise<VaultCandidate> {
  engine()
  if (data.byteLength > MAX_BYTES) throw new CryptoInputError('El archivo de claves o certificados supera 1 MiB.')
  if (/\.(?:p12|pfx)$/i.test(filename)) {
    try {
      const pfx = pki.PFX.fromBER(data)
      const pass = new TextEncoder().encode(password).buffer
      await pfx.parseInternalValues({ password: pass, checkIntegrity: true })
      const safe = pfx.parsedValue?.authenticatedSafe
      if (!safe || safe.safeContents.length > 32) throw new Error('Unsupported safe')
      await safe.parseInternalValues({ safeContents: safe.safeContents.map(item => item.contentType === '1.2.840.113549.1.7.6' ? { password: pass } : {}) })
      const groups = safe.parsedValue.safeContents as { value: pki.SafeContents }[]
      let key: ArrayBuffer | undefined
      const certificates: string[] = []
      for (const group of groups) for (const bag of group.value.safeBags) {
        if (![ '1.2.840.113549.1.12.10.1.1', '1.2.840.113549.1.12.10.1.2', '1.2.840.113549.1.12.10.1.3' ].includes(bag.bagId)) throw new CryptoInputError('Este P12 contiene entradas no admitidas. Exporta las claves y certificados por separado para conservarlos completos.')
        if (bag.bagValue instanceof pki.CertBag && bag.bagValue.parsedValue instanceof pki.Certificate) certificates.push(toPem('CERTIFICATE', bag.bagValue.parsedValue.toSchema().toBER()))
        if (bag.bagValue instanceof pki.PKCS8ShroudedKeyBag || bag.bagValue instanceof pki.PrivateKeyInfo) {
          if (key) throw new CryptoInputError('Este P12 contiene varias claves privadas. Exporta una entrada por archivo para importarla.')
          if (bag.bagValue instanceof pki.PrivateKeyInfo) key = bag.bagValue.toSchema().toBER()
          else {
            const encrypted = new pki.EncryptedData({ encryptedContentInfo: new pki.EncryptedContentInfo({ contentEncryptionAlgorithm: bag.bagValue.encryptionAlgorithm, encryptedContent: bag.bagValue.encryptedData }) })
            key = await encrypted.decrypt({ password: pass })
          }
        }
      }
      if (key) return importAsymmetric(key, true, certificates)
      if (certificates.length) return importCertificates(certificates)
      throw new CryptoInputError('El almacén no contiene claves o certificados compatibles.')
    } catch (error) {
      if (error instanceof CryptoInputError) throw error
      throw new CryptoInputError('No se pudo abrir el P12/PFX. Revisa la contraseña y el formato; se requieren algoritmos compatibles con Web Crypto.')
    }
  }
  const text = new TextDecoder().decode(data).trim()
  if (/\.jwe$/i.test(filename)) {
    try {
      const opened = await compactDecrypt(text, new TextEncoder().encode(password), { keyManagementAlgorithms: ['PBES2-HS512+A256KW'], contentEncryptionAlgorithms: ['A256GCM'], maxPBES2Count: 100_000 })
      try { return await importVaultFile(buffer(opened.plaintext), 'key.jwk') } finally { opened.plaintext.fill(0) }
    } catch { throw new CryptoInputError('No se pudo autenticar el JWK protegido. Comprueba la contraseña y el archivo.') }
  }
  if (text.startsWith('{')) {
    let jwk: JsonWebKey
    try { jwk = JSON.parse(text) as JsonWebKey } catch { throw new CryptoInputError('El JWK no es JSON válido.') }
    if (jwk.kty === 'oct' && jwk.k) {
      const secret = decodeBase64(jwk.k, 'base64url', 64)
      if (secret.length !== 16 && secret.length !== 32) throw new CryptoInputError('Se admiten claves AES de 128 o 256 bits.')
      return candidate({ kind: 'aes', algorithm: 'AES-GCM', secret: encodeBase64(secret, 'base64'), certificates: [] }, secret.length * 8)
    }
    if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') throw new CryptoInputError('El JWK debe ser AES, RSA o EC.')
    const algorithm = jwk.kty === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: jwk.crv || '' }
    const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: undefined, key_ops: [jwk.d ? 'sign' : 'verify'] }, algorithm, true, [jwk.d ? 'sign' : 'verify'])
    return importAsymmetric(await crypto.subtle.exportKey(jwk.d ? 'pkcs8' : 'spki', key), Boolean(jwk.d))
  }
  const certificates = [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map(match => `${match[0]}\n`)
  const privateMarkers = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----/g)]
  const privateBlocks = [...text.matchAll(/-----BEGIN (ENCRYPTED PRIVATE KEY|PRIVATE KEY)-----[\s\S]+?-----END \1-----/g)]
  if (privateMarkers.length > 1) throw new CryptoInputError('El archivo contiene varias claves privadas. Importa una entrada por archivo.')
  if (privateMarkers.length !== privateBlocks.length) throw new CryptoInputError('La clave privada debe estar completa y en formato PKCS#8 (PRIVATE KEY o ENCRYPTED PRIVATE KEY).')
  if (privateBlocks[0]?.[1] === 'PRIVATE KEY') return importAsymmetric(fromPem(privateBlocks[0][0], 'PRIVATE KEY'), true, certificates)
  if (privateBlocks[0]?.[1] === 'ENCRYPTED PRIVATE KEY') {
    let decoded: ArrayBuffer
    try {
      const bag = pki.PKCS8ShroudedKeyBag.fromBER(fromPem(privateBlocks[0][0], 'ENCRYPTED PRIVATE KEY'))
      const encrypted = new pki.EncryptedData({ encryptedContentInfo: new pki.EncryptedContentInfo({ contentEncryptionAlgorithm: bag.encryptionAlgorithm, encryptedContent: bag.encryptedData }) })
      decoded = await encrypted.decrypt({ password: new TextEncoder().encode(password).buffer })
    } catch { throw new CryptoInputError('No se pudo abrir la clave privada. Comprueba la contraseña y el formato PKCS#8.') }
    return importAsymmetric(decoded, true, certificates)
  }
  if (certificates.length) return importCertificates(certificates)
  if (text.includes('-----BEGIN PUBLIC KEY-----')) return importAsymmetric(fromPem(text, 'PUBLIC KEY'), false)
  try {
    const cert = pki.Certificate.fromBER(data)
    return importVaultFile(new TextEncoder().encode(toPem('CERTIFICATE', cert.toSchema().toBER())).buffer, 'certificate.pem')
  } catch { /* Try binary key encodings after X.509. */ }
  try { return await importAsymmetric(data, true) } catch { /* Public SPKI is the last supported binary representation. */ }
  try { return await importAsymmetric(data, false) } catch { throw new CryptoInputError('Archivo no compatible. Usa P12/PFX, JWK, X.509 o PEM/DER SPKI y PKCS#8.') }
}
export function parseKeyMaterial(value: string): KeyMaterial {
  let item: KeyMaterial
  try { item = JSON.parse(value) as KeyMaterial } catch { throw new CryptoInputError('El material guardado no tiene un formato compatible.') }
  if (!item || !['aes', 'rsa', 'ec', 'certificate'].includes(item.kind) || !Array.isArray(item.certificates)) throw new CryptoInputError('El material guardado no tiene un formato compatible.')
  return item
}
async function signingKey(material: KeyMaterial) {
  engine()
  if (!material.privateKey || (material.kind !== 'rsa' && material.kind !== 'ec')) throw new CryptoInputError('Esta operación necesita una clave privada RSA o EC.')
  const algorithm = material.kind === 'rsa' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: material.curve! }
  return crypto.subtle.importKey('pkcs8', fromPem(material.privateKey, 'PRIVATE KEY'), algorithm, true, ['sign'])
}
export async function createCertificateRequest(material: KeyMaterial, commonName: string, dns: string[], selfSigned = false) {
  if (!commonName.trim() || commonName.length > 255 || dns.length > 100 || dns.some(name => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(name))) throw new CryptoInputError('Indica un nombre común y nombres DNS válidos.')
  const key = await signingKey(material)
  const publicInfo = pki.PublicKeyInfo.fromBER(fromPem(material.publicKey!, 'PUBLIC KEY'))
  const subject = new pki.RelativeDistinguishedNames({ typesAndValues: [new pki.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1.Utf8String({ value: commonName.trim() }) })] })
  const extensions = dns.length ? [new pki.Extension({ extnID: '2.5.29.17', extnValue: new pki.GeneralNames({ names: dns.map(value => new pki.GeneralName({ type: 2, value })) }).toSchema().toBER() })] : []
  if (!selfSigned) {
    const request = new pki.CertificationRequest({ version: 0, subject, subjectPublicKeyInfo: publicInfo, attributes: extensions.length ? [new pki.Attribute({ type: '1.2.840.113549.1.9.14', values: [new pki.Extensions({ extensions }).toSchema()] })] : [] })
    await request.sign(key, material.curve === 'P-384' ? 'SHA-384' : 'SHA-256')
    return toPem('CERTIFICATE REQUEST', request.toSchema().toBER())
  }
  const serial = crypto.getRandomValues(new Uint8Array(16)); serial[0] &= 0x7f; serial[0] ||= 1
  const cert = new pki.Certificate({ version: 2, serialNumber: new asn1.Integer({ valueHex: serial.buffer }), subject, issuer: subject, subjectPublicKeyInfo: publicInfo,
    notBefore: new pki.Time({ value: new Date(Date.now() - 60_000) }), notAfter: new pki.Time({ value: new Date(Date.now() + 365 * 86_400_000) }),
    extensions: [new pki.Extension({ extnID: '2.5.29.19', critical: true, extnValue: new pki.BasicConstraints({ cA: false }).toSchema().toBER() }), ...extensions] })
  await cert.sign(key, material.curve === 'P-384' ? 'SHA-384' : 'SHA-256')
  return toPem('CERTIFICATE', cert.toSchema().toBER())
}
export async function exportVaultKey(material: KeyMaterial, format: 'pem' | 'jwk' | 'jwk-protected' | 'p12' | 'certificate' | 'certificate-der' | 'public' | 'csr', password: string): Promise<{ data: string | Uint8Array; filename: string }> {
  engine()
  if (format === 'jwk-protected') {
    if (password.length < 8 || password.length > 1024) throw new CryptoInputError('Usa una contraseña de exportación de 8 a 1024 caracteres.')
    const exported = await exportVaultKey(material, 'jwk', '')
    const plain = new TextEncoder().encode(exported.data as string)
    try {
      const encrypted = await new CompactEncrypt(plain).setProtectedHeader({ alg: 'PBES2-HS512+A256KW', enc: 'A256GCM', p2c: 100_000 }).encrypt(new TextEncoder().encode(password))
      return { data: encrypted, filename: 'clave.jwk.jwe' }
    } finally { plain.fill(0) }
  }
  if (format === 'csr') {
    if (!material.requests?.length) throw new CryptoInputError('La entrada no tiene solicitudes CSR guardadas.')
    return { data: material.requests.join('\n'), filename: 'solicitudes.csr' }
  }
  if (format === 'certificate-der') {
    if (!material.certificates.length) throw new CryptoInputError('La entrada no tiene un certificado asociado.')
    return { data: new Uint8Array(fromPem(material.certificates[0], 'CERTIFICATE')), filename: 'certificado.cer' }
  }
  if (format === 'public') return { data: material.publicKey || material.certificates[0] || '', filename: 'publica.pem' }
  if (format === 'certificate') {
    if (!material.certificates.length) throw new CryptoInputError('La entrada no tiene un certificado asociado.')
    return { data: material.certificates.join('\n'), filename: 'certificados.pem' }
  }
  if (format === 'jwk') {
    if (material.kind === 'aes') return { data: JSON.stringify({ kty: 'oct', k: encodeBase64(decodeBase64(material.secret!, 'base64'), 'base64url'), ext: true }, null, 2), filename: 'clave.jwk' }
    const key = material.privateKey ? await signingKey(material) : await crypto.subtle.importKey('spki', fromPem(material.publicKey!, 'PUBLIC KEY'), material.kind === 'rsa' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: material.curve! }, true, ['verify'])
    return { data: JSON.stringify(await crypto.subtle.exportKey('jwk', key), null, 2), filename: 'clave.jwk' }
  }
  if (!material.privateKey) {
    if (material.kind === 'aes') throw new CryptoInputError('Exporta la clave AES como JWK; este formato contiene el secreto.')
    return { data: material.publicKey || material.certificates.join('\n'), filename: 'publica.pem' }
  }
  if (password.length < 8 || password.length > 1024) throw new CryptoInputError('Usa una contraseña de exportación de 8 a 1024 caracteres.')
  const protection = { password: new TextEncoder().encode(password).buffer, contentEncryptionAlgorithm: { name: 'AES-CBC', length: 256 } as pki.ContentEncryptionAlgorithm, hmacHashAlgorithm: 'SHA-256', iterationCount: 100_000 }
  const privateInfo = pki.PrivateKeyInfo.fromBER(fromPem(material.privateKey, 'PRIVATE KEY'))
  const bag = new pki.PKCS8ShroudedKeyBag({ parsedValue: privateInfo })
  await bag.makeInternalValues(protection)
  if (format === 'pem') return { data: toPem('ENCRYPTED PRIVATE KEY', bag.toSchema().toBER()), filename: 'privada-protegida.pem' }
  if (!material.certificates.length) throw new CryptoInputError('Para exportar P12/PFX importa un certificado correspondiente o crea uno autofirmado de prueba.')
  const safe = new pki.AuthenticatedSafe({ parsedValue: { safeContents: [{ privacyMode: 0, value: new pki.SafeContents({ safeBags: [new pki.SafeBag({ bagId: '1.2.840.113549.1.12.10.1.2', bagValue: bag }), ...material.certificates.map(cert => new pki.SafeBag({ bagId: '1.2.840.113549.1.12.10.1.3', bagValue: new pki.CertBag({ parsedValue: pki.Certificate.fromBER(fromPem(cert, 'CERTIFICATE')) }) }))] }) }] } })
  await safe.makeInternalValues({ safeContents: [{}] })
  const pfx = new pki.PFX({ parsedValue: { integrityMode: 0, authenticatedSafe: safe } })
  await pfx.makeInternalValues({ password: protection.password, iterations: 100_000, pbkdf2HashAlgorithm: 'SHA-256', hmacHashAlgorithm: 'SHA-256' })
  return { data: new Uint8Array(pfx.toSchema().toBER()), filename: 'certificado.p12' }
}
const jwtAlgorithm = (material: KeyMaterial) => material.kind === 'rsa' ? 'RS256' : material.kind === 'ec' ? material.curve === 'P-384' ? 'ES384' : 'ES256' : null
export async function signJwt(material: KeyMaterial, payload: string) {
  const alg = jwtAlgorithm(material)
  if (!alg || !material.privateKey) throw new CryptoInputError('Selecciona una clave privada RSA o EC para firmar.')
  if (new TextEncoder().encode(payload).byteLength > MAX_BYTES) throw new CryptoInputError('El contenido supera 1 MiB.')
  let claims: Record<string, unknown>
  try { claims = JSON.parse(payload) as Record<string, unknown> } catch { throw new CryptoInputError('El contenido JWT debe ser un objeto JSON válido.') }
  if (!claims || Array.isArray(claims) || typeof claims !== 'object') throw new CryptoInputError('El contenido JWT debe ser un objeto JSON.')
  return new SignJWT(claims).setProtectedHeader({ alg, typ: 'JWT' }).sign(await importPKCS8(material.privateKey, alg))
}
export async function verifyJwt(material: KeyMaterial, token: string) {
  const alg = jwtAlgorithm(material)
  if (!alg || !material.publicKey) throw new CryptoInputError('Selecciona una clave pública RSA o EC compatible.')
  if (token.length > MAX_BYTES * 1.4) throw new CryptoInputError('El JWT supera 1 MiB.')
  try {
    const verified = await jwtVerify(token.trim(), await importSPKI(material.publicKey, alg), { algorithms: [alg] })
    return JSON.stringify({ firma: 'verificada', algorithm: alg, payload: verified.payload }, null, 2)
  } catch { throw new CryptoInputError('La firma o las fechas del JWT no son válidas para la clave seleccionada.') }
}
