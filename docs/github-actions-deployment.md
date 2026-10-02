# Despliegue automático con GitHub Actions

El workflow `Clarin CI and Deploy` prueba cada push y pull request hacia `main` o
`master`. Despliega solamente los pushes a `main` y las ejecuciones manuales sobre
`main`, después de que las pruebas del backend, signer, bridge y frontend,
el chequeo de tipos, la compilación y Playwright terminen correctamente.

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
**Actions → Clarin CI and Deploy → Run workflow → main**. Después, cada push a
`main` vuelve a ejecutar las comprobaciones y el despliegue.
