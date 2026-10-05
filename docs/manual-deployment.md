# Despliegue manual por SSH

Los despliegues se inician desde la máquina local mediante una conexión SSH
directa al servidor. El servidor construye y publica Clarin con `make deploy`
desde `/root/proyect/clarin`. Publicar un commit en `main` no despliega la
aplicación.

## Preparar los cambios

Ejecutar las comprobaciones de `AGENTS.md` correspondientes a las capas
modificadas, revisar el diff y publicar los commits que se quieran desplegar en
`main`. Conservar cualquier trabajo local o del servidor que no pertenezca al
cambio.

## Conectar desde la máquina local

```powershell
ssh vps
```

`vps` es el alias SSH local del servidor. Sin ese alias, conectar con
`ssh root@72.61.37.46` usando las credenciales locales ya configuradas.

## Actualizar y desplegar en el servidor

```bash
cd /root/proyect/clarin
git status --short
git branch --show-current
```

El checkout debe estar en `main`. Si hay cambios locales, revisarlos y
conservarlos antes de continuar; no usar un reset para descartarlos.

```bash
git fetch origin main &&
git merge --ff-only origin/main &&
make deploy
```

Si la actualización no puede avanzar por fast-forward, resolver la divergencia
antes de desplegar. El flujo conserva la configuración `.env` del servidor y
los volúmenes persistentes. `make deploy` copia `CHANGELOG.md` a
`backend/CHANGELOG.md` para el build; cualquier diferencia posterior en ese
archivo debe revisarse antes del siguiente despliegue.

## Verificar el resultado en el servidor

```bash
docker ps --filter name=clarin
docker exec clarin-backend wget -qO- http://127.0.0.1:8080/health
docker exec clarin-backend wget -qO- http://127.0.0.1:8080/api/version
docker logs --tail=80 clarin-backend
docker logs --tail=60 clarin-frontend
```

Comprobar que los servicios están activos, el backend responde correctamente y
la versión publicada corresponde al commit desplegado. Revisar los logs en el
servidor sin compartir credenciales ni datos personales. Aplicar además las
verificaciones de base de datos, MCP u otras capas que exija `AGENTS.md` para
el cambio concreto.

Las pruebas unitarias y Playwright permanecen disponibles para ejecución
manual; retirarlas del flujo automático no elimina las pruebas del proyecto.
