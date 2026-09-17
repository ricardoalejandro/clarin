# Clarín offline en la web

Este documento describe el flujo v4. El estado real de aceptación y despliegue se registra en `offline-v4-checkpoint.md`; tener este documento no significa que el despliegue haya terminado.

## Recibir la actualización

Si aparece «Hay una actualización de Clarin pendiente», guardar el trabajo, cerrar **todas** las pestañas de Clarín y volver a abrirlo con conexión. Después, reintentar la preparación. Recargar una sola pestaña no garantiza activar una actualización que está esperando. No instalar nada ni borrar caché o IndexedDB: esa limpieza puede eliminar cambios pendientes.

## Uso cotidiano

1. Con conexión, entrar a Clarín en el navegador habitual y abrir **Configuración → Offline → Solicitar acceso offline**. No instalar programas, extensiones, servicios ni certificados.
2. El superadmin revisa la solicitud en **Administración → Offline** y autoriza expresamente las cuentas y operaciones de ese usuario en ese perfil de navegador. La autorización no amplía los permisos normales del usuario.
3. El usuario elige los recursos que necesita, confirma su contraseña actual de Clarín y pulsa **Preparar acceso offline**. Esperar el mensaje de copia verificada antes de desconectarse. La contraseña necesita al menos 12 caracteres; no se solicita una contraseña diferente para offline.
4. Si Clarín o la protección de acceso dejan de responder, elegir **Seguir sin conexión** o **Esperar**. También se puede usar **Entrar en modo offline** desde Configuración. Los borradores online no guardados no se trasladan automáticamente.
5. Después de cerrar y volver a abrir el navegador, visitar la misma dirección de Clarín y desbloquear la copia con el usuario y contraseña. Si ese usuario tiene varias cuentas preparadas, elegir una después de identificarse.
6. Al restablecerse el acceso, la sesión conserva su usuario, cuenta y modo offline. Mientras la web permanece abierta y desbloqueada, sincroniza los cambios de esa identidad. El indicador muestra modo, pendientes y estado; también hay un botón **Sincronizar**.
7. Para cambiar de identidad, usar **Bloquear / cambiar usuario o cuenta**. Volver al modo online es una acción explícita y requiere autenticación online; una autorización offline nunca genera por sí sola una sesión del servidor.

## Qué queda disponible

- Tareas: consultar, crear y completar, según permisos del superadmin y del recurso.
- Contactos, programas y pizarras: consulta de los recursos preparados, sin edición offline.
- Otros módulos, recursos no seleccionados y cuentas no autorizadas no se descargan.
- No hay sincronización con el navegador cerrado. Si se borra el almacenamiento del sitio, se puede perder la copia y cualquier cambio pendiente; no usar esa limpieza para intentar resolver un error de sincronización.

## Seguridad y límites

La autorización distingue origen, perfil de navegador, usuario, cuenta y grant. Otro perfil, otro navegador o un navegador recién instalado necesita su propia autorización. Una web sin componente nativo no puede acreditar que dos perfiles pertenecen al mismo hardware físico.

La caché compartida guarda solamente la interfaz pública. Los datos, claves privadas de sincronización y operaciones pendientes quedan cifrados en IndexedDB, separados por autorización mediante claves aleatorias AES-256-GCM y contexto autenticado. La contraseña, su hash del servidor y los tokens de sesión no se guardan en esa copia. La contraseña protege la clave local con PBKDF2-HMAC-SHA256, 600.000 iteraciones y sal aleatoria de 32 bytes.

Cerrar la sesión local o cambiar la identidad online bloquea el acceso; 30 minutos de inactividad también lo bloquean. El cifrado protege datos bloqueados en reposo: no pretende proteger una sesión ya desbloqueada contra malware, extensiones invasivas o acceso al mismo sistema operativo. Mantener el equipo y el navegador protegidos sigue siendo necesario.

La autorización offline dura hasta 24 horas desde la última firma válida. Una revocación remota no puede llegar a un navegador realmente desconectado: se aplica al volver a contactar con Clarín o al vencer el plazo local. Cambiar contraseña o permisos puede exigir nueva autorización y preparación; los pendientes cifrados no se borran automáticamente por un fallo de red, Cloudflare o una respuesta desconocida.

Hasta 20 recursos por autorización, 5 GiB en conjunto por perfil sujeto a la cuota real del navegador, 8 MiB/5.000 filas por snapshot y 1.000 operaciones pendientes. Los excesos se rechazan expresamente sin truncar ni borrar pendientes. Si el navegador no concede almacenamiento persistente, la copia queda limitada a lectura: no se promete durabilidad de escrituras que el navegador podría desalojar.

Clarín solicita la persistencia automáticamente al preparar y vuelve a comprobarla al usar la copia. No requiere configurar Windows. Si el navegador deja de concederla, muestra una advertencia, conserva los pendientes cifrados y bloquea nuevas creaciones/completados offline; no presenta ese estado como una copia apta para nuevas escrituras durables.

## Operación del servidor

`OFFLINE_V4_ENABLED` y `OFFLINE_V4_TASK_WRITES_ENABLED` controlan v4 de forma independiente del flujo Windows histórico. Activar las variables no aprueba usuarios ni cuentas automáticamente. No convertir autorizaciones nativas antiguas en autorizaciones del navegador.

Antes de desplegar, respaldar PostgreSQL y las claves del firmante con `scripts/offline/browser-release-backup.mjs`. Desplegar exclusivamente con `make deploy`; nunca publicar la imagen QA, compilada para localhost. Verificar contenedores, salud, logs, `/api/version`, `/api/offline/v4/runtime/availability`, rechazo sin sesión y las nueve tablas `offline_v4_*` en PostgreSQL real.

En este VPS, Traefik v2.11 usa Swarm/file provider y no consume las etiquetas de los contenedores Compose. `make deploy` instala atómicamente el fragmento propio `infra/offline/traefik-browser-v4.yml` en el directorio dinámico de Dokploy, sin sobrescribir otras rutas. La regla emplea [la sintaxis oficial de v2.11](https://doc.traefik.io/traefik/v2.11/routing/routers/#rule). Verificar en el proxy real estado habilitado y rechazo HTTP 413 de cuerpos mayores de 2 MiB, incluidas variantes de mayúsculas. El backend también rechaza exceso de tamaño y cuerpos comprimidos antes del parsing; el límite global de otros uploads no se cambia.

Para pausar v4, desactivar ambas variables y volver a desplegar. Conservar esquema, claves, recibos y pendientes. Apagar el servidor no borra una copia desconectada ni acorta retroactivamente su autorización firmada.
