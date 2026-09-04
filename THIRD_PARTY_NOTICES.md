# Third-Party Notices

This file indexes notices that must accompany third-party software distributed by Clarin. It contains no credentials or runtime configuration.

## `@excalidraw/excalidraw`

- Distributed version: `0.18.1-clarin.6`
- Vendored source SHA-256: `942466e44ec36aa2e652ac1a8fefd52dd1f3cef578183ed959a50c271c0e2fd5`
- Upstream source: tag `v0.18.1`, commit `a2ec2889babf7d2295469c6d90ebe77fae57df84`
- Editor license: MIT, Copyright (c) 2020 Excalidraw
- Canonical component notice and current advisory record: [`frontend/THIRD_PARTY_EXCALIDRAW.md`](frontend/THIRD_PARTY_EXCALIDRAW.md)

The frontend build serves the audited editor assets from `frontend/public/vendor/whiteboards-editor/0.18.1-clarin.6/`. The selector exposes 32 local families: 7 official selectable families plus 25 Clarin-catalog families represented by 49 independently hashed WOFF2 files. The upstream asset set also contains these licensed families:

| Family | Recorded upstream license |
| --- | --- |
| Assistant | SIL Open Font License 1.1 |
| Cascadia | SIL Open Font License 1.1 |
| ComicShanns | MIT |
| Excalifont | SIL Open Font License 1.1 |
| Liberation Sans | SIL Open Font License 1.1 |
| Lilita | SIL Open Font License 1.1 |
| Nunito | SIL Open Font License 1.1 |
| Virgil | SIL Open Font License 1.1 |
| Xiaolai | SIL Open Font License 1.1 |

The upstream `0.18.1` package does not place separate notices beside every font. Clarin therefore distributes the reconciled upstream notices in [`frontend/third_party/excalidraw/FONT-NOTICES.md`](frontend/third_party/excalidraw/FONT-NOTICES.md), together with the complete [`OFL-1.1.txt`](frontend/third_party/excalidraw/OFL-1.1.txt) and [`COMIC-SHANNS-MIT.txt`](frontend/third_party/excalidraw/COMIC-SHANNS-MIT.txt) texts. Every additional catalog family records its SPDX license, source and file hash in [`frontend/third_party/whiteboard-fonts/catalog.json`](frontend/third_party/whiteboard-fonts/catalog.json), with its exact license text under `frontend/third_party/whiteboard-fonts/licenses/`. The preparation step copies the applicable notices beside the versioned runtime assets.

This notice covers the public MIT-licensed Excalidraw project only. It grants no rights to Excalidraw Plus, proprietary source or services, trademarks, or assets absent from the public license.

## Reproducible Excalidraw dependency inventory

The exact runtime/optional/peer closure rooted at `@excalidraw/excalidraw@0.18.1-clarin.6` is defined by `frontend/package-lock.json` and audited through [the machine-readable supply-chain baseline](.codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json). The deterministic CycloneDX 1.6 inventory binds the vendored tree to upstream tag `v0.18.1`/commit `a2ec2889babf7d2295469c6d90ebe77fae57df84` plus the documented rich-text, paragraph, caret, IME, clipboard, local-font and pressure patches, contains 251 components and has SHA-256 `ca6a0ae4e12ecc94cd4778a2bae94b5b431c9030756cbd43b9a0966bada8c302`. The advisory snapshot was refreshed on `2026-08-29`.

Generate and verify it without contacting a third-party service:

```bash
node .codex/skills/clarin-excalidraw-development/scripts/generate-supply-chain-sbom.mjs \
  --manifest frontend/package.json \
  --lockfile frontend/package-lock.json \
  --baseline .codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json \
  --output /tmp/clarin-excalidraw-engine.cdx.json
```

The npm lock omits license fields for `fuzzy@0.1.3` and `khroma@2.1.0`; the baseline records their MIT license-file locations and SHA-256 evidence, which the generator checks against installed material. The SBOM is an inventory and does not replace copyright/license texts that must accompany distributed components. The current advisory status and production decision are recorded in [`frontend/THIRD_PARTY_EXCALIDRAW.md`](frontend/THIRD_PARTY_EXCALIDRAW.md) and [the supply-chain gate](.codex/skills/clarin-excalidraw-development/references/supply-chain.md).

## `@excalidraw/laser-pointer`

- Distributed version: `1.3.1`
- npm integrity: `sha512-psA1z1N2qeAfsORdXc9JmD2y4CmDwmuMRxnNdJHZexIcPwaNEyIpNcelw+QkL9rz9tosaN9krXuKaRqYpRAR6g==`
- License: MIT, Copyright (c) 2023 Excalidraw
- Complete license text: [`frontend/third_party/excalidraw/LASER-POINTER-MIT.txt`](frontend/third_party/excalidraw/LASER-POINTER-MIT.txt)

Clarin uses this exact local package only to generate the outline geometry of
constant-width freehand strokes. It introduces no service integration or
network destination.

## `fractional-indexing`

- Distributed version: `3.2.0`
- npm integrity: `sha512-PcOxmqwYCW7O2ovKRU8OoQQj2yqTfEB/yeTYk4gPid6dN5ODRfU1hXd9tTVZzax/0NkO7AxpHykvZnT1aYp/BQ==`
- Upstream source: <https://github.com/rocicorp/fractional-indexing/tree/v3.2.0>
- License: CC0 1.0 Universal (`CC0-1.0`; no rights reserved)

Excalidraw `0.18.1-clarin.6` uses this exact package to generate fractional ordering keys. Clarin's backend ports the same key-generation rules for canonical scene reconciliation, and the differential golden generator imports the exact installed `3.2.0` source after verifying its SHA-256. CC0 applies to that fractional-indexing implementation; Excalidraw's surrounding reconciliation and index-grouping code remains under the Excalidraw MIT notice above.
