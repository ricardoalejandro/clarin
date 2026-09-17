# Offline v4 — continuidad de implementación

## Cierre verificado — 15 septiembre, 04:15 UTC

**Implementación, QA y despliegue completados.** Versión final `2026.09.15-1-040024992194032-d420a6bea1a5`, `make deploy` código 0; health, logs, `/api/version`, flags y schema real comprobados. 38/38 controles internos, 11/11 públicos y 510/510 assets SHA/tamaño PASS. V4 activo con autorización explícita; v3/enrollment nativo desactivados. Ningún grant real aprobado automáticamente.

La cola grande final también PASS: 12 tareas/2,4 MB, lotes 2.007.468 y 401.717 bytes, ACK perdido y replay rechazado, reintento sin duplicados, autor/cuenta/lista correctos y cola cero. 51/51 unitarios del motor y TSC finales, seis tests nuevos de backend y Go completo PASS. No queda pendiente implementar o desplegar este alcance. Los apartados siguientes son cronología, no trabajo para reiniciar.

Evidencia completa, imágenes, respaldos, limitaciones y operación: [offline-v4-verificacion-2026-09-15.md](offline-v4-verificacion-2026-09-15.md). Mantener pendientes cifrados y no borrar caché para actualizar. Pruebas Chrome/Edge realizadas en Linux VPS; no afirmar prueba física de Windows. Si se retoma, partir de este cierre y verificar únicamente cualquier incidencia nueva.

## Estado actual — 15 septiembre, 03:56 UTC

El primer `make deploy` terminó correctamente y producción sirve `2026.09.15-1-033315981588675-d420a6bea1a5`. Health, logs de backend/frontend/firmante/worker, 38 verificaciones internas de schema/identidad/acceso y 510/510 assets públicos SHA/tamaño PASS. **Entrega todavía abierta:** la verificación pública detectó dos ajustes de endurecimiento; se incorporan y requieren un segundo `make deploy` antes de cerrar.

- Traefik real es v2.11 en Swarm y usa file provider para Clarín; no consume las etiquetas de contenedores Compose. Se añadió `infra/offline/traefik-browser-v4.yml` y un instalador atómico exclusivo de ese archivo en el despliegue. La ruta activa utiliza la sintaxis `Path` con regexp nombrada de v2.11, prioridad 270, cuerpo 2 MiB y memoria 64 KiB. No se cambian rutas ajenas ni se reinicia el proxy. API interna confirmó estado `enabled`; HTTPS devolvió **413 antes del backend** para usuario/admin y mayúsculas. La primera variante `PathRegexp` quedó deshabilitada por v2.11, se corrigió y no cuenta como aceptación. Instalador/deploy/runtime: 13 unitarios PASS.
- Backend añade guard propio previo a auth/parsing: 413 por longitud declarada/real y 415 ante `Content-Encoding`, incluso duplicados, antes de descomprimir. Preserva v3 y uploads normales. Seis pruebas nuevas y `go test ./...` PASS; todavía pendiente publicar ese binario.
- Detectada agrupación por 50 operaciones sin límite de bytes: varias descripciones largas podían exceder el máximo del servidor. Motor está incorporando lotes por UTF-8/envelope sin perder orden/IDs/pendientes. Añadir prueba real focalizada con cola legítima mayor de 2 MiB antes de aceptación.
- El laboratorio v4 fue detenido conservando volúmenes y evidencias; se reabre solo para el caso focalizado. El laboratorio v3 previo no se modificó. No se han concedido autorizaciones reales automáticamente.

## Aceptación previa al primer despliegue — 15 septiembre, 03:34 UTC

Implementación y aceptación QA completadas; **despliegue en curso, todavía no acreditado en producción**. `make deploy` iniciado con versión `2026.09.15-1-033315981588675-d420a6bea1a5`. Los apartados posteriores conservan la cronología, no son pendientes actuales.

- Regresión final: **245 archivos / 1.290 pruebas Vitest PASS**, TypeScript PASS; backend y firmante `go test ./...` PASS. Comprobadores de despliegue/runtime: 8/8 PASS.
- Shell público final: **22 pruebas Chrome/Edge PASS** (`test-results/offline-v4-shell-final-report.json`), incluyendo ausencia de caché privada, navegación sin red, caída de Cloudflare, denegaciones auténticas y rollback de actualización corrupta.
- Recorridos completos reales Chrome y Edge PASS: diez usuarios, dos cuentas, once autorizaciones sintéticas, cuatro módulos, tareas offline, sincronización idempotente, pérdida de ACK y aislamiento de pendientes al cambiar usuario. Reportes `test-results/offline-v4-flow-{chrome,edge}-report.json`.
- Imagen QA final `sha256:0f06f5ffb40bbcd6ed534b5f79876db05aba56a8f98679f945cb641fa1c31ed1`: **4/4 humos PASS** (migración desde SW v3 público real y nueva solicitud posterior a aprobación antigua, ambos navegadores); **2/2 cierre completo/Cloudflare PASS**, incluido solo lectura cuando el navegador pierde persistencia y conservación del pendiente cifrado. Reportes `test-results/offline-v4-final-smokes-report.json` y `test-results/offline-v4-final-restart-report.json`.
- Pruebas de navegador ejecutadas en Linux VPS con datos sintéticos y Turnstile oficial de prueba; no equivalen a una prueba física de la PC Windows ni del proveedor de autenticación de producción. No hay fallos inyectados ni procesos propios de prueba pendientes.
- Backup reciente verificado: `.runtime/offline/v4-backups/2026-09-15T03-25-00-291Z-416cd270` (dump PostgreSQL, catálogo, SHA e imágenes; claves del firmante privadas). No se ha ensayado restauración.
- Configuración de producción persistida: `OFFLINE_V4_ENABLED=true`, `OFFLINE_V4_TASK_WRITES_ENABLED=true`; preflight Compose confirma origen `https://clarin.naperu.cloud` y v3/enrollment nativo desactivados. **Ningún usuario se aprueba automáticamente.** Estos valores no acreditan que los contenedores ya los apliquen.
- Siguiente paso: terminar `make deploy`, comprobar contenedores, health, logs, versión, schema real y endpoints públicos. Registrar resultado antes de afirmar despliegue completo. Nunca publicar la imagen QA, compilada para localhost.

## Contrato vigente (15 septiembre 2026)

El usuario autorizó implementar, probar y desplegar la arquitectura **exclusivamente navegador**. La misma URL de Clarín debe funcionar sin instalador, extensión, servicio Windows, certificados de cliente, BitLocker, Hyper-V o Sandbox. La arquitectura nativa v3 queda histórica y desactivada; sus pruebas no acreditan v4.

La autorización v4 es origen/perfil de navegador/usuario Clarín/cuenta/grant, con aprobación exclusiva del superadmin, selección del usuario, lease de 24 horas y bloqueo por inactividad de 30 minutos. El navegador no acredita hardware físico ni SID Windows. No se amplían permisos normales ni se convierten grants v3 automáticamente.

Se reutilizan vistas, proyecciones autorizadas, comandos transaccionales de tareas, recibos y actualización atómica del shell. Se sustituyen bridge localhost, SQLite/DPAPI y pruebas de instalación por IndexedDB cifrado + SharedWorker + API v4.

Misma contraseña Clarín, confirmada online antes de preparar; no nueva contraseña offline. PBKDF2-HMAC-SHA256 600.000/sal32 protege claves aleatorias AES256GCM por grant. Nunca persistir contraseña/hash backend/JWT en la copia. AAD vincula cada registro al contexto completo. Máximo 20 recursos/grant y 5 GiB/perfil sujetos a cuota; persistencia no concedida permite lectura, no escritura offline durable.

Tareas consultar/crear/completar; contactos/programas/pizarras solo lectura. Reapertura offline requiere copia preparada y contraseña. Reconexión no cambia identidad ni modo. Sincronización solo mientras el navegador está abierto/desbloqueado; revocación y borrado del almacenamiento tienen los límites documentados en el plan aprobado.

## Trabajo en curso — NO implica aceptación ni despliegue

- Backend: agente `browser_offline_plan_backend`, dueño de contratos, rutas, schema, ACL/snapshots/commands y firmas v4.
- Motor: agente `browser_offline_engine`, dueño de tipos, crypto, IndexedDB, SharedWorker, cliente y gateway v4.
- UI: agente `qa_environment_closure` reasignado; todo trabajo Windows/Sandbox cancelado. Dueño de paneles usuario/admin, runtime CSR y wiring login.
- Principal: Service Worker v4, build del shell/worker, CSP, despliegue desacoplado del instalador, integración y QA.

La rama tiene numerosos cambios previos ajenos: conservarlos. No reset/clean, no activar grants reales automáticamente y no publicar instalador. Flags v4 inicialmente apagados; solo habilitar tras verificar el flujo.

## Comprobaciones pendientes

Unitarios nuevos y regresión, PostgreSQL real aislado/migración doble, TypeScript/build, Chrome/Edge sin helper, diez usuarios y cuentas múltiples, cierre/reapertura, denegaciones auténticas vs Cloudflare, pérdida de ACK, corrupción/cuota, revocación, CSP/red y rollback. Ejecutar backup antes de migración de producción, `make deploy` y comprobaciones reales de contenedores/health/logs/version/schema. No afirmar que estas pruebas pasaron hasta registrar su ejecución y evidencia.

## Avance verificado — 15 septiembre, 01:41 UTC (trabajo en curso)

- Backend `GOCACHE=/tmp/go-build go test ./...`: PASS; firmante `go test ./...`: PASS.
- PostgreSQL sintético `v4_integration`: migración principal dos veces, FK de cuenta, dos usuarios/mismo perfil, selección ajena, nonce repetido, crear/completar/idempotencia, firma fallida con rollback, cuota y revocación: PASS. La firma mantiene los locks de autoridad hasta el commit.
- Motor: 30 pruebas de criptografía/cola/almacenamiento/API, diez usuarios y cuentas múltiples: PASS. UI: 39 pruebas focalizadas y TypeScript: PASS.
- Shell público: 22 pruebas en Chrome 153.0.8010.36 y Edge 153.0.4234.32 Linux: PASS (incluye cierre completo/reapertura, caída real del socket, Cloudflare, respuestas auténticas 403/429 y corrupción de assets). Repetir con los últimos ajustes del worker antes de aceptación.
- Primera regresión completa Vitest: 1.239/1.241 PASS; una cuenta de pendientes ya corregida y un timeout de Calendario bajo compilaciones simultáneas. Ambos archivos repetidos sin aumentar timeouts: 25/25 PASS. Repetición final de suite pendiente.
- Pruebas de dependencias: 7/7 PASS fuera del aislamiento, que había bloqueado sus subprocesos con EPERM. No se cambió Next.js/React/Node ni se aceptó ese bloqueo como éxito.
- Producción sigue en las imágenes anteriores y `health` comprobado a las 01:39 UTC: PostgreSQL y Redis saludables. NO se ha desplegado v4 ni habilitado grants reales.
- Laboratorio nuevo `.runtime/offline/v4-qa`: PG/Redis/MinIO/backend/firmante saludables, identidad verificada, dos cuentas y diez usuarios sintéticos preparados. Puerto solo loopback `http://localhost:19444`. No se copió información de producción.
- La imagen frontend de QA se compila con API/WS/APP hacia localhost:19444 porque las pantallas online tienen URLs de compilación. Playwright bloquea cualquier salida excepto el laboratorio y el widget oficial de prueba de Turnstile. No ejecutar contra el frontend anterior ni contra URLs productivas.
- El despliegue normal ya no exige un artefacto Windows. Hay limitación de cuerpo de 2 MiB en la ruta v4 de Traefik; pendiente verificarla tras despliegue.

Límites explícitos de esta implementación: hasta 20 recursos/grant, 5 GiB agregado/perfil sujeto a cuota, snapshot completo de hasta 8 MiB/5.000 filas por recurso y hasta 1.000 operaciones pendientes. Los límites rechazan sin truncar ni borrar pendientes; no son paginación de snapshots arbitrariamente grandes. Cambiar contraseña o permisos invalida épocas y requiere nueva autorización/preparación; no se promete renovación silenciosa de una copia cuya clave ya no pueda desbloquearse.

## Avance verificado — 15 septiembre, 02:02 UTC

- Regresión frontend final, después de congelar el producto: **243 archivos / 1.268 pruebas Vitest PASS**, además de 38 pruebas Node y 23 del editor en las fases previas de `npm run test:unit -- --run --maxWorkers=2`. TypeScript independiente PASS. La corrección de limpieza de `useTaskWindow.test.tsx` evita tareas React pendientes después de destruir JSDOM; no cambia el comportamiento del módulo.
- Motor final: 37 pruebas focalizadas PASS. UI final: 40 pruebas focalizadas PASS. Shell v4 repetido: 22 pruebas Chrome/Edge PASS; la recuperación adicional de login cuando falta el shell tiene cobertura unitaria.
- Imagen frontend QA compilada correctamente con origen exclusivamente `http://localhost:19444`, incluyendo TypeScript, render de producción, shell v4 y verificación del editor. ID Docker: `sha256:5bc13457407eb38b0d237cca2b39b8b62f11cdc29f7e5608c76ffdef483477b1`.
- Laboratorio actualizado a imágenes finales de backend, firmante y frontend; identidad exacta, salud PG/Redis y disponibilidad `protocol_version=4`, `enabled=true`, `task_writes_enabled=true` verificadas. Pruebas completas del flujo iniciadas, todavía **no aceptadas**.
- Backup privado de producción creado antes de migrar: `.runtime/offline/v4-backups/2026-09-15T01-42-52-788Z-22572a21`. Archivo PostgreSQL y catálogo `pg_restore --list` verificados; claves del firmante respaldadas sin imprimirlas. No se ha ensayado una restauración.
- Producción todavía NO se ha desplegado ni se han cambiado sus flags. No usar la imagen QA para producción: contiene URLs de compilación del laboratorio. El siguiente despliegue debe ser `make deploy` con URLs productivas, seguido de health/logs/version/schema reales.

## Hallazgos de integración — 15 septiembre, 02:15 UTC

- Chrome real detectó `Illegal invocation` al invocar `fetch` con un receptor de clase dentro del SharedWorker. Corregido mediante `globalThis.fetch(...)`; reproducción real muestra HTTP 200 con la corrección y el error anterior sin ella. API unitarios: 7/7 PASS.
- La selección de candidatos arrastraba metadatos de interfaz que el parser estricto no acepta. Ahora el motor envía únicamente `module`, `resource_type` y `resource_id`; 18/18 pruebas del motor PASS, incluido el cuerpo exacto.
- Solicitud real y aprobación superadmin de dos cuentas PASS en el laboratorio. El catálogo de pizarras reveló una referencia a `deleted_at` inexistente; PostgreSQL real confirmó `archived_at`. Backend corrige la consulta y amplía pruebas reales de los cuatro catálogos antes de regenerar la imagen.
- Los intentos iniciales también corrigieron problemas del harness: esperar hidratación antes de escribir credenciales, no observar tráfico SharedWorker mediante `page.waitForResponse`, acotar selectores al grupo de cuentas autorizadas y mantener login explícito al cambiar usuario. Ningún intento interrumpido o fallido cuenta como aceptación.
- Imagen QA incremental del runtime: `sha256:23758cd4d5f4629ee125511b44f1a1c9103cea1c85d66913f4ab454069071614`, ya generada, pendiente aplicar junto al backend corregido. El Dockerfile `infra/offline/qa/Dockerfile.browser-runtime` conserva el Next localhost ya verificado y sustituye solamente los artefactos independientes; producción siempre se reconstruye con `make deploy`.
- Regresión Vitest repetida tras estas correcciones: sesión 51795 en curso. E2E completo Chrome/Edge aún pendiente. Producción saludable a las 02:09 UTC, versión anterior `2026.09.14-1-235507698122867-d420a6bea1a5`; flags v4 todavía sin modificar.

## Avance verificado — 15 septiembre, 02:30 UTC

- Regresión final actualizada: **243 archivos / 1.270 pruebas Vitest PASS** (sesión 51795 finalizada), TypeScript posterior PASS (49581). Backend `go test ./...` posterior al catálogo/resolver activo PASS.
- PostgreSQL aislado ampliado: cuatro catálogos y snapshots, búsqueda con nombre vacío/fallback, cursores por módulo, cuentas/actores ajenos, recursos archivados, replay y rollback: PASS. La validación offline usa el resolver activo de pizarras; la lectura histórica online no se altera.
- Laboratorio usa backend QA `sha256:08b65239cb5afd9c9157319b7a743bd68efd2b534cca4c56177db5166f60daf5` y frontend QA `sha256:23758cd4d5f4629ee125511b44f1a1c9103cea1c85d66913f4ab454069071614`. Al refrescar este laboratorio, pasar `OFFLINE_QA_BACKEND_IMAGE=clarin-offline-v4-backend-qa:catalog-fix` para no volver al tag backend anterior.
- El último bloqueo de preparación resultó ser **infraestructura QA**, no el Service Worker: el proxy reescribía el manifiesto sin descomprimir gzip. Se retiró esa transformación innecesaria porque el frontend ya está compilado con el origen QA. Manifiesto gzip 200 y **510/510 recursos con SHA-256/tamaño correctos** comprobados mediante HTTP; `BUILD_ID` y origen coinciden. No se relajó ningún control del producto.
- Proxy QA añade fallo acotado `sync_unavailable` para verificar que el usuario A conserve pendientes cifrados cuando B inicia sesión online en el mismo navegador. La prueba también contempla Cloudflare 503 → Esperar/Seguir sin conexión y cierre completo del proceso.
- E2E Chrome repetido (57841) en curso; **todavía no hay aceptación E2E ni despliegue**. No activar flags, grants reales ni publicar imágenes QA hasta aprobar el recorrido.

## Avance verificado — 15 septiembre, 02:49 UTC

- Regresión frontend actual: **244 archivos / 1.275 pruebas Vitest PASS** (66886), sin fallos. Corrección posterior del orden de solicitudes: panel 6/6 PASS (tres casos nuevos), TypeScript PASS (84723), `git diff --check` PASS. La solicitud más reciente se consulta antes que las aprobaciones antiguas y se omiten solicitudes inaccesibles de otros usuarios locales.
- Añadido bloqueo/cambio de identidad accesible en pantalla estrecha: dos pruebas nuevas y comprobación de geometría/acción a 375, 768 y 1440 px. La barra lateral conserva su control de escritorio.
- Si se pierde la persistencia concedida por el navegador, el motor elimina acciones de escritura y comunica solo lectura al abrir, preparar, consultar estado, sincronizar o intentar escribir. Mantiene identidad y pendientes cifrados. Motor 21/21 PASS, incluidos tres casos nuevos.
- Chrome real ha verificado preparación de ambas cuentas y los cuatro módulos, consulta de pizarra con render/zoom, creación/completado sin red, cifrado y ausencia de datos privados en CacheStorage, cierre de página/reapertura y pérdida de ACK. Consultas reales al backend acreditan una sola creación y el completado con autor/cuenta correctos. **Aún no se aceptó el conjunto de cuatro recorridos Chrome/Edge**: el harness ahora espera que la cola cifrada llegue realmente a cero antes de iniciar el siguiente fallo, no que desaparezca temporalmente el texto durante `Sincronizando`.
- Permiso de almacenamiento en QA: contextos persistentes normales y autorización CDP a nivel navegador. No se falsifica StorageManager. El permiso de pruebas sobrevive al cierre de una pestaña, pero no al cierre completo del proceso; la segunda prueba acredita reapertura/desbloqueo/lectura y conservación de pendientes, no escritura durable tras reiniciar sin que el navegador vuelva a conceder persistencia.
- Laboratorio frontend actual `sha256:d8f7c7792929f202921a588a94a16edacf2aec706ada4366acc1838796922e10`, backend `sha256:08b65239cb5afd9c9157319b7a743bd68efd2b534cca4c56177db5166f60daf5`; identidad y salud verificadas a las 02:44 UTC. Compilación Next completa final 53613 en curso, sin sustituir todavía las imágenes del recorrido activo.
- Segundo backup privado verificado: `.runtime/offline/v4-backups/2026-09-15T02-30-59-042Z-de529618`. **Todavía no se ha desplegado ni habilitado v4 en producción.**

## Hallazgo y comprobación — 15 septiembre, 03:00 UTC

- Se confirmó un fallo de producto en una pestaña de login abierta antes de activar offline: el usuario nuevo era autenticado y la identidad local anterior se bloqueaba, pero faltaba iniciar la transición explícita antes de solicitar modo online. El Service Worker rechazaba correctamente el cambio y el refresco de Turnstile ocultaba el mensaje del fallo.
- Corrección: después de autenticación online real y verificación de identidad, `completeExplicitOnlineLogin` exige ACK de `BEGIN_ONLINE_REAUTH` y después ACK de `SET_MODE online`. Incluye pestañas normales sin parámetros; no instala ni exige worker a usuarios online ordinarios. Un fallo descarta la nueva cookie. Turnstile solo limpia errores propios de captcha, nunca errores de autenticación/transición. 10 pruebas focalizadas PASS y TypeScript PASS (19899).
- Desbloqueo admite el mismo límite de entrada que preparación (1.024 unidades de texto; el motor limita además a 1.024 bytes UTF-8), sin truncar silenciosamente en 256. Componente 4/4 PASS (28071).
- **Chrome cierre completo/Cloudflare PASS**, sesión 80964, 1,1 minutos: Esperar conserva online; entrar offline crea una tarea; cerrar todo el proceso y reabrir el mismo perfil sin red exige contraseña y recupera la tarea y su pendiente cifrado. Evidencia `test-results/offline-v4-restart-chrome-report.json`. Se mantiene la limitación documentada del permiso CDP que no persiste entre procesos: la reapertura prueba lectura/retención, no nuevas escrituras durables.
- La compilación Next 53613 PASS (TypeScript, 32 páginas estáticas, editor y artefactos). No se aplicó: empezó antes del hallazgo de login. La nueva compilación final 55856 incorpora la corrección y está en curso. Laboratorio/producción aún conservan sus imágenes previas; **v4 todavía no desplegado**.
- Comprobador read-only de producción añadido: `scripts/offline/browser-runtime-check.mjs`. Cinco unitarios y 38 comprobaciones sobre laboratorio PASS. Ejecutar después de `make deploy` con flags/versión reales; aún no ejecutado en producción.

## Continuidad — 15 septiembre, 03:06 UTC

- **Edge cierre completo/Cloudflare PASS**, sesión 15938, 1,7 minutos; evidencia `test-results/offline-v4-restart-edge-report.json`. Mismo alcance y limitación de persistencia CDP que Chrome. Ambos navegadores pasan este recorrido.
- Build QA 55856 terminó con cancelación `130/context canceled`, no con error de compilación. La causa quedó sin determinar. El agente de navegador no ejecutó terminaciones globales ni comandos Docker. Salud de producción verificada a las 03:01 UTC (PG/Redis saludables, versión anterior); memoria y disco disponibles comprobados. Reintento 79160 compiló código y está comprobando TypeScript.
- La revisión de compatibilidad detectó que no debe exigirse un mensaje v4 a un Service Worker v3 antiguo que todavía controla una pestaña online. El helper se acota a estado público v4 real (`OFFLINE_V4_META_CACHE`), sin crear IndexedDB ni copias. Un login online ordinario sin ese estado continúa; una transición offline requerida o un estado v4 existente conserva los dos ACK obligatorios. Corrección/unidades finales a cargo de `qa_environment_closure`; esperar su congelación antes de la imagen final.
- No ejecutar ni afirmar despliegue todavía. Los recorridos de diez usuarios/cambio de identidad y la migración del worker siguen pendientes de aceptación final.

## Aceptación de recorridos — 15 septiembre, 03:18 UTC

- **Chrome recorrido completo PASS** (38845, 5,4 minutos) sobre frontend QA `sha256:b3154f4fe4e42211d5a04e9e2832799b10858e1f741e2e33b83939ee72dcbab4` y backend 08b65239: diez usuarios, once grants y dos cuentas; cuatro módulos; tareas sin red; cierre de pestaña; pérdida de ACK y confirmación de cola cero; servidor con creación exactamente una vez y autor/cuenta correctos; login B en pestaña normal preexistente bloquea A. La nueva cola de A conserva exactamente una operación tras preparar los otros nueve usuarios y nunca aparece en el servidor bajo B. B no accede a la cuenta B (403). Sin errores de página, solicitudes nativas ni salidas de origen no autorizadas. Evidencia `test-results/offline-v4-flow-chrome-report.json`.
- Capturas sintéticas revisadas: móvil 375 px con bloqueo visible y escritorio con indicador en `top=0`, `scrollY=0`. El desplazamiento aparente de la captura fullPage anterior no era un defecto del layout.
- Integridad pública HTTP del candidato b3154f4f: **510/510 assets**, 23.237.814 bytes, SHA-256 y tamaños correctos, origen exacto `http://localhost:19444` (77408).
- La versión b3154f4f ya incluye la corrección de login entre pestañas. El último ajuste de compatibilidad con SW anterior y la retirada del buscador global inactivo en Administración → Offline se verificaron con 20 pruebas focalizadas y TypeScript (66913). Build final 16708 incorpora esos ajustes: código y TypeScript PASS, completando empaquetado. No cambiar imágenes del laboratorio durante Edge core activo.
- Regresión frontend completa más reciente 4267, un worker, sigue ejecutándose. Comprobadores de despliegue/runtime: 8/8 unitarios PASS fuera del sandbox; la repetición dentro del sandbox acredita `spawnSync EPERM` como causa de dos fallos de infraestructura, no del producto.
- Humo de migración listo para imagen final: `tests/offline-v4-legacy-login.spec.ts`. Usa exclusivamente el SW público de producción anterior, 16.851 bytes, SHA-256 `d3c0c4f8cbc076d36519a07c90369d111f5fe2bfaf57a472b11ef338118895e9`, versión `2026.09.14-1-235507698122867-d420a6bea1a5`; no se copió información privada ni se modificó producción. Debe probar login real con controlador legado, sin metadatos ni base privada v4.
- **Pendientes antes de producción:** terminar Edge core, aplicar imagen final al laboratorio, ejecutar humos de solicitud nueva y migración en ambos navegadores, completar regresión, backup reciente, activar flags v4 sin aprobar usuarios y ejecutar `make deploy` más comprobaciones reales.
