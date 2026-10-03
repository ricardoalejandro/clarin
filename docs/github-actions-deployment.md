# Despliegue automático con GitHub Actions

El workflow `Clarin Deploy` activa una release ya preparada: se activa con
pushes a `main` y ejecuciones manuales sobre `main`. No ejecuta pruebas ni se
activa para pull requests o `master`. Su job tiene un límite de cinco minutos.
La cola de GitHub y la preparación previa de imágenes quedan fuera de ese límite.

Las validaciones se ejecutan en el entorno de Clarín **antes del push** con
`make qa`, que comprueba backend, signer, bridge, salvaguardas del despliegue,
frontend, tipos y compilación. Los escenarios de navegador se seleccionan
explícitamente según el cambio. La preparación y los comandos están en
[Validaciones en el entorno](environment-validation.md).

Actions ya no exige un resultado automático de QA. Quien publica el commit
debe comprobar y precargar las imágenes de la misma revisión antes de enviarla;
los chequeos de salud del servidor verifican que arrancó la versión solicitada, pero no sustituyen las
pruebas funcionales.

El destino predeterminado es `root@72.61.37.46:22`, en
`/root/proyect/clarin`. El repositorio del servidor debe estar en `main`, apuntar
a `ricardoalejandro/clarin` y poder hacer `git fetch origin main`.

## Credenciales de GitHub y del entorno

En **Settings → Secrets and variables → Actions → New repository secret**, crear:

| Secret | Contenido |
| --- | --- |
| `DEPLOY_SSH_KEY` | Clave **privada** OpenSSH sin passphrase, autorizada para el usuario `root` del servidor. La clave pública por sí sola no permite autenticar el workflow. |

Las claves públicas del **servidor**, proporcionadas por el propietario, están
fijadas en `scripts/deploy/known_hosts`. El cliente exige comprobación estricta
de identidad; no acepta automáticamente claves obtenidas de la red.

Para otro destino, configurar las variables `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_PORT` y `DEPLOY_PATH`. Un secret opcional `DEPLOY_KNOWN_HOSTS` puede
reemplazar el archivo fijado. Para puertos diferentes de 22, las entradas usan
el formato `[host]:puerto`.

Para preparar las imágenes desde el entorno de Clarín y cargarlas antes del
push, el entorno necesita también `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`
y acceso TCP al puerto SSH del servidor. Usar los mismos valores/identidad
fijada del destino de Actions. Los secrets de GitHub no se copian al entorno
automáticamente; configurarlos mediante su mecanismo de credenciales, sin
guardarlos en el repositorio. `DEPLOY_PORT`, `DEPLOY_PATH` y
`DEPLOY_KNOWN_HOSTS` siguen siendo opcionales. No se necesita un registry nuevo: las
imágenes viajan por SSH y quedan cargadas antes del Action.

El entorno GitHub `production` registra cada despliegue. Si se configuran
revisores obligatorios en ese entorno, GitHub esperará su aprobación;
para despliegue automático debe permitir ejecutar `main` sin esa aprobación.

## Configuración del servidor

El servidor conserva su `.env` y los volúmenes de PostgreSQL, MinIO, WhatsApp y
Codex. Las variables configuradas en el entorno de Codex no se transfieren a
GitHub ni al servidor. `docker compose config` debe resolver las credenciales
de producción; el workflow comprueba las obligatorias sin imprimir sus valores.

El host requiere Bash, Git, Node.js, Docker con Compose, curl, flock, timeout,
tar y sha256sum. Para staging se necesita también realpath. El usuario SSH
necesita cargar imágenes y actualizar las rutas de Traefik/Dokploy. El flujo
rápido requiere una instalación ya preparada con sus servicios de datos.
El workflow no instala dependencias en el servidor ni modifica `authorized_keys`.

## Preparación y activación

Validar el commit final, guardarlo y preparar sus imágenes con `make release-prepare`.
Después, ejecutar `make release-stage RELEASE_DIR="ruta-del-bundle"` desde el
entorno configurado para SSH. Los comandos están documentados en
[Validaciones en el entorno](environment-validation.md).

La preparación construye cuatro imágenes para cinco servicios, fija una sola
versión y registra SHA/checksum/IDs de imagen. Staging verifica el bundle, carga
las imágenes sin arrancarlas y publica la release completa por SHA. Estos pasos
ocurren antes de publicar el commit que desplegará Actions.

Un merge o squash que genere otro SHA requiere preparar ese nuevo commit. No se
aceptan imágenes de una revisión distinta. Si ya se publicó en main sin release,
prepararla y repetir manualmente el workflow; ese primer intento falla antes de
reemplazar servicios. Preparar el commit de merge local antes del push evita ese
intento. El piloto nativo offline V3 conserva su preparación de instalador firmado
por separado; la activación rápida lo rechaza si está habilitado.

## Comportamiento del despliegue

- GitHub y el servidor serializan los despliegues. Un run de un commit que ya no
  es la punta de `main` se omite para evitar que publique una revisión antigua.
- El checkout avanza exclusivamente mediante fast-forward al SHA comprobado.
  Los cambios locales de archivos versionados bloquean el despliegue.
- El archivo `backend/CHANGELOG.md` copiado por `make deploy` vuelve a su estado
  anterior después del build en el flujo manual original. Antes de actualizar,
  solo se recupera una copia
  generada cuyo contenido coincide exactamente con el changelog raíz. El flujo
  rápido construye desde un archivo del commit y no copia archivos en el checkout.
- Se exige `.runtime/deploy/releases/<SHA>/ready` y el manifest exacto. Se
  comprueban las cuatro imágenes cargadas, sus labels, versión y plataforma
  antes de hacer fast-forward. No hay fallback a compilación ni descargas.
- Se actualizan las rutas del proxy y se ejecuta Compose con IDs de imagen
  inmutables, `--no-build` y `--pull never`. Se comprueban salud del backend,
  login del frontend, versión completa y las imágenes reales de los cinco
  servicios. Se revisan logs sin publicarlos completos. El último SHA verificado
  queda en `.runtime/deploy/last-successful.sha`.
- El cliente SSH impone un timeout remoto de 210 segundos, con terminación de
  cinco segundos adicional; Compose tiene un presupuesto de 120 segundos y las
  comprobaciones de salud 60 segundos. El job tiene un límite de cinco minutos.
  Un timeout se informa como fallo, no como despliegue exitoso. Una activación
  parcial requiere revisar el estado real de los servicios antes de recuperar.
- Los fallos detienen el workflow. No se revierten automáticamente migraciones,
  datos ni volúmenes; una recuperación debe considerar el esquema persistido.

Antes de activar este workflow, configurar SSH en GitHub y en el entorno,
preparar y precargar la release del SHA exacto de `main`. Usar
**Actions → Clarin Deploy → Run workflow → main** para medir la primera
activación real. Después, cada push preparado a `main` ejecuta directamente la
activación y las comprobaciones. El flujo manual original `make deploy` conserva
la compilación en el servidor para bootstrap o mantenimiento fuera de este job.

## Diagnóstico de la separación (3 de octubre de 2026)

La [ejecución del 2 de octubre](https://github.com/ricardoalejandro/clarin/actions/runs/36987539296)
pasó las pruebas de backend, signer, bridge, frontend, tipos y compilación.
Playwright lanzó 759 instancias con un worker y hasta dos reintentos por fallo;
consumió 84 minutos y 10 segundos antes de que el job alcanzara su límite de
90 minutos. El despliegue quedó omitido por depender de ese job.

La selección general también incluía escenarios que requieren el laboratorio
offline y ejemplos que visitan `playwright.dev`. La matriz responsive, en cambio,
se omitía al no configurar sesión simulada ni credenciales. Esa combinación no
es una comprobación adecuada para cada despliegue; se conserva la batería para
ejecutarla por escenarios en el entorno correspondiente.
