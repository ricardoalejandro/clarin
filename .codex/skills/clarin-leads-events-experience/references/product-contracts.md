# Leads And Events Product Contracts

## Entity And Activity Scope

- `Contact` owns identity, communication coordinates, avatar, Contact tags, notes, custom fields, do-not-contact state, and cross-module history.
- `Lead` is a child opportunity. It owns pipeline/stage, lifecycle, commercial properties, and interactions written with its `lead_id`.
- `event_participant` is one Contact's contextual membership in one Evento. It owns event stage, membership provenance/state, and interactions written with its `participant_id` and `event_id`.
- Display direct Lead or participant observations separately from canonical Contact history. Every heading and composer states its scope.
- A completed/cancelled Evento is read-only for event-context writes while historical Contact data remains readable.

## Operational Detail

- Default Lead and participant detail to docked right. Floating and docked modes leave the board interactive; maximized and mobile modes are modal.
- Preserve preferred floating geometry independently from viewport clamps. Persist only manual floating geometry by account, user, and surface.
- Put opportunity/Evento context and stage in the outer header, then render canonical Contact identity once in a compact fixed strip.
- Keep Observation, Message, and Edit actions above the first scroll boundary. Task creation belongs inside Related tasks.
- Use one vertical scroll owner and this ordered accordion stack: Contact information, Contact tags, direct observations, opportunity/Evento context, related tasks, general Contact history, integrations. The first three start open; the rest start collapsed.
- Do not use Summary/Activity tabs or a competing activity rail. Accordion state survives maximize/restore and chat, then resets to defaults on entity change.
- Opening chat forces a temporary maximized mode without persisting it. At 980 measured pixels or more, show compact detail beside chat; below it, chat replaces detail with a return action. Closing restores mode, preferred geometry, scroll, accordion state, and focus exactly.
- Give each visible pane one primary vertical scroll owner and restore focus when child windows close.

## Contact Tags And Observations

- Assigned Contact tags paint immediately. Add/remove uses the canonical Contact profile API, bounded search, exact 500 ms debounce, abort/stale guards, permission-gated creation, pending feedback, rollback, and retry.
- The Contact editor remains the place for identity and extensive fields; tag and observation work never requires opening it.
- Birth dates and Contact custom fields of type date use the shared operational picker in date-only mode. Display localized `dd/mm/aaaa`, preserve exact `YYYY-MM-DD` or null, expose direct month/year navigation, and omit time, timezone, all-day, and relative due-date actions. Selection updates only the editor draft; Guardar contacto remains the sole write.
- A Lead or participant without canonical Contact uses the same date-only control for its historical birth date. Do not apply it to Evento dates, filters, or bitácora fields as an accidental scope expansion.
- Direct observation composers accept `note` and `call`, expose Nota/Llamada visibly, submit with Ctrl/Cmd+Enter, and return/render `created_by_name`. Every item shows type, timestamp, and an honest author/origin fallback.
- Observation history is lazy and independently collapsible. Its count and add action remain visible while collapsed, and saving one observation leaves the composer available.
- `scope=participant` returns only direct interactions whose `participant_id` matches the account-scoped participant. The legacy aggregate participant query remains the compatibility default.

## Related Clarin Work Tasks

- Related task scope is `{ contactId, leadId?, eventId? }`. Event-participant task scope uses Contact plus event because tasks do not own a participant field.
- Queries remain actor-authorized in the task repository. Opening and creation use Clarin Work detail/editor components, real Entorno/list/workflow/status contracts, and their canonical realtime reducers.
- Default the compact CRM panel to open top-level work; closed work remains available explicitly.
- A task child window renders above CRM detail and restores focus without destroying CRM scroll, draft, or selection.

## Pipeline Drag And Reconciliation

- Lead and event boards move entities between stages only; they do not persist within-stage manual order.
- Pickup captures cards, loaded pagination membership, counts, selected IDs, open detail entity, and source/target stage metadata.
- DndKit owns pointer, keyboard, Escape, edge autoscroll, and 520 ms touch pickup. An explicit handle owns drag while the card body owns detail opening.
- Preview matches Clarin Work: source at 20-25% opacity, stable placeholder, colored destination, and a lightweight overlay with grip, destination name, up to three converging layers, true multi-selection count, and an approximately 180 ms drop animation.
- One completed gesture sends at most one mutation and may carry an `operation_id`. Event multi-drag uses the existing atomic bulk participant endpoint.
- A visible `Sin etapa` column is an honest destination represented at the API boundary by `stage_id: null`, never by a fake UUID. Canonical HTTP and WebSocket payloads preserve the explicit null so clients remove stale stage metadata and reconcile loaded cards and counters in place.
- Cancellation, invalid target, `409`, or network failure restores the exact snapshot. Success applies the canonical response/WebSocket result without skeleton replacement, duplicates, stale paginated tails, scroll reset, or F5.
- Controls inside a card never begin drag. Keyboard and touch users receive equivalent pickup, destination, drop, and cancellation behavior.
