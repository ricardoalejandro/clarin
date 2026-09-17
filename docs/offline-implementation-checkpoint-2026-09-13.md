# Clarin Offline para Windows — estado de implementación y despliegue

Fecha de cierre: 2026-09-13 UTC

## Estado actual

El piloto offline sin certificados quedó implementado, probado y desplegado en
el VPS. La versión verificada en producción es:

`2026.09.13-1-213341056440881-d420a6bea1a5`

No se usa HashiCorp Vault, PKI, CA, certificados cliente, PFX ni Authenticode.
El instalador es interno y deliberadamente no firmado; se entrega únicamente
por la API HTTPS autenticada de Clarin y se verifica con SHA-256 en servidor y
frontend.

Artefacto desplegado:

- Ruta local: `.runtime/offline/artifacts/Clarin-Offline-Setup.exe`
- Ruta del contenedor: `/run/clarin-offline-artifacts/Clarin-Offline-Setup.exe`
- Versión de la app: `0.3.3`
- Plataforma: Windows 11 x64
- Tamaño desplegado: `122429365` bytes
- SHA-256 desplegado: `53e152719f669fb9af9cf955a696a1debd75686b0d11ae4fb0641ef62a623aaf`

## Corrección de identidad Windows 0.3.2 del 2026-09-13

- Se eliminó la dependencia de `ExportSubjectPublicKeyInfo()` de .NET, que no
  está disponible de forma fiable en Windows PowerShell 5.1 y provocaba el
  mensaje «Windows no pudo proteger la identidad offline de este equipo».
- La clave pública CNG se obtiene ahora mediante el formato nativo
  `EccPublicBlob` y se convierte dentro del agente a SPKI PEM.
- La firma CNG admite el formato P1363 devuelto por PowerShell 5.1 y lo
  normaliza a ASN.1 DER antes de enviarlo al backend.
- Si Windows no permite usar el proveedor CNG, el agente genera sin intervención
  una identidad ECDSA P-256 alternativa. Su clave privada se guarda únicamente
  dentro del perfil cifrado con DPAPI `CurrentUser`; nunca llega al backend.
- El fallo del camino CNG ya no bloquea el enrolamiento ni exige que el usuario
  abra PowerShell, cambie políticas o configure Windows.

## Robustez integral del cliente 0.3.3 del 2026-09-13

- El agente comprueba el SHA-256 canónico de cada snapshot antes de guardarlo;
  el backend calcula ahora ese hash sobre los mismos bytes JSON estables que
  viajan por la API.
- El almacén DPAPI valida completamente el perfil antes de publicarlo en
  memoria, recupera de forma segura el último archivo anterior y elimina los
  residuos temporales al ejecutar un borrado firmado.
- Los conflictos terminales dejan de permanecer indefinidamente en el outbox;
  los recibos se deduplican y se conservan con un límite de 2.000 entradas.
- Una tarea completada se vuelve a leer con progreso efectivo de 100 %, sin
  destruir el progreso manual que deba conservarse como historial.
- El cliente mínimo aceptado por producción es `0.3.3`; las versiones previas
  no pueden activar ni sincronizar una terminal con el protocolo corregido.

## Corrección de enrolamiento cero-config del 2026-09-13

- BitLocker y Windows Hello dejaron de ser requisitos que bloquean el
  enrolamiento. El único requisito técnico local es Windows 11 x64.
- La aplicación consulta ambos estados silenciosamente. El usuario no abre
  PowerShell, no ejecuta comandos y no configura seguridad del sistema para
  solicitar acceso.
- El agente transmite solo estados normalizados de postura, nunca texto crudo,
  rutas, secretos ni resultados completos de herramientas de Windows.
- Si BitLocker o Windows Hello están desactivados, no configurados o no se
  pueden determinar, la solicitud continúa. El superadmin ve la situación y
  debe confirmar expresamente el riesgo para aprobar ese equipo.
- La postura se actualiza durante cada sincronización y los cambios quedan en
  la auditoría de la terminal.
- Los fallos locales de enrolamiento se convierten en mensajes estables y
  comprensibles; la interfaz ya no muestra errores internos de Electron,
  PowerShell o el agente.

## Corrección de descarga y conflictos del 2026-09-13

- Se corrigió el cierre prematuro del archivo entregado por `SendStream`: el
  servidor HTTP conserva ahora la propiedad del descriptor hasta completar la
  transmisión y lo cierra después.
- El artefacto se sirve con tamaño explícito, `Content-Encoding: identity` y
  una política privada `no-store`, `no-cache` y `no-transform`.
- El frontend añade el SHA-256 a la URL como clave inmutable de versión y sigue
  descartando cualquier descarga cuyo cuerpo no coincida con el hash anunciado.
- Se corrigió el listado/resolución de conflictos para usar el catálogo global
  real de `roles`; el aislamiento sigue dependiendo de la membresía exacta
  `user_accounts(account_id,user_id)`.
- Se corrigieron dos carreras de la interfaz: la activación ya no publica el
  estado activo antes de que Windows confirme la persistencia, y una lectura
  tardía de selecciones ya no puede borrar una selección recién guardada.
- Las terminales sin grants se serializan como colecciones vacías y la pantalla
  administrativa deja de fallar al abrir solicitudes nuevas o rechazadas.
- La auditoría de selección ya no delega en PostgreSQL la inferencia de un
  parámetro sin tipo dentro de JSON; los metadatos se codifican en Go y se
  insertan explícitamente como `jsonb`.

## Corrección de limpieza QA y purga administrativa del 2026-09-13

- La previsualización de purga conserva en `null` las tablas opcionales que no
  existen en una instalación, pero ya no ejecuta consultas contra ellas.
- Solo se cuentan tablas confirmadas por `pg_catalog.pg_tables`; un error real
  sobre una tabla existente se devuelve y deja de ocultarse silenciosamente.
- El E2E final creó y purgó una cuenta completa sin errores en PostgreSQL y
  confirmó cero cuentas, usuarios y terminales QA residuales.

## Contrato funcional cerrado

- El usuario solicita acceso desde su propia sesión de Clarin en la aplicación
  Windows; no escribe ni copia usuario, cuenta, ID de terminal, SID, claves o
  códigos.
- Solo el superadmin global puede aprobar, rechazar o revocar la terminal.
- El superadmin selecciona entre una y cinco cuentas a las que el usuario ya
  pertenece y los módulos autorizados.
- El usuario selecciona hasta 20 recursos por cuenta entre los que ya puede
  consultar.
- Pizarras, Contactos y Programas son de solo lectura en este piloto.
- Tareas permite leer, crear y completar. La escritura vuelve a pasar por las
  ACL canónicas de Clarin Work y usa recibos idempotentes.
- La autorización offline dura como máximo 24 horas.
- El almacenamiento local está limitado a 5 GiB.
- Reiniciar Windows cambia la identidad de arranque y bloquea el acceso local
  hasta obtener una autorización nueva mediante sincronización online.
- El conflicto inicial conserva la versión canónica del servidor.
- Una revocación genera una orden de borrado firmada; el equipo solo borra al
  validar esa firma.

## Diseño criptográfico desplegado

### Terminal Windows

- Intenta generar una clave ECDSA P-256 nombrada en Microsoft CNG con política
  de exportación `None`.
- Si CNG no está disponible, usa una clave ECDSA P-256 guardada solo dentro del
  perfil cifrado con DPAPI `CurrentUser`.
- Solo la clave pública SPKI PEM llega al backend.
- La activación demuestra posesión de la clave firmando terminal e identidad de
  instalación.
- Cada petición de sincronización firma método, ruta, terminal, cuenta,
  challenge, nonce, contador, tipo de contenido y hash del cuerpo.
- El estado local se cifra con DPAPI y el directorio se restringe al usuario de
  Windows y `SYSTEM`.

### VPS

- `clarin-offline-signer` conserva una clave ECDSA P-256 distinta para leases y
  controles.
- Clave y token viven en volúmenes Docker persistentes separados.
- El signer no publica puertos al host, usa filesystem raíz de solo lectura,
  elimina capabilities y aplica `no-new-privileges`.
- El backend accede únicamente a `http://clarin-offline-signer:8200`; el código
  rechaza cualquier otra dirección, esquema, path, query o credencial embebida.
- La autenticación backend→signer usa un token aleatorio montado de solo lectura
  con propietario `0:65532` y modo `0440`.
- Las firmas se serializan como `clarin:v1:<ECDSA-DER-base64>` y el cliente exige
  coincidencia exacta de versión y clave pública.

## Superficies implementadas

- Configuración de usuario: descarga verificada, solicitud automática, estado
  de aprobación, selección de recursos con búsqueda de 500 ms y resolución
  server-wins.
- Administración global: lista de solicitudes/terminales, aprobación por cuenta
  y módulos, rechazo y revocación firmada.
- API browser/JWT: solicitudes, estado, instalador, grants, candidatos,
  selecciones y conflictos.
- API device-key v2: challenge, activación, sincronización, fetch selectivo y
  ACK de controles.
- Aplicación Electron: cambio automático entre Clarin online y la vista local,
  reintento al recuperar conectividad e IPC limitado por origen.
- Agente Go para Windows: CNG, DPAPI, leases ligados al arranque, cuota, outbox,
  replay protection, snapshots y wipe firmado.

## Persistencia y aislamiento

- Las migraciones están registradas en `backend/pkg/database/database.go`.
- Las tablas activas incluyen terminales, grants account-scoped, selecciones,
  heads, nonces, cursores, recibos, conflictos, controles y auditoría.
- Las tablas antiguas de certificados, pairing y enrolamiento fueron eliminadas
  únicamente después de comprobar que estaban vacías.
- Las columnas antiguas `certificate_pem`, `certificate_serial`,
  `certificate_not_after` y `csr_pem` ya no existen en producción.
- Candidatos y snapshots se filtran por `account_id`, membresía/módulo vigente y
  ACL del recurso. Las tareas de una lista usan la consulta actor-aware para no
  filtrar tareas privadas.

## Verificaciones realizadas

- Backend: `GOCACHE=/tmp/go-build go test ./...` — aprobado.
- Frontend: `npm run test:unit` — 203 archivos y 1.054 pruebas aprobadas.
- Frontend: `npx tsc --noEmit` — aprobado.
- Frontend: `npm run build` — aprobado, incluida verificación de Pizarras.
- Agente: tests Go y cross-build `GOOS=windows GOARCH=amd64` — aprobados.
- DPAPI Windows dentro de un perfil Wine limpio: `CryptProtectData` y
  `CryptUnprotectData` completaron el round-trip, junto con atomicidad,
  recuperación del estado anterior y eliminación de residuos — aprobado.
- Signer: tests Go, build y firma verificable — aprobados.
- App Electron: sintaxis y 6 pruebas de política/IPC/navegación — aprobadas.
- Detector de carreras Go (`go test -race`) en API/dominio/repositorio/config,
  agente y signer — aprobado.
- Compose válido; instalador reconocido como PE/NSIS y checksum comprobado.
- `make deploy` — aprobado.
- Contenedores backend, frontend, worker, signer, PostgreSQL, Redis, MinIO y
  Codex bridge — levantados; servicios con healthcheck en estado healthy.
- `/health` interno — `200 healthy` con PostgreSQL y Redis disponibles.
- `/api/version` interno y HTTPS público — versión desplegada confirmada.
- `/api/offline/v2/installer` sin JWT por HTTPS público — `401`.
- El instalador 0.3.3 montado en el backend coincide byte a byte con el artefacto
  local: `122429365` bytes y SHA-256
  `53e152719f669fb9af9cf955a696a1debd75686b0d11ae4fb0641ef62a623aaf`.
- E2E autenticado en producción — aprobado en 21,9 s: usuario no superadmin,
  rechazo, reintento, aprobación con riesgo, activación, descarga completa y
  hash, cuatro módulos, selecciones, firmas, anti-replay, snapshots, tarea
  offline, reconexión idempotente, conflicto server-wins, cambio de permisos,
  revocación, wipe firmado y ACK.
- `/api/offline/v2/conflicts?limit=100` con sesión temporal de QA — `200`; la
  sesión de QA fue retirada de Redis inmediatamente después de la prueba.
- `/api/offline/v2/challenge` con cuerpo inválido — `400 invalid terminal`, lo
  que confirma que v2 está activa.
- Backend→signer autenticado: lectura de clave pública y firma — aprobado.
- PostgreSQL real: tablas e índices v2 presentes; objetos PKI retirados ausentes.
- Logs de backend, frontend, worker y signer sin errores de arranque; PostgreSQL
  sin errores durante el E2E final ni durante la purga de su cuenta desechable.

## Única validación externa todavía necesaria

El VPS Linux no puede ejecutar una instalación física de Windows ni comprobar
Microsoft CNG, DPAPI y el cambio online/offline en una sesión humana real. El
siguiente smoke del piloto se realiza en una sola PC Windows 11 x64:

1. Un usuario no superadmin entra a Clarin y descarga el instalador desde
   Configuración → Offline.
2. Windows mostrará `Editor desconocido`; el usuario acepta porque esta primera
   entrega no usa Authenticode.
3. La app comprueba silenciosamente que sea Windows 11 x64, crea la clave local,
   consulta la postura disponible y envía la solicitud automáticamente. No se
   exige activar BitLocker ni Windows Hello.
4. El superadmin abre Admin → Terminales offline y aprueba una cuenta y los
   módulos deseados. Si la postura no es completa, confirma explícitamente el
   riesgo antes de aprobar.
5. El usuario elige entre 5 y 20 recursos, sincroniza, desconecta la red y
   valida lectura más creación/completado de tareas.
6. Reconecta y confirma que el cambio llega al servidor; después reinicia
   Windows y confirma que se requiere conexión para desbloquear otra vez.

No hace falta instalar Vault, crear certificados ni facilitar secretos para
realizar este smoke.
