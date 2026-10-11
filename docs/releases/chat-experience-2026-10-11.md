# Chat y Contactos: experiencia y reversión

## Alcance

Base de producción: `8be01b0e5c66eda4f0fc355c25d05e4160ee468c`. Rama: `codex/chat-experience-android`.

- Leer hasta el final elimina No leído aun cuando el último entrante quedó fuera de los últimos 50 mensajes. La necesidad de respuesta es independiente de la lectura.
- La atención usa una frontera observada y conserva llegadas concurrentes. La unificación de identidades WhatsApp recalcula lectura/atención y conserva reacciones.
- Los archivos que el inventario ya declaró eliminados se presentan como no disponibles. La consulta se hace por lotes y cuenta; no borra ni modifica mensajes históricos.
- Escritorio, tablet y Android conservan el fondo y diseño general. Mejoran agrupación, legibilidad, escritura mientras un envío termina, reintentos idempotentes, visor, menú táctil, filtros y navegación Atrás.
- Detalles usa su ancho real, protege notas sin guardar, permite enfocar el chat y mejora etiquetas y acordeones. Contactos mantiene las páginas cargadas al reconciliar eventos y expone fallos de eliminación.

## Compatibilidad

No hay migraciones de esquema ni reparación masiva de datos. Los campos nuevos de API son aditivos. Las lecturas/atenciones realizadas después del despliegue son actividad normal de la cuenta y se conservan al revertir. La operación de reversión no restaura PostgreSQL, no elimina archivos y no borra mensajes recibidos después del despliegue.

## Reversión preparada

Antes del despliegue se verificó que producción estaba limpia en el commit base y se etiquetaron las cinco imágenes en ejecución. Respaldo privado del operador:

`/root/clarin-rollbacks/chat-experience-20261011/`

Contiene `manifest.json` (IDs exactos), `images.yml` (override de Compose) y `rollback.sh` (usa imágenes conservadas, sin build ni pull).

Si se solicita volver a la versión anterior:

```sh
ssh vps /root/clarin-rollbacks/chat-experience-20261011/rollback.sh
ssh vps docker ps --filter name=clarin
ssh vps docker exec clarin-backend wget -qO- http://127.0.0.1:8080/health
ssh vps docker logs --tail=80 clarin-backend
ssh vps docker logs --tail=60 clarin-frontend
```

Verificar además `/api/version`. Para alinear el código, revertir el commit de este PR mediante un PR de reversión y el flujo normal `make deploy`. No usar reset sobre trabajo ajeno ni restaurar una base de datos antigua. Conservar las imágenes etiquetadas hasta que el usuario dé por aceptada la experiencia.

## Verificación

Backend: `GOCACHE=/tmp/go-build GOMAXPROCS=2 go test ./...` completado en Linux. `TestChatAttentionIntegration` y `TestChatExperienceIntegration` pasaron contra PostgreSQL efímero aislado, retirado al terminar. Cubren lectura con una cola de salientes, fronteras de atención concurrentes, unificación LID/PN, reacciones y proyección de medios eliminados por cuenta.

Las pruebas del proveedor no envían mensajes a contactos reales. La evaluación de Android usa Chromium con viewport/touch y APIs sintéticas; no equivale a probar un teléfono físico con su teclado.

Navegador: pase completo en 375, 768 y 1440 px, sin desbordamiento horizontal ni errores JavaScript. El final queda a 0 px después de cargar imágenes y mostrar errores de audio; redimensionar mientras se lee el historial conserva la posición. Verificados compositor con teclado simulado, lectura independiente de Pendiente, visor y navegación Atrás, Detalles, selector de dispositivos y ausencia de solicitudes para videos ya eliminados. Las acciones de escritorio se revelan al pasar el puntero o recibir foco para evitar cubrir texto en reposo; en táctil conservan su control exterior visible.

Reversión: revisión independiente de los cinco IDs de imagen contra sus etiquetas y `sh -n rollback.sh` aprobadas. No se ejecutó el rollback.

La advertencia amarilla de preload de la captura no identifica el recurso exacto. Los 404 de medios eliminados tienen una causa confirmada y se corrigen; no se atribuye a esa advertencia un fallo de chat sin evidencia.
