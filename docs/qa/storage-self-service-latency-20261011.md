# Almacenamiento: correcciones de carga y revisión

Código de producto verificado: `ed35263c8485babf600392d530c9d6ccaf2667ba`.
El frontend completo, TypeScript y build aprobaron con las fuentes de `eed37be`, idénticas en el corte final. Después sólo cambiaron dos casos backend detectados por QA y sus regresiones; backend completo y runner nativo se repitieron sobre el corte final.

## Problemas reproducidos y cambios

Las actualizaciones ordinarias podían cancelar continuamente una consulta más lenta, manteniendo los esqueletos o la comprobación de impacto. Ahora se agrupa una lectura posterior sin cancelar la actual. El usuario puede revisar mientras se actualiza su página. Cambiar de cuenta o permisos sigue cancelando y ocultando el estado anterior. La carga y preparación tienen un plazo de 30 segundos y reintento explícito; los avisos no amplían ese plazo.

El servidor repetía las consultas de referencias para cada archivo seleccionado y calculaba metadatos antes de limitar la página. La revisión reúne hasta 100 claves en una consulta, con una instantánea local a una fase de lectura. La confirmación vuelve a leer bajo la barrera de la cuenta y las comprobaciones posteriores a mutaciones siguen siendo en vivo. El listado selecciona identidades antes de hidratar sus metadatos; el resumen agrega su relación física autorizada una vez. No hay caché de permisos en el servidor.

Las claves físicas literales y las URLs se interpretaban de manera indistinta: `%20`, `?`, `#` y delimitadores podían cambiar la identidad o crear alias. Se conserva la clave literal, se escapan los segmentos al construir URLs y se decodifican URLs una sola vez. El prefiltro JSON utiliza la serialización de PostgreSQL, incluyendo comillas, `&<>` y separadores Unicode. El índice anterior se invalida atómicamente una sola vez y lo reconstruye el trabajador por lotes.

Un fallo operativo podía parecer ausencia 404 o conflicto 409. Ahora SQL, Redis y S3 devuelven un error recuperable de servicio. Una ausencia física comprobada sigue devolviendo 404 al pedir bytes; su revisión presenta un elemento bloqueado con cero bytes, sin eliminar ubicaciones ni consumir recuperaciones. Si falla un elemento, los presentes siguen siendo revisables. Los cambios reales de selección o acceso conservan 409 y obligan a revisar nuevamente.

Un cambio de una fuente ajena también podía quitar la selección mientras el índice se actualizaba. La disponibilidad para revisar Chats usa sus referencias autorizadas vigentes; las cargas abandonadas y la purga mantienen el requisito de índice completo. La revisión en vivo bloquea usos protegidos aunque todavía no estén indexados.

La ejecución nativa encontró dos casos adicionales, corregidos antes del pase final: una revocación de acceso a Work al restaurar se etiquetaba como servicio no disponible; una recuperación cuyos bytes faltaban mostraba un error transitorio. Se conservan la denegación y el historial, con respuestas comprensibles y sin mutación.

Las capturas no incluyen las claves completas ni una copia de esos objetos. Por tanto, este informe acredita las condiciones reproducidas con datos sintéticos; no establece si cada 404 concreto de la captura corresponde a un archivo físicamente ausente, inaccesible o una URL histórica distinta.

## QA final

| Comprobación | Resultado |
| --- | --- |
| Backend completo y compilación | PASS en el corte final. |
| Frontend completo | 1.819 PASS: 1.747 principales, 28 del editor y 44 de Node. |
| TypeScript y build | PASS; metadatos del checkout restaurados. |
| Runner PostgreSQL 16, Redis y MinIO | 137 hojas PASS, 154 contando grupos, 0 fallos y 0 omisiones. |
| Navegador Chromium 151 sobre aplicación compilada | 28/28 PASS: 25 anteriores en 46.338 s y 3 regresiones en 59.752 s; 9 casos con servicios reales y 19 con API simulada. Cero fallos, reintentos y omisiones. |
| Rendimiento | 25/25 escenarios PASS, 10 muestras y 2 calentamientos; fuentes Go intactas y 0 S3 durante lecturas. |
| Runtime | API y frontend compilados verificados, login/proxy HTTP/S3 y WebSocket autenticado 101 PASS. |
| SQL/S3 posterior y limpieza | 12 estados del fixture original y 46 del nuevo verificados; hashes exactos de los presentes, restauración y purga física. Limpieza de 11 + 45 objetos propios; 0 restantes en ambos. |

El primer pase nativo detectó el conflicto de Work; no se presenta como aprobación. Tras corregirlo se repitió el runner completo. La suite frontend requiere omitir `NEXT_PUBLIC_API_URL` sólo en el proceso de pruebas, pues las pruebas de cliente esperan rutas relativas. No se modificaron pruebas ajenas ni la configuración persistente para ocultar ese desajuste.

El nativo adicional comprueba descargas con JWT y Redis reales, 13 nombres especiales, URL-only legacy, bytes y hashes, separación A/B, 404 sin reconciliar, fallo de proveedor 503, retirada y recuperación sin bytes, revisión de 40 frente a 10.000 textos y una sola consulta de referencias. La revisión de 40 devolvió 200 en 644,314 ms durante QA concurrente: es una observación funcional, no un benchmark aislado.

## Navegador real y evidencia visual

Los tres casos nuevos usan el trabajador ordinario, sin forzar reconciliación, 46 objetos y 10.000 textos. El inventario nuevo alcanzó `ready` en 35,076 s desde abrir la pantalla; es un arranque inicial de índice sintético, no una medición de apertura sobre un índice ya preparado ni un SLA. La revisión de 40 devolvió 200 y mostró la confirmación en 1,025 s durante avisos reales. El registro contiene siete avisos de almacenamiento; la selección y revisión permanecieron vigentes. Cancelar no generó operaciones.

Se descargaron documentos con claves históricas y caracteres especiales, comprobando tamaño, SHA-256 y píxeles del PDF realmente renderizado. La cuenta A no obtuvo bytes de B. Se retiró sólo el objeto sintético marcado `missing` después de observarlo; la lectura respondió 404 y la revisión 200 bloqueada, sin éxito inventado, reintento automático ni mutación de sus referencias.

La verificación posterior comprobó 46 estados SQL, los 45 hashes presentes y la única ausencia esperada. El otro perfil volvió a comprobar restauración, purga física, conservación del texto y uso compartido; sus 12 estados finales fueron válidos. La limpieza delimitada dejó cero objetos de ambos fixtures, conservando los servicios generales.

El registro nuevo contiene cuatro `request_failed` de Uso/Archivos al iniciar cambios de ruta, seguidos de respuestas 200. No guardó el motivo de transporte y no permite atribuirles una causa definitiva; ninguno ocurrió durante el ruido y la revisión de 40. No se afirma que toda navegación tenga cero cancelaciones. Ningún caso tuvo errores de ejecución no capturados del navegador.

Las capturas de este informe son nuevas, de la aplicación compilada de esta ejecución:

- [Revisión de 40 bajo actualizaciones reales](storage-self-service-latency-20261011/01-revision-40-archivos.png).
- [Ausencia física explicada y bloqueada](storage-self-service-latency-20261011/02-objeto-ausente-bloqueado.png).
- [Lista en escritorio](storage-self-service-latency-20261011/01-escritorio-lista.png), [cuadrícula](storage-self-service-latency-20261011/02-escritorio-cuadricula.png) y [detalle de uso compartido](storage-self-service-latency-20261011/14-retirada-uso-compartido.png).
- [Papelera recuperable](storage-self-service-latency-20261011/07-papelera-recuperable.png), [actividad](storage-self-service-latency-20261011/09-actividad-y-resultados.png), [lista móvil](storage-self-service-latency-20261011/12-movil-archivos.png) y [revisión móvil](storage-self-service-latency-20261011/13-movil-revision.png).

[Resultados sanitizados, estados finales y hashes de logs](storage-self-service-latency-results-20261011.json). Los manifiestos privados, credenciales y logs sin revisar permanecen fuera de los artefactos publicados.

## Rendimiento medido

Se repitió la matriz completa de 25 escenarios sobre `ed35263`, sin builds ni cargas sostenidas competidoras. PostgreSQL 16.15, Go 1.25.11, GOMAXPROCS=3, cuota de cuatro CPU y límite de 16 GiB. Los datos principales son medios sintéticos de 1 KiB, una referencia y diez textos por medio, distribuidos en 100 Chats. Los hashes de los 696 archivos Go permanecieron iguales.

“Apertura” mide Resumen y Archivos concurrentes en handlers reales con identidad sintética y servicios nativos; excluye navegador, login y transporte remoto. Latencias en milisegundos y memoria en MiB:

| Objetos | Apertura miembro anterior p50 | Apertura miembro actual p50 / p95 | Apertura administrador actual p50 / p95 | Asignación Go por apertura miembro p50 | Pico RSS Go miembro |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 68.72 | 34.46 / 55.33 | 35.41 / 38.34 | 0.50 | 34.24 |
| 10,000 | 613.20 | 332.91 / 367.74 | 337.36 / 381.54 | 0.50 | 35.29 |
| 50,000 | 3324.07 | 1902.04 / 2005.27 | 1902.05 / 2100.36 | 0.50 | 38.50 |

La columna anterior procede del informe del 10 de octubre: misma forma de datos, recursos y método, pero es una ejecución histórica separada, no un A/B contemporáneo. La reducción de mediana fue aproximadamente 50%, 46% y 43% en los tres volúmenes. Con 50.000 objetos, la apertura aún tarda unos 1,90 s; la búsqueda, los recuentos exactos y los offsets siguen dependiendo del volumen. No se declara respuesta instantánea para toda cuenta.

Todas las consultas y lotes extra de memoria registraron cero peticiones S3. Dos calentamientos y diez muestras por escenario; con diez muestras p95 coincide con el máximo. RSS/heap se muestrean cada 10 ms en un lote adicional tras GC/liberación de memoria: corresponden sólo al proceso Go, excluyen los servicios y pueden omitir picos breves. Las asignaciones acumuladas no son memoria retenida.

El detalle de un archivo con 10.000 usos mantiene un coste material: p50 2.276,045 ms, p95 2.455,946 ms, 212,39 MiB asignados y 68,89 MiB de RSS Go muestreado. Todavía materializa las coincidencias antes de paginar. No se atribuye a estas correcciones una mejora de ese recorrido. En esa misma forma compartida, Archivos tuvo p50 290,95 ms y apertura 271,57 ms, frente a 252,19 y 243,42 ms de la ejecución anterior. Esa variación refuerza que no se afirma una mejora universal de todos los recorridos.

La semilla de 50.000 archivos tomó 457,82 s y su índice inicial 39,98 s. Se drenó explícitamente el reconciliador real; esos tiempos no acreditan un SLA del trabajador ordinario. El fixture nuevo de navegador lo comprueba por separado. Al terminar: cero bases desechables, cero objetos ordinarios/privados restantes y servicios generales conservados.

Los 25 resultados, método, entorno, semilla, limpieza y hashes se conservan en [JSON de medición](storage-self-service-latency-performance-20261011.json).

## Límites y reproducción

No se midió almacenamiento de producción ni se diagnosticó el consumo de una cuenta real. La medición de consultas no incluye navegador, login o transporte remoto. La inicialización drenada del índice no acredita su SLA de actualización ordinaria. Las cuentas privadas, carga multiusuario sostenida, transferencias grandes, móviles físicos y Firefox/WebKit mantienen los límites del informe anterior. El detalle de usos sigue materializando coincidencias antes de paginar.

El perfil nuevo de navegador deja el índice al trabajador normal, sin `ReconcileStorageInventory`. Usa 46 objetos, 10.000 textos y cambios de un Chat no seleccionado; revisa 40 durante avisos reales, abre PDF histórico con bytes/hash y verifica un objeto ausente sin limpiar sus referencias. El perfil anterior conserva sus recorridos de restauración, purga, vistas previas y uso compartido.

Para reproducir el nativo: `bash scripts/qa/run-storage-self-service.sh`. Los servicios son desechables y sus puertos diferentes a los del entorno general. El fixture `storage-ui-fixture.sh create --profile regression` requiere un manifiesto nuevo y opt-in local. Los manifiestos con credenciales y los logs privados no se publican.

Para reproducir las dos suites de navegador después de levantar la aplicación compilada:

```bash
source /workspace/clarin-cloud/activate.sh
export CLARIN_STORAGE_UI_QA=1 CLARIN_STORAGE_BROWSER_QA=1
export PLAYWRIGHT_BASE_URL=http://localhost:3000
export CLARIN_QA_CHROMIUM_PATH=/usr/bin/chromium
# Elegir un manifiesto privado nuevo por perfil; nunca reutilizar uno limpiado.
export CLARIN_STORAGE_UI_QA_MANIFEST=/workspace/clarin/work/storage-ui-qa/nuevo.private.json
bash scripts/qa/storage-ui-fixture.sh create --profile regression
npx playwright test --config=playwright.storage-regressions.config.ts
bash scripts/qa/storage-ui-fixture.sh verify
bash scripts/qa/storage-ui-fixture.sh cleanup
# Repetir con otro manifiesto, create sin --profile y playwright.storage.config.ts.
# En ese perfil verify usa --expect restore=active,purge=purged.
```

El contrato funcional y operativo continúa en [storage-self-service.md](../storage-self-service.md). La ampliación anterior y sus mediciones permanecen archivadas; este informe sustituye sus cifras de aceptación para el código actual.
