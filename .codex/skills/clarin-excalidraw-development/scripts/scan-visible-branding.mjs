#!/usr/bin/env node

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_POLICY = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../references/visible-branding-policy.json",
);
const SCANNABLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".txt",
]);
const MAX_STATIC_FILE_SIZE = 30 * 1024 * 1024;

function usage() {
  console.log(`Usage:
  scan-visible-branding.mjs (--snapshot FILE | --root PATH)... [options]

Inputs:
  --snapshot FILE       JSON con superficies, texto y acciones visibles (repetible)
  --root PATH           Artefacto o directorio local que no debe contener marca visible (repetible)
  --policy FILE         Política auditable; por defecto references/visible-branding-policy.json
  --json FILE           Escribe el informe en JSON
  --help                Muestra esta ayuda

Los avisos legales sólo se excluyen cuando su basename aparece expresamente en
legalArtifactBasenames. El estado es 2 con infracciones y 0 cuando pasa.`);
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseBrandingArgs(argv) {
  const args = { snapshots: [], roots: [], policy: DEFAULT_POLICY };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--snapshot") args.snapshots.push(requiredValue(argv, ++index, token));
    else if (token === "--root") args.roots.push(requiredValue(argv, ++index, token));
    else if (token === "--policy") args.policy = requiredValue(argv, ++index, token);
    else if (token === "--json") args.json = requiredValue(argv, ++index, token);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`${label} inválido (${path}): ${error.message}`);
  }
}

function normalizeHost(value) {
  return String(value).trim().toLowerCase().replace(/^\*\./u, "").replace(/\.$/u, "");
}

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function compileTextRule(rule) {
  if (!rule || typeof rule.id !== "string" || typeof rule.pattern !== "string" || typeof rule.reason !== "string") {
    throw new Error("Cada regla forbiddenVisibleText requiere id, pattern y reason.");
  }
  if (!/^[a-z0-9-]+$/u.test(rule.id)) throw new Error(`ID de regla inválido: ${rule.id}`);
  let expression;
  try {
    expression = new RegExp(rule.pattern, rule.flags || "u");
  } catch (error) {
    throw new Error(`Regex inválida en ${rule.id}: ${error.message}`);
  }
  return { ...rule, expression };
}

export function validateBrandingPolicy(rawPolicy) {
  if (!rawPolicy || rawPolicy.schemaVersion !== 1 || typeof rawPolicy.policyId !== "string") {
    throw new Error("La política de branding debe declarar schemaVersion 1 y policyId.");
  }
  if (!Array.isArray(rawPolicy.legalArtifactBasenames) || rawPolicy.legalArtifactBasenames.length === 0) {
    throw new Error("La política debe declarar legalArtifactBasenames de forma explícita.");
  }
  const legalArtifactBasenames = new Set();
  for (const value of rawPolicy.legalArtifactBasenames) {
    if (
      typeof value !== "string"
      || value.length === 0
      || basename(value) !== value
      || /[*?\[\]{}]/u.test(value)
      || value === "."
      || value === ".."
    ) {
      throw new Error(`Excepción legal inválida; sólo se permite un basename exacto: ${String(value)}`);
    }
    if (legalArtifactBasenames.has(value)) throw new Error(`Excepción legal duplicada: ${value}`);
    legalArtifactBasenames.add(value);
  }
  if (!Array.isArray(rawPolicy.forbiddenVisibleText) || rawPolicy.forbiddenVisibleText.length === 0) {
    throw new Error("La política debe incluir forbiddenVisibleText.");
  }
  const ruleIds = new Set();
  const rules = rawPolicy.forbiddenVisibleText.map((rule) => {
    const compiled = compileTextRule(rule);
    if (ruleIds.has(compiled.id)) throw new Error(`Regla duplicada: ${compiled.id}`);
    ruleIds.add(compiled.id);
    return compiled;
  });
  const actions = rawPolicy.forbiddenVisibleActions;
  if (!actions || !Array.isArray(actions.testIds) || !Array.isArray(actions.classTokens) || !Array.isArray(actions.hrefRules)) {
    throw new Error("forbiddenVisibleActions debe declarar testIds, classTokens y hrefRules.");
  }
  const hrefRules = actions.hrefRules.map((rule) => {
    if (!rule || typeof rule.id !== "string" || typeof rule.hostSuffix !== "string" || typeof rule.pathPattern !== "string") {
      throw new Error("Cada hrefRule requiere id, hostSuffix y pathPattern.");
    }
    let pathExpression;
    try {
      pathExpression = new RegExp(rule.pathPattern, "iu");
    } catch (error) {
      throw new Error(`Regex de ruta inválida en ${rule.id}: ${error.message}`);
    }
    return { ...rule, hostSuffix: normalizeHost(rule.hostSuffix), pathExpression };
  });
  return {
    ...rawPolicy,
    legalArtifactBasenames,
    forbiddenVisibleText: rules,
    forbiddenVisibleActions: {
      testIds: new Set(actions.testIds),
      classTokens: new Set(actions.classTokens),
      hrefRules,
    },
  };
}

export function loadBrandingPolicy(path = DEFAULT_POLICY) {
  return validateBrandingPolicy(readJson(path, "Política de branding"));
}

function textViolations(value, source, policy) {
  if (typeof value !== "string" || value.length === 0) return [];
  const violations = [];
  for (const rule of policy.forbiddenVisibleText) {
    rule.expression.lastIndex = 0;
    const match = rule.expression.exec(value);
    if (!match) continue;
    violations.push({
      source,
      rule: rule.id,
      reason: rule.reason,
      value: match[0].replace(/\s+/gu, " ").slice(0, 180),
    });
  }
  return violations;
}

function normalizeClassTokens(action) {
  if (Array.isArray(action.classNames)) return action.classNames.map(String);
  if (typeof action.className === "string") return action.className.split(/\s+/u).filter(Boolean);
  return [];
}

function actionViolations(action, source, policy) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return [];
  const violations = [];
  const testId = String(action.testId ?? action.dataTestId ?? "");
  if (policy.forbiddenVisibleActions.testIds.has(testId)) {
    violations.push({ source, rule: "forbidden-action-testid", reason: `Acción upstream visible: data-testid=${testId}`, value: testId });
  }
  for (const token of normalizeClassTokens(action)) {
    if (!policy.forbiddenVisibleActions.classTokens.has(token)) continue;
    violations.push({ source, rule: "forbidden-action-class", reason: `Acción upstream visible: class=${token}`, value: token });
  }
  if (typeof action.href === "string" && /^(?:https?):\/\//iu.test(action.href)) {
    let parsed = null;
    try {
      parsed = new URL(action.href);
    } catch {
      parsed = null;
    }
    const hrefRule = parsed
      ? policy.forbiddenVisibleActions.hrefRules.find((candidate) => {
          candidate.pathExpression.lastIndex = 0;
          return hostMatches(normalizeHost(parsed.hostname), candidate.hostSuffix)
            && candidate.pathExpression.test(`${parsed.pathname}${parsed.search}${parsed.hash}`);
        })
      : null;
    if (hrefRule) {
      violations.push({
        source,
        rule: "forbidden-action-href",
        reason: `Acción visible enlaza a la ruta upstream ${hrefRule.id}`,
        value: action.href,
      });
    }
  }
  for (const field of ["text", "accessibleName", "ariaLabel", "label", "title"]) {
    violations.push(...textViolations(action[field], `${source}.${field}`, policy));
  }
  return violations;
}

export function scanBrandingSnapshot(rawSnapshot, policy, snapshotLabel = "snapshot") {
  if (!rawSnapshot || rawSnapshot.schemaVersion !== 1 || !Array.isArray(rawSnapshot.surfaces) || rawSnapshot.surfaces.length === 0) {
    throw new Error(`${snapshotLabel} debe contener schemaVersion 1 y al menos una superficie visible.`);
  }
  const violations = [];
  let visibleTextEntries = 0;
  let visibleActions = 0;
  for (const [surfaceIndex, surface] of rawSnapshot.surfaces.entries()) {
    if (!surface || typeof surface.name !== "string" || !Array.isArray(surface.visibleText) || !Array.isArray(surface.visibleActions)) {
      throw new Error(`${snapshotLabel}.surfaces[${surfaceIndex}] no cumple el contrato de trace visible.`);
    }
    const surfaceLabel = `${snapshotLabel}#${surface.name}`;
    for (const [index, value] of surface.visibleText.entries()) {
      visibleTextEntries += 1;
      violations.push(...textViolations(value, `${surfaceLabel}.visibleText[${index}]`, policy));
    }
    for (const [index, action] of surface.visibleActions.entries()) {
      visibleActions += 1;
      violations.push(...actionViolations(action, `${surfaceLabel}.visibleActions[${index}]`, policy));
    }
  }
  return { surfaces: rawSnapshot.surfaces.length, visibleTextEntries, visibleActions, violations };
}

function listFiles(path) {
  const root = resolve(path);
  const files = [];
  function walk(current) {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      const name = basename(current);
      if (current !== root && [".git", "node_modules"].includes(name)) return;
      for (const entry of readdirSync(current).sort()) walk(resolve(current, entry));
      return;
    }
    if (info.isFile()) files.push(current);
  }
  walk(root);
  return { root, files };
}

export function scanBrandingRoot(rawPath, policy) {
  const { root, files } = listFiles(rawPath);
  const violations = [];
  let scannedFiles = 0;
  let legalFiles = 0;
  for (const file of files) {
    if (policy.legalArtifactBasenames.has(basename(file))) {
      legalFiles += 1;
      continue;
    }
    if (!SCANNABLE_EXTENSIONS.has(extname(file).toLowerCase()) || statSync(file).size > MAX_STATIC_FILE_SIZE) continue;
    const content = readFileSync(file);
    if (content.subarray(0, Math.min(content.length, 8192)).includes(0)) continue;
    scannedFiles += 1;
    const label = `${rawPath}:${relative(root, file).replaceAll("\\", "/") || basename(file)}`;
    violations.push(...textViolations(content.toString("utf8"), label, policy));
  }
  return { root, files: files.length, scannedFiles, legalFiles, violations };
}

function dedupe(items) {
  return [...new Map(items.map((item) => [`${item.source}\0${item.rule}\0${item.value}`, item])).values()]
    .sort((left, right) => `${left.source}${left.rule}${left.value}`.localeCompare(`${right.source}${right.rule}${right.value}`));
}

export function buildBrandingReport({ snapshots = [], roots = [], policy, policyPath = DEFAULT_POLICY }) {
  const snapshotResults = snapshots.map(({ label, value }) => ({ label, ...scanBrandingSnapshot(value, policy, label) }));
  const rootResults = roots.map((path) => scanBrandingRoot(path, policy));
  const violations = dedupe([
    ...snapshotResults.flatMap((item) => item.violations),
    ...rootResults.flatMap((item) => item.violations),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    policyId: policy.policyId,
    policyPath: resolve(policyPath),
    snapshots: snapshotResults.map(({ violations: _violations, ...item }) => item),
    roots: rootResults.map(({ violations: _violations, ...item }) => item),
    violations,
    decision: violations.length === 0 ? "PASS" : "FAIL",
  };
}

function writeJson(path, report) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function runBrandingCli(argv = process.argv.slice(2)) {
  const args = parseBrandingArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (args.snapshots.length === 0 && args.roots.length === 0) throw new Error("Provide at least one --snapshot or --root");
  const policy = loadBrandingPolicy(args.policy);
  const report = buildBrandingReport({
    policy,
    policyPath: args.policy,
    roots: args.roots,
    snapshots: args.snapshots.map((path) => ({ label: resolve(path), value: readJson(path, "Snapshot de branding") })),
  });
  if (args.json) writeJson(args.json, report);
  console.log(`Branding decision: ${report.decision}`);
  console.log(
    `Scanned: ${report.snapshots.reduce((sum, item) => sum + item.surfaces, 0)} visible surface(s), `
      + `${report.snapshots.reduce((sum, item) => sum + item.visibleActions, 0)} visible action(s), `
      + `${report.roots.reduce((sum, item) => sum + item.scannedFiles, 0)} static file(s); `
      + `${report.roots.reduce((sum, item) => sum + item.legalFiles, 0)} legal artifact(s) preserved`,
  );
  for (const item of report.violations) {
    console.log(`VIOLATION: ${item.rule} ${item.source} ${item.value} (${item.reason})`);
  }
  return report.violations.length > 0 ? 2 : 0;
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  try {
    process.exitCode = runBrandingCli();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    usage();
    process.exitCode = 1;
  }
}
