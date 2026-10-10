# Almacenamiento: contrato y verificación

La única pantalla es `/dashboard/storage`. El enlace anterior de Configuración
redirige a esa pantalla. En la aplicación móvil se abre desde el panel de cuenta;
los cinco módulos principales y el funcionamiento sin conexión se conservan.

## Alcance del usuario

- Se muestran fotos, videos, audios y documentos con referencias verificadas a
  contenido que el usuario puede consultar en su cuenta.
- El permiso de gestión existente (`settings`) permite solicitar operaciones,
  pero nunca sustituye los permisos del origen, como `chats`.
- En esta versión se pueden retirar los medios utilizados exclusivamente en
  chats. Se explica el impacto sobre todos sus mensajes antes de confirmar.
  Si también se usan en otro módulo, se conservan y se indica su origen.
- Work, Pizarras, estados privados, archivos técnicos y objetos cuyo origen no se
  puede demostrar conservan sus circuitos específicos. No se ofrece al usuario
  borrar tablas, registros del servidor, copias de seguridad ni objetos desconocidos.
- La papelera conserva los archivos durante al menos siete días. No libera cuota
  inmediatamente. Restaurar recupera los adjuntos de los mensajes que todavía
  existen; el texto de los mensajes se conserva en todo momento.
- El borrado definitivo es manual y sólo se habilita después de la retención y
  una nueva comprobación de referencias. Se informa el espacio verificado.
- El administrador de la cuenta ve su uso agregado. Los demás usuarios ven sólo
  el tamaño de sus medios autorizados, sin inferir la capacidad libre de la cuenta.

## Integridad y aislamiento

Las revisiones caducan, pertenecen a una cuenta y a un actor, y describen una
selección exacta. La confirmación vuelve a consultar permisos y referencias.
Si algo cambió, la selección debe revisarse de nuevo. Repetir una confirmación
devuelve o reanuda la misma operación.

Las referencias de medios usan una barrera de escritura por cuenta. Antes de
borrar bytes se confirma una intención persistente y se retira el objeto de la
reutilización por hash. Un fallo de S3 o de la finalización SQL conserva esa
intención. Actividad permite reintentar los elementos pendientes; no se reactiva
un archivo cuyos bytes pudieron haberse eliminado. Los registros sobreviven a
la eliminación del usuario y un administrador de la misma cuenta puede recuperar
una purga ya confirmada. No puede confirmar revisiones ajenas sin ejecutar.

Las descargas ordinarias exigen sesión, cuenta y permisos de origen. El bucket
deja de permitir lectura anónima. Las encuestas y dinámicas publicadas utilizan
permisos temporales ligados al archivo y a la publicación; el servidor vuelve a
comprobar la publicación en cada lectura. Los medios recién subidos tienen una
vista previa temporal ligada a su usuario, sesión y cuenta. Guardar una referencia
a un archivo existente también exige acceso a ese archivo.

Las rutas antiguas de eliminación directa y deduplicación responden `410`.
La limpieza administrativa reconoce la papelera para no saltarse su retención.

## Batería reproducible de QA

```bash
cd backend
GOCACHE=/tmp/go-build go test ./...
cd ../frontend
TZ=UTC npm run test:unit
npm run typecheck
npm run build
cd ..
bash scripts/qa/run-storage-self-service.sh
PLAYWRIGHT_LOCAL_SERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3011 \
  npx playwright test tests/storage-self-service.spec.ts --project=chromium
```

El script de integración crea PostgreSQL 16, Redis 7 y un MinIO oficial temporal,
utiliza cuentas y credenciales sintéticas, restringe sus puertos a loopback y
elimina sólo sus propios servicios al terminar. No lee la configuración de
producción ni inicia sesiones de WhatsApp o Kommo. También ejecuta los casos de
concurrencia y de conservación de los estados de carga de otros módulos. Redis
permite comprobar sesiones reales, cambio de cuenta y revocación de descargas.

Las pruebas de navegador del almacenamiento usan respuestas de API simuladas
para comprobar interfaz y comportamiento. Las pruebas Go de integración
comprueban SQL, transacciones, almacenamiento real, aislamiento, referencias
compartidas, reintentos y fallos parciales. Una suite omitida por falta de servicios
no equivale a una integración aprobada. PGlite sólo complementa la comprobación
de SQL; no sustituye la prueba de concurrencia en PostgreSQL nativo.

Las suites `TestStorageSelfServiceSQLIntegration` y
`TestMediaAccessSQLIntegration` ejecutan consultas y repositorios reales sin S3.
Cubren la resolución actual de permisos, referencias entre módulos, aislamiento,
operaciones transaccionales y revocación de publicaciones. No prueban la lectura
de bytes, el ciclo completo de confirmación, las políticas del bucket ni el
borrado físico. El runner nativo también incorpora estos casos.

### Preparación del entorno

Estas pruebas no dependen de GitHub Actions, retirado según la documentación de
QA existente. Ejecutar el script desde un entorno Linux con Bash, Go 1.25.11
(el toolchain del backend), `curl`, `openssl` y un daemon Docker local operativo
y accesible mediante `/var/run/docker.sock`. El runner fija ese socket local y
descarta contextos remotos; Docker rootless en otro socket no está contemplado.
El cliente Docker por sí solo no basta. Un daemon remoto tampoco
expone PostgreSQL en el loopback que usan las pruebas. También se necesita acceso
al registro de imágenes de PostgreSQL y a las dependencias Go verificadas de MinIO.

Antes de crear recursos, el script comprueba las herramientas y el acceso a
Docker. Los puertos locales 15439, 16379, 19001 y 19002 deben estar libres. El script
arranca PostgreSQL, Redis y MinIO, espera sus comprobaciones de salud y ejecuta las
pruebas; no necesita un `.env` ni servicios de producción. Redis forma parte del
laboratorio de sesiones y se elimina junto con los demás servicios desechables.

En un entorno ya preparado se puede reutilizar un binario oficial de MinIO
mediante `CLARIN_QA_MINIO_BINARY` y su `CLARIN_QA_MINIO_SHA256`, obtenido y
verificado previamente contra la distribución oficial. El runner comprueba el
checksum antes de crear recursos, imprime la versión y sigue utilizando datos
temporales y credenciales nuevas. Si no se especifica, compila la revisión
oficial fijada en el script. Esto permite usar el entorno general de Clarín sin
alterar sus servicios persistentes ni depender de otra descarga.

La medición sintética es opcional y se ejecuta después de las suites funcionales:

```bash
CLARIN_RUN_STORAGE_SELF_SERVICE_PERFORMANCE=1 \
CLARIN_STORAGE_PERF_OBJECTS=1000,10000,50000 \
CLARIN_STORAGE_PERF_SAMPLES=10 \
CLARIN_STORAGE_PERF_CHATS=100 \
bash scripts/qa/run-storage-self-service.sh
```

Cada objeto tiene 1 KiB, una referencia de Chat y diez mensajes adicionales sin
medios (`CLARIN_STORAGE_PERF_TEXT_RATIO`), repartidos entre 100 chats
(`CLARIN_STORAGE_PERF_CHATS`). Se miden las páginas inicial y final,
búsqueda, Uso y la apertura paralela de Uso y Archivos. Los registros
`STORAGE_PERF` contienen latencia, asignaciones y memoria del proceso Go; no
incluyen la RAM de PostgreSQL/MinIO ni acreditan capacidad de producción.

El laboratorio anterior está definido en `deploy/docker-compose.integrity-qa.yml`.
Su script `start-integrity-services.sh` espera la ruta fija
`/root/clarin-integrity-qa-20261007`; no debe confundirse con un arranque automático
de cualquier workspace. El runner de almacenamiento resuelve la raíz del
repositorio desde su propia ubicación.

Si la plataforma no permite un daemon Docker o las operaciones de red requeridas
por MinIO, instalar paquetes o añadir variables no resuelve esa limitación. Se
necesita un entorno que permita esos servicios. La integración nativa debe
mantenerse pendiente hasta ejecutarla allí; las pruebas con API simulada o PGlite
no la sustituyen.

## Capacidad y límites medidos

La paginación limita la respuesta y los elementos de la interfaz. El inventario
del servidor todavía enumera los objetos y referencias de la cuenta; su coste
crece con el volumen total. Se omiten filas sin medios y se calculan huellas sólo
para las selecciones revisadas; las confirmaciones conservan su revalidación.

El [pase nativo del 10 de octubre de 2026](qa/storage-self-service-native-20261010.md)
aprobó PostgreSQL 16.15, Redis 7.4.11 y MinIO reales, además del backend completo.
Midió 1.000, 10.000 y 50.000 objetos sintéticos, con 100 chats y diez mensajes de
texto adicionales por objeto. En 50.000 objetos la primera página tuvo una
mediana de 2,27 s; abrir Uso y Archivos en paralelo, 2,57 s. Esa apertura asignó
1.112,8 MiB acumulados y alcanzó 253,5 MiB de RSS Go muestreado: son métricas
distintas, y excluyen la memoria de los servicios. El informe contiene las quince
mediciones, condiciones y límites de reproducción.

El recorrido completo y su duplicación al abrir Uso/Archivos siguen pendientes
de una solución de escala. No se ha medido con datos de producción ni bajo carga
concurrente sostenida. Antes del despliegue se debe contrastar la distribución
real de cuentas y medios, los tiempos de espera y la recuperación ante servicios
lentos; este ensayo sintético no acredita por sí solo capacidad de producción.

## Condiciones del despliegue

1. Exigir QA nativa y compilación satisfactorias sobre el commit que se desplegará.
2. Aplicar las migraciones mediante `database.Migrate()` y comprobar el arranque
   con los permisos reales de PostgreSQL y del bucket.
3. Si existen cachés o CDN delante de los medios, invalidar el contenido antiguo
   de `/api/media/file/*` y del bucket: las respuestas anteriores podían estar
   almacenadas como públicas durante un año. Las nuevas respuestas usan
   `private, no-store`; eso no revoca copias descargadas previamente.
4. Comprobar con dos cuentas reales de prueba la descarga, cambio de cuenta,
   papelera, restauración y publicaciones explícitas. Mantener Kommo inactivo.

No volver a la versión anterior mientras haya purgas pendientes: esa versión no
conoce las intenciones persistentes ni las barreras de referencias. Ante un
incidente, detener las nuevas operaciones y conservar los registros y bytes para
corregir la versión; no retirar las barreras ni reabrir el bucket anónimamente.
