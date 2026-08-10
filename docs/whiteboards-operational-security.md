# Límites operativos de Pizarras

## Intercambio de enlaces públicos

`POST /api/public/whiteboard-links/:id/session` recibe sólo el nombre visible,
la contraseña opcional y el secreto del enlace. El cuerpo máximo es **16 KiB**.

La protección existe en dos capas:

1. El router Traefik `clarin-whiteboard-guest-session`, de prioridad 250, aplica
   `buffering.maxRequestBodyBytes=16384` antes de enviar la petición al backend.
2. `guardWhiteboardGuestSessionExchange` comprueba `Content-Length`, el cuerpo
   real y los límites por IP/enlace antes de ejecutar `BodyParser`.

No se debe quitar el límite del proxy. Fiber conserva un límite global de 52 MiB
porque otros módulos cargan ficheros grandes y fasthttp puede materializar el
cuerpo antes de ejecutar el middleware de una ruta. Si se sustituye Traefik por
Nginx u otro proxy, se debe replicar un límite exacto para esta ruta (por ejemplo,
en Nginx: `client_max_body_size 16k`) y verificar un `413` desde el exterior.

## Tickets de colaboración y registros de acceso

El ticket de `/ws/whiteboards/:id` dura poco, se usa una sola vez y viaja en la
query del handshake WebSocket. El access log de Fiber usa `${path}` y no
`${url}` ni `${queryParams}`; una prueba del backend garantiza que el ticket y
la query no aparecen en ese registro.

En el despliegue actual de Dokploy, Traefik no tiene `accessLog` habilitado. Por
tanto, hoy el proxy tampoco registra la query, pero esto es **ausencia de log**,
no redacción. Antes de habilitar access logs en Traefik o cambiar de proxy se
debe configurar el formato para omitir por completo la query (o cambiar el
transporte del ticket), comprobarlo con un ticket señuelo y documentar la
retención. No basta con confiar en que el ticket caduque: un handshake fallido
puede dejarlo válido durante su ventana breve.

## Escenas y colaboración

- Escena canónica REST: máximo 16 MiB.
- Mensaje realtime/fanout: máximo 1 MiB.
- `scene.snapshot` o ACK canónico: máximo seguro 900.000 bytes, dejando espacio
  al sobre Redis y a los metadatos.
- Una escena mayor sigue siendo válida por REST. El backend emite
  `sync.required` y el cliente recarga la escena mediante su endpoint autorizado.
- Los `PUT` completos de invitados y el fallback REST `PATCH` se limitan antes
  de `BodyParser`, por sesión, IP y enlace. El `PATCH` usa presupuestos
  decrecientes por tamaño: 60 solicitudes/minuto hasta 1 MiB, 20 entre 1 y
  4 MiB, y 6 por encima de 4 MiB por sesión.
- Tras autenticar la sesión, la persistencia completa también se limita por
  pizarra y cuenta antes de comprimir, bloquear PostgreSQL o escribir en MinIO.

## Bibliotecas y recursos

El listado de bibliotecas no devuelve `library_json`; entrega resumen, número de
elementos y tamaño. El JSON (máximo 8 MiB) se obtiene sólo desde el detalle
autorizado. Las descripciones tienen un máximo de 1.000 caracteres Unicode.

Los listados de recursos son cursor-paged (`50` por defecto, `200` máximo). Para
hidratar un editor se usa `referenced_only=1`; los identificadores se derivan en
el repositorio desde la escena o biblioteca canónica de la misma cuenta. Nunca
se aceptan IDs de fichero del cliente como prueba de autorización.
