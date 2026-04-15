# Especificación de Feature: Participantes de Programa Solo Contactos

**Rama**: `001-program-contacts-only`
**Creado**: 2026-04-14
**Estado**: Borrador
**Input**: "En la sección de programas, cuando se añaden participantes, solo se deben poder añadir contactos (no leads), porque esto es posterior a la venta."

## Escenarios de Usuario y Testing *(obligatorio)*

### Historia de Usuario 1 - Añadir participantes solo desde contactos (Prioridad: P1)

Como administrador del programa, cuando abro la ventana "Agregar Participantes" en un programa, solo debo poder buscar y seleccionar contactos de WhatsApp. No debo ver leads en la lista de resultados porque un programa es una actividad post-venta y los participantes deben ser personas con las que ya tengo comunicación directa por WhatsApp.

**Por qué esta prioridad**: Es el cambio central de la feature. Sin esto, el resto no tiene sentido.

**Test independiente**: Se puede verificar abriendo cualquier programa → clic en "Agregar Participantes" → confirmar que la búsqueda solo devuelve contactos, nunca leads.

**Escenarios de Aceptación**:

1. **Dado** que estoy en la página de detalle de un programa, **Cuando** abro la ventana "Agregar Participantes" y busco un nombre, **Entonces** solo aparecen resultados de la tabla de contactos (personas con JID de WhatsApp).
2. **Dado** que existe un lead llamado "Juan Pérez" que NO tiene un contacto vinculado, **Cuando** busco "Juan Pérez" en la ventana de añadir participantes, **Entonces** NO aparece en los resultados.
3. **Dado** que existe un contacto llamado "María López" con JID de WhatsApp, **Cuando** busco "María López", **Entonces** aparece en los resultados y puedo seleccionarla.

---

### Historia de Usuario 2 - Eliminación del filtro de tipo de fuente (Prioridad: P2)

Como administrador del programa, ya no debo ver el filtro "Todos / Contactos / Leads" en la ventana de selección de participantes del programa, porque solo existe un tipo posible (contactos). El filtro no aporta valor y genera confusión.

**Por qué esta prioridad**: Mejora la claridad de la interfaz al eliminar una opción que ya no aplica en este contexto.

**Test independiente**: Abrir la ventana de añadir participantes → confirmar que no hay selector de tipo de fuente visible.

**Escenarios de Aceptación**:

1. **Dado** que estoy en la ventana "Agregar Participantes" de un programa, **Cuando** reviso los filtros disponibles, **Entonces** NO existe un selector de tipo de fuente (contact/lead/all).
2. **Dado** que el componente `ContactSelector` se usa en OTROS contextos del sistema (campañas, eventos), **Cuando** se usa fuera de programas, **Entonces** el filtro de tipo sigue disponible si el contexto lo requiere.

---

### Historia de Usuario 3 - Validación del backend (Prioridad: P2)

Como sistema, cuando recibo una solicitud para añadir un participante a un programa, debo rechazar solicitudes que envíen solo un `lead_id` sin `contact_id`. El backend debe ser la última línea de defensa independientemente de lo que haga el frontend.

**Por qué esta prioridad**: Seguridad y consistencia de datos. El frontend puede ser manipulado.

**Test independiente**: Enviar petición POST directa al endpoint con solo `lead_id` y sin `contact_id` → confirmar error 400.

**Escenarios de Aceptación**:

1. **Dado** que envío `POST /api/programs/:id/participants` con `{"lead_id": "xxx", "contact_id": null}`, **Cuando** el backend procesa la solicitud, **Entonces** responde con HTTP 400 y un mensaje indicando que `contact_id` es obligatorio.
2. **Dado** que envío `POST /api/programs/:id/participants` con `{"contact_id": "xxx-valid-uuid"}`, **Cuando** el backend procesa la solicitud, **Entonces** el participante se crea correctamente sin necesidad de resolver leads.

---

### Casos Borde

- ¿Qué pasa si un contacto ya fue añadido al programa? → El constraint UNIQUE(program_id, contact_id) ya maneja esto — el sistema actualiza el estado en vez de duplicar.
- ¿Qué pasa con los participantes existentes que fueron añadidos como leads? → Se mantienen intactos. El campo `lead_id` en registros existentes no se elimina. Solo se cambia el flujo de adición futura.
- ¿Qué pasa si no hay contactos en la cuenta? → La ventana muestra la lista vacía con un mensaje apropiado (comportamiento actual del componente).

## Requerimientos *(obligatorio)*

### Requerimientos Funcionales

- **RF-001**: La ventana de "Agregar Participantes" en programas DEBE buscar exclusivamente en la tabla de contactos, no en leads.
- **RF-002**: El filtro de tipo de fuente (all/contact/lead) DEBE estar oculto cuando el selector se usa en el contexto de programas.
- **RF-003**: El backend DEBE rechazar con HTTP 400 cualquier solicitud de añadir participante que no incluya un `contact_id` válido.
- **RF-004**: El backend DEBE eliminar la lógica de resolución de leads (buscar contacto por teléfono o crear contacto desde lead) del endpoint de participantes de programa.
- **RF-005**: El componente `ContactSelector` DEBE seguir funcionando normalmente en otros contextos donde se necesite buscar leads y contactos (campañas, eventos, etc.).
- **RF-006**: Los participantes existentes en programas que fueron añadidos previamente mediante leads NO DEBEN verse afectados por este cambio.

### Entidades Clave

- **Contact**: Persona con JID de WhatsApp registrada en el sistema. Tiene nombre, teléfono y un identificador de dispositivo WhatsApp. Es la entidad canónica para participantes de programa.
- **ProgramParticipant**: Registro que vincula un contacto con un programa. Tiene `contact_id` (obligatorio) y `lead_id` (opcional, para referencia histórica).
- **Lead**: Prospecto comercial. NO debe ser seleccionable para agregar a programas directamente.

## Criterios de Éxito *(obligatorio)*

### Resultados Medibles

- **CE-001**: Los usuarios al abrir "Agregar Participantes" en un programa ven solo contactos en los resultados, en el 100% de los casos.
- **CE-002**: El tiempo de búsqueda de participantes se mantiene igual o mejora (la query es más simple al eliminar el UNION con leads).
- **CE-003**: Ningún endpoint permite insertar un participante de programa sin un `contact_id` válido.
- **CE-004**: El componente `ContactSelector` sigue funcionando sin cambios en campañas y otros contextos que lo usen.

## Supuestos

- El componente `ContactSelector` se reutiliza en múltiples contextos y debe mantenerse genérico. El cambio se implementa via props o parámetros, no modificando su comportamiento por defecto.
- La columna `lead_id` en `program_participants` se mantiene en la base de datos para compatibilidad con datos históricos. No se elimina.
- No se requiere migración de datos. Los participantes añadidos previamente vía leads ya tienen un `contact_id` resuelto en la base de datos.
- La búsqueda de contactos usa el endpoint `/api/people/search` existente, filtrado por tipo `contact`.
