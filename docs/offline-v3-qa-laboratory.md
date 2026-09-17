# Laboratorio aislado para Offline web v3

Este laboratorio rompe la dependencia circular «activar para probar / probar
antes de activar» sin abrir v3 en producción. Usa los **bytes exactos** del
instalador candidato y su mismo origen `https://clarin.naperu.cloud`. Las
imágenes backend/frontend/signer se capturan por ID inmutable; PostgreSQL,
Redis, MinIO y las claves del signer son nuevos y exclusivos de QA.

No es un certificado cliente ni una dependencia PKI del producto. La CA HTTPS
de laboratorio existe sólo para una **VM Windows 11 x64 desechable**. Nunca se
debe importar en una computadora habitual, en producción o en un perfil que
tenga sesiones reales de Clarín. No se modifica DNS público ni Cloudflare.

## Lo implementado y comprobable desde el VPS

Desde la raíz del repositorio, con Docker disponible:

```bash
node --test scripts/offline/qa-environment.test.mjs
node scripts/offline/qa-environment.mjs init
node scripts/offline/qa-environment.mjs up --turnstile-test
node scripts/offline/qa-environment.mjs smoke
node scripts/offline/qa-seed.mjs
node scripts/offline/qa-verify-fixtures.mjs
node scripts/offline/qa-environment.mjs kit
```

`init` rechaza sobrescribir un laboratorio existente. No lee `.env`, tokens,
volúmenes ni credenciales de producción. Genera contraseñas aleatorias y una
CA de duración limitada bajo `.runtime/offline/v3-qa` (directorio `0700`,
secretos `0600`, excluido de Git). No imprime secretos. No ejecutar `docker
compose config` sin `--quiet`: resolvería los secretos de los archivos env.

El proyecto Compose es `clarin-offline-v3-lab`. Sólo publica
`127.0.0.1:19443`, no `0.0.0.0`. La base de datos y servicios de aplicación
permanecen en una red `internal`. El gateway tiene una segunda red propia para
el binding loopback; Docker no materializa ese binding en una red exclusivamente
interna. No hay redes/volúmenes externos ni socket Docker dentro de contenedores.

El perfil explícito `turnstile-test` añade un proxy que acepta únicamente
`CONNECT challenges.cloudflare.com:443`; TLS sigue siendo validado extremo a
extremo por el backend. Se usan las claves públicas de prueba oficiales, no
se desactiva Turnstile ni se cambia `ENV=production`. Sin ese perfil, la
validación remota falla cerrada. Esto prueba la integración de test con
Cloudflare, **no** la configuración/seguridad del proveedor en producción.

`smoke` valida TLS, marcador aleatorio del laboratorio, hash exacto del EXE,
health, versión, configuración de seguridad, disponibilidad v3, login, SW y
shell. `qa-seed` vuelve a comprobar TLS + marcador antes de enviar cualquier
credencial o escritura. Cookies quedan sólo en RAM; no imprime ni guarda JWT.
No acepta una URL de destino configurable ni puede resolver al servidor público.

Fixtures creados exclusivamente por el API real del laboratorio:

- Dos cuentas ficticias A/B, diez usuarios **no superadmin** y un superadmin de
  laboratorio. Los diez tienen administración de A; sólo `offlineqa_user_01`
  pertenece también a B. Ser administrador de cuenta no autoriza offline.
- Por cuenta: un Entorno, dos listas, dos tareas, tres Contactos sin teléfono,
  un Programa de clases y una Pizarra vacía. Son datos ficticios, no copias de
  producción; no hay dispositivos WhatsApp ni integración Kommo.
- Un intento real de `offlineqa_user_02` de cambiar a B debe devolver `403`
  sin cookie nueva. No se crean solicitudes, aprobaciones ni grants offline.
- El ledger `fixtures.json` permite reanudar pasos confirmados sin duplicarlos.
  Ante una respuesta perdida/500 incierta, se detiene el paso para inspección,
  no repite escrituras a ciegas. Las contraseñas están sólo en el fichero privado
  `credentials.json`; el operador las distribuye por un canal seguro de QA.

## Refrescar después de un nuevo despliegue o candidato

El laboratorio no sigue tags `latest` ni reconstrucciones silenciosamente.
Antes de empezar Windows, si las imágenes o el candidato cambiaron:

```bash
node scripts/offline/qa-environment.mjs refresh
node scripts/offline/qa-environment.mjs up --turnstile-test
node scripts/offline/qa-environment.mjs smoke
node scripts/offline/qa-verify-fixtures.mjs
node scripts/offline/qa-environment.mjs kit
```

`refresh` requiere que el laboratorio esté accesible, comprueba que su
PostgreSQL tiene **cero solicitudes y grants offline**, detiene sólo este
proyecto, conserva la captura anterior y captura las imágenes desplegadas y
el candidato exacto actuales. Conserva fixtures y claves propios de QA. Toda
evidencia de una captura anterior queda obsoleta. Si ya hubo enrollment, no
actualizar el objetivo de una prueba en curso: se requiere un laboratorio nuevo
coordinado, no purgar las autorizaciones para sortear la guarda.

`qa-verify-fixtures` vuelve a autenticar dos usuarios mediante Turnstile de
prueba, verifica `/api/me`, el cambio permitido A→B y el cambio ajeno rechazado
sin cookie nueva ni cambio de identidad. No recrea recursos y cierra las
sesiones al terminar. Produce evidencia de autenticación vinculada a la captura
actual, no evidencia Windows. El no-op de un `qa-seed` ya completado no sustituye
esta revalidación después de actualizar imágenes.

## Preparación del ejecutor Windows (operador de QA)

Debe ser Windows 11 x64 real/virtualizado con Chrome y Edge reales. Wine,
Chromium Linux, una compilación cruzada o `Test-OfflineV3.ps1` por sí solos no
cumplen este requisito. Este procedimiento es **del laboratorio**, no del
usuario final.

1. Crear una VM desechable, usuario Windows exclusivo y snapshot limpio. No
   iniciar ninguna cuenta de producción ni copiar perfiles reales al laboratorio.
2. Copiar únicamente la carpeta `windows-kit-*` producida por `kit`. Contiene
   EXE, hashes, manifiesto, diagnóstico, esta guía, identidad QA y **certificado
   público** `qa-ca.crt`. Nunca copiar `ca.key`, `server.key`, archivos `.env`,
   directorios signer ni el almacén DPAPI de otra máquina.
3. Verificar SHA-256 de EXE y `qa-ca.crt` por un canal de administración confiable.
   La CA debe tener el nombre `Clarin Offline V3 DISPOSABLE QA ONLY`; usar un
   snapshot permite eliminarla al terminar sin tocar la máquina habitual.
4. **Sólo dentro de la VM**, como administrador, importar `qa-ca.crt` en el
   almacén raíz `LocalMachine` (el servicio LocalService también valida HTTPS):

   ```powershell
   Import-Certificate -FilePath .\qa-ca.crt -CertStoreLocation Cert:\LocalMachine\Root
   ```

5. **Sólo dentro de la VM**, añadir a su archivo `hosts` una única entrada
   `127.0.0.1 clarin.naperu.cloud`. No editar hosts del VPS/PC habitual ni DNS
   público. Preparar un túnel SSH autenticado al VPS, sin reenvío público:

   ```powershell
   ssh.exe -N -L 127.0.0.1:443:127.0.0.1:19443 usuario_qa@VPS
   ```

   El operador resuelve `usuario_qa@VPS` mediante su acceso autorizado; no se
   pide copiar claves privadas o credenciales SSH al chat. No usar
   `--ignore-certificate-errors`, `curl -k`, TLS skip-verify o un puerto distinto
   en la URL de Clarín: rompería la equivalencia del origen.
6. Abrir `https://clarin.naperu.cloud/__offline-v3-qa`, verificar el `run_id` y
   `installer_sha256` de `lab-identity.json`, conexión TLS sin aviso y que el
   servidor sea el laboratorio. Si no coincide, detenerse antes de login.
7. Instalar el EXE exacto dentro de la VM, aceptar UAC y el permiso de red local
   del navegador cuando corresponda. Entrar como usuario sintético, solicitar
   offline y aprobar la tupla exacta desde el superadmin **de laboratorio**.
   Elegir recursos y preparar la copia. El piloto de producción sigue apagado.

El túnel debe permanecer abierto durante las fases online. Cerrarlo interrumpe
Clarin sin desactivar Internet del navegador y permite probar fallback; un corte
de red de la VM prueba ausencia total de Internet. Después de reiniciar Windows,
primero probar apertura y desbloqueo offline **sin túnel**, y después reabrirlo
para reconexión. El certificado no omite ninguna comprobación del protocolo
offline; sólo transporta el origen exacto a un servidor QA.

## Evidencia obligatoria y fin del laboratorio

Ejecutar todos los checks de `requiredWindowsChecks` en
`scripts/offline/release-artifact.mjs` en **ambos** navegadores: DPAPI/ACL/UAC,
10 usuarios, dos cuentas, pestañas obsoletas, cierre/reapertura, reinicio real,
sync sellada, expiración/rollback de reloj, throttle, revocación, manipulación,
ACK perdido, readonly, caché sin datos privados, disco/cuota y actualización con
cola pendiente. Añadir escenas con imágenes y asistencia histórica desde los
APIs/UI normales; los fixtures vacíos no prueban esos casos por sí solos.

Las fallas HTTP de Cloudflare simuladas no se deben presentar como una caída
real del proveedor. Conservar las trazas y resultados exactos, sin credenciales,
vinculados al EXE y a la captura de imágenes. El diagnóstico sólo genera
`not_run` para checks funcionales que no ejecutó. Ningún script del laboratorio
escribe `windows-qa-report.json`, cambia el gate ni promueve el instalador.

Cuando termine:

```bash
node scripts/offline/qa-environment.mjs stop
```

Esto detiene contenedores propios pero conserva fixtures y evidencia. No hay
comando de purga automática. Revertir/eliminar la VM desechable elimina su trust
CA, hosts, perfiles y datos; en otro caso quitar explícitamente sólo esa CA y
entrada hosts. El operador coordina el ciclo de vida de la VM. Los certificados
de laboratorio expiran (CA 14 días; servidor 7 días); no ampliar validez ni
desactivar TLS como solución a una prueba tardía.

Referencias: [claves oficiales de prueba Turnstile](https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
[redes aisladas Compose](https://docs.docker.com/reference/compose-file/networks/) y
[selección explícita de archivos de entorno](https://docs.docker.com/compose/how-tos/environment-variables/envvars/).
