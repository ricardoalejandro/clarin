# Leads And Events Verification Matrix

## Detail And Responsive Layout

- Test Lead with and without canonical Contact; participant with and without Contact; zero/one/many opportunities; long names/phones/fields; no/many tags, observations, and tasks.
- At 320, 375, 768, 833x818, 1024, 1081x818, 1280, and 1440 px and zoom 80-150%, verify Contact, context/stage, tags, Observation, and Message remain identifiable without scrolling.
- Assert the accordion order and defaults exactly: Contact, tags, direct observations open; context, related tasks, general history, integrations closed. Changing modes/chat preserves state; changing entity resets it.
- Confirm there are no Summary/Activity tabs, no competing activity rail, no duplicated identity, and no Google integration block before the primary CRM work.
- Exercise docked, floating, every resize edge/corner, reset, maximize/restore, double-click, mobile conversion, remembered geometry, backdrop strength, board interaction, Escape, and focus restoration.
- Open chat with less/more than 980 px measured space and verify temporary maximize, split versus reversible subview, and exact restoration of mode, geometry, scroll, accordion state, and focus.
- Confirm one scroll owner per pane and no clipped picker, task window, confirmation, or final action.
- Edit a canonical Contact birth date, a custom date field, and historical Lead/participant birth dates. Assert localized display, direct old-year navigation, exact date-only payload/null, dirty-state behavior, no write before the parent Save action, and no native `input[type=date]` in those CRM editors.
- At 320, 375, 833x818, 1024, 1440, and the reported 1747x818 viewport, open the birth-date picker near both vertical edges with sidebar/Eros states. Verify it portals above the CRM window, flips/clamps, survives zoom/scroll repositioning, restores focus, and contains no time, timezone, all-day, or relative shortcuts.

## Tags And Activity

- Add/remove the first, middle, and last tag; fail each request; switch Contact mid-request; verify pending feedback, exact rollback, stale-response rejection, and canonical reconciliation.
- With fake timers assert no remote tag search at 499 ms and one final search at 500 ms; clear/select remains immediate and global creation follows permission.
- Keep Contact, Lead, and event-participant histories visibly distinct. A direct participant query must exclude Contact-only and other-event interactions.
- Create both Nota and Llamada, submit through Ctrl/Cmd+Enter, and verify type, timestamp, returned author name, and honest fallbacks for system/imported/unavailable users.
- Add while history is collapsed, retry a failed add, switch entities rapidly, and preserve correct count/composer scope.
- Verify completed/cancelled Eventos expose history but reject or disable event-context writes.

## Related Tasks

- Query open and closed related tasks with actor/account isolation. Test no Entorno access, Ver, Comentar, Editar, and Administrar capabilities.
- Open task detail, create a correctly linked task, cancel dirty creation, fail/retry save, reconcile WebSocket, and return focus/CRM state after closing.
- Prove the CRM surface uses Clarin Work task components and never issues a legacy task-list/form mutation.

## Pipeline Drag

- Test pointer, touch long-press, normal touch scroll, keyboard pickup/drop, Escape, outside drop, empty/populated/off-screen stages, and horizontal/vertical autoscroll.
- Verify touch pickup waits 520 ms; controls do not drag; a short card click opens detail; overlay/placeholder/destination do not change column dimensions.
- Compare against Clarin Work: 20-25% source opacity, grip, destination label, colored target, up to three converging layers, true count, and 180 ms drop animation.
- Simulate success, safe API error, `409`, and WebSocket-before/after-HTTP. Assert one write, exact rollback, no duplicates, correct counts, preserved selection/detail/scroll, and no skeleton flash.
- Move one card and an Eventos multi-selection both into and out of a visible `Sin etapa` bucket; assert a nullable payload, explicit canonical nulls, exact counters, one logical write, rollback, and remote-session reconciliation.
- For Eventos, drag an existing selected group and confirm one bulk request and a true-count stack overlay.

## Baseline

- Add unit tests for deterministic geometry, responsive view selection, activity query construction, tag mutation state, drag snapshot/reducer, rollback, and count reconciliation.
- Run `GOCACHE=/tmp/go-build go test ./...` from `backend`.
- Run `npm run test:unit -- --run`, `npx tsc --noEmit`, and `npm run build` from `frontend`.
- Run `git diff --check` and inspect the diff for account isolation, legacy task controls, duplicated Contact identity, and unrelated changes.
