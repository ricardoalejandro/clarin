# Correcciones tras la revisión del chat

Seguimiento del PR #9, ya integrado. Este cambio se mantiene en un PR separado para poder revertir únicamente las observaciones de esta revisión.

## Observaciones incorporadas

1. Quitar la leyenda repetida «Leído · pendiente» de las filas. También se retira «Pendiente de atención». El contador de no leídos y el filtro Pendientes conservan su comportamiento; no se cambian los estados guardados.
2. Mantener tamaño y fondo de las etiquetas, eligiendo blanco o slate según el contraste entre los colores realmente renderizados. El índigo usa blanco. El icono de quitar hereda el mismo color.
3. y 7. El adjunto roto antes de enviarlo y su recuperación después de recargar corresponden a una causa reproducida: el acceso online navegaba dentro del documento de login, cuya CSP bloquea imágenes `blob:`. El acceso online ahora solicita un documento nuevo. No se amplía la política de seguridad.
4. La imagen mantiene una URL local propia durante la subida. Si se abre el visor mientras se envía, éste adopta la URL canónica al llegar la confirmación HTTP o WebSocket, antes de liberar el recurso local.
5. y 6. La foto local del contacto usa el mismo tipo de recurso bloqueado por la CSP heredada. Se conserva el editor y su diseño; el acceso online corregido resuelve ese bloqueo común. Los errores reales de formato o archivo siguen siendo visibles.

La entrada offline conserva la navegación cliente que mantiene desbloqueado su SharedWorker. La transición explícita hacia online debe completarse antes de renovar el documento. La allowlist de destinos posteriores al login no cambia.

No hay migraciones, cambios de datos, eliminación de archivos ni alteración del fondo de WhatsApp. No se envían mensajes reales para las pruebas.

## Verificación y reversión

El PR recoge los comandos y resultados finales de las pruebas unitarias, TypeScript, compilación y navegador. Las pruebas de navegador utilizan archivos y APIs de prueba, con subida demorada para comprobar la imagen durante el envío.

Base previa: `517b77a6f54e34a1ddbb174b693ddaf7b63f9f52`.

Antes del despliegue se conservan las cinco imágenes de los servicios en `/root/clarin-rollbacks/chat-review-20261011/`, con manifiesto de IDs, override de Compose y `rollback.sh`. Para restaurarlas:

```sh
ssh vps /root/clarin-rollbacks/chat-review-20261011/rollback.sh
```

El rollback no restaura PostgreSQL ni borra los mensajes posteriores. Comprobar contenedores, salud, logs y versión después de ejecutarlo. Para alinear el código, crear un PR que revierta el commit de este seguimiento y ejecutar `make deploy` desde `/root/proyect/clarin`. La reversión completa del PR #9 continúa documentada por separado.
