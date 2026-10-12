# Eventos y corrección de listas vacías de Work

## Alcance

Implementación en el VPS, en `codex/events-experience`. El PR se publica y su commit se despliega antes de fusionar, según el flujo solicitado. La fusión a `main` requiere el go posterior del usuario.

- Configuración operativa Datos/Etapas/Reglas desde lista y tablero, borradores independientes, conflictos de versión y cierre remoto.
- Orden de etapas por agarre, teclado, botones o posición; reasignación explícita al eliminar y copia aislada si el pipeline está compartido con otro Evento o Programa.
- Selector de contactos paginado de 50, búsqueda a 500 ms, selección remota completa, exclusiones, revisión congelada y confirmación idempotente.
- Resumen de las etapas reales, identidad por ID y ordenamiento global antes de paginar.
- Bitácoras paginadas, snapshot de filtro y etapa, notas multilínea, cierre/reapertura, auditoría y exportación.
- Work: página vacía canónica `[]`, normalización de servidores previos y reconciliación al cambiar de lista o mover la última tarea.

## Datos y compatibilidad

Las migraciones se registran en `Migrate()` y son aditivas: revisión de etapas, recibos de selección y sus elementos, versión/scope de captura/autoría de bitácoras y auditoría. No se elimina información histórica. Las lecturas y transacciones se limitan a la cuenta y el evento; los recibos también al actor. Las colecciones se paginan y las mutaciones de un evento cerrado se rechazan en el servidor.

Las etapas de una bitácora mantienen su identidad de captura aunque cambie el pipeline. Las capturas antiguas sin filtro conocido lo indican explícitamente. El reemplazo de una plantilla de pipeline utilizada queda protegido para impedir cambios indirectos sobre Eventos/Programas.

## Verificación

Las pruebas usan datos sintéticos en PostgreSQL/Redis y un backend/frontend separados de producción. Nunca se usa el catálogo real como fixture. El guion `tests/events-experience-smoke.mjs` comprueba que la conexión apunta a la base desechable antes de sembrar datos.

Resultados verificados antes de construir la versión de producción:

- Suite frontend general: 358 archivos y 2.108 pruebas aprobados en la primera pasada. Los seis archivos con fallo se repitieron: 100/100 aprobadas, incluidas las pruebas de Chats, Pizarras, editor de Tareas y motor offline. La primera pasada coincidió con la preparación del paquete local de Excalidraw y compilaciones; los timeouts no se ocultaron aumentando sus límites. El test de Eventos detectó texto decorativo en el nombre accesible de ordenamiento, corregido con `aria-hidden`.
- Última pasada focal de Eventos y Work: 93/93 pruebas en 17 archivos. TypeScript aprobado; el build final vuelve a verificarlo.
- Todos los paquetes Go aprobados. Las integraciones de repositorio pasaron con PostgreSQL aislado (159 s). API se repitió con el Redis de QA requerido para la prueba HTTP de Work (14,35 s); la invocación anterior había omitido esa variable.
- Integraciones adicionales del remapeo de filtros de bitácoras aprobadas: copia de pipeline, transferencia de etapa, snapshots y notas preservados, versión/409, auditoría, aislamiento y rollback.
- Smoke de Eventos aprobado: datos/etapas, selección y confirmación de 120 contactos, captura pendiente, notas multilínea, recaptura, completar/reabrir, CSV/XLSX e historial. Cero errores de navegador; ventanas y workspace revisados a 320, 375, 768 y 1440 px.
- Smoke Work aprobado: página vacía `[]`, cambio de lista sin filas anteriores y movimiento de última tarea reconciliado por WebSocket sin F5. El fixture redirige `/ws` al ingress de QA porque Next dev solo proporciona el proxy HTTP; producción conserva su ingress existente.

El selector con 20.000 contactos confirmó y auditó en 20,71 s y consultó el resultado en 211 ms. El plan original podía estimar una sola fila para un snapshot recién creado y repetir una búsqueda sobre el catálogo por cada contacto. Solo las transacciones grandes usan planificación específica y deshabilitan nested loops localmente; no se cambia la configuración global de PostgreSQL ni el plazo de 45 s.

El ingress de QA limita CORS al frontend de loopback, usa las cookies reales de la aplicación y no altera la autenticación. Se mantuvieron los servicios de producción separados durante todas estas pruebas.

El resultado del build y las comprobaciones exactas del despliegue quedan en la descripción del PR.

## Recuperación

Antes de desplegar se conserva un dump PostgreSQL, el commit e imágenes previos y el archivo ajeno `backend/CHANGELOG.md` que ya estaba modificado en el checkout de despliegue. El flujo de `make deploy` sobrescribe ese archivo al construir; su contenido original se restaura después. Las migraciones aditivas permiten recuperar el código anterior sin eliminar las nuevas tablas/columnas. No restaurar automáticamente el dump sobre escrituras posteriores.
