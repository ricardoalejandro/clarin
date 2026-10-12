# Tareas y Pizarras: integridad y simplificación

Base: `d349f386f62739a81379338761780e71c721e552`. Implementación y verificación en un checkout aislado del VPS (`/root/proyect/clarin-work-qa-20261012`). No se modificó ni desplegó el checkout de producción.

## Entrega

1. PR #13: integridad y rendimiento de Pizarras, conservando el motor `.7`.
2. PR #14: contratos, reconciliación autorizada, agenda, métricas y escrituras de Tareas. Apilado sobre #13.
3. PR #15: navegación diaria, configuración progresiva y motor `0.18.1-clarin.8`. Apilado sobre #14.

Los PR se revisan en ese orden. Merge y despliegue son pasos posteriores, fuera de esta implementación.

## Regresiones cubiertas

| Contrato | Evidencia |
|---|---|
| Una confirmación no borra una edición intercalada | `whiteboardSaveState.test.ts`, pruebas de los editores y navegador |
| Escena e imágenes pertenecen a una misma captura | segunda imagen durante subida y después del envío; deshacer después de borrar/guardar |
| Fallo incierto conserva exactamente operación y contenido | reintento 503; rechazo definitivo de imágenes prepara otra operación |
| Cierre de parches sin búsquedas cuadráticas | prueba de lecturas de ID: el código anterior hacía 13.540.500 con 3.000 elementos |
| Amplio crece de verdad y respeta contenido histórico | motor: 16 constante, 8 variable/formas; selección mixta, presión, undo/redo y personalizado |
| Exportación incluye la tinta | Chromium comprueba márgenes de SVG y píxeles PNG; mantiene recorte deliberado por marco |
| Recargas no conservan una cola fantasma | ventanas de 1/50/150 filas, reordenamiento entre páginas y fallos parciales |
| Una versión posterior no equivale a permiso renovado | barrera de revocación para lecturas, escrituras, rollback y Calendario |
| Resumen usa todas las filas autorizadas | agregados SQL y contrato real `{success, summary}`; navegador con total 150 |
| Calendario aplica sólo filtros de tareas a las tareas | búsqueda/responsable compartidos, eventos preservados, cursor estable |
| Fechas coherentes y recordatorios actualizados | rollback completo del lote, cambio de responsable, borrado de vencimiento, campo legado y Gantt |
| Repetir creación no duplica | 8 operaciones concurrentes contra PostgreSQL producen 1 tarea, 1 actividad y 1 recibo |
| Creación pendiente no pierde su identidad | cierre/escape bloqueados durante POST, payload congelado ante resultado incierto |

## Entornos y alcance de evidencia

- Pruebas de repositorio con PostgreSQL real, datos sintéticos y aislamiento por cuenta/actor. La variable de conexión exige una base cuyo nombre incluya `test` o `qa`.
- Chromium usa la aplicación real y un servidor Next aislado, con API/WebSocket simulados para controlar latencia, respuestas invertidas y permisos. No es prueba contra la API de producción.
- PostgreSQL, Redis y MinIO de QA están aislados. Que un servicio esté saludable no prueba que cada caso lo haya ejercitado.
- Las pruebas unitarias, TypeScript y builds complementan la evidencia de navegador; no la sustituyen.
- La prueba HTTP de Tareas usa login con contraseña, JWT, middleware de autorización y sesiones Redis reales: descarta la primera respuesta después del commit y comprueba que el reintento recupera la misma tarea. Verifica dos cuentas, conflicto de contenido, dos migraciones consecutivas y ausencia de resurrección después de purgar.
- La prueba HTTP de Pizarras usa handlers y PostgreSQL/MinIO reales, con identidad inyectada por el fixture del router: 422 sin avance ni recibo, PNG físico, save/replay, borrar/deshacer/reanexar, descarga, inventario y 404 entre cuentas. Las cuatro pruebas de fanout/autoridad/presentación ejercitan Redis real. No equivalen a una sesión de navegador conectada a esos servicios.

## Límites relevantes para revisión

- Agenda rechaza explícitamente una ventana con más de 5.000 candidatos de eventos (`agenda_capacity_exceeded`); ya no devuelve una agenda truncada como si estuviera completa.
- La base upstream continúa en Excalidraw `0.18.1`. `.8` es una revisión interna del fork, sin migración destructiva de escenas.
- El informe npm conserva seis entradas heredadas: tres altas de la cadena braces/chokidar/sass y tres bajas relacionadas con KaTeX/Mermaid. No se presenta el artefacto como libre de avisos; SBOM, licencias y clasificación están en `frontend/third_party/excalidraw/supply-chain-2026-10-12.json`.
- No se autoriza automáticamente publicación, merge o despliegue por haber pasado los checks.

## Ejecuciones

- `GOCACHE=/tmp/go-build go test ./...`: aprobado sobre el candidato.
- Integración Tareas: siete pruebas de repositorio PostgreSQL aprobadas y una prueba HTTP PostgreSQL/Redis aprobada (14,75 s).
- Integración Pizarras: router PostgreSQL aprobado (11,45 s), subcaso MinIO aprobado (0,24 s) y cuatro pruebas Redis aprobadas.
- Primera suite frontend completa: motor 37/37, scripts 45/45 y aplicación 2.085/2.087 (354/355 archivos). Dos esperas de la página de Documentos expiraron durante compilaciones y navegadores simultáneos; la repetición aislada de Documentos pasó 15/15 sin cambios en su código. Se repite el conjunto final con menos carga antes del cierre.
- Chromium de guardado: tres casos aprobados (ráfagas en una y dos sesiones, imagen fallida/reintento), con transporte simulado y comparación de contenido reabierto.
- Captura comparativa: dos casos aprobados antes y después, con idénticos fixtures y viewports 375/768/1024/1440. Se sustituyeron temporalmente ocho fuentes de interfaz por `d349f386` sólo en QA y se restauraron automáticamente. El motor `.8` y los activos fueron comunes: esta comparación mide la interfaz, no recrea un despliegue histórico completo.
- La primera pasada completa de Pizarras en desarrollo fue interrumpida por el indicador de Next que cubría el botón móvil Editar. Se registraron el aviso de hidratación de dimensiones y el fallback del worker de fuentes; se valida de nuevo sobre el build de producción aislado.

### Perfil del cierre de parches

`frontend/scripts/benchmark-whiteboard-patch.mjs` ejecuta calentamiento y siete muestras por escenario. La tabla recoge medianas; el VPS tenía otras comprobaciones de QA simultáneas. Son medidas del helper, no del render completo ni una promesa de latencia por gesto.

| Escena / elementos cambiados | Node 20 anterior | Node 20 corregido | Chromium 145 corregido |
|---|---:|---:|---:|
| 10.000 / todos | 2.794,93 ms | 15,29 ms | 27,30 ms |
| 10.000 / uno | 7,21 ms | 8,67 ms | 12,00 ms |
| 50.000 / todos | no ejecutado | 210,29 ms | 136,90 ms |
| 50.000 / uno | no ejecutado | — | 29,40 ms |
| 1.000 / todos | — | — | 5,60 ms |
| 1.000 / uno | — | — | 0,70 ms |

La mejora corresponde al caso que hacía búsquedas repetidas para muchos elementos cambiados. No se alega aceleración del cambio de un solo elemento: allí domina recorrer la escena.

### Comparación visual reproducible

| Módulo | 375 px | 768 px | 1024 px | 1440 px |
|---|---|---|---|---|
| Tareas antes | [PNG](tasks-whiteboards-20261012/before/tasks-reference-375.png) | [PNG](tasks-whiteboards-20261012/before/tasks-reference-768.png) | [PNG](tasks-whiteboards-20261012/before/tasks-reference-1024.png) | [PNG](tasks-whiteboards-20261012/before/tasks-reference-1440.png) |
| Tareas después | [PNG](tasks-whiteboards-20261012/after/tasks-reference-375.png) | [PNG](tasks-whiteboards-20261012/after/tasks-reference-768.png) | [PNG](tasks-whiteboards-20261012/after/tasks-reference-1024.png) | [PNG](tasks-whiteboards-20261012/after/tasks-reference-1440.png) |
| Pizarras antes | [PNG](tasks-whiteboards-20261012/before/pizarra-reference-375px.png) | [PNG](tasks-whiteboards-20261012/before/pizarra-reference-768px.png) | [PNG](tasks-whiteboards-20261012/before/pizarra-reference-1024px.png) | [PNG](tasks-whiteboards-20261012/before/pizarra-reference-1440px.png) |
| Pizarras después | [PNG](tasks-whiteboards-20261012/after/pizarra-reference-375px.png) | [PNG](tasks-whiteboards-20261012/after/pizarra-reference-768px.png) | [PNG](tasks-whiteboards-20261012/after/pizarra-reference-1024px.png) | [PNG](tasks-whiteboards-20261012/after/pizarra-reference-1440px.png) |

Las capturas comparativas se hicieron en desarrollo y pueden incluir su indicador de diagnóstico, ajeno a la interfaz publicada. Los tests funcionales finales se ejecutan sobre el servidor standalone de producción en QA.
