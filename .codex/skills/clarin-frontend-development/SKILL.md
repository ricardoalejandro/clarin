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
- Do not ship inert controls. Trace every visible action through API behavior, feedback, retry/empty state, and final UI reconciliation.
- Use portals for menus, pickers, and avatar controls that may escape a panel with `overflow`; position and flip them against the viewport, and restore focus on close.
- Base dense workspace breakpoints on a measured container, including sidebar and Eros consumption. Do not infer available room from `window.innerWidth` or zoom percentage alone.
- Keep a single vertical scroll owner per drawer/panel unless a deliberately bounded child (for example a picker list) requires its own scroll.
- Preserve exact requested/historical visual assets locally; centralize their CSS and provide a plain-color fallback.
- Keep the canonical Contact detail ordered and shared across modules. Module context follows the contact profile/history and must not introduce a second identity editor.
- In contact editing, show assigned tags as removable chips and search a bounded remote catalog on demand; never map the entire account tag catalog into the form. Show tag creation only when the API reports permission.
- Make contact observation history independently expandable and lazy-loaded. Its collapsed header must retain the count and `Añadir observación`; opening the composer must not force the history list open.
- In Programas, create participation dates automatically but allow an explicit correction from participant detail. Explain attendance states in terms of the participation window and keep out-of-window records visible without including them in percentages.
- Default Program participant lists to active membership and place retired/completed memberships in an explicit history surface. Do not expose a normal hard-delete action for a participation with real activity.
- Show Program survey templates only as choices for creating an application. Sharing, opening/closing and results belong to the created application, not to the template itself.

## State And Data Safety

- Guard async requests that can race when switching leads, contacts, chats, accounts, filters, or devices.
- Clear stale local state when opening a different entity or closing an inline panel.
- For chat and contact panels, never allow a late response from a previous chat/contact to overwrite the current view.
- Distinguish initial/filter loading from realtime reconciliation. WebSocket events must patch or silently reconcile data without replacing mounted rows with skeletons or resetting scroll/selection.
- Deduplicate incoming/sent events, use stable entity keys, and keep user searches independent from background reconciliation cancellation.
- Render Contact identity once; embedded opportunity UI must contain only commercial fields and must inherit the parent panel scroll.
- Keep API client types and component state in sync with backend contracts.
- Do not print tokens, cookies, JWTs, WhatsApp identifiers beyond what the UI already needs, or raw imported personal rows.

## Verification

- For frontend changes, run from `frontend`:

```bash
npx tsc --noEmit
```

- Run `npm run build` when routes, production rendering, imports, or API contracts may be affected.
