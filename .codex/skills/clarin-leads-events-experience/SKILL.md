---
name: clarin-leads-events-experience
description: Use when analyzing, planning, designing, implementing, reviewing, testing, or deploying Clarin Leads, CRM pipelines, Eventos, event participants, their Kanban/list interactions, Contact detail inside these modules, scoped observations, Contact tags, related Clarin Work tasks, chat sidecars, optimistic stage movement, or CRM realtime reconciliation. Enforces canonical Contact identity, honest Lead and event-participation context, professional operational windows, account isolation, exact rollback, and complete responsive behavior.
---

# Clarin Leads And Events Experience

Build Leads and Eventos as one coherent CRM experience without merging their domain truth. Keep Contact identity canonical, Lead context commercial, and event participation contextual to one event.

## Load Required Context

1. Read repository `AGENTS.md`.
2. Read `../clarin-interface-design-system/SKILL.md` and its relevant references for every layout, window, control, drag, motion, overlay, or responsive change.
3. Read every matching layer skill: frontend, backend, database, quality assurance, and chat/WhatsApp as applicable.
4. Read `../clarin-task-work-experience/SKILL.md` plus its relevant references whenever Leads or Eventos render, create, open, update, or reconcile real Clarin Work tasks.
5. Read [product-contracts.md](references/product-contracts.md) before changing CRM identity, detail composition, activity scope, pipeline movement, event participation, or related tasks.
6. Read [verification-matrix.md](references/verification-matrix.md) before finalizing tests, deployment, or a completion claim.

## Execute The Work

### 1. Preserve CRM Entity Truth

- Render Contact-owned identity, phones, email, avatar, tags, notes, custom fields, and cross-module history once through `ContactDetailSurface`.
- Keep Lead-owned pipeline, stage, lifecycle, commercial fields, and direct opportunity observations in a Lead context surface.
- Keep event stage, membership state/source, event-specific actions, and direct participant observations in an event-participant context surface.
- Never adapt an event participant into a fake Lead to reuse a detail form. Use typed contextual components and explicit IDs.
- Keep Kommo API actions dormant unless the user explicitly requests reactivation.

### 2. Make Detail Immediately Scannable

- Use the shared operational-window contract for complex CRM detail: docked by default, floating/resizable, maximized, remembered safe geometry, and full-screen mobile.
- Put the opportunity or Evento context and current stage in the outer header, then render the Contact once in a fixed compact operational strip.
- Keep `Observacion`, `Mensaje`, and `Editar` as the primary actions. Put `Tarea` inside the related-tasks section instead of competing in the first action row.
- Use one vertical scroll owner and this accordion order: Contact information, Contact tags, direct observations, contextual opportunity/event data, related tasks, general Contact history, integrations. Open the first three by default and collapse the rest.
- Do not split this workflow into Summary/Activity tabs or a competing activity rail. Preserve accordion state, scroll, and drafts through window-mode and chat changes; reset defaults when the selected entity changes.
- Give accordion groups restrained but distinct icons, accents, and tints so their boundaries remain obvious without visual noise.
- Edit Contact birth dates and Contact custom fields of type date with the shared operational date-only picker. Preserve exact `YYYY-MM-DD`, provide direct month/year navigation, and never expose task due-date semantics such as time, timezone, all-day, or relative shortcuts. Apply the same control to honest historical Lead/participant identity when no canonical Contact exists.
- Portal every picker, confirmation, menu, and child task window above its owning CRM window.
- Keep docked/floating workspaces interactive and block only maximized/mobile modes.

### 3. Keep Tags, Activity, And Tasks Honest

- Edit Contact tags directly from the visible chip row. Search a bounded remote catalog at exactly 500 ms, abort predecessors, reject stale completions, gate global creation by permission, and roll back a failed add/remove.
- Keep the observation composer independent from history expansion. Always expose its count and add action.
- Direct observations support explicit `Nota` and `Llamada` types, submit with Ctrl/Cmd+Enter, and render type, timestamp, and author. Missing users use an honest origin such as Sistema, Importacion, or Usuario no disponible.
- Label and query activity by explicit scope: Contact history, this opportunity, or this event participation. Never silently merge them.
- Render related work through Clarin Work components and actor-authorized APIs. Do not use legacy task forms/lists as a second task experience.
- Opening `Mensaje` temporarily maximizes the CRM window. At 980 measured pixels or more, render compact detail and chat side by side; below that, replace detail with chat and a clear return action. Closing chat restores the exact prior mode, preferred geometry, scroll, accordion state, and invoker focus.

### 4. Move Pipeline Items Reliably

- Treat drag as a stage change only; do not invent within-column manual order.
- Use the shared DndKit pipeline primitive with an explicit handle; the card body opens detail, while buttons, checkboxes, and menus never initiate drag.
- Support mouse, keyboard, Escape, edge autoscroll, and touch with a 520 ms long-press, with distinct click, selection, menu, and drag ownership.
- Match the Clarin Work pickup language: source at 20-25% opacity, stable placeholder, color-tinted destination, lightweight overlay with grip and destination name, up to three converging layers, true selected count, and a roughly 180 ms drop animation.
- Snapshot the complete visible board at pickup, preview without layout oscillation, send at most one logical stage mutation with an optional local `operation_id`, and reconcile canonical HTTP/WebSocket entities.
- Treat a rendered `Sin etapa` bucket as a real nullable destination: its reducer, `stage_id: null` payload, canonical response, counters, rollback, and realtime reconciliation must agree. Never render a droppable destination that the backend ignores or rejects.
- Restore the exact snapshot, selection, detail context, and counts after cancellation, invalid drop, conflict, or transport failure.
- Keep populated content mounted through HTTP/WebSocket reconciliation; never flash skeletons, duplicate cards, or reset scroll.

### 5. Verify The Vertical Slice

- Trace every visible mutation through state, request, account-scoped backend validation, persistence, response, WebSocket echo, canonical rendering, conflict, rollback, and retry.
- Add deterministic unit coverage for window geometry, detail layout decisions, activity scope, tag mutation, drag snapshot/rollback, counts, and stale-response guards.
- Run the frontend/backend checks required by the quality skill and the focused CRM matrix.

## Non-Negotiable Review Questions

- Can a user identify the Contact, module context, stage, tags, observations, tasks, and message action without scrolling?
- Can a Contact observation appear as if it belonged only to one Lead or event participation?
- Can editing an event participant accidentally mutate or duplicate Contact identity?
- Can a failed stage move leave a card, count, selection, or open detail in the wrong state?
- Can a late response replace a newly selected Lead or participant?
- Can a visible task control bypass Clarin Work permissions, hierarchy, or canonical components?
- Can any query, mutation, event, tag, observation, or task cross `account_id`?
