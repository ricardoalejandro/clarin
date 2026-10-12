# Tareas y Pizarras: integridad y simplificación

Base: `d349f386f62739a81379338761780e71c721e552`. Implementación y verificación en un checkout aislado del VPS (`/root/proyect/clarin-work-qa-20261012`). No se modificó ni desplegó el checkout de producción.

## Entrega

1. PR #13: integridad y rendimiento de Pizarras, conservando el motor `.7`.
2. PR #14: contratos, reconciliación autorizada, agenda, métricas y escrituras de Tareas. Apilado sobre #13.
3. PR #15: navegación diaria, configuración progresiva, salida segura del editor y motor `0.18.1-clarin.8`, incluido el worker local de exportación. Apilado sobre #14.

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
| Salir no autoriza sólo la versión que existía al pulsar | escena, biblioteca y revisión de comentarios comprobadas nuevamente antes de navegar |
| Atrás/Adelante conserva el historial al cancelar | ledger temprano, sin entradas adicionales; cancelación, ráfagas, recarga y respuesta tardía |
| Exportar fuentes usa el worker local | URL HTTP del propio origen, módulos autocontenidos, bindings sin `Function` y plazo activo separado del tiempo inactivo |

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
- Una escena de 50.000 elementos sigue siendo pesada: el perfil completo registró 3,15 s para el gesto y 9,30 s hasta su confirmación con transporte simulado. El cambio elimina el coste cuadrático demostrado, pero no certifica fluidez en el límite máximo del editor.
- El informe npm conserva seis entradas heredadas: tres altas de la cadena braces/chokidar/sass y tres bajas relacionadas con KaTeX/Mermaid. No se presenta el artefacto como libre de avisos; SBOM, licencias y clasificación están en `frontend/third_party/excalidraw/supply-chain-2026-10-12.json`.
- No se autoriza automáticamente publicación, merge o despliegue por haber pasado los checks.
- La protección de historial del editor de miembros cubre entradas instrumentadas desde el arranque del documento. Una entrada anterior sin marca sólo se reconoce si la API nativa ofrece índices coherentes; no se inventa su dirección. Las salidas de documento conservan `beforeunload`, sujeto a la política del navegador. Los enlaces del editor y cambios de vista usan `requestLeave`; un `router.push` arbitrario ajeno a ese contrato no queda certificado. Invitados conservan su protección `beforeunload`; el nuevo guard de historial se registra en el editor de miembros.

## Ejecuciones

- `GOCACHE=/tmp/go-build go test ./...` y `go build -buildvcs=false -o /tmp/clarin-qa-backend ./cmd/server`: aprobados sobre el candidato.
- `npx tsc --noEmit`: aprobado. Build de producción final aprobado: compilación, rutas estáticas, cinco artefactos CSS, shells offline-v4/v5, aislamiento de 939 artefactos y separación de branding/avisos. El servidor standalone de este build se usa para la última pasada de navegador.
- Integración Tareas: siete pruebas de repositorio PostgreSQL aprobadas y una prueba HTTP PostgreSQL/Redis aprobada (14,75 s).
- Integración Pizarras: router PostgreSQL aprobado (11,45 s), subcaso MinIO aprobado (0,24 s) y cuatro pruebas Redis aprobadas.
- Suite frontend completa final: `npm run test:unit -- --maxWorkers=2 --testTimeout=15000`, aprobada con 61 pruebas del motor, 47 de scripts y 2.101 de aplicación en 356 archivos. El bloque de aplicación tardó 618,30 s. Las dos primeras pasadas agotaron esperas de 5 s de Documentos (dos casos en la primera, uno en la segunda); Documentos pasó 15/15 aislado sin modificar su código. La pasada final limita a dos workers y permite 15 s por prueba, conservando todas las aserciones y esperas internas.
- Tareas, Chromium sobre el build final: 58 escenarios aprobados en 7,7 min; se omite únicamente la captura comparativa opt-in, ya ejecutada por separado. Incluye filtros/Resumen/Calendario, fechas/Gantt, permisos, ventanas, comentarios, adjuntos, teclado y superficies responsive. Las seis capturas del build final están en `tasks-whiteboards-20261012/production/`.
- Pizarras, Chromium sobre el build final: 21 escenarios aprobados en 7,9 min. Las dos omisiones son la captura comparativa opt-in y la exportación de fuentes reservada a Firefox. El editor de miembros pasó el caso de edición posterior a Atrás, cancelación de Atrás/Adelante y recarga conservando el cursor.
- Aislamiento final: 69 archivos estáticos y 293 URLs del recorrido completo, sin violaciones CSP ni bloqueos inesperados. El informe conserva tres `ERR_ABORTED` de chunks durante navegación/cierre. Branding: dos superficies, 95 acciones y 33 archivos; seis avisos legales preservados. Evidencia saneada en `production/whiteboard-egress.json` y `production/whiteboard-branding.json`.
- Chromium de guardado final: cuatro casos aprobados en 47,5 s (ráfagas en una y dos sesiones, imagen fallida/reintento y desconexión con recuperación). Se compara el contenido y sus IDs al reabrir. La desconexión usa `context.setOffline(true)`, cierre del WebSocket y rechazo de HTTP; los cambios permanecen exportables localmente antes de recuperar la conexión.
- Captura comparativa: dos casos aprobados antes y después, con idénticos fixtures y viewports 375/768/1024/1440. Se sustituyeron temporalmente ocho fuentes de interfaz por `d349f386` sólo en QA y se restauraron automáticamente. El motor `.8` y los activos fueron comunes: esta comparación mide la interfaz, no recrea un despliegue histórico completo.
- La primera pasada completa de Pizarras en desarrollo fue interrumpida por el indicador de Next que cubría el botón móvil Editar. Se registraron el aviso de hidratación de dimensiones y el fallback del worker de fuentes; se valida de nuevo sobre el build de producción aislado.
- Navegación: 103 unitarias focalizadas aprobadas y seis casos del controlador con navegador real aprobados en Chromium 145, Firefox 146 y WebKit 26. Estos seis usan un documento de prueba. El editor de miembros dentro de Next pasó después 3/3 casos, uno en cada motor, en 1,2 min. Una primera aserción Firefox comparaba longitud de historial a través de la recarga: la traza confirmó que la entrada adicional ya existía antes del bootstrap del nuevo documento, sin un `pushState` del guard. La prueba final espera el montaje del catálogo y exige longitud idéntica antes/después de cada cancelación y del ciclo inicial Atrás/Adelante. Se conserva el [diagnóstico](tasks-whiteboards-20261012/production/history/firefox-reload.json); sólo cambió el fixture.
- Worker: el control negativo sobre el primer build de producción confirmó `file://` rechazado y el fallback bloqueado por `Function`, con cero respuestas del worker. La corrección pasa 61 pruebas nativas del motor, 35 de compatibilidad/render/offline y 15 del grupo de hardening. Conserva `connect-src 'none'` en el worker y no amplía la política de los documentos. El plazo activo es 15 s y la liberación inactiva 1 s. Chromium confirmó la respuesta nativa con 2.248 bytes WOFF2 tras retrasar 1,5 s su descarga, SVG con fuente incrustada y ausencia de fallback/errores. La primera expectativa de copias offline-v3/v5 se corrigió para comprobar los archivos realmente publicados y declarados por los manifiestos; no cambió el producto.
- El worker real también pasó en Firefox y WebKit, y Firefox completó su caso específico de escena/SVG/PNG con fuentes locales. Controles positivos: [Chromium](tasks-whiteboards-20261012/production/worker/worker-after-chromium.json), [Firefox](tasks-whiteboards-20261012/production/worker/worker-after-firefox.json) y [WebKit](tasks-whiteboards-20261012/production/worker/worker-after-webkit.json); [control negativo](tasks-whiteboards-20261012/production/worker/worker-before.json). No se registraron fallback, errores ni avisos de hidratación en esos controles positivos.
- Dependencias del build final: 311 archivos JS de Next, KaTeX identificado en un chunk y Mermaid en dos; Next no publica sus mapas. Los 68 mapas del fork reúnen 477 fuentes sin módulos Sass/Chokidar/braces. Esto respalda su alcance de herramientas de compilación, sin afirmar ausencia absoluta en toda salida minificada. Rutas, hashes y límites en [artifact-reachability.json](tasks-whiteboards-20261012/production/artifact-reachability.json).

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

### Perfil del editor completo

`tests/whiteboards-editor-performance.spec.ts` pasó 3/3 casos en Chromium 145 sobre el standalone final, sin otros runners de QA. Una muestra por tamaño, viewport 1440×900, contexto frío y servidor caliente. Usa el editor de invitados, rectángulos sencillos y descarte de elementos fuera del viewport; HTTP/WebSocket están simulados y el ACK incluye la escena completa. Mide montaje, gesto y confirmación, incluyendo debounce, render y serialización; no mide FPS ni latencia de base de datos, ni representa escenas con imágenes o texto enriquecido.

| Elementos | Navegación → canvas + dos frames | Clic + mover un píxel | Gesto → guardado confirmado |
|---|---:|---:|---:|
| [1.000](tasks-whiteboards-20261012/production/editor-performance-1000.json) | 2,13 s | 0,25 s | 2,14 s |
| [10.000](tasks-whiteboards-20261012/production/editor-performance-10000.json) | 6,10 s | 1,69 s | 4,18 s |
| [50.000](tasks-whiteboards-20261012/production/editor-performance-50000.json) | 7,76 s | 3,15 s | 9,30 s |

Cada caso modifica exactamente un elemento, envía un parche y exporta la cardinalidad original con la nueva posición confirmada, sin errores ni solicitudes bloqueadas. A 50.000 elementos se observó una tarea larga máxima de 2,77 s y heap JS aproximado de 342 MB; esa cifra no es memoria total del navegador. No se ejecutó un perfil equivalente del editor completo anterior: la comparación antes/después demostrada corresponde al helper de la sección previa.

### Comparación visual reproducible

| Módulo | 375 px | 768 px | 1024 px | 1440 px |
|---|---|---|---|---|
| Tareas antes | [PNG](tasks-whiteboards-20261012/before/tasks-reference-375.png) | [PNG](tasks-whiteboards-20261012/before/tasks-reference-768.png) | [PNG](tasks-whiteboards-20261012/before/tasks-reference-1024.png) | [PNG](tasks-whiteboards-20261012/before/tasks-reference-1440.png) |
| Tareas después | [PNG](tasks-whiteboards-20261012/after/tasks-reference-375.png) | [PNG](tasks-whiteboards-20261012/after/tasks-reference-768.png) | [PNG](tasks-whiteboards-20261012/after/tasks-reference-1024.png) | [PNG](tasks-whiteboards-20261012/after/tasks-reference-1440.png) |
| Pizarras antes | [PNG](tasks-whiteboards-20261012/before/pizarra-reference-375px.png) | [PNG](tasks-whiteboards-20261012/before/pizarra-reference-768px.png) | [PNG](tasks-whiteboards-20261012/before/pizarra-reference-1024px.png) | [PNG](tasks-whiteboards-20261012/before/pizarra-reference-1440px.png) |
| Pizarras después | [PNG](tasks-whiteboards-20261012/after/pizarra-reference-375px.png) | [PNG](tasks-whiteboards-20261012/after/pizarra-reference-768px.png) | [PNG](tasks-whiteboards-20261012/after/pizarra-reference-1024px.png) | [PNG](tasks-whiteboards-20261012/after/pizarra-reference-1440px.png) |

Las capturas comparativas se hicieron en desarrollo y pueden incluir su indicador de diagnóstico, ajeno a la interfaz publicada. Los tests funcionales finales se ejecutan sobre el servidor standalone de producción en QA.

La escala 125 % de la captura final de Tareas se emula con viewport 1152×800 y `deviceScaleFactor: 1.25`; no representa una prueba de Ctrl+zoom del navegador. Se verificaron también Eros acoplado, movimiento reducido, teclado y controles táctiles dentro de los escenarios responsive.
