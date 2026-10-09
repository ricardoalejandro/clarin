# QA de Dispositivos, Chats, Contactos, Eventos y Programas

Fecha: 2026-10-09. Base de la revisión: `0c1107a`.

Reverificación para el informe Word: frontend y capturas sobre `943d74f`;
backend final sobre `bfce3e1`. Este último sólo añade el paso del estado solicitado
de alta a la validación existente y su regresión HTTP/PostgreSQL. El frontend
es idéntico entre ambas versiones.

La auditoría se reprodujo en el laboratorio local. Este cambio corrige sus
incidencias y añade regresiones nativas; las pruebas de caracterización de la
conducta anterior no se usan como evidencia de corrección. Contact sigue siendo
la identidad canónica y se conserva la separación por cuenta.

## Matriz de correcciones

| ID | Incidencia y comportamiento verificado |
| --- | --- |
| DEV01 | El alta de un canal oficial dirige a Conectar con Meta, sin ofrecer un formulario manual que termina en 409. |
| DEV02 | Recepción en el editor se guarda como borrador; cancelar no escribe. Un fallo del toggle revierte y muestra error. |
| DEV03 | Guardas síncronas impiden alta/guardado duplicados por Enter durante una petición pendiente. |
| DEV04 | El polling comparte una lectura lenta; no la aborta cada cinco segundos y tiene timeout acotado. |
| DEV05 | Nombres de más de 255 caracteres Unicode se rechazan antes de SQL en alta y edición. |
| DEV06 | Los indicadores del canal oficial reflejan capacidades y estados reales. |
| DEV07 | Un dispositivo con JID histórico y store ausente puede finalizar su retirada local bajo reserva, operación, lease, cuenta e identidad validados. Conserva contactos, chats, mensajes, oportunidades y media. |
| DEV08 | La interfaz explica y deshabilita la baja oficial no implementada; no presenta un éxito ficticio de Meta. |
| C01 | Guardado, referencias e inventario de foto comparten transacción/bloqueos. GC espera el asset y comprueba referencias nuevas antes del borrado físico. Incluye el trigger de eliminación de Contact. Restaurar una foto histórica rota cambia la revisión/URL para recargarla sin F5; un fallo posterior a subir bytes, también en restauración, queda registrado para limpieza segura. |
| C02 | Validaciones de longitudes/fecha previas y creación transaccional de identidad, metadatos y etiquetas evitan 201 parciales. Se aplica también a cada fila de importación masiva. |
| C03 | Crear etiquetas globales requiere PermTags; PermContacts puede consultar y asignar existentes. `can_create` depende del actor actual, fuera de la caché compartida. |
| C04 | Grupos, orden, exclusión de etiquetas y campos personalizados no reutilizan la caché de la lista predeterminada. |
| C05 | La ordenación por nombre sigue custom_name/name/push_name/phone/JID, con desempate estable. |
| C06 | El recorte transforma coordenadas CSS a las del canvas; funciona en móvil y escritorio. |
| C07 | Archivo corrupto cancela la imagen/editor anterior, bloquea Guardar y muestra un error accesible visible; no sube una imagen negra. |
| CH01 | La respuesta canónica de historial prevalece para texto, revocación y reacciones, conservando recibos superiores. |
| CH02 | Una respuesta tardía de envío no rebaja delivered/read a sent ni duplica el mensaje optimista. |
| CH03 | Mensajes fuera de orden se insertan por timestamp e identidad estable. |
| CH04 | Retirar la última reacción vuelve a conciliar la lista con ese filtro. |
| CH05 | La conciliación silenciosa elimina filas que dejan de cumplir filtros y revalida todo el rango cargado con páginas acotadas. |
| CH06 | Reintentar un sticker guardado reutiliza URL/tipo sin exigir un File inexistente. |
| CH07 | Fallar la carga de historial muestra error y Reintentar, conservando mensajes existentes. |
| CH08 | Paginación normalizada en handler y servicio: por defecto 50, máximo 200 y offset no negativo. |
| CH09 | Baja individual/lote/todos emite chat_deleted después de commit, sólo a cuenta y PermChats; el receptor cancela cargas y no resucita filas borradas. |
| EV01 | Lecturas/escrituras de bitácora verifican cuenta, evento, bitácora y entrada. No se puede modificar una entrada de otro contexto. |
| EV02 | Recaptura conserva IDs y notas por upsert. Excluir una entrada anotada devuelve 409 y revierte la captura completa. |
| EV03 | Editar fecha en America/Lima no desplaza el instante cinco horas; una fecha sin cambio conserva el original. |
| EV04 | Modificar la fecha de bitácora la persiste realmente; una colisión se rechaza sin cambios parciales. |
| EV05 | Crear Evento guarda la carpeta solicitada y comprueba que pertenezca a la cuenta. |
| EV06 | Vaciar fecha inicial/final, descripción o ubicación envía null explícito y lo persiste; omisión conserva el campo. |
| EV07 | Evento completado/cancelado bloquea escrituras de bitácora y edición de metadatos del evento, incluso si el cierre concurre con la operación. |
| EV08 | Crear/editar rechaza fin anterior al inicio. |
| EV09 | Actualizaciones de bitácora aplican sólo campos suministrados sobre una fila bloqueada y fresca; no sobrescriben una captura o notas de otra edición. |
| EV10 | Respuestas tardías de bitácora no cambian la selección ni los editores de otro evento/bitácora. |
| PRG01 | Salud y participantes tienen abortos y guardas por cuenta/programa/generación; una respuesta de A no sustituye B. |
| PRG02 | Un 409 de versión exige recargar antes de volver a guardar un borrador viejo. |
| PRG03 | Refrescar publica participantes y Salud juntos; falla de manera recuperable conservando la pareja anterior. |
| PRG04 | Carpeta ajena/inexistente se rechaza en repositorio y FK compuesta. La migración repetible desvincula sólo referencias ajenas, conserva programas/historia y account_id. |
| PRG05 | Alta/edición valida el catálogo active/completed/archived. El DTO de alta transmite el estado solicitado; uno inválido devuelve 400 sin crear filas, en lugar de ignorarlo y crear active. Omitirlo conserva el valor predeterminado active. |
| PRG06 | Notes legacy de asistencia persisten como observaciones canónicas y proyección en la misma transacción; reintento idempotente, omisión/limpiar marca conserva historia. |
| PRG07 | Sin marcas se devuelve null/no_data, distinto de un 0 % medido; UI, dashboard y consumidores offline preservan esa diferencia. |

EV09 y EV10 se detectaron durante la revisión independiente del parche y se
incluyeron antes de su publicación.

## Ejecución y controles

Laboratorio: PostgreSQL 16, Redis 7, MinIO local, API Go y Next.js; fixtures
sintéticas. Las integraciones crean bases desechables y/o eliminan sus propias
filas al terminar. Credenciales, cookies, logs privados y capturas de trabajo no
se incluyen en Git.

Las regresiones nuevas están junto a su módulo:

- API: `functional_integrity_helpers_test.go`, `functional_integrity_integration_test.go`, `chat_deletion_realtime_integration_test.go`, `logbook_handler_test.go`.
- PostgreSQL/storage: `contact_creation_integrity_integration_test.go`, `contact_avatar_integrity_integration_test.go`, `event_logbook_integrity_integration_test.go`, `program_audit_regression_integration_test.go`.
- Dispositivos/migraciones: `device_deletion_missing_session_test.go`, `device_deletion_missing_integration_test.go`, `program_folder_integrity_migration_test.go`.
- UI: pruebas de SettingsDevices/administración, ContactAvatarControl/creación, ChatReliability/ChatListReliability/messageState, formularios/bitácora de Eventos, ProgramDetailRefresh/ProgramSettingsDialog/programHealthView y adaptador offline.

Comandos generales:

```text
backend: GOMAXPROCS=2 go test -p 2 ./... -json
backend: GOMAXPROCS=2 go build -p 2 ./cmd/server
frontend: npm run test:unit -- --maxWorkers=2
frontend: CIRCLE_NODE_TOTAL=3 GOMAXPROCS=2 npm run build
frontend: npm run typecheck
git diff --check
```

Las integraciones optativas se ejecutan además de la suite general mediante
sus flags: `CLARIN_RUN_CONTACT_MEDIA_INTEGRATION`,
`CLARIN_RUN_CHAT_DELETION_INTEGRATION`,
`CLARIN_RUN_FUNCTIONAL_INTEGRITY_INTEGRATION`,
`CLARIN_RUN_DEVICE_DELETION_INTEGRATION`, `INTEGRITY_TEST_DATABASE_URL` y
`EVENT_LOGBOOK_TEST_DATABASE_URL`. Un test omitido por flag no cuenta como
integración ejecutada.

Resultados finales: las 41 incidencias de la matriz tienen controles y evidencia
local. DEV08 acredita el bloqueo explicado de una acción no implementada;
la baja remota Meta continúa pendiente y no se presenta como una función probada.

| Verificación | Resultado |
| --- | --- |
| Suite Go general sobre el backend final bfce3e1 | 1.720 registros PASS, 82 SKIP, 0 FAIL, sin caché de resultados. El contador incluye tests padre y subtests; los SKIP de integraciones optativas no se contabilizan como ejecuciones. |
| Suite frontend general sobre 943d74f, idéntico en bfce3e1 | 296 archivos/1.629 pruebas de aplicación, 28 del editor y 44 de scripts PASS: 1.701 pruebas, 0 FAIL y 0 SKIP. Los focales se solapan y no se suman como pruebas únicas. |
| Integraciones repetidas sobre 943d74f | 11 grupos/37 pruebas principales PASS; 89 registros contando subpruebas, 0 FAIL y 0 SKIP. El refuerzo posterior de PRG05 se prueba además sobre bfce3e1. |
| Peticiones HTTP dedicadas sobre la API final bfce3e1 | 3 grupos PASS: C02 bulk devuelve created=1/skipped=1 sin identidad/etiqueta parcial; PRG05 rechaza cuatro altas y cinco actualizaciones inválidas sin mutación y conserva estados válidos/default; PRG06 guarda notas single/batch, autor e historia, reintenta sin duplicar y rechaza notas de más de 4.000 caracteres sin escribir. Fixtures propias: 0 restantes. |
| Compilación de producción y TypeScript | PASS, incluida generación de shells interactivos/offline y artefactos del editor. |
| Migración de arranque sobre datos previos y repetición | PASS. La reparación de carpetas conserva historia y la FK rechaza referencias ajenas. |
| Contactos: PostgreSQL/MinIO y API | 8 regresiones de ciclo de foto PASS; integración de foto en Contact/Chat/Lead/EventParticipant/ProgramParticipant PASS; creación atómica, permisos, orden y variantes de caché PASS. |
| Contactos: interfaz y Chromium | 55 pruebas focales PASS. PNG/JPEG se suben y visualizan sin dispositivo conectado. Restaurar el mismo JPEG de una foto histórica rota conserva el asset, cambia revisión/URL y la muestra sin F5. Recorte móvil e imagen corrupta verificados. |
| Dispositivos: Go/PostgreSQL/API | 9 pruebas Go, 2 suites SQL y 5 escenarios API PASS, incluidas bajas con sesión ausente, preservación de datos, reservas/identidad y rechazo de baja oficial. |
| Dispositivos: interfaz y Chromium | 20 pruebas focales y 7 escenarios de navegador PASS: respuestas lentas, errores/rollback, cancelación, doble Enter, Unicode, capacidades y eliminación con eventos WebSocket reales. |
| Chats: interfaz/API/Chromium | Regresiones de estado, historial y filtros PASS dentro de la suite frontend; integración API con 5 subcasos de bajas, rollback, permisos, cuenta y WebSocket PASS. Tres escenarios Chromium verifican historial real sin dispositivo conectado (50 por defecto, máximo 200), recuperación de HTTP 500 inyectado y baja desde otra pestaña por WebSocket real sin F5, conservando Contact y otro historial. |
| Eventos: PostgreSQL/API/interfaz | 7 grupos SQL, 6 casos API y 20 pruebas frontend PASS en Lima y UTC; integración adicional de metadatos cerrados PASS. |
| Eventos: Chromium | 7 escenarios PASS: fechas sin desplazamiento, nulls persistidos, validación, captura concurrente, respuestas tardías y controles de eventos cerrados. |
| Programas: PostgreSQL/interfaz/Chromium | 4 grupos de integración y 40 pruebas focales finales PASS; una ejecución más amplia anterior pasó 80 pruebas. Cuatro escenarios Chromium reales verifican inscripción externa + Actualizar, Sin datos, ausencia real 0 % y conflicto de versión HTTP 409 + recarga + guardado HTTP 200, con capturas escritorio/móvil. |
| Higiene del cambio | `git diff --check` PASS; fixtures propias de navegador limpiadas y credenciales/cookies fuera del commit. |

El navegador usa la API, PostgreSQL y MinIO locales reales. Para Dispositivos,
el arnés reproduce la ruta `/ws` del gateway Traefik con un puente a la API,
porque Next dev sólo configura `/api`; las notificaciones no son simuladas.
Los fallos HTTP inyectados de interfaz se distinguen de las pruebas de
integración y de las cargas/bajas reales. No se cuenta una prueba de
caracterización del fallo anterior como una regresión superada.

La petición HTTP dedicada de alta descubrió que el DTO descartaba `status`,
aunque el servicio lo validaba. La nueva regresión falló antes del refuerzo
(201/active para `invalid`) y pasó después: cuatro estados inválidos rechazados
sin filas; catálogo válido y valor predeterminado persistidos. También pasan los
otros cuatro subcasos de la integración del handler. La compilación y el arranque
autenticado de la API final se comprobaron tras repetir Go.

Se conservan los intentos fallidos por configuración del arnés: URLs absolutas
del runtime en fixtures unitarias que esperan `/api`, y mezcla de `localhost`
con `127.0.0.1` en el escenario Programas. La reejecución usa el entorno de prueba
correspondiente sin modificar código para eludir aserciones. En desarrollo se
observó además un aviso de hidratación de estilos de viewport en `RootLayout`,
preexistente y fuera del parche; no se declara una consola libre de avisos.

## Alcance de publicación

Los cambios se publican en una rama y pull request hacia main; no acredita
merge ni despliegue en producción. No se usan destinatarios reales ni sesiones
vinculadas de WhatsApp/Meta/Kommo. La retirada `cleanup_scope=local` elimina el
registro de Clarin; no promete desvinculación remota. La baja de WhatsApp
oficial sigue requiriendo un flujo de desuscripción Meta implementado y validado.
La migración de carpetas utiliza PostgreSQL 16 (`SET NULL (folder_id)`).
