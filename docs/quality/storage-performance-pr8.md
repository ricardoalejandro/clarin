# Almacenamiento: evidencia de rendimiento e integridad para PR #8

Fecha: 11 de octubre de 2026. Implementación y pruebas desde el VPS. Este informe no certifica un despliegue: el cierre de producción se registra por separado.

## Causas comprobadas y corrección

- Un texto de plantilla con muchos signos de porcentaje disparaba el decodificador de URL sobre el JSON completo. La concatenación carácter por carácter era cuadrática; una búsqueda real de referencias de un vídeo superó los 12 s. El decodificador ahora agrupa fragmentos y tiene salida directa sin porcentajes. El filtro decodifica sólo valores escalares con apariencia de ruta/URL; el parser estructural de Go sigue probando la referencia real.
- La vista previa enumeraba usos antes de autorizar contenido. Ahora la autorización se limita al objeto solicitado y revalida fuentes y ACL actuales; HEAD, GET, Range e If-Range conservan ese control. El flujo entrega un stream cerrado/cancelado con su sesión, sin almacenar el archivo entero en RAM. MinIO recibe su ETag real para If-Match; el ETag HTTP permanece independiente.
- En el resumen de la cuenta reportada, EXPLAIN previo midió 3.911 ms de ejecución, de los que 3.541 ms eran compilación JIT (3.550 funciones). La lista tenía dos consultas caras de recuento/página; la página sola midió 4.462 ms y 4.080 ms de JIT. No son percentiles: son muestras diagnósticas de una consulta.
- Las ACL de Pizarras se expandían repetidamente para cientos de imágenes de la misma pizarra. Se calcula una relación canónica materializada por sentencia, con el mismo account/actor y los mismos permisos. La transacción de lectura usa SET LOCAL jit=off: no modifica PostgreSQL global ni conserva permisos en caché.
- El recuento y la selección de claves comparten consulta; los metadatos se hidratan sólo para la página. Usos indexados aplican autorización y paginación antes de hidratar. Durante indexación pendiente se consultan referencias canónicas de la clave, se ordenan identidades y sólo se cargan payloads ordinarios de la página. Este fallback queda limitado a 2.000 candidatos y 4 MiB de payload antes de parsear, con 2 lectores simultáneos por proceso y 1 por cuenta, sin cola. Si excede el presupuesto devuelve HTTP 503, code=storage_indexing_budget, catalog_status=indexing y reintento de 3 segundos, sin total ni lista de usos. Revisión, confirmación y GC conservan la validación completa, sin ese truncamiento.

## Medición con las dos cuentas reales

30 muestras por escenario, 2 calentamientos, conexión PostgreSQL con default_transaction_read_only=on y tiempos acotados. Se reutilizó un actor administrador real sólo dentro de las consultas; no se crearon sesiones ni tokens. No se imprimen identificadores, claves, nombres ni payloads. Las cifras miden SQL + Go en el VPS, no red HTTP ni navegador. Hubo compilaciones y pruebas aisladas concurrentes en el mismo host de 4 CPU; no es un laboratorio dedicado.

| Cuenta (objetos) | Operación | p50 ms | p95 ms | máximo ms |
|---|---|---:|---:|---:|
| Cuenta de la captura (1.351) | summary | 195.032 | 341.131 | 353.497 |
| Cuenta de la captura (1.351) | files | 87.33 | 226.258 | 286.468 |
| Cuenta de la captura (1.351) | videos | 53.875 | 72.407 | 82.975 |
| Cuenta de la captura (1.351) | uses | 35.525 | 66.106 | 93.006 |
| Cuenta de la captura (1.351) | content_authorization | 1.283 | 4.292 | 4.489 |
| Cuenta de comparación (4.056) | summary | 285.901 | 613.613 | 849.929 |
| Cuenta de comparación (4.056) | files | 189.925 | 344.003 | 389.536 |
| Cuenta de comparación (4.056) | videos | 103.276 | 237.331 | 265.677 |
| Cuenta de comparación (4.056) | uses | 17.823 | 71.015 | 73.221 |
| Cuenta de comparación (4.056) | content_authorization | 1.15 | 10.007 | 13.038 |

El objetivo p95 de 750 ms para resumen y listado se cumple en ambas cuentas en esta medición. El máximo de resumen de la cuenta de comparación fue 850 ms; no se promete un límite absoluto. EXPLAIN posterior no presenta JIT y el conjunto de referencias privadas se obtiene una vez por sentencia; sus tiempos fríos bajo carga se conservan en el JSON, separados de los percentiles.

## Veracidad del espacio ocupado

Reconfirmado a las 17:28:39 UTC mediante ListObjectsV2 GET sobre el prefijo de la cuenta y SQL dentro de BEGIN READ ONLY. No hubo reconcile, limpieza, borrado ni cargas en producción.

| Fuente | Objetos | Bytes |
|---|---:|---:|
| MinIO ordinario | 1.172 | 3.689.223.836 |
| MinIO privado | 179 | 37.096.190 |
| Total físico | 1.351 | 3.726.320.026 |
| storage_inventory_objects presentes | 1.351 | 3.726.320.026 |
| storage_inventory_totals | 1.351 | 3.726.320.026 |

El total actual equivale a unos 3,47 GiB. La interfaz anterior lo rotulaba GB. Los archivos visibles dependen de la autorización y no son una segunda medida de cuota física. No hay evidencia suficiente para atribuir los 12 GB históricos a una causa concreta: el código histórico consultado también filtraba por cuenta.

## Escala HTTP aislada

PostgreSQL 16.11, MinIO oficial por digest inmutable, Redis 7.4.7, Go 1.25.11. Contenedores efímeros con puertos loopback y sin volúmenes, credenciales ni datos de producción. Los handlers Fiber se ejecutan mediante HTTP app.Test y consultas reales, con 30 muestras y 2 calentamientos. Esto cubre el contrato HTTP y proveedor real, pero no incluye TLS, proxy público ni latencia de navegador.

1.000 objetos físicos de 1 KiB, 1.000 referencias de medios, 10.000 mensajes de texto adicionales y 100 chats. Para 10.000 y 50.000 objetos se usa inventario relacional sintético con fuentes, FK, restricciones, triggers e indexación reales, y un objeto físico representativo por cuenta; no se finge haber cargado físicamente 50.000 archivos. El caso compartido usa un objeto físico y 10.000 referencias canónicas. Los contadores de S3 deben permanecer en cero durante resumen/listado indexados; contenido/rangos se verifican aparte con bytes físicos.

| Objetos | Escenario | p50 ms | p95 ms | máximo ms | lecturas S3 |
|---:|---|---:|---:|---:|---:|
| 1000 | files_first | 45.858 | 85.639 | 94.574 | 0 |
| 1000 | files_last | 48.088 | 71.781 | 81.138 | 0 |
| 1000 | files_search | 51.747 | 70.265 | 80.306 | 0 |
| 1000 | usage | 67.004 | 106.75 | 106.764 | 0 |
| 1000 | page_open_parallel | 88.597 | 144.277 | 155.002 | 0 |
| 1000 | files_first_admin | 50.839 | 80.878 | 145.502 | 0 |
| 1000 | page_open_admin_parallel | 105.087 | 152.083 | 170.591 | 0 |
| 10000 | files_first | 425.326 | 980.321 | 1762.463 | 0 |
| 10000 | files_last | 342.455 | 405.635 | 407.404 | 0 |
| 10000 | files_search | 384.633 | 513.882 | 531.257 | 0 |
| 10000 | usage | 920.717 | 1142.335 | 1206.967 | 0 |
| 10000 | page_open_parallel | 1079.287 | 2302.202 | 2551.137 | 0 |
| 10000 | files_first_admin | 381.839 | 447.135 | 498.892 | 0 |
| 10000 | page_open_admin_parallel | 748.554 | 1359.238 | 1727.618 | 0 |
| 50000 | files_first | 1598.981 | 2401.668 | 4129.734 | 0 |
| 50000 | files_last | 2233.439 | 4451.22 | 4507.694 | 0 |
| 50000 | files_search | 2265.636 | 3156.879 | 3263.805 | 0 |
| 50000 | usage | 3763.164 | 5179.468 | 8205.556 | 0 |
| 50000 | page_open_parallel | 3899.812 | 5547.528 | 8181.016 | 0 |
| 50000 | files_first_admin | 1678.405 | 2660.354 | 4080.439 | 0 |
| 50000 | page_open_admin_parallel | 3986.3 | 7527.631 | 7530.271 | 0 |
| 1 | shared_files | 480.443 | 993.496 | 1291.787 | 0 |
| 1 | shared_usage | 186.055 | 249.064 | 274.092 | 0 |
| 1 | shared_page_open_parallel | 563.162 | 699.535 | 747.419 | 0 |
| 1 | shared_uses_detail | 319.245 | 365.343 | 375.34 | 0 |

Estado de la matriz: completada: 25 escenarios de 30 muestras, más 2 calentamientos por escenario; suite de rendimiento PASS.

El objetivo p95 de 750 ms no se cumple universalmente a gran escala. Con 10.000 objetos, el resumen midió p95 1.142 ms; con 50.000, la lista inicial 2.402 ms, el resumen 5.179 ms y la apertura paralela como administrador 7.528 ms. El volumen de respuesta y la hidratación permanecen paginados, pero el trabajo relacional de recuento y autorización todavía crece. Estas cifras no deben presentarse como una experiencia instantánea en cuentas de 50.000 objetos.

Una medición previa al límite del fallback de 10.000 usos con una fuente ajena sucia obtuvo p50 531 ms/p95 1.033 ms, pero asignó 120,7 MB por petición y alcanzó un pico muestreado de 84 MB de heap/125 MB de RSS. Esa evidencia motivó el guard de presupuesto; no es un resultado de éxito de la versión final. La versión final devuelve el estado 503 de actualización para ese caso y conserva HTTP 200/página de 40 cuando el índice está listo. Ambas respuestas y la ausencia de falsos ceros se verificaron con PostgreSQL y MinIO nativos. El SQL del filtro canónico todavía puede trabajar hasta su deadline de 45 s; el límite impide el recorrido ilimitado de payloads en Go, no promete coste SQL constante.

La matriz indexada se inició antes de añadir el guard del fallback. Las rutas indexadas medidas no cambiaron; se complementó con el focal nativo de la versión final, incluida cancelación SQL al alcanzar el presupuesto. No se volvió a sembrar toda la matriz sólo por ese guard de un estado distinto.

## Integridad y límites

La suite nativa cubre referencias múltiples, aislamiento entre cuentas, módulos revocados, permisos privados de Work/Pizarras, retenciones, papelera, restauración, conflictos, concurrencia con GC, archivos faltantes y cargas propias. Las pruebas añadidas cubren porcentajes/Unicode, cursores inválidos y ajenos, paginación de un objeto compartido, indexación sucia, ACL cambiadas sin reindexación, HEAD por cookie real, descarga attachment, rangos/sufijos/If-Range/416 y cancelación del stream. Una transacción de inventario rechaza escrituras y restaura la configuración JIT de la sesión al terminar.

Las pruebas de MinIO no habilitan conexiones WhatsApp ni limpiezas sobre el sistema activo. Los cambios mantienen revalidación canónica transaccional antes de cualquier retirada o borrado. Una prueba visual, un build o estas mediciones aisladas no sustituyen la verificación del despliegue final.

Los datos numéricos saneados están en [storage-performance-pr8.json](storage-performance-pr8.json). El runner reproducible está en [run-storage-self-service.sh](../../scripts/qa/run-storage-self-service.sh); la prueba READ ONLY exige activación explícita y una URL de conexión separada.
