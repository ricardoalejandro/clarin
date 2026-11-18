# Utilitarios: edición y guardado fiables

## Comportamiento

- `Ctrl+S`, `Cmd+S` y **Guardar** confirman el documento activo mediante la misma cola que el autoguardado. Funcionan con ambos paneles, comparación y vista por tramos; no descargan la página ni validan obligatoriamente el contenido. El autoguardado mantiene su espera de 2 segundos y su máximo de 5 segundos durante escritura continua.
- **Editor de texto y código** conserva la ruta y el identificador `json`. Admite JSON, JSON con comentarios (JSONC), XML, TXT, Markdown, CSV, LOG, YAML, INI, HTML, CSS, JavaScript, TypeScript y SQL. JSONC admite comentarios y comas finales. Los modos se conservan independientemente por panel.
- Todos los modos permiten editar, buscar, comparar y descargar. Sólo JSON/JSONC/XML ofrecen sus operaciones estructurales existentes. Los otros modos usan resaltado local cuando corresponde, sin ejecutar código ni producir vistas HTML. CSV, LOG y extensiones desconocidas usan texto simple.
- La apertura conserva el texto y el archivo original; rechaza datos binarios nulos o una decodificación inválida sin sustituir el borrador. La descarga respeta la extensión elegida y los sufijos originales compatibles. Se mantienen las protecciones de codificación y firma XML.
- Cada fila de **Documentos** tiene acciones para renombrar y eliminar sin abrir el fichero. Eliminar exige confirmación. Cerrar una pestaña conserva el documento. Los menús son portales y la búsqueda espera exactamente 500 ms.

## Integridad y recuperación

El contenido sigue siendo privado de la cuenta y del usuario propietario. No se guarda en almacenamiento compartido del navegador ni se envía a servicios de análisis. Las solicitudes de fondo no renuevan la sesión por actividad artificial.

Autoguardado, guardado explícito y cambios de metadatos comparten una barrera por documento. Ante una confirmación perdida se repiten exactamente la operación y su carga antes de enviar versiones posteriores; una eliminación incierta requiere confirmación explícita y no se repite desde el autoguardado. Las versiones se mantienen separadas para metadatos y contenidos de cada panel.

La lectura asocia los bytes al `X-Content-Version` de esa misma respuesta. El backend conserva un bloqueo compartido del documento durante la lectura del objeto y de su diario, evitando que el checkpoint elimine la representación que se está materializando. CORS admite las cabeceras de concurrencia necesarias y expone la versión del contenido.

Los errores de conexión, autorización y conflicto conservan su significado. Un conflicto real no fuerza sobrescrituras ni reenvía indefinidamente la misma versión: permite descargar el borrador, guardar una copia o **guardar una copia y cargar la versión guardada**. Esta última opción confirma primero todos los contenidos de la copia. Si falla la recarga, la copia queda accesible en otra pestaña y el borrador original permanece abierto. La navegación protege también las confirmaciones de metadatos aún pendientes.

## Verificación realizada — 2026-11-17

| Comprobación | Resultado observado |
| --- | --- |
| Suite completa Go en Linux | Todos los paquetes pasaron, incluido `cmd/storage-ui-qa`, con Go `1.27.2 linux/amd64`, backend montado sólo para lectura y caché temporal. |
| `TestUtilitiesPostgresReadCheckpointIntegration` | Pasó en 8,53 s: aislamiento por cuenta/propietario, conflicto PostgreSQL `55P03` durante una lectura compartida, checkpoint posterior coherente y liberación del bloqueo al cancelar. Objetos simulados en memoria; PostgreSQL e inventarios reales. |
| `TestUtilitiesPostgresAndMinIOIntegration` | Pasaron sus 12 casos en 9,44 s con PostgreSQL y MinIO reales: CAS/reintentos, carrera de checkpoint, búsqueda, metadatos/pestañas, vault y copias, limpieza física de versiones, cuotas, concurrencia y originales no UTF-8. |

Las dos verificaciones de integración ejecutaron las migraciones dos veces sobre una base desechable. Después de la limpieza de los fixtures quedaron cero cuentas, documentos, contenidos, cambios y objetos de Utilitarios en esa base. Los contenedores y su red se eliminaron comprobando nombres exactos y etiquetas de QA.

MinIO fue `RELEASE.2025-09-07T16-13-09Z`, procedente exclusivamente de una exportación de su imagen pública cacheada, por ID inmutable `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`. No se exportaron contenedores, configuración, credenciales ni datos del servidor. Todas las escrituras de integración ocurrieron en los contenedores locales desechables y en el bucket dedicado del fixture.

La cobertura unitaria de interfaz incluye guardado inmediato y concurrente, conservación de ambos paneles, formatos/extensiones, búsqueda a 500 ms, acciones sobre documentos cerrados, confirmaciones perdidas, recuperación de conflictos y protección de navegación. Las pruebas Playwright usan el editor real y un API de biblioteca simulado con estado, servido por HTTP nativo en un puerto efímero de `127.0.0.1`. El servidor lee los bytes recibidos: el protocolo de intercepción de WebKit omite los cuerpos `Blob`, aunque el navegador sí los transmite. Se verificó ese comportamiento contra un receptor HTTP real y el transporte del fixture en los tres motores, sin modificar `fetch` de la aplicación. Estas pruebas son complementarias a las verificaciones reales de PostgreSQL/MinIO anteriores.

## Repetir las comprobaciones de backend

Desde `backend`, con Go 1.27.2 y servicios de QA aislados:

```sh
GOCACHE=/tmp/go-build GOTOOLCHAIN=local go test -mod=readonly -p=2 ./...
CLARIN_RUN_UTILITIES_POSTGRES_INTEGRATION=1 go test ./internal/utilities -run '^TestUtilitiesPostgresReadCheckpointIntegration$' -count=1 -v
CLARIN_RUN_UTILITIES_INTEGRATION=1 go test ./internal/utilities -run '^TestUtilitiesPostgresAndMinIOIntegration$' -count=1 -v
```

Los fixtures requieren `UTILITIES_TEST_DATABASE_URL` con host literal `127.0.0.1` y base `clarin_utilities_qa`. El segundo requiere además `UTILITIES_TEST_MINIO_ENDPOINT=127.0.0.1:<puerto>` y los buckets y credenciales sintéticos definidos en el fixture. Las variables opt-in permanecen desactivadas en la suite ordinaria. Estos resultados describen QA aislado y no acreditan ningún despliegue.
