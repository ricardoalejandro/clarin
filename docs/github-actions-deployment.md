# Despliegue automático con GitHub Actions

El workflow `Clarin Deploy` se ocupa solamente del despliegue: se activa con
pushes a `main` y ejecuciones manuales sobre `main`. No ejecuta pruebas ni se
activa para pull requests o `master`.

Las validaciones se ejecutan en el entorno de Clarín **antes del push** con
`make qa`, que comprueba backend, signer, bridge, salvaguardas del despliegue,
frontend, tipos y compilación. Los escenarios de navegador se seleccionan
explícitamente según el cambio. La preparación y los comandos están en
[Validaciones en el entorno](environment-validation.md).

Actions ya no exige un resultado automático de QA. Quien publica el commit
debe comprobar la misma revisión antes de enviarla; los chequeos de salud del
servidor verifican que arrancó la versión solicitada, pero no sustituyen las
pruebas funcionales.

El destino predeterminado es `root@72.61.37.46:22`, en
`/root/proyect/clarin`. El repositorio del servidor debe estar en `main`, apuntar
a `ricardoalejandro/clarin` y poder hacer `git fetch origin main`.

## Configuración pendiente en GitHub

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

El entorno GitHub `production` registra cada despliegue. Si se configuran
revisores obligatorios en ese entorno, GitHub esperará su aprobación;
para despliegue automático debe permitir ejecutar `main` sin esa aprobación.

## Configuración del servidor

El servidor conserva su `.env` y los volúmenes de PostgreSQL, MinIO, WhatsApp y
Codex. Las variables configuradas en el entorno de Codex no se transfieren a
GitHub ni al servidor. `docker compose config` debe resolver las credenciales
de producción; el workflow comprueba las obligatorias sin imprimir sus valores.

El host requiere Bash, Git, Make, Node.js, Docker con Compose, curl y flock.
El usuario SSH necesita ejecutar el flujo existente `make deploy`, incluido el
actualizador de rutas de Traefik/Dokploy. El workflow no instala dependencias en
el servidor ni modifica `authorized_keys`.

## Comportamiento del despliegue

- GitHub y el servidor serializan los despliegues. Un run de un commit que ya no
  es la punta de `main` se omite para evitar que publique una revisión antigua.
- El checkout avanza exclusivamente mediante fast-forward al SHA comprobado.
  Los cambios locales de archivos versionados bloquean el despliegue.
- El archivo `backend/CHANGELOG.md` copiado por `make deploy` vuelve a su estado
  anterior después del build. Antes de actualizar, solo se recupera una copia
  generada cuyo contenido coincide exactamente con el changelog raíz.
- Se ejecuta `make deploy`, se comprueban la salud del backend, el login del
  frontend y el SHA de la versión publicada, y se revisan los logs recientes
  sin publicarlos completos. El último SHA verificado queda en
  `.runtime/deploy/last-successful.sha`.
- Los fallos detienen el workflow. No se revierten automáticamente migraciones,
  datos ni volúmenes; una recuperación debe considerar el esquema persistido.

Para el primer despliegue, guardar `DEPLOY_SSH_KEY` y usar
**Actions → Clarin Deploy → Run workflow → main**. Después, cada push a
`main` ejecuta directamente el despliegue y sus comprobaciones de salud y versión.

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
