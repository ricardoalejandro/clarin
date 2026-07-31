# Clarin Interface Design Contract

## Contents

1. Product character
2. Visual hierarchy and density
3. Controls and forms
4. Windows, dialogs, and overlays
5. Drag, selection, and direct manipulation
6. Responsive layout and scroll
7. Motion and feedback
8. Accessibility and functional completeness

## Product Character

- Make Clarin feel calm, precise, capable, and pleasant under sustained daily use.
- Prefer operational clarity over decoration. Beauty comes from hierarchy, alignment, proportion, responsive feedback, and confidence in the outcome.
- Use the established neutral slate family for structure and emerald for the principal product action. Reserve rose, amber, blue, violet, and other accents for real semantics or controlled identity choices.
- Use Tailwind and Lucide consistently. Do not introduce arbitrary SVG markup, icon styles, gradients, or a second component language when the catalog already covers the need.
- Preserve module personality through content, workflow, and restrained accents without making each page look like a different product.

## Visual Hierarchy And Density

- Make the page title, active scope, primary action, and main view immediately discoverable.
- Keep operational headers compact. Stable primary tabs must not move because search, filters, or contextual tools expand.
- Use full-bleed measured canvases for boards, calendars, timelines, editors, and other spatial views. Reading views may retain a small deliberate margin.
- Default geometry:
  - controls and compact action surfaces: about 12 px radius;
  - cards and bounded groups: about 16 px radius;
  - primary dialogs and work windows: about 24 px radius;
  - touch targets: at least 44 by 44 px even when the visible icon is smaller.
- Use borders and soft shadows for resting surfaces. Reserve deep shadows, rings, stronger backdrop contrast, and slight scale for active elevation or destination feedback.
- Keep metadata between 10 and 12 px only when it remains legible; normal operational content is generally 13–14 px and principal headings 18–24 px.
- Avoid inset empty-state cards surrounded by unused space. Let the empty state explain the next action inside the available surface.

## Controls And Forms

### Comboboxes And Pickers

- Use a portaled combobox when options require search, remote loading, grouping, icons, colors, descriptions, breadcrumbs, counts, roles, or semantic categories.
- Show the current value with enough context to understand it without opening the menu. Inside the menu show one clear label, optional description/breadcrumb, selection mark, and empty/loading/error state.
- Keep search bounded and debounced when the catalog can be large. Abort stale requests and never let an older result replace the newest query.
- Clamp and flip the menu inside the viewport, reposition on scroll/resize, close on Escape/outside interaction, and restore focus to its trigger.
- Support Arrow keys, Home/End when useful, Enter/Space selection, and visible focus.
- Selecting a value may write immediately only when the effect is local, obvious, and reversible. Bulk, structural, workflow-changing, or destructive choices must stage a summary and require Confirm.

### Dates And Time

- Use one professional date primitive across a workflow. Include calendar, localized value, optional time, all-day state, timezone, quick values, and clear/remove when those concepts exist.
- Link start/end controls: explain the relationship, reject invalid ranges, and never silently invent or shift the other endpoint unless the product contract explicitly requires it.
- Preserve exact values and timezone semantics through display, editing, API payload, reload, and realtime reconciliation.
- Show native date inputs only when the workflow is truly simple and consistent with surrounding controls; do not mix a primitive input beside richer date behavior for the same entity.

### Property And Multi-Select Controls

- Pair color with text or icon semantics; never communicate state through color alone.
- Show selected participants or tags as removable chips and search the remaining catalog on demand rather than rendering an unbounded list.
- Explain the difference between owner, collaborator, watcher, creator, or other roles instead of relying on proximity.
- Keep the final removal and explicit empty collection canonical; never preserve a stale visual chip.

### Destructive And Bulk Actions

- State the exact affected count and descendants or related records.
- Separate preparation from execution: destination selection, remapping, or preview occurs before Confirm.
- Use exact-name or canonical-phrase confirmation when scope is large or irreversible.
- Disable duplicate submissions, expose progress, preserve rollback/retry, and distinguish a saved operation from a failed refresh.

## Windows, Dialogs, And Overlays

### Choose The Correct Surface

- Use a popover for compact contextual choices.
- Use a simple modal for short, blocking decisions or focused forms.
- Use a docked drawer when reference to the workspace is important and horizontal room exists.
- Use a work window for complex creation/editing with enough duration or content to benefit from drag, resize, docking, maximize/restore, remembered geometry, and workspace interaction.
- Use maximized or mobile full-screen mode when the measured space cannot sustain a floating work window.

### Work Window Contract

- Provide a clear draggable header that does not steal clicks from header actions.
- Expose resize affordances on borders/corners with correct cursors, keyboard alternatives where practical, and viewport clamps.
- Support dock-right and maximize/restore when the task is complex enough to justify a work window. Double-clicking the header may toggle maximize when consistent with the surface.
- Remember geometry per user only after clamping it to the current measured viewport.
- Keep floating and docked workspaces interactive when the product contract allows it; maximized/mobile modes may be modal.
- Protect dirty drafts on close or Escape. A cancelled discard keeps the complete draft and window state.

### Contrast And Layering

- Use a monotonic semantic layer registry: workspace content < workspace popover < work window < dialog < confirmation < picker backdrop < picker/menu < drag overlay < notification.
- Portal any surface that may cross an overflow boundary. A child picker must render above its owning window or dialog.
- A blocking modal generally uses a dark slate backdrop around 40–55% plus subtle blur. A non-blocking floating surface uses a lighter veil; module contracts may define exact values.
- Reinforce floating surfaces with border, ring, and shadow rather than making the entire background opaque.
- Trap focus only for modal surfaces. Restore focus to the invoking control when closing any temporary surface.

## Drag, Selection, And Direct Manipulation

- Separate open/click, completion, selection, drag, resize, and pan regions. Each region owns one cursor and one gesture.
- Use a stable handle when the rest of a row/card has meaningful click or selection behavior. Do not alternate pointer and grab classes from competing hover states.
- Snapshot the visible/canonical state at drag start and provide exact cancellation or failure rollback.
- Highlight a destination declaratively with tint, border, shadow, label, icon change, or a slight transform near 1.02. Never change layout dimensions and cause target oscillation.
- Keep the drag overlay lightweight; do not mount duplicate stateful/sortable components inside it.
- Multi-selection should remain minimal at rest, obvious once active, and understandable during a group drag through a compact stack/count representation.
- Provide keyboard movement and `aria-live` announcements for pickup, count, destination, success, and cancellation.
- One gesture produces at most one logical backend write unless the product explicitly models a longer workflow.

## Responsive Layout And Scroll

- Measure the actual module container after the main sidebar, secondary navigation, Eros, and other chrome.
- Prefer reflowing properties to a second row before truncating controls into ambiguity.
- Use compact variants only while the label, semantics, focus, and touch target remain understandable.
- Convert complex dialogs to full-height mobile surfaces or bottom sheets according to task duration and required context.
- Keep one primary vertical scroll owner per window/drawer/panel. Bound child pickers, timelines, code, or activity lists explicitly when they require independent scrolling.
- Make scrollbars thin and quiet; reveal or strengthen them when overflow, hover, or keyboard focus makes orientation necessary. Add edge shadows only when content exists beyond the visible boundary.
- Verify layouts with long localized text and at 320, 375, 768, 1024, 1280, and 1440 px, plus the module-specific reported viewport.

## Motion And Feedback

- Use roughly 140–220 ms for ordinary transitions. Prefer ease-out for entering/settling and avoid long decorative motion in operational flows.
- Animate transform, opacity, and controlled grid/height changes. Avoid repeated DOM reordering or measurements that create flicker.
- Preserve neighboring layout with placeholders during drag or optimistic creation.
- Respect `prefers-reduced-motion`: remove travel, rotation, and convergence while retaining clear state feedback.
- Show pending work close to the initiating control without replacing populated content with skeletons.
- Make success calm and temporary; make errors persistent enough to read, actionable, and specific about whether the write occurred.

## Accessibility And Functional Completeness

- Use semantic roles, accessible names, `aria-expanded`, `aria-controls`, `aria-selected`, and live announcements where state is otherwise visual.
- Keep visible focus and logical tab order. A collapsed or hidden region must not retain focusable descendants.
- Support mouse, touch, keyboard, Escape, and reduced motion for primary workflows.
- Do not rely on hover as the only discovery path. Touch and keyboard need equivalent access to contextual actions.
- Verify contrast for text, focus, selected, disabled, and semantic colors.
- A polished surface covers loading, empty, disabled, permission, validation, conflict, offline/network, retry, cancellation, and canonical reconciliation states.
