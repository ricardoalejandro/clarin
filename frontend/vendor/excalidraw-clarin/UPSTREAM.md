# Excalidraw fork provenance

- Upstream repository: `https://github.com/excalidraw/excalidraw`
- Upstream tag: `v0.18.1`
- Upstream commit: `a2ec2889babf7d2295469c6d90ebe77fae57df84`
- Clarin package version: `0.18.1-clarin.4`
- License: MIT (see `LICENSE`)

The `packages/excalidraw`, `packages/math`, and `packages/utils` directories
were copied from the exact upstream commit above. Clarin changes are intentionally
limited to rich-text marks, per-paragraph alignment, deterministic local font
preloading, and the narrow host API needed by Pizarras. Existing network and
product hardening is applied by the repository build pipeline after this source
fork is compiled.
