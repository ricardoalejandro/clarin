# Verificación del intercambio de Programas

Fecha: 22/11/2026.

El cambio se publica para revisión en el PR #38, sobre `main`, sin incluir los cambios de la rama de utilitarios.

## Aprobado

- Compilación del backend y pruebas específicas de formato, repositorio, API, permisos y cupo de contactos.
- PostgreSQL real 16.11: 21 pruebas de repositorio, sin omisiones. Se verificaron A → B → A, reimportación sin duplicados, conflictos de asistencia, rollback íntegro, clases distintas el mismo día, contactos con identidad pendiente y reutilización del mismo Contacto en dos Programas.
- Repetición de migraciones de arranque sobre las mismas bases de prueba.
- Prueba HTTP con archivos firmados y un pool de una conexión: rechazo atómico cuando el cupo está lleno e importación correcta después de liberar una plaza.
- Las pruebas de PostgreSQL se repitieron sobre el árbol aislado basado en `main`, con las dos bases desechables recreadas. Los tres pasos terminaron con código 0 y sin casos omitidos.
- TypeScript y 57 pruebas focalizadas del frontend de Programas.
- Chromium: cargar archivo, revisar conflicto, cambiar entre móvil y escritorio, resolver por teclado, confirmar una sola vez, mostrar resultado y devolver el foco al botón que abrió el diálogo.

## Repetición de PostgreSQL en Windows

El ejecutor instala un paquete nativo de PostgreSQL 16 fijado por versión en un directorio de QA, usa credenciales aleatorias, abre exclusivamente loopback y crea solo `program_survey_integrity_test` y `program_transfer_http_test`. No lee la configuración de producción.

```powershell
./scripts/qa/program-transfer-postgres.ps1
```

Para repetir sobre un árbol aislado con un clúster previo detenido, el ejecutor admite los parámetros `SourceRoot`, `ReuseRunRoot` y `ResetDatabases`. Solo deben usarse con directorios de QA y bases de prueba del propio ejecutor.

Evidencia de la ejecución sobre el árbol de `main`: `.qa/program-transfer-postgres/runs/2d9d57b68c0041eb9cc37e2a618937cc/checks/1460d35c833947adbe9f182564c12344/`. El servidor quedó detenido al terminar.

## Comprobaciones pendientes de cierre

- Resultado final de la suite completa del frontend y del build de producción. Los builds con Node 22 fallaron con `EPERM` al crear directorios generados; se comprueba un árbol limpio con Node 24.
- La repetición de la suite general de Go fue rechazada por revisión automática debido a una posible transmisión de telemetría a un endpoint de Visual Studio cuyo contenido no se especificó. No se intentó eludir ese rechazo.
- El workflow de GitHub Actions incluido todavía no ha producido una ejecución; su existencia no se contabiliza como una prueba aprobada.
- Despliegue, versión, migraciones y salud de producción: no ejecutados. El intento de SSH al VPS fue denegado desde la sesión actual.

## Correcciones verificadas durante la revisión

El control de cupo usa la conexión de la propia transacción y serializa la cuenta antes de abrir su snapshot. La identidad portable de Contacto se resuelve dentro de la cuenta receptora a través de sus Programas, conservando versiones separadas por Programa. Los cambios incompatibles en temas de una clase se revisan antes de guardar. La autoría importada se muestra como procedencia y no otorga permisos de edición.
