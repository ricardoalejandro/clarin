# Feature Specification: Corregir Eliminación/Edición de Programas y Filtros Avanzados de Participantes

**Feature Branch**: `003-programs-fix-filters`
**Created**: 2026-04-15
**Status**: Draft
**Input**: Corrección de funcionalidades rotas en la página de detalle de programa (eliminar, editar) y mejora del selector de participantes para incluir los mismos filtros avanzados que la página de Contactos.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Eliminar Programa desde Menú de Tres Puntos (Priority: P1)

El usuario abre un programa, hace clic en el menú de tres puntos (⋮), selecciona "Eliminar Programa", confirma la acción, y el programa se elimina correctamente. Actualmente al hacer clic en "Eliminar" no sucede nada visible — no hay feedback ni acción.

**Why this priority**: Es la funcionalidad más crítica rota. Sin poder eliminar programas, el usuario acumula datos obsoletos que no puede gestionar.

**Independent Test**: Abrir cualquier programa → clic en ⋮ → "Eliminar Programa" → confirmar → el sistema redirige a /dashboard/programs y el programa ya no aparece en la lista.

**Acceptance Scenarios**:

1. **Given** el usuario está en la página de detalle de un programa, **When** hace clic en ⋮ → "Eliminar Programa", **Then** aparece un diálogo de confirmación claro (no el `confirm()` nativo del navegador).
2. **Given** el diálogo de confirmación está abierto, **When** el usuario confirma la eliminación, **Then** el programa se elimina, aparece un mensaje de éxito, y el usuario es redirigido a /dashboard/programs.
3. **Given** el diálogo de confirmación está abierto, **When** el usuario cancela, **Then** el diálogo se cierra y nada cambia.
4. **Given** la API devuelve un error al intentar eliminar, **When** el usuario confirma, **Then** aparece un mensaje de error visible (no solo en consola).

---

### User Story 2 — Editar Programa desde Botón Lápiz (Priority: P1)

El usuario hace clic en el botón de lápiz (✏️) para editar un programa, se abre un modal con los datos actuales, modifica campos (nombre, descripción, color, estado), guarda, y los cambios se reflejan inmediatamente. Actualmente al intentar editar no funciona correctamente.

**Why this priority**: Igual que eliminar, es una funcionalidad básica de CRUD que está rota y bloquea la gestión diaria.

**Independent Test**: Abrir programa → clic en ✏️ → cambiar nombre → guardar → el nombre actualizado aparece en el encabezado de la página sin recargar.

**Acceptance Scenarios**:

1. **Given** el usuario está en la página de detalle de un programa, **When** hace clic en el botón ✏️, **Then** se abre un modal de edición con los datos actuales del programa precargados.
2. **Given** el modal de edición está abierto, **When** el usuario modifica el nombre y hace clic en "Guardar", **Then** los cambios se persisten y se reflejan inmediatamente en la página.
3. **Given** el modal de edición está abierto, **When** el usuario hace clic en "Cancelar" o fuera del modal, **Then** se cierra sin guardar cambios.
4. **Given** la API devuelve un error al guardar, **When** el usuario intenta guardar, **Then** aparece un mensaje de error visible y el modal permanece abierto para reintentar.

---

### User Story 3 — Filtros Avanzados al Agregar Participantes (Priority: P2)

Cuando el usuario hace clic en "Agregar Participantes" en un programa, la ventana de selección de contactos debe ofrecer los mismos filtros avanzados que la página de Contactos: etiquetas con include/exclude, modo AND/OR, editor de fórmulas avanzado, filtro por fecha, y filtro por dispositivo. Actualmente solo tiene checkboxes simples de tags y filtro de teléfono.

**Why this priority**: Es una mejora de productividad. Los programas pueden tener cientos de contactos potenciales, y sin filtros avanzados el usuario tiene que buscar uno por uno.

**Independent Test**: Abrir programa → "Agregar Participantes" → la ventana muestra un panel de filtros con 2 columnas (dispositivo + fecha a la izquierda, tags con include/exclude + fórmula a la derecha) → los filtros reducen los resultados mostrados → seleccionar contactos → confirmar.

**Acceptance Scenarios**:

1. **Given** la ventana de agregar participantes está abierta, **When** el usuario abre los filtros, **Then** ve un panel de 2 columnas con: filtro de dispositivo, filtro de fecha (9 presets + rango personalizado), y filtro de etiquetas con include/exclude.
2. **Given** los filtros están visibles, **When** el usuario hace clic en una etiqueta una vez, **Then** se marca como "incluida" (verde). Un segundo clic la marca como "excluida" (rojo). Un tercer clic la desmarca.
3. **Given** los filtros están visibles, **When** el usuario activa el toggle AND/OR, **Then** los resultados cambian según la lógica seleccionada (AND = tiene todas las etiquetas, OR = tiene alguna).
4. **Given** los filtros están visibles, **When** el usuario cambia al modo "Avanzado", **Then** aparece el editor de fórmulas con sintaxis `"tag" and "tag2" or not "tag3"` y autocompletado de etiquetas.
5. **Given** los filtros están aplicados, **When** el usuario selecciona contactos y confirma, **Then** los contactos se agregan como participantes del programa.
6. **Given** la ventana se usa en otros contextos (campañas, eventos), **When** no se pasa la prop de filtro avanzado, **Then** el comportamiento actual se mantiene sin cambios (retrocompatibilidad).

---

### User Story 4 — Feedback Visual en Todas las Operaciones (Priority: P2)

Todas las operaciones de la página de programa (eliminar, editar, archivar, eliminar participante, eliminar sesión, editar sesión) deben mostrar feedback visual al usuario: mensaje de éxito cuando funciona, mensaje de error cuando falla. Actualmente los errores solo aparecen en la consola del navegador.

**Why this priority**: Sin feedback, el usuario no sabe si su acción tuvo efecto. Esto causa confusión, acciones repetidas, y la percepción de que "nada funciona".

**Independent Test**: Realizar cualquier operación (editar, eliminar, archivar) → siempre aparece una notificación toast indicando éxito o error.

**Acceptance Scenarios**:

1. **Given** el usuario realiza cualquier operación exitosa (eliminar, editar, archivar), **When** la API confirma, **Then** aparece un toast verde con mensaje descriptivo (ej: "Programa actualizado", "Participante eliminado").
2. **Given** la API devuelve un error en cualquier operación, **When** el error ocurre, **Then** aparece un toast rojo con mensaje descriptivo (ej: "Error al eliminar programa").
3. **Given** una operación destructiva (eliminar programa, eliminar participante, eliminar sesión), **When** el usuario inicia la acción, **Then** se muestra un modal de confirmación personalizado (no el `confirm()` nativo del navegador).

---

### Edge Cases

- ¿Qué pasa si el usuario intenta eliminar un programa que tiene participantes y sesiones con asistencia? → El sistema debe eliminar en cascada (ya configurado en backend SQL).
- ¿Qué pasa si dos usuarios editan el mismo programa simultáneamente? → El último en guardar gana (no se requiere bloqueo optimista para esta versión).
- ¿Qué pasa si el selector de participantes no encuentra contactos con los filtros aplicados? → Mostrar estado vacío con mensaje "No se encontraron contactos con estos filtros".
- ¿Qué pasa si la sesión del usuario expira mientras edita? → El sistema de refresh automático de JWT maneja esto transparentemente.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El sistema DEBE permitir eliminar un programa desde el menú de tres puntos, con confirmación previa y feedback visual.
- **FR-002**: El sistema DEBE permitir editar un programa (nombre, descripción, color, estado, horario) desde el botón de lápiz, mostrando un modal con datos precargados.
- **FR-003**: El selector de participantes DEBE incluir filtro de etiquetas con triple estado: incluir (verde), excluir (rojo), sin filtro.
- **FR-004**: El selector de participantes DEBE incluir toggle AND/OR para la lógica de combinación de etiquetas.
- **FR-005**: El selector de participantes DEBE incluir un modo "Avanzado" con el editor de fórmulas (sintaxis `"tag" and/or/not "tag"` con autocompletado).
- **FR-006**: El selector de participantes DEBE incluir filtro por rango de fechas con presets (hoy, ayer, últimos 7 días, este mes, etc.) y rango personalizado.
- **FR-007**: El selector de participantes DEBE incluir filtro por dispositivo WhatsApp.
- **FR-008**: El panel de filtros del selector DEBE mostrarse en layout de 2 columnas, consistente con la página de Contactos.
- **FR-009**: Todas las operaciones de la página (CRUD completo) DEBEN mostrar feedback visual: toast de éxito o error.
- **FR-010**: Las operaciones destructivas DEBEN usar un modal de confirmación personalizado en lugar del `confirm()` nativo del navegador.
- **FR-011**: Los cambios en el selector de participantes DEBEN ser retrocompatibles — otros usos del componente (campañas, eventos) mantienen su comportamiento actual.

### Key Entities

- **Program**: Programa educativo con nombre, descripción, color, estado, horario configurado.
- **ProgramParticipant**: Relación entre programa y contacto, con estado (active, completed, withdrawn).
- **Contact**: Contacto de WhatsApp con teléfono, nombre, etiquetas, dispositivo asociado.
- **Tag**: Etiqueta con nombre y color, usada para filtrar contactos.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El usuario puede eliminar un programa en menos de 5 segundos (2 clics: menú + confirmar) y recibe confirmación visual inmediata.
- **SC-002**: El usuario puede editar cualquier campo de un programa y ver los cambios reflejados sin recargar la página.
- **SC-003**: El selector de participantes permite filtrar contactos usando al menos 5 criterios simultáneos (texto, etiquetas include/exclude, modo AND/OR, fecha, dispositivo).
- **SC-004**: El 100% de las operaciones de la página muestran feedback visual al usuario (nunca errores silenciosos en consola).

## Assumptions

- Los endpoints backend de DELETE y PUT para programas ya existen y funcionan correctamente (verificado).
- El componente FormulaEditor ya existe y puede reutilizarse sin modificaciones.
- El componente NotificationProvider (toasts) ya existe en la aplicación.
- Los filtros avanzados se añaden al componente ContactSelector de forma retrocompatible (prop opcional).
- El endpoint `/api/people/search` puede necesitar parámetros adicionales para soportar los nuevos filtros, o se puede cambiar a `/api/contacts` cuando sourceFilter="contact".
- No se requieren cambios en el esquema de base de datos.
