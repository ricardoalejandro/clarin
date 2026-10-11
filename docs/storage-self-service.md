# Almacenamiento: contrato y verificación

La única pantalla es `/dashboard/storage`. El enlace anterior de Configuración
redirige a esa pantalla. En la aplicación móvil se abre desde el panel de cuenta;
los cinco módulos principales y el funcionamiento sin conexión se conservan.

## Alcance del usuario

- Se muestran fotos, videos, audios y documentos con referencias verificadas a
  contenido que el usuario puede consultar en su cuenta.
- El permiso de gestión existente (`settings`) permite solicitar operaciones,
  pero nunca sustituye los permisos del origen ni los permisos de una tarea,
  Entorno o pizarra concreta.
- La unidad de gestión es un **uso del archivo**: retirarlo de una ubicación no
  elimina los otros usos ni sus bytes. Un archivo compartido puede seguir en
  Archivos mientras una retirada concreta aparece en Papelera.
- No se ofrece al usuario borrar tablas, registros del servidor, copias de
  seguridad, archivos técnicos ni objetos de procedencia desconocida. La
  administración del servidor conserva esa responsabilidad.
- El administrador de la cuenta ve el uso agregado de los objetos observados por
  el índice, con su fecha y estado de verificación. No representa tablas, logs,
  copias ni todo el disco del servidor. Los demás usuarios ven sólo el tamaño
  de sus medios autorizados, sin inferir la capacidad libre de la cuenta.

| Uso | Gestión desde Almacenamiento | Protección y recuperación |
| --- | --- | --- |
| Chats | Retirar el adjunto de uno o varios mensajes autorizados. | Conserva texto e historia; restaura en los mensajes que aún existen y no fueron sustituidos. |
| Campañas | Retirar medios de campañas en borrador. | Campañas programadas, en ejecución y otros estados permanecen protegidos; no se modifica JSON cuyo significado no esté demostrado. |
| Respuestas rápidas | Retirar el medio de sus representaciones relacionadas, con permiso de gestión de respuestas rápidas además de Chats y Almacenamiento. | Conserva texto y orden; no permite dejar una respuesta sin contenido. |
| Stickers guardados | Retirar el sticker de los favoritos autorizados. | Otros mensajes o ubicaciones que lo utilicen conservan el archivo. |
| Fotos de contactos | Retirar la foto canónica con permiso de Contactos. | Actualiza la revisión y los eventos del contacto; la recuperación no sustituye una foto posterior. |
| Adjuntos de Work | Retirar adjuntos de tareas o comentarios con permiso efectivo actual de Editar sobre la tarea y acceso de al menos Ver a su Entorno. | Conserva texto, relaciones de comentarios y anotaciones; recupera sólo si sigue existiendo una ubicación compatible y no hay un adjunto sustituto. |
| Imágenes del lienzo de Pizarras | Retirar las imágenes correspondientes de una pizarra editable. | Usa el editor canónico; conserva formas, textos y cambios ajenos. Recuperar exige que los elementos retirados no hayan cambiado. |
| Versiones históricas y bibliotecas de Pizarras | Consultar los usos autorizados como protegidos. | Nunca se altera una revisión inmutable ni la estructura de una biblioteca para liberar bytes. |
| Cargas propias sin publicar | Retirar una carga con procedencia registrada y verificada, sin uso en contenidos y con al menos 24 horas desde la última carga. | Sólo su propietario; otra carga o uso válido del mismo objeto conserva los bytes. Una deduplicación por sí sola no demuestra la procedencia de un objeto antiguo. |
| Dinámicas, encuestas, plantillas y documentos de Documentos —incluidos borradores—, estados privados y usos desconocidos | Permanecen protegidos por sus circuitos actuales. | La presencia de cualquiera de estas referencias impide el borrado físico, aunque no sea visible para el actor. |

Las cargas temporales de Work y Pizarras respetan además su propietario, el
vencimiento del borrador y los permisos del recurso. Una cuenta administradora
no obtiene acceso a borradores privados de otro usuario por abrir Almacenamiento.

## Pantalla y revisión del impacto

Hay tres vistas: **Archivos, Papelera y Actividad**. Archivos permite filtrar,
ordenar, paginar, previsualizar y abrir los usos de cada archivo en una ventana
adaptable al espacio disponible. Los controles muestran qué usos pueden
retirarse y por qué se conservan los protegidos. La selección individual de usos
se mantiene al cambiar de página; la acción sobre el archivo completo sólo se
ofrece cuando el servidor acredita que todos sus usos son retirables.

Antes de confirmar se muestran los usos que se retirarán y los que permanecerán,
si el archivo entrará en papelera y cuánto espacio se liberaría. Retirar un uso
libera **cero bytes** en ese momento. Las dependencias que el actor no puede ver
sólo producen un aviso genérico de conservación; no exponen nombres, enlaces ni
contenido privado. Las recomendaciones aplican filtros sobre medios autorizados
y explican si el inventario aún está verificándose.

La papelera identifica cada retirada por su propia recuperación, por lo que dos
retiradas del mismo archivo pueden aparecer por separado. Los tamaños físicos
no se suman dos veces por ese motivo. Cambiar de cuenta o perder permisos limpia
selecciones, revisiones y visores. Actividad muestra los resultados efectivos y
permite reintentar la operación persistida cuando queda trabajo pendiente.

## Integridad y aislamiento

Las revisiones caducan, pertenecen a una cuenta y a un actor, y describen una
selección exacta. La confirmación vuelve a consultar permisos y referencias.
Si algo cambió, la selección debe revisarse de nuevo. Repetir una confirmación
devuelve o reanuda la misma operación.

Cada retirada conserva un registro privado de recuperación independiente del
estado físico del objeto. Se retiene durante **al menos siete días**, sin
caducidad que elimine automáticamente los bytes. Mientras permanezca recuperable
sigue contando como espacio ocupado. El borrado definitivo requiere acción
manual, el cumplimiento de la retención de todas las retiradas pertinentes y una
nueva prueba de ausencia de referencias, incluidas las ocultas y las históricas.
Cuando coexisten una recuperación anterior y una nueva del mismo objeto, ambas
purgas quedan bloqueadas hasta resolver esa coexistencia; ninguna omite el otro
registro. Las restauraciones conservan sus backups y funcionan en ambos órdenes.

Restaurar vuelve a comprobar los permisos actuales y la ubicación original.
Si el contenido fue sustituido o editado de forma incompatible se informa un
conflicto y no se sobrescribe. Work mantiene una marca explícita de retirada;
sus listados, descargas, comentarios, vistas previas, sincronización y trabajos
de conversión dejan de exponer ese adjunto. Pizarras guarda sólo los vínculos y
elementos afectados, aplica un cambio canónico y conserva las ediciones ajenas.
Las revisiones históricas siguen reteniendo sus imágenes. Los eventos y las
invalidaciones de caché se emiten después de confirmar la transacción y dentro
de la cuenta correspondiente. `storage_changed` avisa a toda la cuenta sólo con
cuenta, revisión y motivo; no contiene nombres, claves ni recursos. Los eventos
con contenido siguen los permisos del módulo y del recurso.

Si la tarea o pizarra desapareció definitivamente, un administrador actual de la
misma cuenta puede consultar y purgar la recuperación auditada cuando proceda;
no puede recrear el recurso desde Almacenamiento. Esta excepción no permite
sortear permisos de un recurso que todavía existe, está oculto o está archivado.

Las referencias de medios usan una barrera de escritura por cuenta. Antes de
borrar bytes se confirma una intención persistente y se retira el objeto de la
reutilización por hash. Un fallo de S3 o de la finalización SQL conserva esa
intención. Actividad permite reintentar los elementos pendientes; no se reactiva
un archivo cuyos bytes pudieron haberse eliminado. Los registros sobreviven a
la eliminación del usuario y un administrador de la misma cuenta puede reanudar
una purga ajena ya confirmada que siga pendiente; no puede confirmar una revisión
ajena que todavía no se haya ejecutado. Los bytes ya purgados no se recuperan.

Las descargas ordinarias exigen sesión, cuenta y permisos de origen. El bucket
deja de permitir lectura anónima. Las encuestas y dinámicas publicadas utilizan
permisos temporales ligados al archivo y a la publicación; el servidor vuelve a
comprobar la publicación en cada lectura. Los medios recién subidos tienen una
vista previa temporal ligada a su usuario, sesión y cuenta. Guardar una referencia
a un archivo existente también exige acceso a ese archivo.

Las rutas antiguas de eliminación directa y deduplicación responden `410`.
La limpieza administrativa y los recolectores de Work y Pizarras reconocen ambas
papeleras y no eliminan bytes con retiradas recuperables o purgas en curso. Los
derivados se retiran mediante los trabajos persistentes de su módulo, después
de la correspondiente comprobación de referencias.

Los recolectores de Work y Pizarras reservan el objeto bajo la misma barrera
exclusiva antes de llamar al almacenamiento. Una respuesta perdida del proveedor
mantiene la reserva y el trabajo de reintento; nunca reactiva bytes cuya eliminación
sea incierta. Mientras ese borrado termina, volver a subir el mismo contenido
puede devolver un conflicto temporal. Tras completar el trabajo se admite una
carga nueva con otra clave; los enlaces al objeto anterior siguen rechazados.

## Inventario y rendimiento

Archivos y Uso consultan un índice persistente de PostgreSQL. La página devuelve
40 archivos por defecto y un máximo de 100, con filtros y orden estable en SQL;
los permisos actuales del actor se aplican antes de paginar y agregar. Hasta seis
orígenes acompañan a cada archivo; los demás se consultan desde su detalle. La
petición de listado no enumera S3 ni construye todo el inventario en memoria Go.

Los cambios de las fuentes incrementan su generación e invalidan sus referencias
indexadas anteriores. Un trabajador actualiza fuentes en lotes de 500 y observa
S3 en páginas de 1.000 objetos con un punto de continuación persistente. Recorre
cada cuenta periódicamente, sin convertir un fallo de servicio en evidencia de
que sus archivos desaparecieron. Las ausencias requieren terminar el recorrido
y comprobar el objeto. El cliente recibe el estado `indexing`, `ready` o
`degraded`, la completitud y la fecha real de verificación; una indexación inicial
incompleta no se presenta como consumo total definitivo.

Las revisiones, confirmaciones, descargas y detalles de usos comprueban en vivo
los objetos seleccionados y sus referencias; el índice no autoriza eliminaciones.
La disponibilidad para revisar un archivo de Chats depende de sus referencias
autorizadas y vigentes, sin bloquearlo por una fuente ajena que esté actualizándose.
Un uso protegido nuevo puede bloquear la revisión en vivo aunque todavía no haya
llegado al índice. Las cargas abandonadas y la purga siguen exigiendo un índice
completo. La revisión de hasta 100 archivos reúne sus referencias en una consulta;
esa instantánea sólo pertenece a una fase de lectura de la petición y se renueva
al confirmar, bajo la barrera de la cuenta. Nunca se reutiliza tras una mutación.

La proyección creada con el parser anterior se invalida una sola vez al aplicar
`exact-object-key-parser-v2`. La actualización atómica cambia generaciones del
índice, conserva todos los datos de negocio y deja la reconstrucción al trabajador
por lotes. Los resultados anteriores dejan de autorizar lecturas mientras esperan
su reconstrucción; repetir el arranque no vuelve a invalidarlos.

Las claves se conservan literalmente y las URLs se decodifican una sola vez.
Un archivo físicamente ausente devuelve 404 y queda bloqueado en una revisión
mixta, con cero bytes atribuidos y sin eliminar sus ubicaciones. Un fallo operativo
de SQL, Redis o S3 devuelve un error recuperable de servicio, no una ausencia ni
un conflicto de selección. Los conflictos reales de la revisión devuelven 409 y
exigen revisar de nuevo antes de confirmar.

Los avisos ordinarios de almacenamiento agrupan una lectura posterior sin
cancelar la que está en curso ni descartar la revisión. Cambiar de cuenta, recurso
o permisos sigue cancelando y ocultando inmediatamente el estado anterior.
La carga y preparación tienen un plazo de 30 segundos en el cliente y ofrecen
reintento explícito; los avisos no reinician ese plazo. Las miniaturas descargan
como máximo cuatro imágenes simultáneas por ámbito autorizado.

El resumen autorizado aún puede recorrer las filas SQL que correspondan al actor,
y el detalle de usos materializa los usos coincidentes antes de aplicar su cursor.
Estos costes no equivalen a un recorrido de S3 en cada página. El informe de QA separa el volumen sintético medido y las distribuciones privadas que todavía no se han medido.

## Batería reproducible de QA

```bash
cd backend
GOCACHE=/tmp/go-build go test ./...
cd ../frontend
env -u NEXT_PUBLIC_API_URL TZ=UTC npm run test:unit
npm run typecheck
npm run build
cd ..
bash scripts/qa/run-storage-self-service.sh
PLAYWRIGHT_BASE_URL=http://localhost:3000 \
  npx playwright test --config=playwright.storage.config.ts tests/storage-self-service.spec.ts
```

El script de integración crea PostgreSQL 16, Redis 7 y un MinIO oficial temporal,
utiliza cuentas y credenciales sintéticas, restringe sus puertos a loopback y
elimina sólo sus propios servicios al terminar. No lee la configuración de
producción ni inicia sesiones de WhatsApp o Kommo. También ejecuta los casos de
concurrencia y de conservación de los estados de carga de otros módulos. Redis
permite comprobar sesiones reales, cambio de cuenta y revocación de descargas.

La suite `tests/storage-self-service.spec.ts` usa respuestas de API simuladas
para comprobar interfaz y comportamiento. La suite adicional
`tests/storage-self-service-live.spec.ts` inicia sesión desde la interfaz y usa
la API, PostgreSQL, Redis y MinIO locales, sin simular respuestas. Su preparación,
evidencias y límites están en el [informe de aceptación visual y funcional](qa/storage-self-service-expanded-20261010.md).
Las pruebas Go de integración
comprueban SQL, transacciones, almacenamiento real, aislamiento, referencias
compartidas, reintentos y fallos parciales. Una suite omitida por falta de servicios
no equivale a una integración aprobada. PGlite sólo complementa la comprobación
de SQL; no sustituye la prueba de concurrencia en PostgreSQL nativo.

El runner incluye suites adicionales para usos entre módulos, permisos de
recursos privados, cargas propias e inventario indexado. Entre sus invariantes
están retirar un uso sin romper otro, revocar permisos entre revisión y
confirmación, restaurar sin sustituir cambios posteriores y mantener intactos
comentarios, anotaciones y versiones de Pizarras. La presencia del caso en la
batería no acredita por sí sola que pasó en la revisión entregada: sus resultados
deben quedar asociados al commit comprobado.

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
Docker. Los puertos desechables 25439, 26379, 29001 y 29002 deben estar libres
(o configurarse con las variables `CLARIN_STORAGE_QA_*_PORT`). El script
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
búsqueda, Uso y la apertura paralela de Uso y Archivos. Se separan miembros y
administradores; otro escenario mide un único archivo con 10.000 usos de Chat.
La indexación inicial se mide por separado, drenando explícitamente el
reconciliador sin las esperas entre ciclos del trabajador de fondo; no representa
un tiempo garantizado de disponibilidad inicial. Los registros `STORAGE_PERF`
contienen latencia, asignaciones y memoria del proceso Go; no incluyen la RAM
de PostgreSQL/MinIO ni acreditan capacidad de producción.

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

## Evidencia histórica: commit `7c7d20f`

Los resultados siguientes corresponden a la versión anterior, centrada en medios
de Chats, y no acreditan por sí solos la ampliación por usos ni el índice nuevo.
El [pase nativo del 10 de octubre de 2026](qa/storage-self-service-native-20261010.md)
registró PostgreSQL 16.15, Redis 7.4.11 y MinIO reales, además del backend completo.
Midió 1.000, 10.000 y 50.000 objetos sintéticos, con 100 chats y diez mensajes de
texto adicionales por objeto. En 50.000 objetos la primera página tuvo una
mediana de 2,27 s; abrir Uso y Archivos en paralelo, 2,57 s. Esa apertura asignó
1.112,8 MiB acumulados y alcanzó 253,5 MiB de RSS Go muestreado: son métricas
distintas, y excluyen la memoria de los servicios. El informe contiene las quince
mediciones, condiciones y límites de reproducción.

Esos costes provenían de enumerar el inventario completo y duplicar ese trabajo
al abrir Uso y Archivos. El índice descrito arriba sustituye ese camino de
lectura. Sus cifras nuevas deben documentarse con la revisión exacta, condiciones,
latencias, memoria y evidencia de las peticiones; no se deducen de la arquitectura.

## Evidencia de la ampliación por usos y del índice

El [informe de aceptación de la ampliación](qa/storage-self-service-expanded-20261010.md)
identifica el código `ffcadbd`, las condiciones, las capturas y los resultados:
backend completo, frontend (1.801 pruebas), TypeScript y build aprobados;
109 comprobaciones nativas sin omisiones; 25 recorridos de navegador aprobados
y verificación de 12 archivos en PostgreSQL/MinIO. El informe detalla también
la medición sintética por volumen, actor y distribución, incluyendo latencia,
asignaciones, memoria Go e indexación inicial. Los informes de `7c7d20f` se
conservan como evidencia histórica, sin sustituir la aceptación de esta ampliación.

**No se ha medido el almacenamiento de producción ni se ha determinado por qué
una cuenta real concreta ocupa tanto espacio.** Tampoco se acredita capacidad de
producción mediante una prueba sintética aislada. Antes de una eventual puesta
en servicio se deben contrastar la distribución real de cuentas y medios, los
tiempos de espera y la recuperación ante servicios lentos.

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
