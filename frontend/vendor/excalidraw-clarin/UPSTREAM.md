# Excalidraw fork provenance

- Upstream repository: `https://github.com/excalidraw/excalidraw`
- Upstream tag: `v0.18.1`
- Upstream commit: `a2ec2889babf7d2295469c6d90ebe77fae57df84`
- Backported pressure commits: `cd514d72d6350082c7f173f7147607c7dc4cb523`
  (#11507) and `2a82821ec5970691199e1ffc6a49ac31f311ab59` (#11551)
- Clarin package version: `0.18.1-clarin.6`
- License: MIT (see `LICENSE`)

The `packages/excalidraw`, `packages/math`, and `packages/utils` directories
were copied from the exact upstream commit above. Clarin changes are intentionally
limited to rich-text marks, per-paragraph alignment, deterministic local font
preloading, native caret stops for blank editable paragraphs, the narrow host
API needed by Pizarras, and the audited freedraw pressure backport recorded in
`PATCHES.md`. Existing network and product
hardening is applied by the repository build pipeline after this source fork is
compiled.
