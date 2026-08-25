# Excalidraw Supply-Chain Gate

## Reproducible Baseline

The machine-readable baseline is
`references/supply-chain-baseline.json`. For the vendored
`@excalidraw/excalidraw@0.18.1-clarin.4` fork it records the exact local tree
SHA-256, upstream tag/commit, the current advisory snapshot, two
audited lockfile-license omissions, the expected component count, and the
SHA-256 of the deterministic CycloneDX 1.6 document.

Generate and verify the exact install closure from the repository root:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/generate-supply-chain-sbom.mjs \
  --manifest frontend/package.json \
  --lockfile frontend/package-lock.json \
  --baseline .codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json \
  --output /tmp/clarin-excalidraw-engine.cdx.json
```

The generator has no external dependencies, timestamps, random serials, or
network calls. It traverses only the runtime, optional and peer dependency
closure rooted at the exact editor package. It fails on a floating manifest
spec, missing/mismatched SRI, unresolved required dependency, unrecorded
license, stale advisory component, component-count drift, or SBOM-digest drift.
Use `--verify archived.cdx.json` to require byte-for-byte equality with release
evidence.

The current baseline is 251 components and SBOM SHA-256
`de60ea5a33eac6d947abb0e0f8d02140e27010404126354a2fdac453bb75c458`.
The npm lock omits a license field for `fuzzy@0.1.3` and `khroma@2.1.0`;
the baseline records their MIT license-file paths and SHA-256 values, and the
generator verifies those exact files in installed material. An SBOM is an
inventory, not a substitute for distributing required copyright and license
notices.

## Current Advisory Snapshot

On 2026-08-23, `npm audit --omit=dev --json` reported 21 findings for the whole
frontend production graph: 6 moderate, 13 high, and 2 critical. The two critical
aggregate findings (`jspdf` and `tar`, the latter through the pre-existing
Fabric/canvas chain) are outside the Excalidraw-rooted closure, as are the
reported Fabric, Next, xlsx, ws, form-data, brace-expansion and PostCSS branches.
They are an inherited application baseline, not vulnerabilities introduced by
Pizarras, but the manual release decision must still record how they are
accepted or remediated.

The engine closure has these recorded advisory families:

- `nanoid@3.3.3` and `nanoid@4.0.2`: `GHSA-mwcw-c2x4-8c55`,
  `GHSA-28wg-ghj8-5hjv`, and `GHSA-2v37-7h3g-55p8`. The audited v0.18.1 source
  uses `nanoid()` and `nanoid(40)`, never a dynamic, zero, negative, or
  non-integer size. Clarin does not use editor IDs as authentication, share-link
  or session secrets. Any changed call site reopens all three findings.
- `lodash-es@4.17.21` through the Mermaid parser:
  `GHSA-r5fr-rjxr-66jc`, `GHSA-f23m-r3pf-42rh`, and
  `GHSA-xxjr-mmjv-4gpg`. Clarin disables Mermaid and AI affordances and does not
  accept Mermaid as an import format. Enabling or exposing the parser is a
  release blocker until the dependency is fixed and the path is reviewed.
- `picomatch@2.3.1`: `GHSA-3v7f-55p6-f55p` and
  `GHSA-c2c7-rcm5-vvqj`. It is in Excalidraw's declared
  `sass -> chokidar -> anymatch` install/build-tool branch, not in the Pizarras
  browser path. Builds use trusted repository globs; a runtime import or
  attacker-controlled build glob reopens both findings.

These are bounded reachability decisions, not claims that vulnerable versions
are patched. Refresh npm, OSV, and GitHub advisory evidence on the decision day;
update the baseline only after reviewing new or changed findings. Never copy a
previous scan date into a new release report.

## GO / NO-GO Rules

The current status is **NO-GO for automatic/unattended production promotion**.
That is distinct from the feature decision: Pizarras is **eligible for a manual
release decision** because no recorded advisory precondition is reachable in its
enabled paths. Mermaid/AI is removed, nanoid receives only fixed/default valid
sizes and never protects a secret, and picomatch is build-only. The release owner
must still explicitly accept or remediate the inherited whole-frontend baseline
and confirm the bundle/runtime evidence; this document does not make that
product-level decision automatically.

A release is GO only when all of the following are true:

1. exact package, lock, tarball/tag/commit and SBOM checks pass without drift;
2. a same-day advisory scan is attached and every reachable high/critical issue
   is fixed, or has a scoped, evidenced and explicitly approved exception; the
   unrelated pre-existing frontend baseline is listed separately and receives a
   deliberate release-owner decision;
3. disabled-code exceptions are proved by source review, production bundle/UI
   tests and runtime egress traces; merely hiding a button is insufficient;
4. all distributed packages/assets have applicable notices and license evidence;
5. format, reconciliation, egress, unit, build, browser and collaboration gates
   pass, with a last-known-good artifact and exact rollback plan.

Any failed integrity/SBOM/license gate, stale scan, new dynamic nanoid size,
reachable Mermaid parser, browser/runtime picomatch path, unreviewed reachable
critical/high finding, or missing rollback is NO-GO. A local build, dependency
scanner result, or mitigation note alone cannot change the decision.

## Script Tests

```bash
node --test \
  .codex/skills/clarin-excalidraw-development/scripts/generate-supply-chain-sbom.test.mjs
```

The tests cover nearest npm resolution, optional/peer closure, deterministic
serialization, exact manifest pinning, advisory-to-component mapping, hashed
license overrides, archived-SBOM verification, and fail-closed drift.
