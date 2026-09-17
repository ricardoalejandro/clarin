# Frontend framework baseline

The repository-root AGENTS.md remains authoritative. Before changing Next.js
behavior, read the version-matched documentation shipped in
`node_modules/next/dist/docs/` from this directory. The pinned production
baseline is Next.js 16.3.5 and React 19.3.0 on Node.js 24 LTS, not Next.js 14.

Clarin intentionally uses `next dev --webpack` and `next build --webpack` to
preserve the audited editor build/hardening boundary. Do not enable experimental
cache components, React Compiler, Turbopack, or alter service-worker caching as
an incidental upgrade step. Request/response API and account data must retain
the existing authentication and no-store policies.

`src/proxy.ts` preserves the previous middleware host/navigation guard; it is
not an authorization layer. Backend session and account checks remain decisive.

Verification commands are `npm run typecheck`, `npm run test:unit`, and
`npm run build`. Next.js 16 removed `next lint`; Clarin has no configured ESLint
baseline, and type checking must not be presented as a lint run.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
