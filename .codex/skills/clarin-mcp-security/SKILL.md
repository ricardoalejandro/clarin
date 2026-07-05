---
name: clarin-mcp-security
description: Use when modifying Clarin MCP server, global MCP admin configuration, MCP credentials, sessions, audit logs, tools, account authorization, routes, or MCP documentation.
---

# Clarin MCP Security

## Current MCP Model

- MCP is global per configured connection and is managed from `Admin -> MCP Global`.
- The primary endpoint is `/mcp`.
- `/mcp/sse` is legacy compatibility only.
- ChatGPT custom MCP connectors use OAuth over the MCP HTTP transport. Support `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/authorize`, and `/oauth/token`.
- Use manual user-defined OAuth clients for ChatGPT in v1: exact `https://chatgpt.com/connector/oauth/...` redirect URI, PKCE S256, token endpoint auth `none`, resource `https://clarin.naperu.cloud/mcp`, and scope `mcp:read`.
- Do not add open Dynamic Client Registration unless the user explicitly asks and the security model is reviewed again.
- Account API Keys are legacy account-specific integration keys. They do not configure or authenticate MCP Global.
- `mcp_enabled` on accounts is legacy and must not be used as the global MCP switch.

## Security Requirements

- Every MCP client/connection must be unique, revocable, and auditable.
- Store only hashed secrets server-side. Show raw secrets only once at creation/rotation.
- Store OAuth authorization codes/access tokens only as hashes. Authorization codes must be short-lived, single-use, and PKCE-bound.
- Sessions must support revocation and must record enough metadata to identify connected clients.
- MCP audit logs should capture client/session, tool/action, selected account, result, and relevant error category without leaking secrets.
- Tools that expose account data must require an allowed account context. Never default to all accounts when the tool can target one account.
- A global MCP client may list/select only accounts explicitly allowed by its configuration.

## Route And UI Rules

- Use `Admin -> MCP Global` wording in docs and UI.
- Do not direct users to account settings API Keys for MCP Global.
- Keep `/mcp/sse` labeled as legacy; do not make it the primary setup path.
- Avoid "empresa"; use "cuenta" or "tenant" unless quoting literal existing UI.

## Verification

- Check credential creation, rotation, revocation, allowed-account enforcement, session revocation, and audit visibility.
- Review race and stale-state behavior in admin UI tables/modals after async updates.
- Run backend and frontend verification when MCP changes touch both sides.
- Required MCP schema must be in the main runtime migration path in `backend/pkg/database/database.go`, not only in `SeedAdmin`, seed helpers, or admin bootstrap.
- If the user asks to deploy MCP changes, run `make deploy` from the repository root and verify the running system.
- After MCP deployment, verify these tables/objects in the real PostgreSQL container when relevant: `mcp_clients`, `mcp_client_accounts`, `mcp_sessions`, and `mcp_audit_events`.
- After MCP deployment, verify `/mcp` without a bearer token returns `401 Unauthorized`.
- Do not claim MCP Global is protected in production until client uniqueness, account allowlists, revocation/session behavior, audit logging, and runtime endpoint authentication have been checked or the unverified gap is stated.
