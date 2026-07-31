---
name: clarin-interface-design-system
description: Use when analyzing, planning, designing, implementing, reviewing, or testing any Clarin interface whose visual hierarchy, layout, forms, tables, cards, sidebars, windows, dialogs, comboboxes, dates, overlays, drag interactions, motion, responsive behavior, or aesthetic consistency can change. Enforces a calm world-class operational design together with complete functional states, accessibility, measured responsiveness, and visual verification.
---

# Clarin Interface Design System

Design Clarin as a coherent operational product. Treat visual quality and functional completeness as one requirement: a beautiful control that is ambiguous, clipped, inaccessible, inert, or unreliable is unfinished.

## Load Required Context

1. Read repository `AGENTS.md` and the frontend, quality-assurance, and affected module skills.
2. Read [design-contract.md](references/design-contract.md) before changing layout, controls, windows, overlays, motion, drag, responsive behavior, or visual identity.
3. Read [verification-matrix.md](references/verification-matrix.md) before finalizing a UI change or claiming that it looks and works correctly.
4. Let explicit user intent and module product truth override general visual defaults. Never weaken data integrity, account isolation, permissions, or honest capability claims for appearance.

## Execute The Design Work

### 1. Ground The Design In The Real Surface

- Inspect the screenshots, viewport, current component, surrounding chrome, and existing reusable primitives before proposing a redesign.
- Treat each annotation as a symptom. Generalize it across empty, short, dense, loading, error, touch, keyboard, narrow, wide, sidebar-open, and Eros-open states.
- Measure the actual content container. Do not infer usable space from browser width, browser zoom, or a single screenshot.
- Identify the primary job, primary action, information hierarchy, scroll owner, interaction owners, and every state-changing control before choosing styling.
- Reuse the established Clarin visual language unless the user explicitly requests a deliberate product-wide change.

### 2. Design Function And Appearance Together

- Trace every visible action through local state, API behavior, pending feedback, canonical response, realtime reconciliation, error, retry, and final rendering.
- Do not ship decorative or inert controls. Remove, disable with a truthful explanation, or implement the complete behavior.
- Define success, loading, empty, disabled, permission, validation, conflict, cancellation, rollback, and retry states before polishing the happy path.
- Use confirmation proportional to risk. A selection in a destination picker prepares an operation when an immediate write could surprise the user.
- Keep destructive actions discoverable but visually secondary; explain scope, require deliberate confirmation, and preserve recovery when the product supports it.

### 3. Apply The Right Interaction Primitive

- Use accessible, viewport-aware portaled comboboxes when choices need search, grouping, icons, colors, descriptions, breadcrumbs, or semantic context. A native select is acceptable only for a short, unambiguous list that needs none of these.
- Every user-typed search waits exactly `500 ms` before changing local results or issuing a remote request. Render the text immediately, expose a quiet pending state, keep clear/select actions immediate, abort older remote requests, and discard stale completions even when abort arrives late.
- Use the shared professional date interaction when date work needs calendar, time, all-day, timezone, quick values, removal, linked ranges, or localized display. Do not scatter unrelated native date controls through one workflow.
- Use a simple modal for short blocking decisions. Use a work window for long-lived creation or editing that benefits from drag, resize, docking, maximize/restore, remembered geometry, or continued access to the workspace.
- Treat large filter builders, configuration inspectors, and other multi-step tools as work windows too when their content benefits from draft/apply, resizing, docking, or maximization. A filter option must not silently commit while the user is still composing a set.
- Portal menus, pickers, tooltips, confirmations, and drag overlays whenever an overflow ancestor could clip them. Use one monotonic layer contract rather than arbitrary z-index values.
- Separate click, selection, completion, resize, pan, and drag ownership. Give each pointer region and cursor one stable meaning.
- Keep primary controls visible; reveal secondary controls progressively through hover, focus, selection mode, contextual menus, or explicit expansion without hiding keyboard and touch access.

### 4. Preserve Calm Density And Clear Feedback

- Build dense, scannable operational surfaces rather than marketing layouts. Remove dead padding while retaining deliberate breathing room around primary groups and canvas edges.
- Let content and real status colors shape the surface. Use quiet borders and shadows at rest; increase elevation, contrast, tint, or scale only to explain focus, drag destinations, selection, or modal depth.
- Animate state changes with purpose and without layout oscillation. Prefer opacity, transform, and controlled grid/height transitions; respect reduced motion.
- Keep one vertical scroll owner per panel unless a bounded child list genuinely needs its own. Make scrollbars quiet, theme-aware, and visible when overflow makes them useful.
- Avoid repeated information. Context already communicated by a column, group, breadcrumb, or selected scope should not dominate every row or card.
- Update badges, totals, grouping counts, and other derived inventory in the same interaction that changes their source. Apply a deterministic optimistic reducer, then reconcile a canonical server snapshot; never require F5 and never ignore a canonical snapshot merely because its `operation_id` is local.
- Scope every file viewer, preview, conversion poll, and long async surface to an explicit session identity. Abort work and destroy workers/documents/render tasks/object URLs when the source, owner, or surface changes so stale content cannot reappear in a different record.
- Accept identity colors only through a validated professional color control: curated choices plus deliberate custom input, normalized `#RRGGBB`, contrast preview on light/dark/tinted surfaces, and no alpha, gradients, arbitrary CSS, or uploaded SVG color payloads.

### 5. Verify Before Completion

- Add or update a deterministic unit test at the nearest stable helper, reducer, hook, or component boundary for every functional UI change.
- Use browser tests for real geometry, clipping, pointer/touch/keyboard interaction, drag, focus restoration, animation, and measured responsive layout.
- Compare the implemented result against the reported viewport and the wider verification matrix, not only a convenient desktop size.
- Inspect the final diff for duplicated primitives, native-control regressions, arbitrary overlay levels, overflow clipping, cursor conflicts, invisible focus, and controls without complete behavior.
- Do not call a surface professional because it compiles. Verify its functional states and visual behavior in the running interface when deployment is requested.

## Non-Negotiable Review Questions

- Is the primary job and action obvious without reading every label?
- Does the design remain calm and legible with no data, one item, hundreds of items, long text, and narrow space?
- Can menus, dates, comboboxes, tooltips, and dialogs escape overflow and remain inside the viewport?
- Can a complex work window move, resize, dock, maximize, restore, protect a dirty draft, and adapt to mobile when those modes are appropriate?
- Does every cursor, hover, focus, drag, selection, and loading state have one stable owner with no flicker or accidental action?
- Can keyboard, touch, reduced-motion, and screen-reader users complete the same workflow?
- Does the control explain what will happen before an expensive, bulk, structural, or destructive write?
- Does the final result preserve product truth, canonical server state, rollback, and account isolation?
