#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";

function usage() {
  console.log(`Usage:
  verify-third-party-notices.mjs [options]

Options:
  --notices FILE           Notice file (default: THIRD_PARTY_NOTICES.md)
  --component-notice FILE  Canonical component notice to include (repeatable)
  --package DIR            Extracted distributed package to verify (repeatable)
  --json FILE              Write a machine-readable report
  --help                   Show this help

Without --package, the script validates the prepared Excalidraw notice. With a
package, it also checks package license files and requires every bundled font
family to be named in the notice. Exit status is 2 on a compliance blocker.`);
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const args = { notices: "THIRD_PARTY_NOTICES.md", componentNotices: [], packages: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--notices") args.notices = requiredValue(argv, ++index, token);
    else if (token === "--component-notice") args.componentNotices.push(requiredValue(argv, ++index, token));
    else if (token === "--package") args.packages.push(requiredValue(argv, ++index, token));
    else if (token === "--json") args.json = requiredValue(argv, ++index, token);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse JSON ${path}: ${error.message}`);
  }
}

function listFiles(root) {
  const files = [];
  function walk(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      const base = basename(path);
      if ([".git", "node_modules"].includes(base) && path !== root) return;
      for (const entry of readdirSync(path).sort()) walk(resolve(path, entry));
    } else if (info.isFile()) files.push(path);
  }
  walk(root);
  return files;
}

function findLicenseFiles(root, files) {
  return files.filter((path) => /(^|[\\/])(licen[cs]e|copying|notice)(\.|$)/i.test(relative(root, path)));
}

function fontFamilyFromPath(root, path) {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  const parts = relativePath.split("/");
  const fontsIndex = parts.findIndex((part) => part.toLowerCase() === "fonts");
  const nestedFamily = fontsIndex >= 0 ? parts[fontsIndex + 1] : null;
  const genericDirectories = new Set(["assets", "dist", "font", "fonts", "otf", "prod", "static", "ttf", "woff", "woff2"]);
  if (nestedFamily && !/\.(?:otf|ttf|woff|woff2)$/i.test(nestedFamily) && !genericDirectories.has(nestedFamily.toLowerCase())) {
    return nestedFamily;
  }
  return basename(path, extname(path)).split(/[-_]/)[0];
}

function inspectPackage(rawPath, noticesText) {
  const root = resolve(rawPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Package directory not found: ${root}`);
  const packageJsonPath = resolve(root, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error(`package.json missing in ${root}`);
  const pkg = readJson(packageJsonPath);
  const files = listFiles(root);
  const licenseFiles = findLicenseFiles(root, files);
  const fontFiles = files.filter((path) => /\.(?:otf|ttf|woff|woff2)$/i.test(path));
  const fontFamilies = [...new Set(fontFiles.map((path) => fontFamilyFromPath(root, path)).filter(Boolean))].sort();
  const blockers = [];
  const warnings = [];

  if (!pkg.name || !noticesText.includes(pkg.name)) blockers.push(`Notice does not name package ${pkg.name ?? "unknown"}`);
  if (!pkg.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) blockers.push(`${pkg.name ?? root} has no exact semantic version`);
  if (!pkg.license) blockers.push(`${pkg.name ?? root} has no package license declaration`);
  if (licenseFiles.length === 0) warnings.push(`${pkg.name ?? root} has no bundled license/notice file; distribution relies on the canonical Clarin notice`);

  for (const path of licenseFiles) {
    const license = readFileSync(path, "utf8");
    if (/copyright/i.test(license) && !/permission|licensed|redistribution/i.test(license)) {
      warnings.push(`Review unusual license text in ${relative(root, path)}`);
    }
  }

  for (const family of fontFamilies) {
    if (!noticesText.toLowerCase().includes(family.toLowerCase())) blockers.push(`Bundled font family ${family} is absent from the notice`);
  }
  if (fontFiles.length > 0 && !/open font license|\bofl\b|font license/i.test(noticesText)) {
    blockers.push("Bundled font assets are present but no font-license notice is recorded");
  }
  if (fontFiles.length > 0 && /residual compliance item|riesgo residual/i.test(noticesText)) {
    warnings.push("The notice records unresolved per-font copyright or Reserved Font Name verification");
  }

  return {
    root,
    name: pkg.name ?? null,
    version: pkg.version ?? null,
    license: pkg.license ?? null,
    licenseFiles: licenseFiles.map((path) => relative(root, path).replaceAll("\\", "/")),
    fontFiles: fontFiles.length,
    fontFamilies,
    blockers,
    warnings,
  };
}

function writeJson(path, report) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const noticesPath = resolve(args.notices);
  if (!existsSync(noticesPath)) throw new Error(`Notice file not found: ${noticesPath}`);
  const noticesText = readFileSync(noticesPath, "utf8");
  const automaticComponentNotice = "frontend/THIRD_PARTY_EXCALIDRAW.md";
  if (noticesText.includes(automaticComponentNotice) && existsSync(resolve(automaticComponentNotice))) {
    args.componentNotices.push(automaticComponentNotice);
  }
  const componentNoticePaths = [...new Set(args.componentNotices.map((path) => resolve(path)))];
  for (const path of componentNoticePaths) if (!existsSync(path)) throw new Error(`Component notice not found: ${path}`);
  const combinedNoticesText = [noticesText, ...componentNoticePaths.map((path) => readFileSync(path, "utf8"))].join("\n\n");
  const blockers = [];
  const warnings = [];
  const requiredMarkers = [
    "@excalidraw/excalidraw",
    "https://github.com/excalidraw/excalidraw",
    "Copyright (c) 2020 Excalidraw",
    "The above copyright notice and this permission notice shall be included",
  ];
  for (const marker of requiredMarkers) if (!combinedNoticesText.includes(marker)) blockers.push(`Missing required notice marker: ${marker}`);
  if (existsSync(resolve("backend/internal/whiteboard/fractional_index.go"))) {
    for (const marker of ["fractional-indexing", "3.2.0", "CC0-1.0"]) {
      if (!combinedNoticesText.includes(marker)) blockers.push(`Missing fractional-indexing notice marker: ${marker}`);
    }
  }
  const requiredLegalFiles = [
    "frontend/third_party/excalidraw/FONT-NOTICES.md",
    "frontend/third_party/excalidraw/OFL-1.1.txt",
    "frontend/third_party/excalidraw/COMIC-SHANNS-MIT.txt",
  ];
  for (const legalFile of requiredLegalFiles) {
    const legalPath = resolve(legalFile);
    if (!existsSync(legalPath)) blockers.push(`Missing required font notice file: ${legalFile}`);
    else if (!noticesText.includes(legalFile)) blockers.push(`Third-party notice does not index required font notice file: ${legalFile}`);
  }
  const supplyChainBaselineFile = ".codex/skills/clarin-excalidraw-development/references/supply-chain-baseline.json";
  const supplyChainBaselinePath = resolve(supplyChainBaselineFile);
  if (existsSync(supplyChainBaselinePath)) {
    const baseline = readJson(supplyChainBaselinePath);
    if (!noticesText.includes(supplyChainBaselineFile)) blockers.push("Third-party notice does not index the supply-chain baseline");
    const baselineMarkers = [
      baseline.root?.name,
      baseline.root?.version,
      baseline.root?.integrity,
      String(baseline.root?.expectedComponentCount ?? ""),
      baseline.root?.expectedSbomSha256,
      baseline.audit?.observedAt,
    ].filter(Boolean);
    for (const marker of baselineMarkers) {
      if (!combinedNoticesText.includes(String(marker))) blockers.push(`Missing supply-chain notice marker: ${marker}`);
    }
    for (const advisory of baseline.advisories ?? []) {
      if (!combinedNoticesText.includes(advisory.id)) blockers.push(`Notice omits recorded advisory ${advisory.id}`);
    }
    for (const override of baseline.licenseOverrides ?? []) {
      for (const marker of [override.name, override.version, override.expression]) {
        if (!combinedNoticesText.includes(String(marker))) blockers.push(`Notice omits license-evidence marker ${marker}`);
      }
    }
    if (!/NO-GO/i.test(combinedNoticesText)) blockers.push("Notice does not record the current supply-chain release decision");
  }
  if (!/\bMIT\b/.test(combinedNoticesText)) blockers.push("Missing MIT license identifier");
  if (/\b(?:TODO|TBD|FIXME)\b|<version>|X\.Y\.Z/i.test(combinedNoticesText)) blockers.push("Notice contains an unresolved placeholder");
  if (!/Excalidraw Plus/i.test(combinedNoticesText)) warnings.push("Notice does not distinguish the MIT project from Excalidraw Plus");

  const packages = args.packages.map((path) => inspectPackage(path, combinedNoticesText));
  blockers.push(...packages.flatMap((item) => item.blockers));
  warnings.push(...packages.flatMap((item) => item.warnings));

  const report = {
    generatedAt: new Date().toISOString(),
    notices: noticesPath,
    componentNotices: componentNoticePaths,
    packages: packages.map(({ blockers: _blockers, warnings: _warnings, ...item }) => item),
    blockers: [...new Set(blockers)].sort(),
    warnings: [...new Set(warnings)].sort(),
  };
  report.decision = report.blockers.length === 0 ? "PASS" : "FAIL";
  if (args.json) writeJson(args.json, report);
  console.log(`Decision: ${report.decision}`);
  console.log(`Notice:   ${report.notices}`);
  for (const item of report.blockers) console.log(`BLOCKER: ${item}`);
  for (const item of report.warnings) console.log(`WARNING: ${item}`);
  process.exit(report.blockers.length > 0 ? 2 : 0);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  usage();
  process.exit(1);
}
