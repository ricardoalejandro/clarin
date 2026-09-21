# Respuestas rápidas y atención de chats — 21 de septiembre de 2026

## Comportamiento entregado

- Cada bloque del editor representa exactamente un mensaje. El pie pertenece al adjunto; `body` en la plantilla es solo una proyección para búsqueda y compatibilidad.
- Elegir una respuesta rápida prepara un borrador editable. El primer intento congela sus solicitudes; cada bloque tiene una operación idempotente y los bloques confirmados no se repiten.
- No leídos representa lectura compartida por cuenta. Pendientes representa mensajes entrantes que requieren atención, ordenados por la espera más antigua. Leer no equivale a atender.
- Responder reconoce únicamente la frontera de mensajes capturada antes del envío. Los mensajes que llegan después siguen pendientes. Una secuencia parcial no cierra la atención.
- Siguiente pendiente es una acción explícita; el chat seleccionado y sus borradores se conservan al cambiar de conversación.
- La autoría procede del usuario autenticado en el servidor y persiste en mensajes, historial y eventos. Un eco tardío no reemplaza la identidad autenticada. El historial sin identidad registrada se presenta como tal.

## Verificación

- Suite Go completa con `GOCACHE=/tmp/go-build go test ./...`.
- Integración sobre PostgreSQL 16 desechable con `CLARIN_RUN_CHAT_ATTENTION_INTEGRATION=1`: migraciones repetidas, reparación de contadores antiguos, aislamiento entre cuentas, duplicados concurrentes, fronteras de lectura y atención, revocación, autoría, eco anterior a persistencia, cursor de pendientes y recuperación idempotente tras perder una respuesta HTTP.
- TypeScript: `npx tsc --noEmit` en el mismo entorno Linux de compilación.
- Suite frontend general, pruebas del editor incorporado y scripts de integridad. La primera ejecución general presentó dos límites de tiempo y un valor de versión propio del entorno de compilación; las tres pruebas pasaron con `NEXT_PUBLIC_BUILD_VERSION=dev` y ejecución acotada.
- Compilación completa de producción mediante `npm run build` en la etapa builder de Docker.
- Playwright Chromium: editor a 320, 375, 768 y 1440 px, pie con formato y Unicode, orden persistido, acciones accesibles, lectura, cola estable, preparación sin envío, fallo parcial y reintento, borradores por conversación, siguiente pendiente, no requiere respuesta y autoría en Información del mensaje.

Los envíos de las pruebas usan un proveedor simulado y contactos ficticios. No se enviaron mensajes de prueba a contactos reales. Las confirmaciones de entrega y lectura continúan dependiendo del proveedor; una identidad histórica desconocida no se puede reconstruir retroactivamente.

## Operación

El despliegue utiliza `make deploy` desde `/root/proyect/clarin`. Antes del cambio se guarda un respaldo PostgreSQL, el commit anterior y referencias a las imágenes anteriores en `/root/clarin-backups/chat-20260921`.

La verificación posterior debe comprobar contenedores, `/health`, `/api/version`, logs de backend y frontend, columnas e índices, el trigger `chat_message_insert` y la coincidencia entre contadores y mensajes no leídos.

Una reversión al backend anterior exige retirar el trigger nuevo antes de volver a aceptar escrituras con ese backend: la versión anterior incrementaba el contador en otra ruta. Las columnas añadidas son compatibles y se conservan. No se restaura automáticamente un respaldo sobre mensajes que hayan llegado después del despliegue.
