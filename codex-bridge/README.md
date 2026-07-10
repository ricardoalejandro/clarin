# Clarin Codex Bridge

Sidecar privado para que Eros use Codex con la sesion ChatGPT/Codex del owner y el MCP de Clarin como fuente unica de herramientas.

## Contrato

- No se publica en Traefik ni expone puerto publico.
- El backend de Clarin lo llama por `EROS_CODEX_BRIDGE_URL`.
- Codex se ejecuta con `approval_policy=never` y sandbox read-only.
- Las consultas y acciones de datos deben pasar por el MCP configurado en `EROS_MCP_BASE_URL`.
- Cualquier capacidad nueva para Eros debe agregarse como herramienta MCP de Clarin, no como logica privada del bridge.

## Variables

- `EROS_CODEX_AUTH_FILE`: archivo `auth.json` dentro del contenedor, por defecto `/run/secrets/codex-auth.json`.
- `EROS_CODEX_AUTH_FILE_HOST`: ruta del host que Compose monta como `EROS_CODEX_AUTH_FILE`.
- `EROS_CODEX_ACCESS_TOKEN`: alternativa para `codex login --with-access-token` si aplica.
- `EROS_CODEX_BRIDGE_TOKEN`: bearer interno entre backend y bridge.
- `EROS_MCP_BASE_URL`: endpoint MCP interno, normalmente `http://clarin-backend:8081/mcp`.
- `EROS_MCP_ACCESS_TOKEN`: bearer MCP con cuentas permitidas para Eros.
- `EROS_CODEX_MODEL`: modelo opcional.

No guardar secretos en este directorio ni en el repositorio.
