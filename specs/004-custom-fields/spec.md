# Especificación de Funcionalidad: Campos Personalizados

**Rama**: `004-custom-fields`
**Creado**: 2026-03-19
**Estado**: Borrador
**Entrada**: Descripción del usuario: "Implementar sistema de campos personalizados para Clarin CRM, inspirado en ClickUp. Los administradores definen campos a nivel de cuenta. Los valores se almacenan por contacto (entidad principal). Incluye 5 fases: backend, config admin, renderizado en panel, columnas en tablas, y filtrado."

## Escenarios de Usuario y Pruebas *(obligatorio)*

### Historia de Usuario 1 — Configuración de Campos Personalizados por el Administrador (Prioridad: P1)

Un administrador de cuenta necesita definir campos personalizados que capturen información específica de su negocio. Desde la página de Configuración, puede crear, editar, reordenar y eliminar definiciones de campos. Cada campo tiene un nombre, un tipo (texto, número, fecha, selección, selección múltiple, casilla, email, teléfono, URL, moneda), y configuración opcional según el tipo (por ejemplo, opciones para campos de selección, símbolo de moneda, etc.). Los campos definidos aplican a todos los contactos de la cuenta.

**Por qué esta prioridad**: Sin la capacidad de definir campos, ninguna otra funcionalidad del sistema funciona. Es el cimiento sobre el cual se construye todo lo demás.

**Prueba independiente**: Se puede probar completamente creando, editando, reordenando y eliminando campos desde la interfaz de Configuración, y verificando que las definiciones persisten correctamente.

**Escenarios de Aceptación**:

1. **Dado** que soy un administrador en la página de Configuración, **Cuando** hago clic en "Nuevo Campo" y completo nombre="Ciudad de Origen", tipo="Texto", **Entonces** el campo aparece en la lista de campos personalizados con su tipo y orden correcto.
2. **Dado** que existe un campo "Ciudad de Origen" de tipo Texto, **Cuando** edito su nombre a "Ciudad Natal", **Entonces** el cambio se refleja inmediatamente en la lista y en todos los lugares donde se muestra.
3. **Dado** que existen 5 campos personalizados, **Cuando** arrastro el campo #4 a la posición #2, **Entonces** el orden se actualiza y persiste tras recargar la página.
4. **Dado** que creo un campo de tipo "Selección" llamado "Nivel Educativo", **Cuando** agrego las opciones "Básico", "Intermedio", "Avanzado", **Entonces** las opciones se guardan y están disponibles al asignar valores.
5. **Dado** que intento crear un campo sin nombre, **Cuando** presiono "Guardar", **Entonces** el sistema muestra un mensaje de validación indicando que el nombre es obligatorio.
6. **Dado** que existe un campo personalizado con valores asignados a contactos, **Cuando** intento eliminarlo, **Entonces** el sistema muestra una confirmación advirtiendo que se perderán los valores asociados.

---

### Historia de Usuario 2 — Asignación de Valores en el Panel de Detalle (Prioridad: P2)

Un usuario del CRM abre el panel lateral de detalle de un lead/contacto y ve los campos personalizados definidos por el administrador, debajo de los campos estándar. Puede editar cada campo inline (clic para editar, guardar al perder foco o presionar Enter), con controles adecuados según el tipo de campo: texto libre, selector numérico, calendario para fechas, dropdown para selección, checkboxes para selección múltiple, interruptor para casillas, etc.

**Por qué esta prioridad**: Una vez definidos los campos, los usuarios necesitan poder asignar y ver valores. El panel de detalle es la interfaz principal de interacción con datos de un contacto.

**Prueba independiente**: Se puede probar abriendo un lead en el panel lateral, viendo los campos personalizados, editando valores de distintos tipos, y verificando que los cambios se guardan correctamente.

**Escenarios de Aceptación**:

1. **Dado** que existen 3 campos personalizados definidos y abro el panel de un lead, **Cuando** me desplazo a la sección de campos personalizados, **Entonces** veo los 3 campos con sus etiquetas, iconos según tipo, y valores actuales (o vacíos si no se han asignado).
2. **Dado** un campo de tipo "Fecha" llamado "Fecha de Inscripción", **Cuando** hago clic en él, **Entonces** aparece un selector de fecha y al seleccionar una fecha se guarda automáticamente.
3. **Dado** un campo de tipo "Selección" con opciones ["Básico", "Intermedio", "Avanzado"], **Cuando** hago clic en él, **Entonces** aparece un dropdown con las opciones disponibles y al seleccionar una se guarda.
4. **Dado** un campo de tipo "Moneda" con símbolo "S/.", **Cuando** ingreso "1500.50", **Entonces** se muestra formateado como "S/. 1,500.50".
5. **Dado** un campo marcado como obligatorio sin valor, **Cuando** veo el panel de detalle, **Entonces** el campo se resalta visualmente indicando que requiere un valor.
6. **Dado** que edito un campo de tipo "Email" con un valor inválido "abc", **Cuando** intento guardar, **Entonces** el sistema muestra un error de validación y no guarda el valor.
7. **Dado** que abro el panel de un lead que no tiene contacto asociado, **Cuando** me desplazo a la sección de campos personalizados, **Entonces** veo un aviso "Vincule un contacto para ver campos personalizados" en lugar de los campos.

---

### Historia de Usuario 3 — Visualización de Campos en Tablas de Contactos y Leads (Prioridad: P3)

Un usuario que navega las tablas de contactos o leads puede configurar qué campos personalizados aparecen como columnas adicionales. Las columnas se añaden dinámicamente a la tabla existente, mostrando los valores formateados según el tipo de campo. El usuario puede elegir qué columnas mostrar u ocultar.

**Por qué esta prioridad**: Ver datos personalizados en tablas permite comparación rápida entre múltiples registros sin abrir cada uno individualmente. Complementa la vista de detalle.

**Prueba independiente**: Se puede probar agregando columnas personalizadas en la tabla de contactos, verificando que los valores se muestran correctamente, y ocultando/mostrando columnas.

**Escenarios de Aceptación**:

1. **Dado** que existen campos personalizados definidos y estoy en la tabla de contactos, **Cuando** hago clic en un botón de "Configurar Columnas", **Entonces** veo una lista de campos personalizados disponibles para añadir como columnas.
2. **Dado** que activo la columna "Nivel Educativo" (tipo Selección), **Cuando** veo la tabla, **Entonces** la columna aparece con los valores formateados de cada contacto.
3. **Dado** que una columna de tipo "Moneda" está visible, **Cuando** veo la tabla, **Entonces** los valores se muestran formateados con símbolo de moneda y separadores.
4. **Dado** que tengo 3 columnas personalizadas activas, **Cuando** recargo la página, **Entonces** mis preferencias de columnas persisten.

---

### Historia de Usuario 4 — Filtrado por Campos Personalizados (Prioridad: P4)

Un usuario que filtra contactos o leads puede incluir campos personalizados como criterios de filtro. Los operadores de filtro son sensibles al tipo de campo: texto soporta "contiene/empieza con", número y moneda soportan "mayor que/menor que/entre", fecha soporta "antes/después/entre", selección soporta "es/no es", casilla soporta "es verdadero/es falso".

**Por qué esta prioridad**: El filtrado permite segmentar la base de datos usando los campos personalizados, lo cual es esencial para campañas, reportes y búsqueda avanzada. Depende de que las fases anteriores estén completas.

**Prueba independiente**: Se puede probar aplicando filtros de distintos tipos de campos personalizados en la lista de leads y verificando que los resultados coinciden con los criterios.

**Escenarios de Aceptación**:

1. **Dado** que existe un campo "Presupuesto" de tipo Moneda con valores asignados, **Cuando** aplico un filtro "Presupuesto > 5000", **Entonces** solo se muestran los leads/contactos con presupuesto mayor a 5000.
2. **Dado** que existe un campo "Nivel Educativo" de tipo Selección, **Cuando** aplico un filtro "Nivel Educativo es Avanzado", **Entonces** solo se muestran contactos con ese valor.
3. **Dado** que existe un campo "Fecha de Inscripción" de tipo Fecha, **Cuando** aplico un filtro "Fecha de Inscripción entre 2026-01-01 y 2026-03-31", **Entonces** se muestran solo los contactos inscritos en ese rango.
4. **Dado** que aplico múltiples filtros de campos personalizados simultáneamente, **Cuando** veo los resultados, **Entonces** todos los criterios se aplican correctamente en conjunto (AND lógico).

---

### Casos Borde

- ¿Qué sucede cuando se elimina una definición de campo que tiene valores asignados? → Se eliminan los valores asociados previa confirmación del usuario.
- ¿Qué sucede cuando se cambia el tipo de un campo que ya tiene valores? → No se permite cambiar el tipo de un campo que ya tiene valores asignados. Se debe crear uno nuevo y migrar manualmente.
- ¿Qué sucede cuando un campo obligatorio no tiene valor al guardar un contacto? → Se muestra un indicador visual, pero no se bloquea el guardado de otros campos (validación suave).
- ¿Qué sucede cuando se crean más de 50 campos personalizados? → El sistema impone un límite máximo de 50 campos por cuenta con un mensaje informativo.
- ¿Qué sucede cuando dos campos tienen el mismo nombre? → El sistema no lo permite; se muestra un error de duplicidad.
- ¿Qué sucede cuando un campo de tipo Selección tiene opciones eliminadas que ya están en uso? → Los valores existentes se preservan como texto pero se marcan como "opción eliminada" visualmente.
- ¿Qué sucede cuando un lead no tiene contacto asociado? → No se muestran campos personalizados; se muestra un aviso invitando a vincular un contacto.

## Requisitos *(obligatorio)*

### Requisitos Funcionales

- **RF-001**: El sistema DEBE permitir solo a los administradores (rol `admin`) crear definiciones de campos personalizados a nivel de cuenta, especificando nombre, tipo de campo y configuración opcional.
- **RF-002**: El sistema DEBE soportar 10 tipos de campo: texto, número, fecha, selección, selección múltiple, casilla de verificación, email, teléfono, URL y moneda.
- **RF-003**: El sistema DEBE permitir solo a los administradores editar el nombre, la configuración y el estado obligatorio de un campo personalizado existente.
- **RF-004**: El sistema DEBE permitir solo a los administradores reordenar los campos personalizados mediante arrastrar y soltar.
- **RF-005**: El sistema DEBE permitir solo a los administradores eliminar campos personalizados, mostrando confirmación cuando existen valores asociados y eliminando dichos valores en cascada.
- **RF-006**: El sistema DEBE almacenar los valores de campos personalizados por contacto, siendo el contacto la entidad principal de datos.
- **RF-006b**: El sistema DEBE permitir a todos los usuarios (independientemente del rol) leer y asignar valores a campos personalizados de contactos.
- **RF-007**: El sistema DEBE renderizar los campos personalizados en el panel lateral de detalle (LeadDetailPanel) con controles de edición inline apropiados según el tipo de campo.
- **RF-008**: El sistema DEBE validar los valores según el tipo de campo: formato de email válido, formato de URL válido, formato de teléfono válido, rango numérico, etc.
- **RF-009**: El sistema DEBE permitir que los usuarios configuren qué campos personalizados aparecen como columnas en las tablas de contactos y leads.
- **RF-010**: El sistema DEBE persistir las preferencias de columnas visibles del usuario entre sesiones.
- **RF-011**: El sistema DEBE permitir filtrar contactos y leads por valores de campos personalizados con operadores sensibles al tipo de campo.
- **RF-012**: Los campos de tipo "Selección" y "Selección Múltiple" DEBEN permitir al administrador definir, editar y reordenar las opciones disponibles.
- **RF-013**: El sistema DEBE imponer un límite máximo de 50 campos personalizados por cuenta.
- **RF-014**: El sistema NO DEBE permitir cambiar el tipo de un campo personalizado que ya tiene valores asignados.
- **RF-015**: El sistema DEBE generar un identificador único (slug) para cada campo basado en su nombre, que no cambie al renombrar el campo.
- **RF-016**: El sistema DEBE notificar a todos los usuarios conectados en tiempo real cuando se crean, editan o eliminan definiciones de campos personalizados.
- **RF-017**: Los campos personalizados de tipo "Moneda" DEBEN permitir configurar el símbolo de moneda y mostrar valores formateados con separadores de miles.
- **RF-018**: El sistema DEBE soportar un campo de "valor por defecto" opcional en la definición del campo, que se aplica automáticamente al crear nuevos contactos.

### Entidades Clave

- **Definición de Campo Personalizado**: Representa el esquema/configuración de un campo. Pertenece a una cuenta. Contiene: nombre, slug, tipo de campo, configuración (opciones para selección, símbolo de moneda, etc.), indicador de obligatoriedad, valor por defecto, y orden de visualización.
- **Valor de Campo Personalizado**: Representa el dato almacenado para un contacto específico en un campo específico. Contiene columnas tipadas separadas para texto, número, fecha, booleano y datos estructurados (para selección múltiple), lo que permite consultas y filtrado eficientes directamente en la base de datos.
- **Contacto** (entidad existente): Entidad principal que posee los valores de campos personalizados. Un contacto puede tener un valor por cada definición de campo de su cuenta.
- **Lead** (entidad existente): Entidad vinculada a un contacto. Muestra los valores de campos personalizados del contacto asociado en su panel de detalle y tabla.

## Criterios de Éxito *(obligatorio)*

### Resultados Medibles

- **CE-001**: Los administradores pueden crear un nuevo campo personalizado completo (con nombre, tipo y opciones) en menos de 30 segundos.
- **CE-002**: Los usuarios pueden ver y editar valores de campos personalizados en el panel de detalle sin necesidad de recargar la página.
- **CE-003**: La tabla de contactos muestra columnas personalizadas sin degradación perceptible de rendimiento con hasta 1000 registros visibles.
- **CE-004**: Los filtros por campos personalizados retornan resultados en menos de 2 segundos para bases de datos con hasta 100,000 contactos.
- **CE-005**: El 100% de los tipos de campo soportados tienen controles de edición y visualización funcionales en el panel de detalle.
- **CE-006**: Los cambios en definiciones de campos se reflejan en tiempo real para todos los usuarios conectados a la misma cuenta.
- **CE-007**: Las preferencias de columnas visibles del usuario persisten correctamente entre sesiones sin pérdida de configuración.

## Supuestos

- Los campos personalizados tienen alcance a nivel de cuenta (aplican a todos los contactos de la cuenta), no a nivel de pipeline o espacio.
- Los 11 campos estándar existentes (email, empresa, edad, DNI, fecha de nacimiento, dirección, distrito, ocupación, tags, notas, fuente) permanecen como campos fijos del sistema y no se migran al sistema de campos personalizados.
- Los valores de campos personalizados se almacenan por contacto (no por lead), ya que el contacto es la fuente de verdad. Los leads muestran los valores del contacto asociado.
- El campo `custom_fields` JSONB existente en leads (usado por la sincronización con Kommo) se mantiene sin cambios y opera independientemente del nuevo sistema de campos personalizados.
- La validación de campos obligatorios es "suave": se muestra un indicador visual pero no se bloquea el guardado de otros datos.
- El límite de 50 campos por cuenta es suficiente para las necesidades actuales del negocio.
- No se requiere versionamiento de definiciones de campo ni historial de cambios de valores en esta iteración.
- La funcionalidad de importación/exportación CSV de campos personalizados queda fuera del alcance de esta iteración.
- No se requieren campos de tipo fórmula, relación, archivo adjunto ni calificación en esta iteración; quedan como extensiones futuras.
- El reordenamiento de campos usa drag-and-drop en la interfaz de configuración.
- Los leads sin contacto asociado no muestran campos personalizados; se muestra un aviso invitando a vincular un contacto. Esto refuerza el principio de "contacto como fuente de verdad".

## Clarificaciones

### Sesión 2026-04-15

- Q: ¿Qué sucede con los campos personalizados de un lead que no tiene contacto asociado? → A: No se muestran campos personalizados; se muestra un aviso "vincule un contacto para ver campos personalizados" (Opción A).
- Q: ¿Quién puede gestionar definiciones de campos vs. asignar valores? → A: Solo administradores (rol `admin`) gestionan definiciones (crear/editar/eliminar/reordenar); todos los usuarios pueden leer y asignar valores (Opción A).
- Q: ¿Se debe avisar al usuario cuando edita un campo de un contacto vinculado a múltiples leads? → A: No; el contacto es fuente de verdad única por diseño y es el comportamiento esperado (Opción B).
