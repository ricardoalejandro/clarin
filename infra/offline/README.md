# Infraestructura offline de Clarin

`make offline-installer` genera el **candidato v3**, no una aplicación Electron
ni una publicación automática. Incluye un servicio Windows y el helper que
vincula inicialmente el navegador al usuario Windows. La interfaz sigue en la
URL habitual de Clarín.

Los artefactos quedan exclusivamente en `.runtime/offline/v3-candidate/`:

- `Clarin-Offline-Setup.exe` y SHA-256 de sus bytes exactos.
- `release-manifest.json`, con hashes de los dos ejecutables Windows x64.
- `windows-qa-template.json`, con todas las pruebas Windows en `not_run`.
- `Test-OfflineV3.ps1`, diagnóstico acotado de sólo lectura.

Requiere Go, Docker y acceso al repositorio de paquetes durante la construcción
del compilador NSIS. La compilación del instalador corre después sin red. El
piloto no requiere Vault, PKI ni certificados comerciales. La descarga debe
mantener HTTPS y verificación de hash; un hash no sustituye Authenticode ni
garantiza que SmartScreen o una política corporativa permita ejecutar el EXE.

## Instalación Windows y límites

El instalador requiere UAC, Windows 11 x64 y crea `ClarinOfflineV3` bajo
`NT AUTHORITY\LocalService`, con SID de servicio y DACL privada en
`%ProgramData%\Clarin\Offline\v3`. Usuarios ordinarios sólo pueden ejecutar los
binarios en Program Files; no modificar el servicio ni leer directamente el
almacén. El helper usa el protocolo `clarin-offline-v3://principal`.

La actualización detiene el servicio antes de reemplazar los binarios. No borra
ni migra la cola desde el instalador. Si falla la configuración/arranque, la
instalación se declara fallida; no presenta la copia como preparada. La
desinstalación conserva los datos cifrados y operaciones pendientes; una purga
es una operación administrativa separada y explícita.

La prueba del SID ocurre durante la vinculación inicial. Las peticiones web
posteriores prueban la clave del navegador, no vuelven a verificar un SID vivo.
La copia/restauración privilegiada de un perfil utilizable queda fuera de una
garantía de identidad física inviolable. No hay protección absoluta frente a
malware o un administrador local.

Después de instalar el candidato en una PC de pruebas, el diagnóstico se puede
ejecutar desde PowerShell de 64 bits, en su carpeta:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Test-OfflineV3.ps1
```

No modifica la política persistente, no instala componentes, no lee cookies ni
contraseñas, no reinicia Windows y no toca BitLocker/firewall. Genera una carpeta
`diagnostics-*` con estado del servicio, hashes y versiones; **no marca como
aprobadas las pruebas de los flujos en Chrome/Edge**. Éstas, incluido reinicio
real coordinado, aislamiento de 10 usuarios, revocación y actualización con
pendientes, requieren ejecutarse sobre Windows 11 antes de activar.

## Publicación y despliegue

`make deploy` no vuelve a compilar el instalador. Comprueba y congela sus bytes
por SHA-256 antes de reconstruir contenedores. `OFFLINE_V3_ENABLED=false` es el
valor por defecto; habilitar v3 exige evidencia real de todas las pruebas del
artefacto exacto en ambos navegadores. El reporte diagnóstico parcial no supera
ese control. Se conserva el artefacto v2 publicado hasta esa promoción explícita.
Las nuevas inscripciones Electron/v2 quedan apagadas por defecto, sin borrar
sus datos ni quitar endpoints de control/sincronización existentes.

El firmador permanece en la red interna Docker, con claves persistentes y token
de servicio sin publicarlo. V3 tiene claves de firma separadas de v2, leases de
hasta 72 horas y firma tipada de bootstrap, controles, snapshots y receipts.

Referencias: [SID de servicio](https://devblogs.microsoft.com/oldnewthing/20231004-00/?p=108849)
y [ejecución y elevación NSIS](https://nsis.sourceforge.io/Docs/Chapter4.html).
Compilar en Linux no verifica DPAPI, ACL, UAC ni permisos de red local del navegador.
