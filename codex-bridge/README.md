# Clarin Codex Bridge

Sidecar privado para que Eros use una conexion administrada con OpenAI y el MCP de Clarin como fuente unica de herramientas.

## Contrato

- No se publica en Traefik ni expone puerto publico.
- El backend de Clarin lo llama por `EROS_CODEX_BRIDGE_URL`.
- Codex se ejecuta con `approval_policy=never` y sandbox read-only.
- Las consultas y acciones de datos deben pasar por el MCP configurado en `EROS_MCP_BASE_URL`.
- Cualquier capacidad nueva para Eros debe agregarse como herramienta MCP de Clarin, no como logica privada del bridge.
- La conexion con OpenAI se inicia desde `Administracion -> Eros` mediante codigo de dispositivo.
- Codex administra, persiste y renueva la sesion dentro del volumen `codex_bridge_home`.
- Los tokens nunca se envian al frontend ni se guardan en la base de datos de Clarin.
- `/live` mide la vida del proceso para Docker; `/health` comprueba la conexion completa con OpenAI y las herramientas de Clarin.

## Variables

- `EROS_CODEX_BRIDGE_TOKEN`: bearer interno obligatorio entre backend y bridge.
- `EROS_MCP_BASE_URL`: endpoint MCP interno, normalmente `http://clarin-backend:8081/mcp`.
- `EROS_MCP_ACCESS_TOKEN`: bearer MCP con cuentas permitidas para Eros.
- `EROS_CODEX_MODEL`: modelo opcional.

No montar un `auth.json` del host ni guardar secretos en este directorio o en el repositorio. El volumen persistente es la unica fuente de credenciales del bridge.
