# Clarin Interface Design Verification Matrix

## Review Sequence

1. Compare the implementation with the user's screenshot, annotation, and target viewport.
2. Verify the primary job, primary action, hierarchy, available-space measurement, and scroll owner.
3. Exercise functional states before reviewing fine visual polish.
4. Test pointer, touch, keyboard, focus, reduced motion, and responsive geometry.
5. Inspect the final diff for duplicated controls, arbitrary layers, native-control regressions, and missing tests.

## Surface And Density

- Test empty, one-item, normal, dense, loading, error, and permission-denied states.
- Use long titles, long names, long localized labels, many folders/options/rows, and missing optional metadata.
- Verify no dead padding, clipped final actions, horizontal overflow without purpose, or inset empty-state cards wasting the canvas.
- Verify one vertical scroll owner and that a scrollbar appears only when overflow exists.
- Check the exact reported viewport plus 320, 375, 768, 1024, 1280, and 1440 px with the main sidebar and Eros both open and closed.

## Comboboxes, Pickers, And Forms

- Open every picker near all four viewport edges and inside overflow-hidden/auto ancestors.
- Verify search, debounce/cancellation when remote, loading, no results, selected state, disabled options, and canonical empty values.
- Verify ArrowUp/Down, Home/End where supported, Enter/Space, Escape, outside close, focus restoration, and touch selection.
- Confirm the menu flips/clamps and renders above its owning window without covering indispensable context unnecessarily.
- For staged operations, prove option selection performs no write and Confirm performs exactly one logical write.

## Dates

- Test localized date-only, date-time, all-day, timezone, quick values, clear, keyboard, and invalid ranges.
- Verify linked start/end constraints without silent date invention.
- Reload and reconcile through realtime; displayed and persisted values must remain identical.
- Open the date picker from narrow, floating, docked, maximized, filtered, calendar, and timeline contexts when applicable.

## Windows, Dialogs, And Layers

- Classify the surface first: popover, modal, drawer, or complex work window.
- For work windows, test header drag, every resize edge/corner, dock, maximize/restore, double-click behavior, remembered geometry, viewport clamps, and mobile conversion.
- Test clean Escape, dirty-draft confirmation, cancelled discard, save failure, retry, and focus restoration.
- Verify non-blocking modes leave the workspace operable and modal modes actually trap focus and block it.
- Open nested picker, confirmation, tooltip, and notification surfaces together; assert monotonic overlay order and no clipping.
- Compare backdrop darkness, blur, border, ring, and shadow in floating, docked, modal, and mobile modes.

## Cards, Lists, Selection, And Drag

- Verify open, completion, selection, menu, drag, resize, and pan regions do not trigger one another.
- Observe cursors while idle, hovering controls, selecting, dragging, panning, dropping, and cancelling; no cursor may flicker between owners.
- Test individual, Shift-range, modifier, touch-hold, multi-select, and Escape clear when supported.
- Drag to empty, populated, collapsed, scrolled, edge, invalid, and outside destinations; verify target clarity without layout movement.
- Verify lightweight overlay/stack count, reduced-motion fallback, autoscroll, keyboard alternative, one write, success, conflict, network failure, and exact rollback.

## Motion And Feedback

- Measure expansion, collapse, menu, selection-bar, and drag feedback; ordinary transitions should settle in roughly 140–220 ms.
- Confirm neighboring content does not jump and reordering does not oscillate.
- Enable reduced motion and verify state remains understandable without travel or rotation.
- Ensure populated content stays mounted during background reconciliation and pending feedback appears near the initiating action.

## Accessibility

- Navigate the complete workflow without a mouse.
- Verify visible focus, accessible names, expanded/selected state, region ownership, live drag announcements, and focus restoration.
- Ensure hidden/collapsed regions are removed from tab order.
- Verify controls remain reachable and at least 44 px in touch interaction area.
- Check contrast without relying only on color to communicate status.

## Functional State Contract

- Unit-test deterministic state, geometry, payload, cursor, density, overlay, and rollback helpers at the nearest stable layer.
- Browser-test real clipping, pointer coordinates, drag sensors, animation, focus, and responsive layout.
- Trace state-changing controls through API success, canonical response, realtime echo, stale-response protection, error, conflict, retry, and reload.
- Confirm destructive and bulk scopes, phrases, descendants, permissions, disabled submission, and recovery.
- Never accept a static screenshot, TypeScript pass, or production build as proof that an interaction works.
