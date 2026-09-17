# Clarin para Windows (modo offline)

La aplicación consulta primero el estado local del agente. Una instalación
nueva abre Clarin en línea para que el usuario solicite acceso desde su propia
sesión. El agente genera una clave ECDSA P-256 en Windows CNG o, si el proveedor
no está disponible, dentro del perfil cifrado con DPAPI `CurrentUser`, y
solo entrega su clave pública al backend. No hay IDs, códigos ni certificados
que el usuario tenga que copiar.

Un superadmin aprueba las cuentas y módulos. Tras la aprobación, la aplicación
demuestra que conserva la clave privada, recibe la clave pública del firmador
de leases y sincroniza. Si dos comprobaciones consecutivas detectan la caída
del servidor, la misma ventana cambia a la vista local; al volver la conexión,
sincroniza cada minuto sin cerrar Clarin.

Los perfiles, snapshots, recibos y cambios pendientes se protegen con DPAPI
`CurrentUser`. Cada lectura local valida cuenta, lease firmado y arranque de
Windows. Reiniciar el equipo bloquea el caché hasta una sincronización online.

`make offline-installer` crea el EXE x64 sin Authenticode. Para este piloto se
acepta el aviso de editor desconocido de Windows. El servidor y el navegador
verifican SHA-256 y el archivo se entrega solo por la sesión HTTPS de Clarin.
