# Almacenamiento y Plantillas — implementación y verificación de PR #8

Estado al 11 de octubre de 2026: implementación, pruebas, build y aceptación final de navegador completados en el VPS. Este informe se guarda antes de integrar y desplegar; la versión y las comprobaciones posteriores al despliegue se registran en la descripción del [PR #8](https://github.com/ricardoalejandro/clarin/pull/8).

## Base y alcance

PR #7 integrado mediante merge en `f6715fb70a27de554f77decbb8ebd9d66983ada1`. Trabajo exclusivamente en `/root/proyect/clarin`, rama `codex/storage-templates-quality`; copia de recuperación del estado anterior y PostgreSQL conservada en el VPS. El commit inicial de implementación de PR #8 es `f9c725c`; después se añadieron las correcciones encontradas durante QA.

La entrega comprende las seis incidencias de Almacenamiento, la biblioteca y editor de plantillas imprimibles, exportación configurable, aislamiento de cuenta, validaciones y pruebas. No modifica encuestas ni plantillas de WhatsApp. No se ejecutó limpieza masiva ni se sembraron pruebas en producción.

## Base desplegada y comprobada

La base PR #7 sí se desplegó mediante `make deploy`. Verificación registrada el 11 de octubre a las 16:51 UTC: `/api/version` devolvió `2026.10.11-1-163747573976283-f6715fb70a27`; backend/frontend/worker/signer/bridge activos, backend healthy y PostgreSQL/Redis saludables. Las 42 líneas de backend y 5 de frontend revisadas después del arranque no mostraron error/fatal/panic. Esto acredita la base, no el despliegue de PR #8.

## Correcciones y experiencia resultante

- Almacenamiento carga resumen, listado y usos por separado; preserva selección, cancela sesiones obsoletas y presenta estados de indexación, permisos, fallos y reintento. El consumo físico se distingue de los archivos visibles autorizados y usa GiB/KiB explícitos.
- Las consultas evitan la expansión repetida de ACL y el coste de JIT en estas lecturas. Conteo y página comparten selección de claves; la hidratación se limita a la página. El fallback de usos con índice pendiente tiene presupuesto de 2.000 candidatos, 4 MiB y concurrencia de 2 por proceso/1 por cuenta; al excederse responde 503 con estado de actualización y reintento, sin falsos totales ni subconjuntos presentados como completos.
- La vista previa usa streaming autenticado por cookie con Range/HEAD, validación de permisos actuales y cierre del stream. No descarga el archivo entero para abrirlo ni expone tokens en URLs. Revisión, retirada, recuperación y purga mantienen referencias y revalidación canónica transaccional.
- Plantillas dispone de biblioteca paginada, formatos iniciales, importación/exportación JSON, duplicado, eliminación y renombrado directo. Renombrar obtiene el documento completo, conserva contenido/miniatura y exige revisión optimista; conflicto o fallo conservan el nombre escrito y requieren una nueva acción explícita. La búsqueda vigente se reconcilia al terminar y los cambios de cuenta abortan la sesión anterior.
- El editor incorpora lienzo adaptable, comandos compartidos entre barra/menú/teclado, selección múltiple, grupos/capas, orden, bloqueos, dibujo, colores, recorte, ajustes y reemplazo de imágenes. Los marcos contain/cover usan objetos Fabric estándar; el reemplazo también resuelve marcos dentro de grupos transformados y respeta bloqueos heredados.
- El guardado conserva borradores y usa revisiones optimistas. Ctrl/Cmd+S confirma el último valor del campo o texto activo. La biblioteca y sus mutaciones tienen deadline de 30 segundos, aborto y rechazo de respuestas tardías; una escritura incierta informa que no se pudo confirmar el resultado.
- PNG/JPEG/PDF tienen perfiles y parámetros configurables, render independiente serializado, previsualización y peso del Blob exacto antes de descargar. PNG/JPEG parten del perfil equilibrado 150 DPI/0,85; PDF del perfil impresión 300 DPI/0,95. El PDF de impresión incorpora raster PNG sin pérdida. El límite de exportación es 32 MP/16.384 px y se comunica cuando reduce la resolución.
- Los diseños se limitan a 2 MiB, 1.000 objetos, 10 niveles de grupos/recortes, profundidad JSON 64 y páginas de 10 a 2.000 mm. Cargas raster verifican MIME real, 10 MiB y 40 MP; la composición se protege con 64 MP agregados y preflight acotado. La generación evita interpretar HTML activo.
- Las URL propias históricas se reconocen por origen configurado, clave exacta y slot real de imagen/fondo/patrón/miniatura en un documento autorizado. La normalización sólo cambia esos slots, preservando texto y metadatos literales. No convierte evidencia genérica `private_external` en autorización. La lectura de medios históricos usa claims recién hidratados; la regresión nativa pasó para imágenes, fondos, patrones y miniaturas antes del primer guardado, y rechazó permisos revocados, documentos eliminados, cuentas ajenas, hosts externos, referencias en texto, recursos protegidos y papelera.

La revisión cruzada detectó y corrigió durante QA la selección de un grupo único al desagrupar, miniaturas bloqueadas por CSP, historial Atrás/Adelante, Ctrl+S durante edición, espera indefinida al confirmar limpieza y segundo guardado rechazado por URL propia absoluta. El repaso final añadió Renombrar, completó los comandos contextuales y reparó multiselección de trazo/reemplazo en marcos.

## Verificación técnica final

- `GOCACHE=/tmp/go-build GOMAXPROCS=2 go test ./...` y `go build ./cmd/server`: PASS sobre el backend final, incluido el ajuste de autorización de medios históricos. Las pruebas nativas focales de acceso/publicación también pasaron con PostgreSQL, Redis, MinIO y cookies de sesión reales (16,777 s).
- `npx tsc --noEmit` y `npm run build`: PASS sobre el frontend final. La compilación comprobó rutas, CSS interactivo, artefactos offline, 937 artefactos de Pizarras y avisos legales/SBOM. La primera suite frontend tuvo 298 archivos aprobados; 11 suites necesitaron preparar el paquete local Excalidraw y un caso excedió cinco segundos bajo carga. Las 12 suites pendientes pasaron después (145 pruebas). No se presenta ese resultado como una única ejecución limpia.
- Regresiones finales: 36 pruebas focales de editor/menús/Fabric/colores y 14 de biblioteca/deadlines aprobadas; exportación y preferencias de formato 7/7. Se conservan además las verificaciones de Storage (70 pruebas) y del estado de indexación/presupuesto (12 del detalle). Los conteos se refieren a ejecuciones concretas y pueden compartir casos.
- Chromium contra build de producción, backend y proveedores reales aislados: **8/8 Plantillas PASS (1,1 min)**. Incluye renombrar sin alterar objetos, grupos y recarga, dibujo/deshacer, navegación con borrador, menús en cuatro esquinas, inserción contextual, reemplazo por imagen de distinta proporción sin deformarla, marcos/filtros, PNG/JPEG/PDF y conflictos de dos pestañas. Viewports 320/375/768/1024/1280/1440, sidebar y Eros modificando espacio real, zoom estable y menús por teclado.
- Misma versión final: **6/6 Almacenamiento PASS (46,9 s)** con una fixture nueva. Reproducción y filtros, revisión sin mutación, uso compartido, papelera/retención/purga/restauración, cambio de cuenta, permisos parciales y actualización sin F5. La comprobación canónica posterior confirmó el archivo restaurado activo y el archivo sintético purgado inaccesible. No hubo mocks de API ni operaciones de limpieza productiva.
- Revisión cruzada independiente de permisos, streams, cancelación, slots de recursos, comandos y marcos; `git diff --check` PASS. La compatibilidad productiva y las limitaciones visuales de sesión se describen abajo.

Los servicios QA llevan `clarin.qa=storage-templates-20261011` y sólo escuchan en loopback. PostgreSQL, Redis y MinIO de pruebas son independientes; credenciales y trazas privadas permanecen fuera de Git. No se incluyen capturas privadas en este informe.

## Compatibilidad de documentos existentes

Se consultaron las 3 plantillas de producción mediante SELECT en una transacción READ ONLY y se pasaron, sin persistir su contenido, por los validadores actuales de frontend y backend. Las 3 son V3 y las 3 cumplen formato, dimensiones y límites; ambos validadores reportaron 0 errores. No había documentos V2 reales para comprobar; V2 tiene cobertura sintética de compatibilidad.

Sólo se reportaron conteos/formato/códigos agregados, sin nombres, identificadores, JSON ni URLs. Esta comprobación no carga los recursos gráficos ni acredita renderizado o sesión autenticada en producción.

## Rendimiento y límites conocidos

Evidencia reproducible: [mediciones de almacenamiento](storage-performance-pr8.md), [datos saneados de almacenamiento](storage-performance-pr8.json) y [mediciones del editor](template-editor-performance-pr8.md).

- En las dos cuentas reales consultadas en READ ONLY, resumen/listado alcanzaron el objetivo p95 de 750 ms en la medición SQL+Go del VPS. No son tiempos TLS/proxy/navegador ni un límite absoluto.
- La matriz aislada completa contiene 25 escenarios con 30 muestras y 2 calentamientos. Con 50.000 objetos relacionales sintéticos, el objetivo no se cumple: p95 de lista inicial 2.402 ms, resumen 5.179 ms y apertura paralela administrativa 7.528 ms. No se cargaron físicamente 50.000 archivos. El conteo/ACL aún escala con el volumen aunque la respuesta y la hidratación estén paginadas.
- El fallback sucio de 10.000 usos que antes asignaba 120,7 MB por petición motivó el guard de presupuesto. El estado final excedido responde 503; el índice listo conserva 200 y página de 40. El límite protege payloads/memoria de Go, no garantiza coste SQL constante: la consulta canónica conserva su deadline de 45 segundos.
- El editor se midió con Chromium/Fabric real y 30, 200 y 1.000 objetos. Con 1.000 objetos a zoom 25 %, el p95 de render síncrono fue 42,6 ms; no se afirma 60 FPS constantes. La exportación PNG 96 DPI de esa escena tardó aproximadamente 1,6 segundos. El benchmark de figuras no acredita tiempos de imágenes, red, fuentes externas o PDF.
- La conciliación actual de MinIO/inventario de la cuenta reportada coincide exactamente en 1.351 objetos y 3.726.320.026 bytes, unos 3,47 GiB. No se tiene evidencia suficiente para explicar los 12 GB históricos; no se atribuyen a una causa no demostrada.
- Dependencias: se actualizaron Next, sharp, DOMPurify y source-map-js con versiones compatibles. El audit completo restante tiene 9 avisos (6 high, 3 low, 0 critical); el de dependencias de producción tiene 6 (3 high, 3 low). Entre los árboles pendientes figuran braces y KaTeX/Mermaid. No se afirma que todos los high sean únicamente de compilación ni que el repositorio quede libre de vulnerabilidades. Evidencia: [audit completo](../storage-templates-dependency-audit-2026-10-11.json) y [audit de producción](../storage-templates-dependency-runtime-audit-2026-10-11.json).
- CUA no expuso navegadores/pestañas para usar la sesión ambiental de producción. Un único login estándar con credenciales administrativas explícitamente configuradas no produjo sesión; no se probaron variantes/defaults, no se emitieron tokens manuales ni se extrajeron cookies de usuarios. La validación visual autenticada productiva permanece sin verificar.

## Evidencia visual y despliegue

Capturas de cuentas sintéticas en los servicios aislados, inspeccionadas después de la aceptación final:

- [Almacenamiento en escritorio](evidence/storage-desktop.png) y [móvil](evidence/storage-mobile.png).
- [Editor en escritorio](evidence/templates-editor-1440.png) y [móvil](evidence/templates-editor-375.png).
- [Menú contextual](evidence/templates-context-menu.png), [imagen reemplazada en marco](evidence/templates-image-frame.png) y [exportación](evidence/templates-export.png).

La copia de recuperación previa contiene el dump PostgreSQL verificado y los identificadores de imágenes activas. El despliegue debe usar `make deploy` desde `/root/proyect/clarin`, seguido de contenedores, health interno, logs de backend/frontend, `/api/version`, migraciones PostgreSQL y conciliación READ ONLY. El resultado exacto de esa operación posterior a este commit se registra en el [PR #8](https://github.com/ricardoalejandro/clarin/pull/8); las pruebas aisladas no sustituyen esas comprobaciones.
