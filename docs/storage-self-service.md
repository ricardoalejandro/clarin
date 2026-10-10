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

El script de integración crea PostgreSQL 16 y un MinIO oficial temporal,
utiliza cuentas y credenciales sintéticas, restringe sus puertos a loopback y
elimina sólo sus propios servicios al terminar. No lee la configuración de
producción ni inicia sesiones de WhatsApp o Kommo. También ejecuta los casos de
concurrencia y de conservación de los estados de carga de otros módulos.

Las pruebas de navegador del almacenamiento usan respuestas de API simuladas
para comprobar interfaz y comportamiento. Las pruebas Go de integración
comprueban SQL, transacciones, almacenamiento real, aislamiento, referencias
compartidas, reintentos y fallos parciales. Una suite omitida por falta de servicios
no equivale a una integración aprobada. PGlite sólo complementa la comprobación
de SQL; no sustituye la prueba de concurrencia en PostgreSQL nativo.

El workflow `Storage self-service QA` ejecuta estos controles en pull requests.

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
