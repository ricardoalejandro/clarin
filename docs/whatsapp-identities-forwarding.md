# WhatsApp Web: identidad de participantes y reenvío nativo

Esta entrega usa `go.mau.fi/whatsmeow` fijado en `v0.0.0-20261017175727-b2b1e71d45e2`. No implementa estas funciones mediante WhatsApp Cloud API.

## Identidad

Los nombres y usuarios públicos se proyectan por cuenta y dispositivo desde hechos PN/LID entregados por el proveedor. Cada campo conserva origen y fecha. Una sincronización antigua no reemplaza hechos más recientes ni revive un usuario eliminado. Consultar participantes no importa Contactos al CRM. Los alias comprobados se usan para resolver y buscar; un usuario público nunca es una clave de Contacto.

Se procesan nombres de mensajes, caché, historial, Contact, BusinessName y AppState cuando esos eventos realmente llegan. La presencia de campos username en protobuf no demuestra que una sesión los entregue. No hay búsqueda genérica ni apertura por @usuario; tampoco se habilita Mensaje sin teléfono comprobado. El fallback visible es Nombre no disponible.

## Reenvío

`Message.forwarding` contiene `state` (`unknown`, `not_forwarded`, `forwarded`, `frequently_forwarded`) y `score` nullable. Los históricos son desconocidos. Las lecturas completas, búsqueda y WebSocket conservan la misma proyección; las observaciones parciales no degradan hechos confirmados. El remitente del grupo sigue siendo quien envió el mensaje al grupo, no un supuesto autor original.

El servidor construye un contexto nuevo: conserva el contador sin copiar citas, identidad del chat de origen ni menciones. Se mantienen leyendas, archivos, audio/nota de voz y animación WebP comprobada. No se reenvían mensajes revocados, de una visualización, medios ausentes ni tipos sin constructor nativo.

POST /api/messages/forward/batch recibe source_chat_id, source_message_id (UUID local), device_id, destination_chat_ids y client_operation_id. El servidor valida el conjunto, reserva un ID de WhatsApp por destino y persiste los resultados. GET /api/messages/forward/batch/:id consulta el recibo del actor autenticado. Repetir una operación no reenvía. Un resultado incierto requiere reconciliación por el mismo ID, nunca una nueva copia automática. Los envíos múltiples pueden tener resultado parcial.

Límites: cinco destinos; para un mensaje ya reenviado, un solo grupo; para reenvíos frecuentes, un destino. Un original propio no se etiqueta automáticamente. Un contador desconocido no se reinicia para permitir el envío.

## Activación

La recepción y visualización de metadatos no necesitan habilitar envíos experimentales. El reenvío nativo permanece apagado por defecto:

- WHATSAPP_NATIVE_FORWARDING_ENABLED=false
- WHATSAPP_NATIVE_FORWARDING_DEVICE_IDS= (UUID separados por coma)

Con la bandera activa, una lista no vacía limita los dispositivos permitidos; vacía permite el despliegue general únicamente después de verificarlo. La capacidad runtime can_forward_native también exige conexión. Tanto el handler como el transporte vuelven a comprobar la bandera. Esto no concede permisos de cuenta, grupo o contacto. Los recibos previos siguen disponibles si se desactiva.

Publicar primero el backend compatible y después el frontend. Mantener las migraciones aditivas y los recibos al revertir la interfaz.

## Verificación frontend

La pasada final ejecutó 145 pruebas de 11 archivos del chat, todas correctas. Cubren la conservación monotónica de metadatos en historial, búsqueda, ecos y respuestas parciales; autor real del grupo y etiquetas; fuente desconocida, contenido restringido, audio sin clasificación; límites de destinos y grupos; búsqueda y vaciado a 500 ms con texto y aborto inmediatos, cancelación y páginas obsoletas; cambio de cuenta/dispositivo; operación única, respuesta perdida, consulta del mismo ID, reintento explícito de destinos probados como no enviados y cierre de fallos definitivos. La capacidad ausente o revocada bloquea nuevas escrituras y mantiene legibles los recibos existentes.

TypeScript y compilación de producción pasaron. La revisión de navegador se ejecutó sobre esa compilación local con cuentas, identidades, mensajes y API totalmente sintéticos; no se enviaron mensajes reales a WhatsApp.

| Superficie | Evidencia y resultado |
| --- | --- |
| 320, 375, 768, 1024 y 1440 px | Diálogo de reenvío, recibo incierto y ficha sin teléfono; sin desbordamiento horizontal ni errores de página. Usuario separado del nombre y teléfono; Mensaje desactivado sin número comprobado. |
| Lote privado y grupo | Un POST por operación; restricción de un grupo y de un destino para mensajes frecuentes. Autor del grupo conservado y original propio sin etiqueta falsa. |
| Respuesta incierta | Cierre y reapertura conservan la operación. A 375 px también se recargó el documento y se reabrió explícitamente el grupo; comprobar hizo un GET al mismo ID sin crear otro POST. |
| Sidebar y Eros | Ocho combinaciones a 1024/1440 px. Eros en pantalla completa a 1024 cubre temporalmente el diálogo: al volver se conservan el mismo nodo, selección y scroll de 120 px. A 1440 se probó Eros acoplado. |
| Capacidad nativa desactivada, 375 px | Explicación visible, confirmación desactivada y cero POST de reenvío. |

Evidencia local no versionada: `tmp/reporteria-qa/identities-forwarding-browser-results.json` y `tmp/reporteria-qa/screenshots/identities-forwarding/`. Se inspeccionaron visualmente `forward-320.png`, `username-320.png`, `chrome-1440-sidebar-expanded-eros-open.png` y `capability-unverified-375.png`. Estas pruebas no acreditan entrega ni presentación remota de WhatsApp, ni que una sesión real entregue nombres de usuario.

## Pruebas reales autorizadas

Usar únicamente Ricardo Frelance / Ricardo Rojas, Filial Iquitos / Propafono y el grupo común test. Antes de cada envío comprobar identificadores de cuenta/dispositivo y miembros actuales: exactamente los dos números autorizados. No contactar terceros, cambiar privacidad, modificar mapas PN/LID ni abrir un segundo cliente de WhatsApp con las mismas sesiones.

La ejecución debe usar una sesión auténtica y las rutas normales de Clarin. No generar JWT de prueba, desactivar Turnstile ni agregar envíos al arranque del servidor. Un ejecutor separado no enviará nada sin autenticación y validación de destinos.

Verificar originales en ambas direcciones, reenvío recibido, original propio, cadena hasta frecuente, imagen/documento/audio sintéticos y recepción del mismo ID. La aceptación del servidor no acredita recepción. Enviar a un LID de un número conocido no demuestra búsqueda por usuario ni comunicación con una persona cuyo número nunca estuvo disponible.

## Evidencia

Registrar por separado pruebas automatizadas, integración PostgreSQL, navegador con datos sintéticos, recepción real y presentación en WhatsApp Web. El informe final y el PR deben identificar capacidades verificadas, no ejercitables, fallidas y no soportadas. No guardar credenciales, sincronizaciones completas ni contenido personal como evidencia.

## Matriz de aceptación de esta entrega

| Capacidad | Estado y límite comprobado |
| --- | --- |
| Resolver nombres PN/LID, procedencia y búsquedas | Implementado; verificación automatizada y de interfaz con datos sintéticos. No se importan Contactos al consultar integrantes. |
| Aislamiento de alias | El mapa global interno de whatsmeow no acredita que otra cuenta/dispositivo conozca un teléfono. Solo se usan pruebas del dispositivo para proyectar identidad y reconciliar Contactos. Las proyecciones históricas sin procedencia se leen conservadoramente hasta recibir metadata actual, sin inventar ni borrar asociaciones. |
| Usuario público recibido | Implementado y probado con eventos/protobuf sintéticos, incluidos cambio y eliminación explícita. No ejercitable como caso nuevo real con las dos cuentas autorizadas. |
| Iniciar por cualquier @usuario | No soportado por un recorrido público verificable de esta versión fijada; no se expone. La presencia de campos protobuf no demuestra resolución ni entrega. |
| Privado LID sin teléfono nunca conocido | Desactivado. Los dos números autorizados ya tienen teléfono conocido; su direccionamiento LID no demostraría este caso. |
| Recibir, persistir y mostrar reenvíos | Implementado y probado con eventos, PostgreSQL, HTTP/WebSocket y navegador sintéticos. No se atribuye el autor original de un reenvío. Los registros antiguos siguen desconocidos. |
| Envío nativo, medios e idempotencia | Implementado y verificado con proveedor simulado y serialización del protobuf real. Deshabilitado por defecto hasta completar recepción real. Resultados inciertos no generan copias automáticas. |
| Recepción real en el otro dispositivo y apariencia WhatsApp Web | Pendiente. No se han enviado mensajes reales en esta entrega. Aunque el usuario abrió una sesión, la herramienta de navegador de la tarea solo expone MCP Apps sin pestañas y devuelve Browser is not available: iab. No se eludió autenticación ni se abrió otro cliente de WhatsApp. |

No se declararon fallidas transmisiones que no llegaron a ejecutarse. El bloqueo de acceso al navegador impide acreditar el recorrido real, no demuestra falta de soporte del protocolo.

## Verificación backend

La pasada final de Linux con PostgreSQL aislado y `GOCACHE=/tmp/go-build go test -count=1 ./...` pasó, al igual que `go build ./cmd/server`. Incluye migraciones repetidas, filas antiguas desconocidas, hidratación monótona, alias entre cuentas/dispositivos con el sqlstore real compartido, reasignación de teléfono, ninguna creación CRM por consultas y operaciones HTTP con proveedor simulado, respuesta perdida y cambio tardío del destinatario. Los tests de grupo exigen el mismo autor o sus alias comprobados antes de enriquecer un mensaje duplicado.

La preparación nativa vuelve a comprobar permiso de grupo después de preparar medios y rechaza contenido o destino modificado antes del transporte. Los eventos de edición se prueban después de ejecutar `events.Message.UnwrapRaw()` real: una edición parcial no convierte la procedencia desconocida en original.

Se ejecutó además una pasada frontend focalizada de 36 pruebas en 3 archivos y TypeScript tras endurecer la reconciliación de participantes: las omisiones canónicas eliminan teléfono, usuario y avatar revocados, y LID distintos no se unen por reutilizar un teléfono. Esta pasada se solapa con las 145 pruebas anteriores.

Los alias incorporados por los propios fallbacks globales de whatsmeow tampoco cuentan como prueba nueva: un SenderAlt LID añadido a un PN entrante se admite solo si ya existe la relación local; los eventos de nombres usan su JID original. La agenda FullName/FirstName se conserva, mientras PushName/BusinessName copiados a alias requieren un hecho original verificable. Las regresiones incluyen este comportamiento real del proveedor. No se intentan deshacer automáticamente fusiones CRM históricas cuya procedencia no puede acreditarse.
