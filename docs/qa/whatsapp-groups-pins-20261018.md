# WhatsApp: grupos, fijados personales y actualización — 18 octubre 2026

## Contrato del producto

- Los grupos se muestran en la bandeja habitual y se identifican por cuenta, canal/dispositivo y JID. Contact `is_group` conserva su identidad técnica, sin teléfono artificial ni creación masiva de contactos personales.
- Los mensajes grupales no crean/actualizan Leads, no pasan por política comercial ni campañas/automatizaciones y no generan Pendientes. Conservan No leídos y lectura compartida.
- El catálogo, la membresía, la restricción de administradores y los eventos del proveedor determinan capacidades reales; el historial permanece legible al perder la pertenencia o eliminar un dispositivo.
- Las menciones contienen identidad estructurada, independiente del nombre mostrado. Autores y citas conservan la identidad del participante; PN y LID nunca se convierten en teléfonos inventados.
- Las preferencias de fijación son privadas por cuenta/usuario/chat, con versión independiente de lectura/atención. Orden de fijación descendente; recibir mensajes no mueve los fijados. Pendientes individuales conserva FIFO.
- Resolver un chat LID a su conversación telefónica transfiere las preferencias dentro de la misma transacción, antes de eliminar la fuente. La fijación toma el mismo bloqueo de chat.
- Los medios grupales se descargan a un temporal acotado: máximo 64 MiB de contenido, dos operaciones simultáneas entre todos los dispositivos y recuperación histórica, con 40 segundos de plazo. El tamaño declarado no sustituye el límite real de escritura. Los archivos que exceden el límite conservan nombre, autor y texto, y se consultan en WhatsApp; no generan reintentos permanentes. Los temporales se eliminan al terminar o cancelar.
- Los recibos grupales abiertos se actualizan con eventos reales del proveedor, agrupando ráfagas y conservando las páginas y filas visibles. La respuesta HTTP también reconcilia los límites permanentes de medios sin depender de WebSocket.

## Dependencia y reversión

El despliegue inicial deja `WHATSAPP_GROUP_CHATS_ENABLED=false`. La aceptación activa primero la capacidad para la cuenta de pruebas mediante `WHATSAPP_GROUP_CHAT_ACCOUNTS`; después se retira la restricción de cuentas. Las capacidades de API y el proveedor aplican el mismo gate.

Se fija whatsmeow `v0.0.0-20261017175727-b2b1e71d45e2` y toolchain Go 1.27.2. La dependencia anterior era `v0.0.0-20260709092057-73fe7355f59f`. Se adapta `IsOnWhatsApp` para separar `PhoneNumber` de LID y el resultado de envío para mantener identidad CRM estable.

La comparación oficial contiene 91 commits. Los cambios relevantes para esta integración son:

| Área | Cambio upstream | Decisión en Clarin |
| --- | --- | --- |
| Identidad y destinatario | Los mensajes individuales usan LID; cambia la consulta `IsOnWhatsApp`, se corrigen negativos, el mapa LID conserva el dispositivo y se prefiere `participant_pn` para autores. | Mantener el teléfono real como identidad CRM y resolver PN/LID explícitamente. Usar `SendResponse.Chat` para el destino efectivo sin duplicar Contact ni Chat. |
| Conexión | La cola de eventos deja de compartirse entre conexiones; se corrige el orden de errores de stream, los contextos Noise y los frames fragmentados. | Actualizar como mantenimiento de compatibilidad y comprobar reconexión de las sesiones existentes. |
| Confirmaciones y reintentos | Correcciones de reintentos, acknowledgements y recepción. | Conservar la idempotencia de envíos de Clarin y comprobar persistencia, citas y recibos reales. |
| Medios | Los medios sin cifrar ignoran claves sobrantes. | Mantener inventario y aislamiento de almacenamiento; acotar también los bytes reales de descargas grupales. |
| Grupos | Correcciones de addressing en JoinedGroup, PN al crear grupos en modo LID y comprobación de permisos. | El soporte básico ya existía. Clarin integra lectura/escritura en grupos existentes y respeta membresía y restricciones; no incorpora creación ni administración de grupos. |

Ejemplos verificables del repositorio oficial: [DM por LID](https://github.com/tulir/whatsmeow/commit/4f8f64e0dd21), [consulta de WhatsApp](https://github.com/tulir/whatsmeow/commit/6e4c34161093), [cola por conexión](https://github.com/tulir/whatsmeow/commit/4fa3462310aa) y [destino efectivo de envío](https://github.com/tulir/whatsmeow/commit/b25a56d63729). La recomendación es actualizar con versión exacta y aceptación gradual: evita mantener una integración sobre contratos de identidad antiguos y permite revertir con evidencia. No se actualizan otras dependencias fuera de las requeridas por este salto.

El esquema de sesiones pasa de 14 a 16 y conserva `compat=8`. Las migraciones upstream son aditivas. El procedimiento reproducible de `scripts/qa/run-whatsmeow-upgrade.sh` prueba el SQL store anterior, el nuevo y otra vez el anterior sobre la misma base de datos sintética; nunca instancia un cliente de WhatsApp.

Antes del despliegue se conserva una imagen inmutable y respaldo consistente. La reversión normal recupera la imagen anterior manteniendo la base actual; nunca retrocede manualmente `whatsmeow_version` ni restaura sesiones antiguas encima de tráfico nuevo. Las sesiones clonadas para validar almacenamiento no deben conectarse a WhatsApp.

## Verificación reproducible

- Backend: `GOCACHE=/tmp/go-build GOMAXPROCS=2 go test -p 2 ./...`.
- PostgreSQL aislado: activar `CLARIN_RUN_CHAT_PREFERENCES_INTEGRATION=1`, `CLARIN_RUN_CHAT_GROUP_INTEGRATION=1`, `CLARIN_RUN_CHAT_GROUP_CONTEXT_INTEGRATION=1`, `CLARIN_RUN_CHAT_GROUP_MESSAGE_INTEGRATION=1` y `CLARIN_RUN_CHAT_ATTENTION_INTEGRATION=1`, con `DATABASE_URL` entregada exclusivamente por entorno. Cada prueba crea y elimina su propia base QA.
- Frontend: suite de unidades, `npx tsc --noEmit`, build de producción y `tests/groups-pins.spec.ts` en navegador con datos sintéticos.
- El navegador cubre bandeja, filtros, autores/citas, menciones, fijar/desfijar, rollback con mensajes concurrentes y anchos 320/375/768/1440.
- La cabecera usa tres filas compactas: dispositivo/acciones, búsqueda/filtros y vistas/tipo. Las opciones de reacción se abren bajo demanda con borrador y Aplicar; no ocupan filas permanentes. El navegador mide un máximo de 184 px de cabecera en escritorio y 200 px en móvil, con objetivos táctiles de 44 px.
- Los envíos reales de aceptación se restringen a los destinos privados designados expresamente por el titular. No se registran credenciales, contenido privado de otras conversaciones ni material de sesiones en reportes.

Los resultados ejecutados y cualquier limitación restante se anotan al cerrar la aceptación; esta lista por sí sola no acredita ejecución ni salud del despliegue.

## Evidencia previa a producción

- Suite completa Go 1.27.2 en Linux: PASS, con paralelismo limitado a un paquete y dos CPU lógicas. Incluye PostgreSQL aislado para grupos, fijados y atención existente.
- Repetición final de backend `c30a3a01`: PASS en todos los paquetes, con los tres flags de integración PostgreSQL activados. El tar final se exporta con `core.autocrlf=false` (SHA-256 `17da3af93c321f80e22223004a8e500eeec321f8fa92bcd844544762664beb76`). El intento anterior convirtió el árbol LF a CRLF por la configuración Windows y falló dos comprobaciones estáticas de saltos de línea; se demostró que el blob y la base eran idénticos y se corrigió únicamente la exportación, conservando las aserciones y el producto.
- `npx tsc --noEmit`: PASS. Navegador: 5/5 recorridos, incluidos los cuatro anchos y rollback/reconciliación de fijados.
- Suite principal de frontend sobre la instantánea final `c30a3a01`: 403/403 archivos y 2 437/2 437 pruebas PASS en Linux, 842,80 segundos, exit 0 y sin OOM. Se usa una imagen de QA con `npm ci` limpio, vendor Excalidraw `clarin.8`, sin red ni mounts, un worker, dos CPU y 4 GiB máximos.
- El primer intento de esa suite heredó variables de compilación de producción y no constituye resultado válido de unidades. Una aserción demostró la URL absoluta frente a la ruta relativa esperada. El control con `api.ts` final y anterior reprodujo los mismos siete fallos; con el entorno normal, la versión anterior pasó 21/21 y la final pasó los cuatro archivos afectados (73/73). La suite completa anterior se repitió vaciando las cinco variables públicas de compilación y usando `NODE_ENV=test`, sin alterar producto ni expectativas para ocultar fallos.
- Store de whatsmeow sintético: anterior 14/8 → nuevo 16/8 → anterior sobre 16/8, PASS. Las lecturas/escrituras antiguas conservan las columnas nuevas; no se conectó ninguna sesión clonada.
- Respaldo PostgreSQL previo restaurado y validado en una base aislada: 11 742 chats. Imágenes anteriores conservadas con etiqueta inmutable; configuración y material de respaldo permanecen privados fuera del repositorio.
- Las migraciones de Clarin se ejecutaron dos veces sobre esa copia restaurada: PASS e idempotencia. Las huellas de Leads, mensajes, identidades, chats y contactos individuales se conservaron. La copia no tenía chats grupales; las variantes grupales se probaron con fixtures SQL aislados.
- La repetición final incluye la columna del límite permanente de medios: dos pasadas PASS, los 18 checks de conservación/idempotencia correctos, seis tablas presentes y cero violaciones de atención, canal, teléfono de grupo, fijados o constraints. Se verificó `media_unavailable_reason TEXT NOT NULL DEFAULT ''` y ningún mensaje antiguo recibió un motivo nuevo.
- Se repitió la integración SQL después de corregir la intersección `kind=group&pending_only=true`: devuelve cero grupos y cero individuales, mientras las variantes individuales conservan su cola real.
- Envío individual previo con la versión antigua al destino expresamente autorizado: PASS. El grupo de aceptación se identificó de forma única y con dos participantes; aún no acredita pruebas posteriores a la actualización.

La comparación de dependencia usa el [repositorio oficial de whatsmeow](https://github.com/tulir/whatsmeow/compare/73fe7355f59f...b2b1e71d45e2). El soporte de grupos ya existía en la dependencia anterior. La actualización se justifica por compatibilidad de protocolo e identidad PN/LID y correcciones upstream; la integración de grupos y fijados pertenece a Clarin. El cambio exige toolchain nueva y dos migraciones aditivas del SQL store, por lo que se valida y activa por etapas.

## Aceptación gradual en el sistema real

La primera versión desplegada es `c30a3a01`, publicada como `2026.10.18-1-225941286734283-c30a3a01c7ab`. Se ejecutó `make deploy` desde el checkout oficial, conservando respaldo PostgreSQL, configuración e imágenes anteriores. Los controles reales de contenedores, health, logs, versión pública, PostgreSQL y MCP sin credencial pasaron. Las dos sesiones previamente autenticadas siguieron conectadas sin volver a emparejar; el contador de transportes del health también incluye conexiones aún sin emparejar y no equivale a sesiones autenticadas.

Con grupos habilitados exclusivamente en la cuenta de aceptación, se comprobaron el destinatario individual autorizado, la consulta real PN/LID, envío y respuesta citada individuales, persistencia e idempotencia, fijar/desfijar sin cambiar No leídos y conservación de la huella de los 227 Leads de esa cuenta. La sincronización descubrió 86 grupos existentes. Sólo se autorizaron envíos al grupo de dos participantes designado por el titular; las pruebas rechazaron convertir su identidad técnica en Lead, vincular otra identidad y mencionar un destinatario ajeno antes de entrar al flujo de envío.

La revisión visual real en 1440 y 375 px comprobó participantes, menciones, filtros compactos y fijados persistidos después de recargar, restaurando su estado inicial. No hubo errores de página ni desbordamiento. La prueba entrante detectó dos defectos antes de ampliar la activación:

- El contexto de un mensaje incluía dos objetos con el mismo UUID, pero la hidratación conservaba sólo uno. Se corrigen todas las proyecciones de la misma cuenta/chat mediante una consulta por identificador único; menciones, autores, citas y disponibilidad de medios quedan consistentes entre target, ventana, historial y búsqueda.
- WhatsApp puede emitir una distribución de clave y el contenido visible como eventos separados con el mismo identificador. El primer evento técnico vacío no debe persistirse ni consumir ese identificador. Los placeholders ya existentes sólo pueden repararse desde contenido auténtico del proveedor con la misma cuenta, dispositivo, chat, identificador y autor, sin sustituir mensajes editados, revocados o medios. La reparación conserva UUID, fecha, lectura y contadores; se publica como actualización del mensaje, nunca como nueva llegada.

La corrección `eede613cb2a4` pasó otra suite completa Go 1.27.2 en Linux con los cinco flags PostgreSQL activados. Se verificaron físicamente los tres nuevos fixtures SQL dentro del artefacto LF antes de ejecutarla (SHA-256 `ae886672c9996e0f1766e42e9696510e65ec483a034b163320e89c0f8f0a5f26`). Incluye API real de contexto/historial/búsqueda, reparación concurrente, rechazo de otra cuenta/dispositivo/autor, actualización WebSocket sin nueva llegada y dos mensajes de texto idéntico con IDs distintos conservados como dos filas y dos No leídos.

El despliegue de `eede613cb2a4` mediante `make deploy` terminó con exit 0; la versión pública es `2026.10.18-1-233719046278253-eede613cb2a4`. Contenedores, health, PostgreSQL, versión y MCP 401 pasaron otra vez. Los logs de arranque acreditan la autenticación de los mismos dos dispositivos previos, con cero indicadores de error o fatalidad; no se usa el contador de transportes como sustituto de esa prueba.

Después de esa corrección, los dos mensajes idénticos enviados por el titular se recibieron como dos filas distintas con contenido visible. La aceptación real de grupos pasó texto, mención, respuesta citada, reacción, imagen sintética 64×64 inventariada, lectura, recibo real de un participante, paginación y alias únicos, fijar/desfijar sin cambiar No leídos y conservación de la huella de los 227 Leads. Los reintentos del helper reutilizan las mismas operaciones y no duplican envíos. Una llamada QA inicial de reacción usó por error el UUID local; se corrigió sólo el helper para usar el ID del proveedor, igual que la interfaz existente, sin cambiar producto.

La revisión visual real de esa versión pasó en 1440 y 375 px: mensaje entrante auténtico, cita navegable dentro del mismo grupo, imagen cargada con dimensiones naturales 64×64, recibo del participante, detalles con dos miembros, mención sin envío y fijados persistidos después de recargar y restaurados al final. Cero errores de página. El comprobador móvil se adapta a la virtualización: verifica cabecera y destino reales en vez de exigir una fila de navegación desmontada.

Se solicitó historial una sola vez para el grupo autorizado. Llegó una respuesta ON_DEMAND a los 2,9 segundos, pero no contenía mensajes importables y el primer placeholder de prueba no se recuperó. No se inventó su texto ni se modificó su fecha, identidad o lectura; tampoco se repitió la solicitud. La API del proveedor no garantiza recuperar mensajes antiguos. La interfaz identifica el texto grupal vacío como «Mensaje no disponible», conserva autor/hora/cita y lo sustituye por el contenido real si posteriormente llega una recuperación válida. Los mensajes individuales, medios, revocados y estados de visualización única conservan su representación propia.

El HEAD oficial de whatsmeow se reconfirmó a las 23:43:31 UTC del 18/10/2026: sigue siendo `b2b1e71d45e2ff171153b025b5a42f475bb30ef8`.
