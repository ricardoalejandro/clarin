import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildBrandingReport,
  loadBrandingPolicy,
  scanBrandingRoot,
  scanBrandingSnapshot,
  validateBrandingPolicy,
} from "./scan-visible-branding.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const skillDirectory = resolve(scriptDirectory, "..");
const policy = loadBrandingPolicy(resolve(skillDirectory, "references/visible-branding-policy.json"));

function fixture(name) {
  return JSON.parse(readFileSync(resolve(skillDirectory, "assets", name), "utf8"));
}

test("permite la UI Clarin y los tokens de compatibilidad .excalidraw", () => {
  const result = scanBrandingSnapshot(
    fixture("branding-clean-visible-snapshot.json"),
    policy,
    "clean-visible-snapshot",
  );
  assert.equal(result.surfaces, 1);
  assert.equal(result.visibleActions, 2);
  assert.deepEqual(result.violations, []);
});

test("bloquea marca, catálogo público y acciones upstream realmente visibles", () => {
  const result = scanBrandingSnapshot(
    fixture("branding-upstream-visible-snapshot.json"),
    policy,
    "upstream-visible-snapshot",
  );
  const rules = new Set(result.violations.map((item) => item.rule));
  assert.ok(rules.has("upstream-product-name"));
  assert.ok(rules.has("upstream-public-library-browser"));
  assert.ok(rules.has("upstream-library-publishing"));
  assert.ok(rules.has("forbidden-action-testid"));
  assert.ok(rules.has("forbidden-action-class"));
  assert.ok(rules.has("forbidden-action-href"));
});

test("permite enlaces http explícitos ajenos al proyecto upstream", () => {
  const result = scanBrandingSnapshot({
    schemaVersion: 1,
    surfaces: [{
      name: "user-links",
      visibleText: ["Enlaces añadidos por el usuario"],
      visibleActions: [
        { tag: "a", href: "https://github.com/cuenta-cliente/manual", accessibleName: "Manual" },
        { tag: "a", href: "https://x.com/cuenta-cliente", accessibleName: "Perfil" },
        { tag: "a", href: "https://youtube.com/watch?v=abc", accessibleName: "Vídeo" },
      ],
    }],
  }, policy, "user-links");
  assert.deepEqual(result.violations, []);
});

test("conserva avisos MIT exactos pero bloquea la misma marca en un artefacto de producto", () => {
  const root = mkdtempSync(join(tmpdir(), "clarin-whiteboard-branding-"));
  try {
    mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, "vendor", "LICENSE"), "Excalidraw\nMIT License\n", "utf8");
    writeFileSync(join(root, "vendor", "NOTICE.md"), "Copyright (c) Excalidraw\n", "utf8");
    writeFileSync(join(root, "manifest.json"), "{\"product\":\"Pizarras Clarin\"}\n", "utf8");
    const clean = scanBrandingRoot(root, policy);
    assert.equal(clean.legalFiles, 2);
    assert.equal(clean.scannedFiles, 1);
    assert.deepEqual(clean.violations, []);

    writeFileSync(join(root, "product-ui.js"), "const label = 'Made with Excalidraw';\n", "utf8");
    const leaked = scanBrandingRoot(root, policy);
    assert.equal(leaked.legalFiles, 2);
    assert.equal(leaked.violations.length, 1);
    assert.equal(leaked.violations[0].rule, "upstream-product-name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rechaza traces vacíos y políticas que amplían implícitamente las excepciones", () => {
  assert.throws(
    () => scanBrandingSnapshot({ schemaVersion: 1, surfaces: [] }, policy, "empty"),
    /al menos una superficie visible/u,
  );
  assert.throws(
    () => validateBrandingPolicy({
      schemaVersion: 1,
      policyId: "broken",
      legalArtifactBasenames: [],
      forbiddenVisibleText: [],
      forbiddenVisibleActions: { testIds: [], classTokens: [], hrefRules: [] },
    }),
    /legalArtifactBasenames/u,
  );
  assert.throws(
    () => validateBrandingPolicy({
      schemaVersion: 1,
      policyId: "wildcard-legal-exception",
      legalArtifactBasenames: ["*"],
      forbiddenVisibleText: [{ id: "brand", pattern: "excalidraw", flags: "iu", reason: "test" }],
      forbiddenVisibleActions: { testIds: [], classTokens: [], hrefRules: [] },
    }),
    /basename exacto/u,
  );
});

test("el informe combina artefactos y snapshots con decisión reproducible", () => {
  const report = buildBrandingReport({
    policy,
    policyPath: resolve(skillDirectory, "references/visible-branding-policy.json"),
    snapshots: [{ label: "clean", value: fixture("branding-clean-visible-snapshot.json") }],
    roots: [resolve(skillDirectory, "assets")],
  });
  assert.equal(report.policyId, "clarin-whiteboards-visible-branding-v1");
  assert.equal(report.decision, "FAIL");
  assert.ok(report.violations.some((item) => item.source.includes("branding-upstream-visible-snapshot.json")));
});
