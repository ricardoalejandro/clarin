# Clarin Offline Agent (Windows 11 x64)

El agente v2 intenta generar una clave ECDSA P-256 no exportable en Microsoft
CNG, demuestra su posesión al activar la terminal y firma cada solicitud de
sincronización. La clave pública se convierte desde `EccPublicBlob`, compatible
con Windows PowerShell 5.1. Si el proveedor CNG no está disponible, genera la
misma identidad ECDSA y guarda la clave privada únicamente dentro del perfil
cifrado con DPAPI `CurrentUser`. Clarin solo almacena la clave pública del
equipo. No usa certificados cliente, PKI ni Vault.

El firmador aislado del servidor firma leases de hasta 24 horas y órdenes de
control. El agente fija su clave pública durante la aprobación y valida cada
lease antes de abrir datos locales. DPAPI `CurrentUser` protege perfil,
inventario, snapshots, recibos y outbox. Un reinicio cambia la identidad de
arranque y exige conexión antes de volver a desbloquear el caché.

El enrolamiento no pide al usuario configurar BitLocker ni Windows Hello. El
agente consulta ambos estados silenciosamente y envía únicamente el resultado
normalizado (`enabled`/`disabled`/`unknown` y
`configured`/`not_configured`/`unknown`), nunca la salida cruda de PowerShell.
Una postura incompleta o desconocida no bloquea la solicitud: queda visible en
Administración y exige que el superadmin reconozca explícitamente el riesgo
antes de aprobar la terminal.

La aplicación Electron expone únicamente estos comandos estrechos:

```text
bootstrap-status
prepare-enrollment --server https://clarin.example
complete-enrollment --server https://clarin.example
local-accounts
local-state --account <uuid>
enqueue --account <uuid>
sync --account <uuid>
```

`enqueue` comprueba lease, selección, módulo, acciones firmadas, dependencias,
límite de 1 MiB, máximo de 1.000 cambios pendientes y cuota de 5 GiB. Cada sync
envía como máximo 100 operaciones y retira snapshots ausentes del inventario
canónico.

Verificación desde Linux:

```sh
GOCACHE=/tmp/go-build-agent go test ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/clarin-offline-agent
```
