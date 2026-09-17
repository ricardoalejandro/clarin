# Offline web v5 — checkpoint de implementación, QA y producción

## Estado final

Implementación, pruebas de calidad y despliegue completados el 15 de septiembre de 2026.

- Versión productiva: `2026.09.15-1-204349039330758-d420a6bea1a5`.
- Despliegue: `make deploy`, código `0`.
- Arquitectura: exclusivamente navegador; no hay instalador, aplicación de escritorio, extensión, servicio Windows, certificado de cliente, BitLocker, Hyper-V ni VM.
- Rollout productivo: protocolo `5`, habilitado, preparación habilitada, escrituras habilitadas y blobs deshabilitados.
- No se crearon grants, políticas, manifiestos ni recibos automáticamente durante el despliegue. El superadmin sigue siendo quien autoriza cada acceso real.
- No queda una implementación nativa pendiente para este alcance. No reiniciar el trabajo desde v3/v4 en una sesión futura.

## Contrato funcional cerrado

Clarín usa las mismas páginas, rutas y componentes Next tanto online como offline. Las rutas auxiliares estáticas `offline-v5-program` y `offline-v5-whiteboard` son únicamente shells de compilación que reexportan los componentes canónicos; el usuario permanece en `/dashboard/programs/:id` y `/dashboard/whiteboards/:id`.

El superadmin autoriza la tupla exacta perfil de navegador + usuario Clarín + cuenta Clarín y los módulos disponibles. Después, ese usuario elige hasta 20 recursos raíz. Solo se descargan esos recursos y sus dependencias imprescindibles; elegir un recurso nunca autoriza ni descarga toda la cuenta.

Un superadmin activo también puede ser el usuario objetivo de una autorización offline. Esto no incorpora administración global a la copia: el grant continúa limitado a la cuenta aprobada, el perfil de navegador, los cuatro módulos permitidos, sus capacidades cerradas, la selección exacta y la ACL viva de cada recurso.

Una misma instalación normal de Chrome o Edge puede conservar copias de varios usuarios y cuentas. Cada registro cifrado queda vinculado a `browser_profile_id`, `grant_id`, `user_id`, `account_id`, manifiesto, selección y época de autoridad. Las sesiones son secuenciales y una identidad no puede leer, mutar ni sincronizar la copia de otra.

Al faltar conectividad se sigue usando la web instalada por el propio navegador. El usuario ve un indicador discreto de modo offline. Si Cloudflare o el origen fallan, Clarín ofrece esperar o entrar offline; una respuesta auténtica `401/403` de Clarín nunca se convierte en fallback. Recuperar Internet no saca al usuario del modo offline ni cambia su identidad: exige reautenticación explícita para volver online.

Cerrar completamente el navegador y volver a abrir la misma dirección sin red permite desbloquear una copia preparada y todavía vigente. La contraseña solicitada es la contraseña actual de Clarín: se usa de forma transitoria para derivar/desbloquear claves y nunca se persiste, se cachea ni se envía como credencial offline reutilizable.

## Funciones editables incluidas

Las capacidades se emiten solamente para un recurso elegido y vuelven a comprobarse con la ACL viva al preparar y al sincronizar.

- Tareas: leer, crear, editar campos permitidos, completar, reabrir y comentar.
- Contactos: leer, editar identidad/campos permitidos y crear observaciones.
- Programas: leer/editar el programa, participantes y ciclo de vida, sesiones, asistencia, observaciones y metas.
- Pizarras: leer y actualizar la escena canónica.

Archivos, adjuntos y cualquier función que no tenga transporte offline completo permanecen explícitamente solo online. `blob_sync_enabled=false` es intencional y el backend ignora una variable antigua que intentara habilitarlo.

## Arquitectura y seguridad implementadas

- Service Worker raíz: shell público de dos generaciones, manifiesto y cada activo verificados por SHA-256/tamaño; CacheStorage no almacena API, snapshots, nombres, cuentas, cookies ni datos privados.
- SharedWorker v5: único dueño del material criptográfico desbloqueado, sesiones y acceso a IndexedDB; bloqueo por inactividad tras 30 minutos.
- IndexedDB: AES-256-GCM, AAD ligado a la identidad completa y blind indexes. La clave de perfil es no exportable y las claves de cada grant permanecen envueltas/cifradas.
- Manifiesto y lease: representación canónica firmada ES256 por el firmante aislado, vigencia máxima de 24 horas, épocas de credencial/autoridad y selección exacta.
- Sincronización: operaciones idempotentes, dependencias ordenadas, recibos por hash exacto, recuperación tras pérdida de ACK sin repetir mutaciones, conflictos conservados y política inicial server-wins.
- Autorización: grant activo, tupla exacta, claves, revisión, manifiesto, selección, capacidad y ACL viva se validan antes de preprocesar o despachar una operación.
- Límites: el body y los máximos de 100 operaciones/20 snapshots se rechazan antes de trabajo criptográfico, consultas costosas o materialización de pizarras.
- Kill switches: `PREPARE=false` bloquea challenges, claves, preparación y renovación; permite solamente recuperar recibos exactos ya comprometidos. `WRITES=false` nunca despacha una mutación.
- El firmante no publica claves privadas y su endpoint interno de claves exige autenticación. El endpoint público del backend entrega una JWK EC P-256 de firma sin parámetro privado `d`.
- El fallback de navegación es HTML público literal con CSP y sin datos de usuario. Las APIs quedan bloqueadas por el Service Worker mientras la sesión está offline, salvo sincronización y la transición explícita autorizada.

## Calidad ejecutada sobre el árbol final

- Backend: `GOCACHE=/tmp/go-build go test ./...`, `go build ./...` y `go vet ./...`: PASS.
- Regresión de superadmin objetivo: prueba unitaria focalizada y flujo completo Request/Approve/Prepare/Sync contra PostgreSQL temporal con un segundo superadmin aprobador: PASS. La base temporal fue retirada.
- Integración PostgreSQL efímera con firmante/timeout: PASS en 39,97 s; cubre recibo current/superseded, pérdida de respuesta y ausencia de replay/preprocesado.
- Frontend TypeScript: `npx tsc --noEmit`: PASS.
- Frontend Vitest final sin carga competidora: 258/258 archivos y 1.380/1.380 pruebas PASS.
- Editor Excalidraw: 23/23 pruebas PASS. Hardening, licencias y dependencias: 39/39 PASS.
- Offline v5 focalizado: 12/12 archivos y 79/79 pruebas PASS.
- Pruebas de cuatro archivos inicialmente sensibles a temporización: 252/252 en cuatro repeticiones. Solo se corrigió la espera de la misma evidencia observable en tests; no se aumentaron timeouts ni se cambió producto.
- Build de producción: Next 16.3.5 + React 19.3.0 sobre Node 24.21.0, 34 páginas, 659 activos v5 y 924 artefactos del editor: PASS.
- Playwright Chromium real: 7/7 PASS, sin skipped/unexpected/flaky. Cubre perfil normal vs autorizado, rutas canónicas, CacheStorage público, Cloudflare 503, `403` auténtico, cierre total/reapertura sin red y rollback de generación corrupta.
- Escaneo formal de seguridad `b5bf43c2-3e14-4578-874e-7f5b7ca10ce1`: 474/474 elementos inventariados, cero hallazgos Critical/High/Medium/Low.
- `git diff --check`, `docker compose config --quiet` y contrato de despliegue del navegador: PASS.

## Evidencia de producción

Corrección de elegibilidad de superadmin desplegada el `2026-09-15` como versión `2026.09.15-1-204349039330758-d420a6bea1a5`: backend, frontend y firmante saludables, `/health` con PostgreSQL y Redis `ok`, changelog productivo actualizado y logs de arranque sin errores. El navegador automatizado abrió el login público real, pero Turnstile exigió verificación humana y no emitió token; la protección no se deshabilitó ni se eludió. La aceptación visual final de esa solicitud requiere un navegador humano autenticado, mientras que la misma rama de autorización quedó ejercitada directamente en integración PostgreSQL.

Comprobado entre `2026-09-15T20:07:24Z` y `2026-09-15T20:15:43Z`:

- `clarin-backend`, `clarin-offline-signer` y `clarin-codex-bridge`: healthy; frontend y task-preview-worker: running.
- `/health`: `healthy`, PostgreSQL y Redis `ok`.
- `/api/version`: versión exacta del despliegue y changelog Offline v5 incluido.
- `/api/offline/v5/runtime/availability`: `enabled=true`, `prepare_enabled=true`, `writes_enabled=true`, `blob_sync_enabled=false`, `protocol_version=5`, `max_resources=20`, `max_offline_seconds=86400`.
- Respuesta pública real mediante Cloudflare/Traefik: `200`, `X-Clarin-Response: 1`, `X-Clarin-Offline-Protocol: 5`, `Cache-Control: no-store`.
- `/api/offline/v5/grants` y `/api/admin/offline-v5/grants` sin sesión: `401`. El `401` público mantiene los marcadores de Clarín y no puede confundirse con un fallo de infraestructura.
- `/sw.js`: `200`, `Service-Worker-Allowed: /`, `no-store`, contiene v5 y el build exacto.
- Manifiesto público: protocolo 5, origen exacto `https://clarin.naperu.cloud`, build exacto y 659 activos.
- Verificación pública completa: 659/659 activos, 34.355.106 bytes, SHA-256 y tamaño correctos; cero fallos.
- PostgreSQL productivo: 10/10 tablas `offline_v5_*`, constraints validados, índice único de manifiesto vigente y PK idempotente de recibos.
- Conteos posteriores al despliegue: 0 políticas, 0 manifiestos y 0 recibos v5; no hubo promoción o aprobación automática.
- Logs posteriores al arranque: sin coincidencias `error`, `fatal`, `panic`, `exception`, `unhandled` o `failed` en backend, frontend, firmante, worker o bridge.
- Backup privado previo y catálogo `pg_restore` verificado: `.runtime/offline/v4-backups/2026-09-15T19-23-57-613Z-dd47b4b2`. El nombre histórico del directorio v4 corresponde al script existente; el dump y el firmante respaldan el estado inmediatamente anterior a v5. No se ensayó restauración.

## Límites operativos honestos

- El usuario no configura ni instala nada, pero el superadmin sí debe aprobar el perfil/usuario/cuenta y el usuario debe preparar su selección una vez mientras está online.
- Borrar los datos del sitio, usar limpieza automática agresiva o desinstalar el navegador elimina la copia local. El modo incógnito/privado no es compatible como almacenamiento durable.
- La cuota deseada es 5 GiB, pero el navegador y el sistema operativo controlan el espacio realmente concedido. Si no hay persistencia durable, la interfaz degrada honestamente a lectura y conserva pendientes ya cifrados.
- Una revocación no puede borrar mágicamente un navegador que está físicamente desconectado; invalida la siguiente preparación/sincronización y el lease vence como máximo en 24 horas. Los datos locales siguen cifrados.
- La sincronización ocurre cuando el navegador está abierto, desbloqueado y vuelve la conectividad; no existe un servicio oculto que sincronice con el navegador cerrado.

## Laboratorio v3 heredado

Los contenedores `clarin-offline-v3-lab-*` que todavía existen en el VPS son evidencia de laboratorio y no intervienen en Offline web v5. Permanecen en redes Compose separadas, la red de datos es interna, su único puerto publicado escucha en `127.0.0.1:19443`, no tienen etiquetas de proxy y no comparten redes con producción. No se eliminaron porque conservan volúmenes propios; su retiro posterior es una limpieza opcional, no un requisito funcional ni una instalación destinada al usuario.

## Instrucción de continuidad

Este alcance está implementado, probado y desplegado. En una tarea futura, comenzar leyendo este archivo y el runtime actual; no volver a diseñar certificados, instaladores, Windows services, Vault, VM ni el frontend paralelo v3/v4. Si se amplía el alcance, los siguientes candidatos explícitos son transporte seguro de blobs/adjuntos o aceptación manual con un grant real, nunca una dependencia nativa.
