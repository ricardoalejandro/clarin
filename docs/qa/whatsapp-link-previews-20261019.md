# WhatsApp: vistas previas recibidas — 19 octubre 2026

## Estado de este informe

Informe de QA del commit desplegado `908ac927eb49c7b7d84e2b1fc7111e8da5436638`, versión pública `2026.10.19-1-221745502272490-908ac927eb49`. Su frontend conserva el código de `5ae34b172800d08a28a57a681c3b9b02e59f9a5e`, con pruebas focalizadas y TypeScript aprobados. La suite Go con diez gates, las dos migraciones sobre copia restaurada, el despliegue y las comprobaciones de runtime pasaron. También pasaron los envíos autorizados de texto plano individual y grupal, la recepción real de una tarjeta con título y descripción, y la aceptación visual. No quedan pendientes funcionales bloqueantes; las limitaciones de proveedor y la limpieza de QA se distinguen al cierre.

Las pruebas reales de grupos, fijados y medios de [la entrega anterior](whatsapp-groups-pins-20261018.md) corresponden a aquella funcionalidad. No sustituyen la aceptación de este cambio.

## Alcance del producto

- Mostrar en conversaciones individuales y grupales una tarjeta compacta con el título, descripción y miniatura que WhatsApp ya haya incluido en el mensaje recibido. El diseño reserva una miniatura de 72 px y permite mantener una tarjeta de texto cuando falta la imagen.
- Vincular los metadatos únicamente a una URL HTTP/HTTPS reconocible dentro del cuerpo del mismo mensaje. Se admite la forma `www.` normalizada a HTTPS. Una URL distinta, inválida o ambigua no autoriza una tarjeta; el texto original se conserva.
- Mantener la tarjeta en recepción, historial, búsquedas, ventanas de cita, ediciones y actualizaciones en tiempo real. La recepción repetida puede completar metadatos faltantes del mismo mensaje sin crear otra llegada, cambiar lectura, incrementar atención ni alterar Leads.
- Respetar revocación y visualización única. Una edición puede reemplazar o retirar la tarjeta; el mensaje original o una entrega tardía no deben recuperar una imagen retirada explícitamente.

No se generan vistas previas salientes, no se rastrean páginas y no se reconstruyen tarjetas históricas visitando sus enlaces. WhatsApp puede entregar título sin imagen, imagen sin descripción o ningún metadato. La tarjeta no está garantizada para todos los enlaces ni se presenta como prueba de que su destino sea legítimo o seguro. La integración recibida pertenece al proveedor WhatsApp Web de Clarin; no acredita paridad con Cloud API.

## Dependencia conservada

Se mantiene whatsmeow `v0.0.0-20261017175727-b2b1e71d45e2`, ya fijado en la entrega de grupos, y el toolchain Go 1.27.2. Esta funcionalidad aprovecha los campos de `ExtendedTextMessage` que esa versión ya expone: texto coincidente, título, descripción y JPEG embebido. No requiere actualizar la librería ni sus dependencias.

La [comparación oficial de la actualización anterior](https://github.com/tulir/whatsmeow/compare/73fe7355f59f...b2b1e71d45e2) y sus 91 commits están documentadas en el informe de grupos. Esa decisión no se repite ni se presenta como una nueva actualización en esta entrega. Tampoco se afirma aquí que el pin siga siendo el HEAD actual del proveedor.

## Navegación, privacidad y límites de recursos

Clarin lee metadatos ya recibidos y sólo admite la miniatura JPEG incluida en ese mensaje. Abrir la conversación no inicia una petición al enlace, a un favicon ni a una URL remota de miniatura. La imagen visible procede del almacenamiento autenticado de la propia cuenta. Abrir voluntariamente el enlace sí lleva al navegador al sitio externo; mostrar una tarjeta no elimina los riesgos habituales de navegación o suplantación.

| Recurso | Límite implementado |
| --- | --- |
| URL de los metadatos | HTTP/HTTPS, máximo 4096 caracteres, sin credenciales ni controles; debe coincidir con una URL del cuerpo. |
| Título y descripción | Hasta 256 y 1024 caracteres respectivamente. |
| Imagen de entrada | Sólo JPEG embebido, máximo 1 MiB y 4 000 000 píxeles; se comprueban dimensiones antes de decodificar. |
| Imagen almacenada | JPEG recodificado, máximo 512 px por lado y 128 KiB; se descartan metadatos del archivo de origen. |
| Normalización simultánea | Dos operaciones; si ambas plazas están ocupadas se conserva la tarjeta sin imagen, sin encolar trabajo. |
| Operación de almacenamiento | Contexto de 3 segundos; cierre del registro durable con hasta 2 segundos adicionales si se cancela el contexto original. |

Una imagen inválida, demasiado grande, sin cupo, sin cuota o con fallo de almacenamiento no impide guardar el texto del mensaje. No se agrega un descargador de URLs arbitrarias ni un trabajador nuevo de generación o borrado automático.

## Persistencia, almacenamiento y aislamiento

La migración principal incorpora `messages.link_preview`, `link_preview_media_asset_id` y `link_preview_version`; el estado de ediciones grupales pendientes conserva también `edited_link_preview` y `edited_link_preview_media_asset_id`. Esto permite recibir una edición antes del mensaje original sin perder su tarjeta. Las referencias de assets pertenecen a la misma cuenta mediante claves compuestas.

Los backfills de Contact para instalaciones antiguas se ejecutan una sola vez. La inicialización de `avatar_auto_fetched_at` ocurre únicamente al introducir esa columna; la promoción histórica del perfil usa una marca durable y una transacción. Una instalación que ya completó el perfil conserva sus valores actuales, incluidos los nulos elegidos después. Reiniciar no vuelve a completar nombres desde snapshots antiguos ni cambia la fecha de obtención automática de una foto. La función y el trigger que mantienen las proyecciones de Contact siguen actualizándose normalmente.

Las miniaturas se reservan en `media_assets` y `storage_objects` antes de subir bytes. Su ruta pertenece a la cuenta, dentro de `link-previews/`, y la deduplicación usa el contenido normalizado. Una clave retirada no se reutiliza: un nuevo intento obtiene otra clave. Si falla o se cancela una carga, permanece un registro durable para el flujo de limpieza existente.

La miniatura es una referencia independiente del adjunto principal. El inventario, la autorización de lectura, los usos visibles, los retiros y la prueba previa al borrado físico incluyen tanto el mensaje como las ediciones grupales pendientes. Retirar la miniatura conserva URL, título, descripción, texto y adjunto principal; restaurarla no sobrescribe lectura, estado de entrega ni otros campos del mensaje. La recuperación rechaza un contenido que haya cambiado desde el retiro.

Las reservas y reutilizaciones renuevan una protección temporal de 24 horas basada en `updated_at`, limitada al espacio y hash de miniaturas. Esa protección se complementa con bloqueos y verificación de referencias vivas, recuperaciones y papelera. Su vencimiento no ejecuta un borrado: permite evaluar el objeto mediante las herramientas de limpieza existentes. Eliminar un chat, dispositivo o cuenta debe liberar sus referencias sin borrar bytes compartidos que otra referencia viva todavía utilice.

## Reconciliación y carreras cubiertas

`link_preview_version` es independiente de lectura, entrega y atención. Un trigger incrementa su valor sólo cuando cambia el JSON de la vista previa o su asset. Retirar y restaurar una miniatura producen revisiones nuevas; actualizar recibos no las cambia.

El worker también ejecuta `Migrate` cuando el backend ya puede atender solicitudes. Por eso la migración mantiene el trigger mediante una única sentencia `CREATE OR REPLACE TRIGGER`, sin un intervalo entre eliminación y creación durante el cual un mensaje pudiera cambiar sin incrementar su revisión. La función también se reemplaza sin eliminarla. La lectura de versión confirmó PostgreSQL 16.11, compatible con [esta sintaxis oficial](https://www.postgresql.org/docs/16/sql-createtrigger.html). El fixture aprobado comprueba que el OID del trigger se conserve entre dos migraciones, además de los incrementos de revisión existentes. La comprobación sobre la copia restaurada también confirmó el OID estable.

El frontend trata la tarjeta y su revisión como una pareja. Después de aplicar un retiro en revisión 2, un enriquecimiento tardío de revisión 1 o una repetición incompatible de revisión 2 no puede recuperar la imagen; una restauración posterior de revisión 3 sí puede hacerlo. Esta regla alcanza la conversación principal, caché, búsqueda y ventana de cita, preservando las reacciones pendientes y los recibos avanzados.

La hidratación de una página antigua no le asigna la revisión de otra versión del cuerpo. Las respuestas tardías de búsqueda o cita también deben reconciliar la pareja antes de sustituir las proyecciones cargadas. Si WhatsApp confirma una edición pero falla su persistencia local, la respuesta informa la situación y no inventa una revisión canónica.

## Verificación realizada y trazabilidad

Los resultados siguientes corresponden a comprobaciones con alcances distintos. No se suman sus conteos porque algunas pruebas se solapan. Las pruebas con PostgreSQL usan bases aisladas y datos sintéticos; no instancian clientes WhatsApp ni conectan sesiones copiadas.

| Comprobación | Resultado conocido al redactar |
| --- | --- |
| Backend completo: `go test ./...` en Linux con diez gates PostgreSQL | PASS sobre `908ac927eb49c7b7d84e2b1fc7111e8da5436638`, incluido el control de OID. Tiempos por paquete: API 102,690 s; repositorio 140,411 s; WhatsApp 20,325 s; database 142,802 s. |
| PostgreSQL de Contact: `TestContactBackfillMigrationIntegration` y `TestContactProfileCanonicalBackfill` | Ambos PASS, también dentro de la suite final. Cubren instalación actual y legacy, rollback, campos canónicos vaciados, conflictos y aislamiento. La evidencia detallada es privada. |
| Migración y conservación de la copia restaurada | `Migrate` dos veces sobre `908ac927`: EXIT 0. Conteos y huellas de campos preexistentes de ocho tablas conservados, incluidos todos sus timestamps. Verificadas las cinco columnas de vistas previas, las dos claves foráneas compuestas y el OID estable del trigger. |
| Normalizador JPEG: límites, salida determinista, cancelación y plazas ocupadas | PASS focalizado; contempla JPEG acotado y rechazo inmediato cuando no hay plaza. |
| Frontend: `node node_modules/vitest/vitest.mjs run src/components/chat/linkPreviewState.test.ts src/components/chat/messageState.test.ts src/components/chat/ChatPanelExperience.test.tsx --maxWorkers=1` | PASS final, 3 archivos y 77 pruebas, 38,27 s. Incluye versiones, eventos en conversación/búsqueda/cita, edición HTTP y respuestas HTTP tardías de búsqueda/cita. |
| Enlaces: `node node_modules/vitest/vitest.mjs run src/lib/webLinks.test.tsx --maxWorkers=1` | PASS final, 16/16 pruebas, 1,76 s. Incluye una entrada determinista de 104 032 caracteres y el recorte de puntuación con recorrido O(n), sin aserciones basadas en tiempos de ejecución. |
| Otras superficies UI | Tres archivos adicionales quedaron aprobados dentro de la pasada de 6 archivos/97 pruebas. Esa pasada se solapa con los focos anteriores y no se suma a sus conteos. |
| Consumidores compartidos de representación de enlaces | PASS, 4 archivos/13 pruebas. |
| TypeScript: `node node_modules/typescript/bin/tsc --noEmit --tsBuildInfoFile ../.runtime/link-previews.tsbuildinfo` | EXIT 0 sobre la fuente final; el último incremental posterior al ajuste O(n) también terminó con EXIT 0. |
| Revisión independiente de referencia segura y propagación de versiones | Realizada. Se detectaron y corrigieron la restitución por redelivery y la promoción de revisión sobre un cuerpo antiguo. |
| `git diff --check` de los últimos cambios propios de almacenamiento | PASS. No sustituye el control final del diff completo. |

El fixture `backend/internal/api/chat_link_preview_storage_integration_test.go`, bajo `CLARIN_RUN_CHAT_LINK_PREVIEW_STORAGE_INTEGRATION=1`, cubre reserva durable, deduplicación y renovación de protección, referencias compartidas, aislamiento de cuenta, retiro real con registro de recuperación, rechazo de redelivery, restauración, revisiones monotónicas, conservación de recibos, inventario paginado, claves retiradas, bloqueo concurrente de una edición pendiente y liberación de referencias al eliminar el chat. Ejecuta la migración dos veces en su propia base; no realiza operaciones contra S3 ni WhatsApp.

La integración de repositorio usa `CLARIN_RUN_CHAT_LINK_PREVIEW_INTEGRATION=1`. Los fixtures de transporte y proyección HTTP/WebSocket se integran con los gates grupales existentes. La suite final aprobó estos controles junto con los de Contact y CRM. Las pruebas aisladas y la migración de la copia restaurada no sustituyen la aceptación del sistema real.

## Producción y aceptación real

`make deploy` de `908ac927` terminó con EXIT 0. La comprobación real confirmó los cinco contenedores, health del backend y la versión pública indicada. Los logs revisados de backend y frontend no mostraron SQLSTATE, panic ni fatal. PostgreSQL confirmó las cinco columnas, las dos claves foráneas compuestas, el trigger y la marca de migración. Se conservaron las dos sesiones WhatsApp previamente autenticadas, los flags globales de grupos y los bytes de configuración y CHANGELOG. `/mcp` sin bearer respondió 401.

La continuidad de WhatsApp se confirmó con eventos reales posteriores al arranque actual: las mismas dos sesiones de la referencia previa emitieron `events.Connected`, sin `Disconnected`, `LoggedOut` ni dispositivos adicionales en el intervalo revisado. La conclusión no depende sólo del estado guardado en PostgreSQL.

Los envíos reales autorizados de texto plano individual y grupal pasaron. El envío individual fue aceptado por el proveedor y conservó el cuerpo original; `link_preview` permaneció `null`, como corresponde al envío de texto plano sin generación de tarjeta. Estas pruebas no acreditan generación saliente de vistas previas ni recibos de lectura.

La recepción grupal real de un enlace de NASA conservó el cuerpo y persistió título, descripción y revisión de la tarjeta, con miniatura nula. El usuario confirmó que WhatsApp nativo también mostraba únicamente título y descripción. Esto valida una vista previa nativa recibida sin imagen; no demuestra recepción de un JPEG embebido ni subida real de una miniatura a S3.

| Aceptación de navegador | Resultado final |
| --- | --- |
| Fixtures en 320, 375, 768 y 1440 px | PASS, 24 comprobaciones; cero errores de página y cero solicitudes externas automáticas. El guion bloqueó 18 intentos de mutación. |
| Tarjeta real recibida de NASA en 375 y 1440 px | PASS, 2 comprobaciones; cero errores y cero solicitudes externas. El guion bloqueó 4 intentos de mutación. |
| Inspección visual de capturas | PASS: tarjetas y detalles en los cuatro anchos, edición con respuesta tardía en 1440 px y tarjeta real de NASA en 375/1440 px. |

El primer guion de 320 px cerraba el chat al pulsar Escape. Se corrigió exclusivamente el guion, sin cambios de producto, y la pasada final completa aprobó los cuatro anchos.

La comprobación posterior conservó idéntica la huella de los 227 Leads. Se registraron 86 grupos, cero Leads grupales, cero Pendientes grupales y cero teléfonos en Contacts de grupo. El registro de aceptación contiene 12 mensajes de prueba; no se publica su contenido. La segunda verificación final volvió a aprobar los cinco servicios, health, versión, esquema, las dos sesiones previas, logs y MCP 401, y confirmó otra vez la conservación de Leads y los invariantes grupales.

## Límites y cierre

- La tarjeta depende de los metadatos que WhatsApp entregue. La imagen sólo se incorpora si llega un JPEG embebido válido; Clarin no visita el enlace ni descarga una miniatura remota para completarla.
- El JPEG se validó mediante unidades, fixtures PostgreSQL y navegador con respuestas simuladas. No se afirma recepción real de JPEG ni almacenamiento S3 real de esa miniatura.
- No se generan vistas previas salientes. La edición y revocación de tarjetas tienen cobertura automatizada; no se presentan como pruebas reales del proveedor en esta aceptación.
- No quedan pendientes funcionales bloqueantes.

La limpieza de QA terminó: se revocó la sesión temporal, se eliminó su JSON local de autenticación del navegador, se retiraron las tres bases de pruebas propias después de comprobar que no tenían conexiones activas y se detuvo el builder dedicado. Se conservaron los datos de producción y los respaldos.

No se adjuntan credenciales, identificadores personales, fotos, contenido de conversaciones ni enlaces privados. Los artefactos operativos y logs completos permanecen fuera de este informe público.
