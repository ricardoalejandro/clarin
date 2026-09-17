# Continuidad offline web v3

Actualizado: 2026-09-15 00:18 UTC. Estado actual: actualización Next16 desplegada y runtime verificado; laboratorio final recapturado y probado. Piloto offline apagado: falta únicamente la aceptación nativa Windows para evaluar su activación. Los bloques anteriores son historia incremental; prevalece el último bloque.

## Punto de partida

- Autorización del usuario: implementar, probar calidad, desplegar.
- Contrato: `docs/offline-v3-implementation.md`.
- Worktree con numerosos cambios anteriores del usuario; preservar todos. v2 mayormente sin seguimiento Git pero existente/desplegado: no asumir que es desechable.
- Pruebas baseline durante análisis previo: backend Go, agente Go, signer Go y frontend unitarios pasaron; no prueban v3 ni Windows. Reejecutar tras cambios.
- No se dispone de ejecución sobre Windows 11 del usuario aún. Host Windows visible no equivale a shell accesible. Preparar gate/harness antes de pedir intervención mínima.

## Trabajo

1. Contrato y continuidad guardados.
2. En curso en paralelo: backend v3 (offline_security_plan), servicio Windows (offline_engine_plan), runtime CSR/SW (offline_web_plan).
   - Root: signer v3 con claves separadas/rotación, lease/control/descriptor tipados e ingesta JWE; tests Go y race pasaron (reejecutar tras últimos cambios).
   - Root: gate de instalador por bytes + evidencia Windows y congelación content-addressed; Makefile ya no reconstruye instalador al desplegar. Tests Node pasaron; despliegue aún no ejecutado.
   - Root: CreateTx/UpdateTx canónicos, comando task v3 con savepoint+receipt+actividad+outbox atómicos, proyección allowlist, dispatcher durable. Unitarios focales pasaron; pruebas PostgreSQL de mutaciones aún pendientes.
   - Revisión cruzada corrigió deriva de payload tasks, distinción version protocolo/rotación y orden de locks autoridad/grant/Work.
   - Backend suite completa ejecutada y pasada durante implementación, antes de terminar todas las piezas; no reemplaza gate final.
   - PostgreSQL QA efímero `clarin-offline-v3-qa-postgres`, localhost:55439, usuario/BD offlineqa; no producción. Agente backend ejecutó Migrate dos veces con éxito. Usar OFFLINE_V3_TEST_DATABASE_URL apuntando exclusivamente a esa BD.
   - Root: PostgreSQL real pasó atomicidad create/complete/receipt/actividad/outbox, replay concurrente x4, rollback, rechazos de tuple/selección, conflicto servidor, Entorno Ver+lista Editar con override de tarea, subtarea online por grant raíz y cuarentena de evento corrupto sin bloquear otros. Archivos `offline_v3_task_command_integration_test.go`, `offline_v3_task_effect_test.go`.
   - Root: signer tipado ahora firma bootstrap, snapshots y receipts (JWS anidado en JWE). Cifrar a clave pública no autentica servidor; firma interior obligatoria. Tests y race signer pasaron. SHA receipt = hash del JWE operación exacto; snapshot hash = bytes JSON serializados exactos.
   - Root: Chromium real `tests/offline-v3-shell.spec.ts` 4/4 pasaron: cookies navegación/noPIIcache, corte real socket origen y URLs normales, Cloudflare503, renderer Pizarras+fuentes locales totalmente offline. Emulación context.setOffline sola NO cortaba SW, test ahora destruye socket origen además.
   - Root: reemplazó placeholder Pizarras por exportToSvg readonly del fork exacto actual, SVG en Blob/img inerte, sin enlaces/embeds/URLs remotas, assets imagen con hash/tamaño/formato verificados, URLs destruidas al cerrar. Build incluye fonts/licencias locales, renderer lazy y manifest integral. Shell estático completo ~22.8MB/509 assets, budget32MiB; entry core sigue separado/lazy. SW staging concurrency6 y dos generaciones.
   - Root: Contactos/Programas readonly completos con phones/tags/campos/observaciones directas y roster/asistencia/historial excluido. Guardas lateasync/cambio gateway/cierre; fecha calendario sin desplazar día; pendiente no es ausencia. 12 unitarios focales pasaron (4 archivos). Las tres vistas aceptan refreshToken?:string, refrescan sin remount ni perder selección/contexto válido. Web agent conecta token last_success_at y preserva borradores Tareas.
   - Auditoría transversal detectó y owners están corrigiendo DTO/proofs divergentes, snapshots sólo en spool sin aplicación, wiring SCM/bridge, disponibilidad/admin/provision, assets binarios pizarra. Estas piezas NO estaban terminadas al pasar unitarios aislados. No activar por compilar paquetes.
   - Candidato Windows v3 debe escribirse separado en `.runtime/offline/v3-candidate`; no reemplazar artefacto público hasta gate real. Se pidió explícitamente al owner motor.
   - docker-compose v3 flags/origen/minversion explícitos, apagados por defecto; nueva inscripción v2 congelada por defecto (sin borrar sync/control/historia).
3. Pendiente: gate Windows real y publicación exacta del artefacto.
4. Pendiente: make deploy y verificaciones de runtime. No activar piloto sin gates.

## Pruebas en curso al actualizar (~2026-09-14 21:34 UTC)

- Root `tsc --noEmit` sesión 51391 terminó con dos errores: narrowing autor observación (root corregido) y genérico vi.fn onlineClient.test (avisado owner web). Reejecutar gate global cuando owners terminen; evitar compilaciones duplicadas.
- Última suite readonly12 tests sesión4283 pasó; rendererChromium4tests sesión50795 pasó.
- Signer Docker build sesión87533 pasó antes de añadir data signer; reconstruir durante deploy.
- Los agentes web/backend/motor siguen activos. Backend debe terminar unit/PG de snapshots+proofs+controles, web panel/provision y gates globales, motor integración Windows+sync/aplicador+harness/candidato.
- Root backend suite completa Go sesión61342 pasó; signer race pasó; readonly13 unitarios y renderer Chromium real con PNG+font local offline pasaron. Todavía requieren gate final después de cambios concurrentes.
- Root tomó `OfflineTasksView`, card, `taskReadModel`, tests: guarda de identidad/selección para respuestas tardías, error no es lista vacía, categoría workflow canónica y prioridad urgente, acciones intersectadas con `list.can_create`/`task.can_complete` de backend. 8/8 tests focales sesión29434 pasaron. Corrigió cleanup explícito del test después de una ejecución global concurrente fallida.
- Root tomó guard reauth online en `handleLogin`/`Auth.Login`: body opcional exacto `offline_reauth_user_id/account_id`, contraseña/Turnstile normales, usuario activo y membership/cuenta exacta antes de emitir sesión. Acepta cuenta no-default del mismo usuario. `offline_reauth.go` API/service + tests; PostgreSQL real sesión94426 pasó, incl no tokens para mismatch/foreign account y throttle durable al preparar copia.
- Root agregó `Auth.VerifyCurrentPassword`: step-up de sesión ya autenticada, bcrypt real, reserva atómica Redis IncrWithTTL + fail-closed si cache falla; nunca crea tokens. Backend owner convierte bootstrap en POST `{password}`; web owner adapta provision para no aceptar contraseña local accidental distinta de Clarín.
- Auditoría root detectó y avisó al owner motor: JSON SyncResponse sin `state` rechazaba toda respuesta; whiteboard strict DTO incompleto rechazaba toda pizarra; complete sólo buscaba overlay task y no closure de snapshot; copia available nunca solicitaba datos nuevos; overlay no podía ganar siempre al snapshot canónico; contadores conflictos estaban hardcoded. Correcciones en curso: no asumir resueltos sin flowtest motor.
- Backend owner implementó delta/renewal con inventory/ACL de todas selecciones y lease tras sync completa, states `synchronized|controls_only|selection_changed|quota_exceeded|writes_disabled`; round-robin motor pendiente de verificar.
- Web owner está cambiando SW a precache lazy sólo al habilitar offline/perfil preparado; no descargar 22.8MB en cada navegador no autorizado. Root Playwright debe revalidarse tras este cambio (timeout enable suficiente).
- Engine owner implementó servicio Windows+helper por pipe con PID/token SID y path Program Files (sin impersonación); crosscompile pasó. Todavía sin prueba real Windows 11. Candidato separado, NO publicar como aprobado.
- Root `OfflineConflictsView` + DTO/gateway readonly implementados, 3/3 tests sesión7101 pasaron; web owner añadió bridge y ruta `/dashboard/conflicts`. Datos cliente/servidor separados, ninguna escritura destructiva ni reenvío automático.
- Root browser5tests sesión73149 pasó con SW lazy (0 assets v3 en no preparado), y test adicional manifest corrupto conserva shell previo pasó sesión4541. SW owner corrigió después workers allSettled/cancelación/cleanup; reejecutar completo final.
- Root suite backend completa sesión10308 pasó antes de últimos cambios dependency/reauth-bootstrap. Signer race y Node artifactgate repetidos pasaron.
- Root cerró backend create→complete sin red: `DependsOnOperationID` opcional en domain.OfflineV3Operation; command resuelve receipt create mismo grant/account/task para base0, missing=>ErrOfflineV3DependencyPending (API owner mapea409), wrongdependency=>rejected, changedserverversion=>conflict. PG todas Tasksv3 sesión87676 pasó, incluidos replay/out-of-order/permiso rootEdit+listaView. Receipt TaskDTO ahora `can_complete` actual. Engine owner conecta dependencia derivada sólo de create local durable, no de UI arbitraria.
- Root Tasks UI ahora permite complete pending version0 sólo si motor entrega can_complete=true; tests latecomplete trasidentityswitch añadidos. Sesión34609 ejecutando12tests tasks/readmodel/conflicts al actualizar.
- Quedan gates finales motor integrados, frontendglobal/tsc/build, Windows real/harness, make deploy +runtime. Todavía nada desplegado por esta tarea.

## Última actualización incremental (~2026-09-14 21:45 UTC)

- Root: indicador persistente ahora muestra usuario/cuenta, pendientes/conflictos, última sincronización y vencimiento efectivo del lease renovado, además de error genérico sin filtrar mensajes internos y aviso de resultados no confirmados. Sesión97371: 9/9 tests Indicator+Tasks pasaron. El owner web integrará en build final.
- Signer: `login_binding_sha256` obligatorio exacto lowercase hex64 en bootstrap/lease; validaciones de ausencia/longitud/case/hex cubiertas, suite race35475 pasó. Backend/web/motor adaptan `{login,password}` sin fallback password-only. No es un segundo factor: passwords compartidas + username conocido conservan el mismo riesgo que login online.
- Root ya no ejecuta PostgreSQL concurrentemente. Owner backend repetirá todos paquetes v3 con `-p 1`; el intento concurrente chocó entre migraciones del propio QA. No contar ese intento como aprobado.
- Auditoría detectó selección-wipe que revocaba grant entero, selección-changed que no suspendía lease vieja y controles pendientes cuya firma caducaba tras >72h. Owners están corrigiendo con pruebas; NO asumir terminado ni activar v3 aún.
- Instalador público v2 intacto; `release-artifact verify`53742 confirmó SHA `53e152719f669fb9af9cf955a696a1debd75686b0d11ae4fb0641ef62a623aaf`. Candidato v3 separado sigue pendiente. No existe evidencia Windows real.
- Todavía no se ejecutó `make deploy` en esta tarea. Publicar servidor/web con v3 desactivado sólo tras gates Linux/PG/browser finales; activación requiere gate Windows real del artefacto exacto.

## Reanudar

Actualización 22:06 UTC:

- Backend owner confirmó FREEZE: Go-all, go build, PG repo v3 completo, migración dos veces y prueba ACL revocada durante la firma de snapshot pasaron. `ConfirmSnapshotsIssued` ahora revalida ACL actual antes de confirmar entrega.
- Root `session.Manager` ya no renueva inactividad desde Acquire/heartbeat/poll; `activity_sequence` explícito per-client únicamente creciente, maxsafeint, plazo exacto30m. Test race69937 PASS (poll continuo expira, no revive sesión, DEK destruida). Wrapper engine y frontend conectados por owners.
- Playwright80057: 8/8 PASS con SW actual entonces; agregó después caso trusted429 (9 escenarios final) para no convertir throttle Clarin en offline. Falta corrida final sobre CSR final.
- Root escribió packaging candidato `infra/offline/{Dockerfile.nsis,build-v3-candidate.sh,offline-v3.nsi,configure-service.ps1,Test-OfflineV3.ps1}`, manifest/test Node. `make offline-installer` ahora usa v3candidate, no Electron. Defaults Make también apagan inscripción v2; deploy sigue v3false.
- NSIS compiler image built; PowerShell7.4 parser syntax62261 PASS (no equivale ejecución Windows5.1/ACL/DPAPI). `make offline-installer`27314 PASS: candidato preliminar4,497,182 bytes, SHA0e5a88034e49be4a4e1bc5b4839ead98c7e73ae38b3067833fbb6bbcd1cfca5e. Recompilar tras fixes finales: NO publicar ni reutilizar como evidencia Windows.
- Root delegó exclusivamente `configure-service.ps1` + `offline-v3.nsi` hardening al agente offline_security_plan: fijar/rechazar /D, staging seguro fuera de temp usuario, ancestros app-owned+hardlinks+ACL explícita y readiness LocalService. Root mantiene buildscript, manifest, harness, README. No solapar esos dos archivos.
- Principalpipe ahora impersonación estrecha sólo para SID/path, LockOSThread, RevertToSelf antes de catálogo/DPAPI; si revert final falla os.Exit120. Instalador incluye SeChangeNotifyPrivilege/SeImpersonatePrivilege. SID sólo en enrollment, no fresco por HTTP; límite documentado.
- Web owner necesita ~10-15 min a las22:04 para gates finales unit/tsc/CSR/Next tras labels canónicos y suspensión. Labels motor ahora separados de Login efímero. Esperar freeze explícito y correr Playwright9 después.
- Todavía no make deploy en esta tarea. Dockerps22:04 mostró runtime previo sano (24h). No Windows real. Activación debe permanecer apagada; falta despliegue dark y verificaciones reales.

Leer contrato, este checkpoint y git diff de archivos v3. Consultar agentes existentes antes de duplicar trabajo. No comenzar de cero ni dar por desplegado lo que solo compila.

## Cierre de gates e inicio de despliegue (2026-09-14 22:33 UTC)

- Motor FREEZE: Go completo sin caché, race completo, vet y crosscompile Windows x64 de todos los paquetes PASS. Incluye Argon2 limitado a 2 trabajos, locks por grant para enqueue/suspend, reaper independiente, transporte round-robin y finalización wipe/ACK. No reconstruir por cambios de documentación.
- Frontend FREEZE: 1126 pruebas globales, 20 del fork y 3 de hardening PASS; 10 unitarias focalizadas finales PASS; tsc final y Next build PASS. Root Playwright (sesión 60152): **10/10 PASS** sobre CSR final de 509 assets/22.82 MB.
- SW latch: modo offline durable público, no identidad; URL normal, reload, nueva pestaña y módulo no soportado no recuperan la cookie anterior. Salida online sólo con transición explícita y login real con marcador backend. Pruebas SW/Playwright aprobadas.
- Packaging FREEZE: rutas fijas, staging GUID CommonFiles64 protegido, sin PLUGINSDIR, owner/DACL System/Admin sin confiar en SID instalador, hardlinks/reparse rechazados, LocalService con SID de servicio y readiness estable. Parser/NSIS/Node PASS; Windows runtime **no probado**.
- Candidato final (sesión 28448) PASS: `.runtime/offline/v3-candidate/Clarin-Offline-Setup.exe`, 4.506.959 bytes, SHA `aeaf679ec7c5137185d11e6620d61084ef3674a7827f795b3375ebe611f9a5d2`. Hash verificado; activación sin reporte Windows rechazada. No reemplaza el artefacto público `53e152719f669fb9af9cf955a696a1debd75686b0d11ae4fb0641ef62a623aaf`.
- Regresión detectada en última revisión: trigger de épocas de membresía reinsertaba FK al eliminar el usuario/cuenta padre. Backend reprodujo SQLSTATE 23503, corrigió la guarda de existencia y probó eliminación directa de membresía (revoca) más cascada de usuario/cuenta (no interfiere). Último Go-all (27767), go build, 2 pruebas PostgreSQL de migración y diff-check PASS. Backend nuevamente FREEZE.
- **make deploy en curso**: sesión 84024, comando `env OFFLINE_V3_ENABLED=false OFFLINE_V3_TASK_WRITES_ENABLED=false OFFLINE_ENROLLMENT_ENABLED=false make deploy`. Versión anunciada `2026.09.14-1-223220180768184-d420a6bea1a5`. NO afirmar terminado hasta finalizar y ejecutar runtime checks.
- Imágenes anteriores registradas en el informe detallado; ninguna fue eliminada.
- Informe detallado: `docs/offline-v3-verification-2026-09-14.md`. Falta Windows 11 real y resolver entorno QA end-to-end (backend v3 activo y aislado; candidato actual fija origen de producción). No basta ejecutar el diagnóstico contra flags desactivados. No fabricar reportes ni abrir el gate para evitar estas etapas.
- Próximo: esperar sesión 84024; comprobar Docker, health, logs, versión, esquema, flags, hash y shell en runtime. Mantener flags desactivados. Registrar el resultado sin equiparar Linux/crosscompile con Windows real.

## Estado final de esta implementación (2026-09-14 22:49 UTC)

**Despliegue de servidor/web completado; piloto offline NO activado.**

- Sesión 84024 terminó exit 0. Versión real interna y pública:
  `2026.09.14-1-223220180768184-d420a6bea1a5`.
- Docker/health/logs verificados. Backend saludable, PostgreSQL/Redis OK,
  WhatsApp 4/4 conectado; frontend y worker activos, signer saludable. Sin
  errores en la ventana de logs revisada.
- PostgreSQL de producción tiene las 20 tablas v3, 0 grants, 0 solicitudes y la
  guarda de cascada corregida. No se crearon autorizaciones ni datos de piloto.
- Flags comprobados en runtime y desde dominio: v3=false, task writes=false,
  nuevas inscripciones v2=false; mínimo cliente v3=3.0.0.
- Runtime servido verificado por HTTP: 509 assets, 22.822.622 bytes, todos los
  hashes/tamaños correctos. Worker con latch presente. API versión y marcador,
  disponibilidad, login, shell y SW públicos OK; `/mcp` anónimo devuelve401.
- Candidato Windows final y artefacto público mantienen los hashes del bloque
  anterior. Candidato no publicado y Windows real sigue `not_run`.
- Se descubrió un gate adicional durante Docker/npm: audit de producción con
  22 alertas (3 críticas, 12 altas, 7 moderadas). Lock comparado con HEAD: todas
  las versiones alertadas ya existían; única dependencia nueva `jose@5.9.6`,
  sin transitivas ni alerta reportada. No se probó inexplotabilidad ni se
  ejecutaron actualizaciones. **Resolver seguridad de dependencias antes de
  activar**, además de Windows; un XSS del mismo origen importa con vault abierto.
- Evidencia: `docs/offline-v3-verification-2026-09-14.md` y
  `docs/offline-v3-dependency-audit-2026-09-14.json`.
- Se eliminó sólo el PostgreSQL efímero de QA `clarin-offline-v3-qa-postgres`
  después de terminar los tests. Reproducible con fixtures/migraciones; puerto
  55439 ya no tiene esa instancia. No buscar ni reutilizar sesiones de tests.
- Para retomar: no rehacer implementación ni deploy. Resolver QA aislado y
  origen del candidato, conectar Windows 11 real y ejecutar la matriz completa
  Chrome/Edge sobre bytes exactos; remediar/validar dependencias, y sólo después
  promover el instalador y habilitar el piloto con aprobación explícita.

## Continuación: seguridad y laboratorio (2026-09-14 23:39 UTC)

- Laboratorio aislado creado y probado: `docs/offline-v3-qa-laboratory.md`, `docs/offline-v3-qa-verification-2026-09-14.md`. Proyecto `clarin-offline-v3-lab`, únicamente loopback:19443, bases/keys/fixtures separados. Diez usuarios sintéticos no superadmin, dos cuentas; aislamiento real de cambio de cuenta probado. Sin autorizaciones/grants de piloto; Windows real todavía `not_run`.
- Dependencias remediadas; candidato Next16.3.5 + React19.3.0 + Node24.21.0 LTS. Fabric7.4.0 con adaptador histórico; jsPDF4.2.1; SheetJS0.20.3 oficial vendorizado; tooling parcheado. npm audit all/prod cero. Scan OSV/GitHub y SBOM con clasificación explícita de avisos en documentos de supply-chain; no afirmar OSV bruto cero.
- Producción comprobada de nuevo: Next14.2.35/Node20.20.2, imágenes frontend2bdff8c… y backend9fa0d0… conservadas. **Aún no make deploy de la actualización Next16.**
- Fork interno Pizarras `clarin.7`; formato 0.18.1 intacto. Mermaid deshabilitado antes de importar. Backend metadata .7 y lector offline .1–.7 alineados; histórico no reescrito. React19 `inert` booleano en paneles/listas/editor corregido.
- QA actual: Next16 build PASS; tsc final PASS; Go-all final PASS; Node artefactos/QA14/14 PASS; dependencias/empaquetado7/7 PASS; corpus4+4 y reconciliación60 PASS; Fabric Chromium2/2 PASS; SW/shell Chromium10/10 PASS; Mermaid + same-origin Chromium2/2 y fuentes Firefox1/1 PASS. Backend/WebSocket del escenario Pizarras son harness, no aceptación Windows.
- Primera suite frontend global1171/1175 expuso whitelist e inert, ya corregidos. Repetición con exceso de concurrencia tiene timeouts: owner `/root/next_react_compat` cerrando suite completa con maxWorkers2, sin ampliar timeouts ni relajar asserts. No dar global por aprobada hasta resultado.
- Revisión independiente encontró SheetJS excluido por .gitignore: excepción agregada. Root encontró assets públicos0600/0700 incompatibles con USERnode: Docker conserva root ownership y aplica a+rX antes de bajar privilegios; prueba de contrato agregada. Verificar todos los hashes HTTP tras construir/desplegar.
- Siguiente: cerrar suiteglobal y avisos/SBOM, `make deploy` con los tres flags false, runtime/version/logs/assets/nonroot, refrescar laboratorio con imágenes definitivas, repetir smoke/kit y documentar. No reconstruir/publicar el EXE ni activar offline sin Windows real.
- Informe de entrega: `docs/next16-release-verification-2026-09-14.md`. Servidor temporal de build local en127.0.0.1:3011, sesión3189, cerrar al terminar. Node24 temporal `/tmp/clarin-dependency-audit.F6zvFHNc/node-v24.21.0-linux-x64/bin`; no cambiar Nodeglobal.

## Punto exacto para continuar (2026-09-15 00:05 UTC)

- **No reiniciar implementación ni pruebas terminadas.** Comando completo `npm run test:unit -- --maxWorkers=2` terminó exit0:1197 Vitest +23 fork +29 scripts. Se agregaron después9 pruebas de distribución de licencias, PASS separado. Tsc final y Go-all PASS; todas las matrices browser del bloque previo PASS.
- Avisos completos de247 dependencias/123textos generados y hash verificado; fsevents Darwin no distribuido excluido. `prepare-excalidraw` verifica archivo archivado y lo agrega al NOTICE existente; no cambiar allowlistbranding. Paquete público Docker509assets/23230112bytes.
- Auditoría renovada00:00:38–00:00:44UTC del15:710 versiones OSV/GitHub completas, npm all/prod0, sin errores. Lock/advisories/matches idénticos al14, comparación deepEqual PASS. Evidencia `docs/security-dependency-audit-refresh-2026-09-15.json`.
- **make deploy sigue activo, sesión74216**, log `/tmp/clarin-next16-deploy.log`. Versión `2026.09.14-1-235507698122867-d420a6bea1a5`. Backend/worker/signer/bridge construidos. Instalación limpia frontend PASS/audit0, preparación fork/licencias PASS. Next16.3.5 compiló en3.5min; Docker está en TypeScript. Esperar terminal, NO lanzar otro deploy concurrente.
- Comando invocado con PATH Node24 y OFFLINE_V3_ENABLED=false, OFFLINE_V3_TASK_WRITES_ENABLED=false, OFFLINE_ENROLLMENT_ENABLED=false. Instalador público/candidato conservan hashes previos; no publicar candidato ni activarflags.
- Health de producción antigua comprobado00:03:41:backendhealthy/PostgreSQL+RedisOK/login200, WhatsApp2/4 ya antes del reemplazo. No atribuir desconexiones preexistentes a la actualización ni afirmar4/4.
- Servidor temporal3011/sesión3189 cerrado correctamente exit130. Ninguna prueba pesada pendiente; no reabrirlo sin motivo.
- Agente `/root/qa_environment_closure` preparado y esperando señal: después de make deploy exit0, enviarle autorización concreta para refresh/up --turnstile-test/smoke/kit + revalidaciónlogin/Turnstile/aislamiento. Root hace runtimeproducción en paralelo. No refrescar QA antes de completar deploy.
- Pendiente root: Dockerps, health, logs filtrados sin datos personales, /api/version interna+pública, confirmarNext16/Node24/UIDno-root, todos509hashes/tamaños HTTP y NOTICE/fonts legibles, flagsOFF, /mcp401. Después guardar resultados y decisiónGO web/NO-GO activaciónoffline por faltaWindowsreal.
- Script para repetir auditoría sólo si necesario: `/tmp/clarin-dependency-audit.F6zvFHNc/audit-final-candidate.mjs` con Node24; emite JSON, no hace triage automático. No hace falta repetir el scan recién aprobado.

## Punto definitivo de continuidad — 2026-09-15 00:18 UTC

**No rehacer implementación ni lanzar otro despliegue. La sesión74216 terminó exit0.**

- Versión en producción interna y pública: `2026.09.14-1-235507698122867-d420a6bea1a5`. Next16.3.5 estable, Node24.21.0 LTS y UID1000 comprobados dentro de `clarin-frontend`.
- Imágenes finales: frontend`sha256:8e14b1a4e70a6fac1ce50b770977a1d1e3029337b36db644596418ecc90874b2`; backend`sha256:21fbdd6fed0d54fcf78989744019d9651e7bbeaebfba221c8086f7dc04dc27c0`. Imágenes anteriores conservadas, no pruning.
- Docker/health/logs/version/flags/SQL reales revisados. Backend/PostgreSQL/Redis/signer saludables. Frontend listo y worker activo. WhatsApp2/4 ya era el estado previo; sólo dos WARN de cierre socketEOF en la ventana inspeccionada, no afirmar4/4.
- 509assets/23.230.112bytes verificados SHA/tamaño por HTTP; manifiesto público coincide; WOFF2 y NOTICE públicos legibles. Bundle completo305.734bytes presente, hash8118dca3… correcto. Login/SW/shell públicos200 y no-store; shell CSP restrictiva. `/mcp`401 en puerto correcto8081 y público; el primer diagnóstico8080 dio404 y se corrigió tras comprobar routing, sin tocar producto.
- Tres flagsOFF comprobados, minimum-client3.0.0. PostgreSQL20tablasv3/0grants/0solicitudes. Sin autorizaciones de piloto nuevas.
- Evidencia completa: `docs/next16-release-verification-2026-09-14.md`, `docs/next16-runtime-verification-2026-09-15.json`, auditoría renovada15sept y baseline supply-chain actualizada aGOweb/NO-GOoffline.
- QA final completado por `/root/qa_environment_closure`: captura4 con esas imágenes exactas, refresh/up --turnstile-test/smoke7/kit PASS. Verificador nuevo `scripts/offline/qa-verify-fixtures.mjs`: dos logins reales con Turnstile oficialtest, cambio A→B autorizado mismoactor y usuario sin acceso→B403 sin cookie ni cambio de identidad, cuatro gatesPASS. Sesiones QA cerradas. Dos cuentas/diez usuarios sintéticos/0requests/0grants. Root revisó el script y ejecutó9unitQA+4candidate+2releasePASS. Informe `docs/offline-v3-qa-verification-2026-09-14.md`.
- Kit actual: `.runtime/offline/v3-qa/windows-kit-aeaf679ec7c5-1789431151752`. ReportesQA: smoke1789431151507 y auth-verification1789431209833. Credenciales/CA/signer privados preservados; no imprimirlos ni exportarlos en respuestas.
- SHA candidato Windows sigue`aeaf679ec7c5137185d11e6620d61084ef3674a7827f795b3375ebe611f9a5d2`; artefacto público sigue`53e152719f669fb9af9cf955a696a1debd75686b0d11ae4fb0641ef62a623aaf`. Ambos comprobados de nuevo; no reconstruidos/promovidos.
- **Único gate de aceptación pendiente: Windows11x64 real, Chrome y Edge, sobre bytes exactos del candidato.** No hay ejecutorWindows conectado. Conectar una VM de pruebas aislada y seguir `docs/offline-v3-qa-laboratory.md`: origen exacto/CA pública/túnel sólo dentro del laboratorio, instalador exacto, UAC/SCM/DPAPI/ACL, cierre/reinicio, permisos de navegadores, usuarios/cuentas y sincronización. No confiar la CAQA en el equipo habitual ni cambiar DNS/Cloudflare de producción.
- Si la matriz descubre fallos, corregir y generar candidato nuevo con evidencia ligada a su hash; no reutilizar aceptación del hash anterior. Sólo promover/activar después de gates reales y autorización de piloto. Todas las pruebas anteriores no equivalen a aprobación Windows.
- No hay builds ni tests root en curso. Laboratorio permanece accesible sólo enloopback19443 para esa validación; no necesita reinicialización. El Node global del VPS se mantuvo sin cambios.

## Solicitud de prueba en PC local — 2026-09-15

- El usuario autorizó probar su PC local y pidió rapidez. Se verificaron las herramientas disponibles: ejecución de esta tarea sigue en Linux/VPS; `read_thread_terminal` no tiene terminal adjunta. `list_projects` muestra proyectos Windows en host `local`, pero no hay herramienta de ejecución Windows ni traslado/creación de tarea disponible en este contexto. Ver el equipo listado no equivale a poder ejecutar comandos allí. No se ejecutó ninguna prueba en la PC.
- Se necesita continuar desde una tarea local de Windows. Primera fase autorizada: diagnóstico acotado, sin instalar CA QA, editar hosts, cerrar perfiles, reiniciar, activar flags ni tocar credenciales/datos reales. Leer `infra/offline/Test-OfflineV3.ps1` y copiar sólo sus cuatro archivos requeridos del kit actual mediante el acceso VPS autorizado: script, release-manifest.json, windows-qa-template.json y EXE exacto (el diagnóstico únicamente lo hashea).
- Ejecutar PowerShell64 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Test-OfflineV3.ps1` desde esa carpeta; examinar campos booleanos, no inferir PASS por exit0. No instala nada; escribe dos JSON diagnostics-*; verifica OS/servicio/hashes/health/Origin/versiones. No prueba flujos de navegador ni DPAPI/ACL/UAC/sincronización/reinicio. Sin servicio v3 instalado, reporta ausencia.
- El procedimiento de CA/hosts de la guía sólo corresponde a VM desechable, no al PC habitual. Para aceptación completa, determinar primero si hay una VM Windows aislada disponible. Nunca convertir el diagnóstico en evidencia funcional aprobada.

## Diagnóstico Windows recibido del usuario — observación 2026-09-15 00:28 UTC

Fuente: informe pegado por el usuario desde la tarea Windows local. Esta tarea VPS no ejecutó las consultas Windows ni abrió los JSON locales; registrar como evidencia reportada, no como verificación independiente del agente VPS.

- Ejecución local informada en `C:\proyectos\016.VARIOS`, Windows11 Enterprise24H2 x64 build26100.9106; Chrome152.0.7977.83 y Edge153.0.4234.32.
- `ClarinOfflineV3` no instalado: sc.exe1060, Get-Service sin resultado, CIMcero servicios. Carpeta/binarios de ProgramFiles ausentes. Loopback17373 rechaza conexión. No interpretar ausencia como cuenta de servicio incorrecta, binario manipulado o falla demostrada de Origin.
- Candidato3.0.0 copiado desde el kit vigente, SHA reportado coincide exactamente con `aeaf679ec7c5137185d11e6620d61084ef3674a7827f795b3375ebe611f9a5d2`. No se ejecutó el instalador. Sólo se copiaron script, EXE, manifest y template; sin credenciales, CA ni perfiles.
- Todas las20 comprobaciones por navegador siguen `not_run` (40 en total). No hay aceptación de instalación, DPAPI/ACL/UAC, login, permisos de red local del navegador, reapertura/reinicio, sincronización ni aislamiento nativo. El sistema operativo cumple sólo el requisito básico del diagnóstico.
- Incidencia del harness pendiente: primera ejecución PowerShell5.1 falló con mensaje genérico, sin informe. Repetición con instrumentación en memoria (`Inspect-DiagnosticFailure.ps1`) y CandidateDirectory explícito terminó exit0 y generó JSON; el fallo no se reprodujo y su causa NO está determinada. No atribuirlo a ruta, CIM o permisos sin error original/reproducción. El catch genérico actual no conserva error técnico sanitizado; no afirmar que la repetición resuelve el incidente.
- Evidencia local reportada: `local-observations.json`, `diagnostics-20260915-002827-816275b5/diagnostics.json` y `windows-qa-report.json`. Exit0 significa generación del diagnóstico, no aprobación del producto.
- La tarea local leyó el checkpoint por SSH existente aliasvps. Sin instalar, reiniciar, modificar servicio/certificados/hosts/BitLocker/firewall, ni abrir perfiles o leer credenciales. La política Bypass se limitó al proceso.
- Próximo paso: en la misma tarea local, comprobar de forma read-only si hay VM Windows11 de pruebas disponible y capacidad de virtualización. No repetir implementación/despliegue ni habilitar Hyper-V/importar CA/editar hosts/reiniciar automáticamente. Instalación y aceptación contra QA requieren entorno aislado y alcance confirmado; el Windows habitual no debe recibir el trust/routing del laboratorio.

## Recursos del PC reportados y alternativa pendiente — 2026-09-15

- El usuario informa: no se detectó VM Windows11 ni instalaciones habituales VirtualBox/VMware; componentes/herramientas Hyper-V deshabilitados, vmms ausente. Hay hipervisor activo, WSL y Virtual Machine Platform habilitados. CPUi5-1335U/10núcleos/12hilos; RAM31.69GiB total/6.88GiB disponible; C:15.14GiB libre de474.89GiB. No se inspeccionaron VHDs sueltos/instalaciones portables: no afirmar ausencia exhaustiva de VMs. Esta tarea VPS no repitió esas mediciones.
- No proponer limpieza de datos personales ni habilitar funciones/reiniciar sin coordinación. La ruta de VM Windows completa necesita recursos y preparación adicionales; no está disponible para la prueba inmediata.
- Comprobación read-only en VPS: no existe /dev/kvm, memoria15GiB/9.7GiB disponible, disco31GiB libre. No se creó una VM en el servidor ni se alteraron servicios de producción.
- Alternativa a evaluar: Windows Sandbox estable de la edición Enterprise ya reportada. Fuentes Microsoft consultadas: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/ y windows-sandbox-install. Requisitos base publicados4GBRAM/1GBdisco no equivalen al consumo total del laboratorio ni garantizan margen para Chrome/Edge/caché/cuota. No necesita instalación separada de una VM Windows completa; habilitación puede requerir reinicio del host. Aún no se ha comprobado si Containers-DisposableClientVM está habilitado/disponible en la PC.
- DesdeWindows11 22H2 Microsoft documenta persistencia a través de reinicios iniciados DENTRO de Sandbox; cerrar Sandbox elimina su estado. No equiparar cierre/reapertura de Sandbox ni reinicio del host con recuperación del mismo vault. No cambiar requiredWindowsChecks ni marcar aceptación por usar Sandbox.
- Si se autoriza evaluar esa alternativa: usar sólo versión estable, revisar margen actual y política del equipo, pedir coordinación antes de reiniciar, no activar Insider. Kit/certificados/routing/datos ficticios únicamente dentro del entorno desechable; ninguna CAQA/hosts/perfiles/contraseña real en el host. Confirmar aislamiento antes de instalar el candidato exacto. Evidencias parciales deben seguir separadas de los40gates y de la aceptación de reinicio/persistencia. Producción sigue fuera del alcance de estas comprobaciones; no se cambiaron flags.
