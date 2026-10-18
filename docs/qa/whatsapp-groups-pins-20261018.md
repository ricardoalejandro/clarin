# WhatsApp: grupos, fijados personales y actualización — 18 octubre 2026

## Contrato del producto

- Los grupos se muestran en la bandeja habitual y se identifican por cuenta, canal/dispositivo y JID. Contact `is_group` conserva su identidad técnica, sin teléfono artificial ni creación masiva de contactos personales.
- Los mensajes grupales no crean/actualizan Leads, no pasan por política comercial ni campañas/automatizaciones y no generan Pendientes. Conservan No leídos y lectura compartida.
- El catálogo, la membresía, la restricción de administradores y los eventos del proveedor determinan capacidades reales; el historial permanece legible al perder la pertenencia o eliminar un dispositivo.
- Las menciones contienen identidad estructurada, independiente del nombre mostrado. Autores y citas conservan la identidad del participante; PN y LID nunca se convierten en teléfonos inventados.
- Las preferencias de fijación son privadas por cuenta/usuario/chat, con versión independiente de lectura/atención. Orden de fijación descendente; recibir mensajes no mueve los fijados. Pendientes individuales conserva FIFO.
- Resolver un chat LID a su conversación telefónica transfiere las preferencias dentro de la misma transacción, antes de eliminar la fuente. La fijación toma el mismo bloqueo de chat.

## Dependencia y reversión

El despliegue inicial deja `WHATSAPP_GROUP_CHATS_ENABLED=false`. La aceptación activa primero la capacidad para la cuenta de pruebas mediante `WHATSAPP_GROUP_CHAT_ACCOUNTS`; después se retira la restricción de cuentas. Las capacidades de API y el proveedor aplican el mismo gate.

Se fija whatsmeow `v0.0.0-20261017175727-b2b1e71d45e2` y toolchain Go 1.27.2. La dependencia anterior era `v0.0.0-20260709092057-73fe7355f59f`. Se adapta `IsOnWhatsApp` para separar `PhoneNumber` de LID y el resultado de envío para mantener identidad CRM estable.

El esquema de sesiones pasa de 14 a 16 y conserva `compat=8`. Las migraciones upstream son aditivas. El procedimiento reproducible de `scripts/qa/run-whatsmeow-upgrade.sh` prueba el SQL store anterior, el nuevo y otra vez el anterior sobre la misma base de datos sintética; nunca instancia un cliente de WhatsApp.

Antes del despliegue se conserva una imagen inmutable y respaldo consistente. La reversión normal recupera la imagen anterior manteniendo la base actual; nunca retrocede manualmente `whatsmeow_version` ni restaura sesiones antiguas encima de tráfico nuevo. Las sesiones clonadas para validar almacenamiento no deben conectarse a WhatsApp.

## Verificación reproducible

- Backend: `GOCACHE=/tmp/go-build GOMAXPROCS=2 go test -p 2 ./...`.
- PostgreSQL aislado: activar `CLARIN_RUN_CHAT_PREFERENCES_INTEGRATION=1` y `CLARIN_RUN_CHAT_GROUP_INTEGRATION=1`, con `DATABASE_URL` entregada exclusivamente por entorno. Cada prueba crea y elimina su propia base QA.
- Frontend: suite de unidades, `npx tsc --noEmit`, build de producción y `tests/groups-pins.spec.ts` en navegador con datos sintéticos.
- El navegador cubre bandeja, filtros, autores/citas, menciones, fijar/desfijar, rollback con mensajes concurrentes y anchos 320/375/768/1440.
- Los envíos reales de aceptación se restringen a los destinos privados designados expresamente por el titular. No se registran credenciales, contenido privado de otras conversaciones ni material de sesiones en reportes.

Los resultados ejecutados y cualquier limitación restante se anotan al cerrar la aceptación; esta lista por sí sola no acredita ejecución ni salud del despliegue.

## Evidencia previa a producción

- Suite completa Go 1.27.2 en Linux: PASS, con paralelismo limitado a un paquete y dos CPU lógicas. Incluye PostgreSQL aislado para grupos, fijados y atención existente.
- `npx tsc --noEmit`: PASS. Navegador: 5/5 recorridos, incluidos los cuatro anchos y rollback/reconciliación de fijados.
- Store de whatsmeow sintético: anterior 14/8 → nuevo 16/8 → anterior sobre 16/8, PASS. Las lecturas/escrituras antiguas conservan las columnas nuevas; no se conectó ninguna sesión clonada.
- Respaldo PostgreSQL previo restaurado y validado en una base aislada: 11 742 chats. Imágenes anteriores conservadas con etiqueta inmutable; configuración y material de respaldo permanecen privados fuera del repositorio.
- Envío individual previo con la versión antigua al destino expresamente autorizado: PASS. El grupo de aceptación se identificó de forma única y con dos participantes; aún no acredita pruebas posteriores a la actualización.

La comparación de dependencia usa el [repositorio oficial de whatsmeow](https://github.com/tulir/whatsmeow/compare/73fe7355f59f...b2b1e71d45e2). El soporte de grupos ya existía en la dependencia anterior. La actualización se justifica por compatibilidad de protocolo e identidad PN/LID y correcciones upstream; la integración de grupos y fijados pertenece a Clarin. El cambio exige toolchain nueva y dos migraciones aditivas del SQL store, por lo que se valida y activa por etapas.
