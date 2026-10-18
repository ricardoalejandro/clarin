# Program experience: frontend verification

This change keeps the mobile Program workspace focused on consultation,
attendance and contextual observations. Program administration remains available
on desktop, including the new photo editor and explicit conclude/reopen actions.

## Automated checks

Run from `frontend` with the repository dependencies and supported Node runtime:

```sh
npm run test:unit -- --maxWorkers=2
npx tsc --noEmit
npm run build
```

Verified on 2026-10-18 in an isolated VPS checkout based on
`da5024b0df6f4a1227e0df8499ec58bf6b37daf5`:

- The complete unit command passed: 395 application test files / 2,391 tests,
  plus 8 Excalidraw fork test files / 61 tests and the Node script checks.
- TypeScript and the complete production build passed, including CSS interaction
  verification and the existing bundled editor checks.
- Targeted regression coverage includes Contact photo behavior, shared window
  focus and pointer sessions, suspended administrative callbacks, contextual
  observation drafts, canonical lifecycle reconciliation and image revision
  conflicts.
- After the final corrections, all 256 targeted tests in 31 files passed,
  covering Program routes/components, Contact photo regressions and shared
  operational windows. These include closed-program empty states, immediate
  mobile suspension before a delayed container measurement and a suspended
  photo viewer that releases keyboard handling and restores its focus.

## Browser scenarios

`tests/responsive-dashboard.spec.ts` covers the following with synthetic API
fixtures. Run the Programas and Asistencia scenarios against a local production
build with `CLARIN_E2E_MOCK_AUTH=1`; never use this authentication bypass against
production. Browser tests exercise real DOM, layout, keyboard input and image
decoding/encoding. Backend and storage correctness are verified independently
against real disposable PostgreSQL and MinIO services; see
[backend verification](program-experience-backend.md).

The Chromium matrix passed all 17 selected scenarios and the WebKit/iPhone
matrix passed all 7 selected scenarios, with no skips. Both used the same
production build and a verified manifest of 47 source/test files. Completed
programs expose no session-creation actions; archive/restore/reopen preserve the
roster, and desktop/mobile transitions preserve configuration drafts and focus.

After the final CSS-only adjustment hiding Safari's duplicate native search
clear control, the 7 focused attendance/search tests, standalone TypeScript and
complete production build passed again. The WebKit attendance scenario was
repeated successfully against that build at 536 and 586 px.

The committed `playwright.program-experience.config.ts` preserves the isolated
runner settings: loopback port 3023, synthetic authentication, blocked service
workers and no retries. With that local build already running, execute from the
repository root:

```sh
CLARIN_E2E_MOCK_AUTH=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3023 \
  npx playwright test --config playwright.program-experience.config.ts --project responsive-desktop
```

Use `--project responsive-mobile-safari` for the WebKit/iPhone project and
`--grep` to select individual scenarios. `CLARIN_E2E_CAPTURE=1` saves the
synthetic visual evidence with the test results.

- Program and participant filters share the search row at 320, 375 and 539 px;
  listbox placement, keyboard use and counts remain usable.
- Eros is hidden in Program routes and remains available outside them.
- Attendance search at 536 and 586 px hides session details immediately,
  debounces participant results, restores the previous details and comment draft
  when cleared, and preserves the separate attendance/observation write flows.
- Photo crop produces a 512 × 512 JPEG within the 250 KiB limit; upload failure,
  revision conflict, explicit refresh, retry and removal preserve other settings
  drafts.
- The 840 × 655 settings window supports moving, resizing, maximizing and
  docking; desktop → mobile → desktop retains its draft, photo crop and focus.
  The available width is bounded by the current layout viewport so a delayed
  container measurement cannot leave desktop administration active after a
  mobile resize; a tablet keyboard alone still preserves the prior layout mode.
- Conclude, archive, restore as completed and reopen preserve the participant
  roster and its dates.

This work was prepared in a separate worktree and branch from `main`. PR18 and
production were not modified or deployed. The existing offline enrollment path
only gains the same active-program guard used by online enrollment, so a queued
creation cannot bypass a concurrent conclusion; no offline protocol, worker or
feature implementation is introduced.

A non-mutating Git merge simulation against PR18 at
`cca98be1695286a00168c51aa093396506b4c68d` completed without textual conflicts.
The overlapping files are the dashboard layout and the existing offline
enrollment repository. This is not a runtime test of the combined branches.
