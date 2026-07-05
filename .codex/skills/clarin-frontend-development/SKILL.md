---
name: clarin-frontend-development
description: Use when modifying Clarin frontend Next.js, React, TypeScript, dashboard pages, components, API calls, WebSocket state, or UI behavior. Enforces existing dashboard conventions, safe async state, and current MCP/account vocabulary.
---

# Clarin Frontend Development

## Product And Vocabulary

- Use "cuenta" or "tenant" for `accounts`; do not say "empresa" unless the existing UI literally says it.
- MCP Global lives in `Admin -> MCP Global`. Do not present account API Keys or `mcp_enabled` as MCP Global configuration.
- Kommo API sync actions stay hidden/dormant unless the user explicitly asks to reactivate them. Local Excel import can remain active.

## UI Rules

- Match the existing dashboard before inventing new visual language.
- Use Tailwind and lucide-react consistently with the target page.
- Operational SaaS screens should be dense, scannable, and calm. Avoid landing-page or marketing layouts inside the dashboard.
- Add loading, empty, disabled, and error states for async flows.
- Keep text from overflowing buttons, cards, modals, tables, and sidebars on mobile and desktop.
- Use confirmation for destructive actions and clear disabled states while saving.

## State And Data Safety

- Guard async requests that can race when switching leads, contacts, chats, accounts, filters, or devices.
- Clear stale local state when opening a different entity or closing an inline panel.
- For chat and contact panels, never allow a late response from a previous chat/contact to overwrite the current view.
- Keep API client types and component state in sync with backend contracts.
- Do not print tokens, cookies, JWTs, WhatsApp identifiers beyond what the UI already needs, or raw imported personal rows.

## Verification

- For frontend changes, run from `frontend`:

```bash
npx tsc --noEmit
```

- Run `npm run build` when routes, production rendering, imports, or API contracts may be affected.
