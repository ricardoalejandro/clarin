# Verificación del intercambio de Programas

Fecha: 22/11/2026.

El cambio se publica para revisión en el PR #38, sobre `main`, sin incluir los cambios de la rama de utilitarios.

## Aprobado

- Compilación del backend y pruebas específicas de formato, repositorio, API, permisos y cupo de contactos.
- PostgreSQL real 16.11: 26 pruebas de repositorio, sin omisiones. Se verificaron A → B → A, reimportación sin duplicados, conflictos de asistencia, rollback íntegro, clases distintas el mismo día, contactos con identidad pendiente y reutilización del mismo Contacto en dos Programas.
- Repetición de migraciones de arranque sobre las mismas bases de prueba.
- Prueba HTTP con archivos firmados y un pool de una conexión: rechazo atómico cuando el cupo está lleno e importación correcta después de liberar una plaza.
- Las pruebas de PostgreSQL se repitieron sobre el árbol aislado basado en `main`, con las dos bases desechables recreadas. Los tres pasos terminaron con código 0 y sin casos omitidos.
- Frontend completo con Node 24 y `TZ=UTC`: 61 pruebas del editor, 47 comprobaciones de scripts y 2.404 pruebas de la aplicación (396 archivos), todas aprobadas y sin omisiones: 2.512 en total. Los 57 casos focalizados de Programas forman parte de estas pruebas, no se suman otra vez. TypeScript también pasó.
- Chromium sobre los assets compilados de la copia aislada en modo producción: cargar archivo, revisar conflicto, cambiar entre móvil y escritorio, resolver por teclado, confirmar una sola vez, mostrar resultado y devolver el foco al botón que abrió el diálogo.

## Repetición de PostgreSQL en Windows

El ejecutor instala un paquete nativo de PostgreSQL 16 fijado por versión en un directorio de QA, usa credenciales aleatorias, abre exclusivamente loopback y crea solo `program_survey_integrity_test` y `program_transfer_http_test`. No lee la configuración de producción.

```powershell
./scripts/qa/program-transfer-postgres.ps1
```

Para repetir sobre un árbol aislado con un clúster previo detenido, el ejecutor admite los parámetros `SourceRoot`, `ReuseRunRoot` y `ResetDatabases`. Solo deben usarse con directorios de QA y bases de prueba del propio ejecutor.

Evidencia de la ejecución sobre el árbol de `main`: `.qa/program-transfer-postgres/runs/2d9d57b68c0041eb9cc37e2a618937cc/checks/a5ac905892984e5eaa8779aa76337e95/`. El servidor quedó detenido al terminar.

## Comprobaciones pendientes de cierre

- El empaquetado de producción `standalone` sigue bloqueado por `EPERM` de Windows. En la copia aislada con Node 24 se verificaron webpack, TypeScript de Next y las 34 páginas estáticas, pero el proceso falló al copiar el artefacto standalone. Esa compilación diagnóstica utilizó directorios vacíos precreados y `cleanDistDir:false` temporal; la configuración y el lock se restauraron exactamente. No se cuenta como un build estándar aprobado.
- Para instalar en Windows sin enlaces privilegiados se empaquetó la dependencia local del editor dentro de la copia de QA. Se verificó que versiones, resoluciones e integridades externas no cambiaran y que los bundles del editor coincidieran. Esta adaptación no se publica como configuración de producción.
- La repetición de la suite general de Go fue rechazada por revisión automática debido a una posible transmisión de telemetría a un endpoint de Visual Studio cuyo contenido no se especificó. No se intentó eludir ese rechazo.
- No se ha podido verificar una ejecución del workflow de GitHub Actions; su existencia no se contabiliza como una prueba aprobada. Está limitado a pruebas específicas de transferencia y build; la suite general de Go permanece pausada por el rechazo indicado.
- Despliegue, versión, migraciones y salud de producción: no ejecutados. El intento de SSH al VPS fue denegado desde la sesión actual.

## Correcciones verificadas durante la revisión

El control de cupo usa la conexión de la propia transacción y serializa la cuenta antes de abrir su snapshot. La confirmación bloquea también el Programa, coordinándose con su cierre o archivo; la prueba concurrente confirmó rechazo sin escrituras parciales. El reintento exacto conserva los mapeos ya aceptados sin duplicar ni volver a crearlos. Un teléfono principal nuevo y compatible se conserva como adicional sin cambiar el principal de la cuenta receptora. La identidad portable de Contacto se resuelve dentro de la cuenta receptora a través de sus Programas, conservando versiones separadas por Programa. Los cambios incompatibles en temas de una clase se revisan antes de guardar. La autoría importada se muestra como procedencia y no otorga permisos de edición.
