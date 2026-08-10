#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCENE_SUFFIXES = [/\.excalidraw$/i, /\.excalidraw\.json$/i];
const LIBRARY_SUFFIXES = [/\.excalidrawlib$/i, /\.excalidrawlib\.json$/i];
const SCENE_ROOT_KEYS = new Set(["type", "version", "source", "elements", "appState", "files"]);
const LIBRARY_ROOT_KEYS = new Set(["type", "version", "source", "libraryItems"]);
const DURABLE_APP_STATE_KEYS = ["gridSize", "gridStep", "gridModeEnabled", "viewBackgroundColor"];
const EXTENSION_KEY = /^(?:clarin|future|unknown|x[-_])/i;

function usage() {
  console.log(`Usage:
  run-compat-fixtures.mjs --fixtures DIR [options]

Options:
  --adapter FILE           ES module exporting roundTripScene and roundTripLibrary
  --allow-external-files   Permit element fileIds absent from the fixture files map
  --json FILE              Write a machine-readable report
  --help                   Show this help

Fixture files may end in .excalidraw, .excalidraw.json, .excalidrawlib, or
.excalidrawlib.json. The runner never modifies fixtures. Scene adapters export
roundTripScene(scene, context) or normalizeScene(scene, context); adapters used
with library fixtures must also export roundTripLibrary(library, context) or
normalizeLibrary(library, context). Exit status is 2 when any fixture fails.`);
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const args = { allowExternalFiles: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--fixtures") args.fixtures = requiredValue(argv, ++index, token);
    else if (token === "--adapter") args.adapter = requiredValue(argv, ++index, token);
    else if (token === "--allow-external-files") args.allowExternalFiles = true;
    else if (token === "--json") args.json = requiredValue(argv, ++index, token);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function listFixtureFiles(root) {
  const files = [];
  function walk(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of readdirSync(path).sort()) walk(resolve(path, entry));
    } else if (info.isFile() && [...SCENE_SUFFIXES, ...LIBRARY_SUFFIXES].some((pattern) => pattern.test(path))) {
      files.push(path);
    }
  }
  walk(root);
  return files;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function stableString(value) {
  return JSON.stringify(stable(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fileMetadataProjection(value) {
  if (Array.isArray(value)) return value.map(fileMetadataProjection);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["dataURL", "url", "src"].includes(key))
    .map(([key, child]) => [key, fileMetadataProjection(child)]));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fixtureKind(path, value) {
  if (LIBRARY_SUFFIXES.some((pattern) => pattern.test(path)) || value?.type === "excalidrawlib") return "library";
  return "scene";
}

function rootExtensions(value, knownKeys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !knownKeys.has(key)));
}

function compatibilityExtensions(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => EXTENSION_KEY.test(key)));
}

function elementProjection(element) {
  return {
    id: element.id,
    type: element.type,
    isDeleted: element.isDeleted ?? false,
    groupIds: element.groupIds ?? [],
    frameId: element.frameId ?? null,
    containerId: element.containerId ?? null,
    boundElements: element.boundElements ?? null,
    startBinding: element.startBinding ?? null,
    endBinding: element.endBinding ?? null,
    fileId: element.fileId ?? null,
    link: element.link ?? null,
    customData: element.customData ?? null,
    extensions: compatibilityExtensions(element),
  };
}

function durableAppStateProjection(appState) {
  if (!isRecord(appState)) return {};
  return Object.fromEntries(DURABLE_APP_STATE_KEYS.flatMap((key) => Object.hasOwn(appState, key) ? [[key, appState[key]]] : []));
}

function sceneCriticalProjection(scene) {
  return {
    type: scene.type,
    elementOrder: scene.elements.map((element) => element.id),
    elements: scene.elements.map(elementProjection),
    appState: durableAppStateProjection(scene.appState),
    files: fileMetadataProjection(scene.files ?? {}),
    rootExtensions: rootExtensions(scene, SCENE_ROOT_KEYS),
  };
}

function libraryItemProjection(item, index) {
  if (Array.isArray(item)) {
    return { legacyIndex: index, elementOrder: item.map((element) => element.id), elements: item.map(elementProjection) };
  }
  return {
    id: item.id,
    status: item.status ?? null,
    created: item.created ?? null,
    name: item.name ?? null,
    elementOrder: item.elements.map((element) => element.id),
    elements: item.elements.map(elementProjection),
    extensions: compatibilityExtensions(item),
  };
}

function libraryCriticalProjection(library) {
  return {
    type: library.type,
    version: library.version,
    source: library.source,
    items: library.libraryItems.map(libraryItemProjection),
    rootExtensions: rootExtensions(library, LIBRARY_ROOT_KEYS),
  };
}

function criticalProjection(value, kind) {
  return kind === "library" ? libraryCriticalProjection(value) : sceneCriticalProjection(value);
}

function validateFiles(files, label) {
  const errors = [];
  if (!isRecord(files)) return [`${label} must be an object`];
  for (const [fileID, value] of Object.entries(files)) {
    if (!fileID) errors.push(`${label} contains an empty file id`);
    if (!isRecord(value)) {
      errors.push(`${label}.${fileID} must be an object`);
      continue;
    }
    if (value.id !== undefined && value.id !== fileID) errors.push(`${label}.${fileID}.id must match its map key`);
    if (value.dataURL !== undefined && (typeof value.dataURL !== "string" || !value.dataURL.startsWith("data:"))) {
      errors.push(`${label}.${fileID}.dataURL must be an inline data URL in an import fixture`);
    }
  }
  return errors;
}

function validateElementCollection(elements, label, files, options) {
  const errors = [];
  if (!Array.isArray(elements)) return [`${label} must be an array`];
  const ids = new Set();
  for (const [index, element] of elements.entries()) {
    if (!isRecord(element)) {
      errors.push(`${label}[${index}] must be an object`);
      continue;
    }
    const identity = element.id ?? index;
    if (typeof element.id !== "string" || element.id.length === 0) errors.push(`${label}[${index}] has no string id`);
    else if (ids.has(element.id)) errors.push(`${label} has duplicate element id ${element.id}`);
    else ids.add(element.id);
    if (typeof element.type !== "string" || element.type.length === 0) errors.push(`${label}[${index}] has no type`);
    if (element.link != null && (typeof element.link !== "string" || !/^(?:https?:\/\/|mailto:)/i.test(element.link))) {
      errors.push(`${label} element ${identity} has a non-permitted link protocol`);
    }
    if (!options.allowExternalFiles && element.fileId != null && !Object.hasOwn(files, element.fileId)) {
      errors.push(`${label} element ${identity} references missing file ${element.fileId}`);
    }
  }
  return errors;
}

function referencedFileIDs(elements) {
  return [...new Set(elements.filter((element) => isRecord(element) && element.isDeleted !== true && typeof element.fileId === "string" && element.fileId).map((element) => element.fileId))].sort();
}

function validateClarinFileExtension(scene) {
  const clarin = isRecord(scene.clarin) ? scene.clarin : null;
  if (!clarin) return [];
  const manifest = isRecord(clarin.assetManifest) ? clarin.assetManifest : clarin;
  const hasFileIDs = Object.hasOwn(manifest, "fileIds");
  const hasFiles = Object.hasOwn(manifest, "files");
  if (!hasFileIDs && !hasFiles) return [];
  const errors = [];
  if (!Array.isArray(manifest.fileIds) || manifest.fileIds.some((id) => typeof id !== "string" || !id)) {
    errors.push("clarin asset manifest fileIds must be an array of non-empty strings");
    return errors;
  }
  if (!isRecord(manifest.files)) {
    errors.push("clarin asset manifest files must be an object");
    return errors;
  }
  const declared = [...new Set(manifest.fileIds)].sort();
  if (declared.length !== manifest.fileIds.length) errors.push("clarin asset manifest fileIds must be unique");
  const metadataIDs = Object.keys(manifest.files).sort();
  const references = referencedFileIDs(scene.elements);
  if (stableString(declared) !== stableString(metadataIDs)) errors.push("clarin asset manifest fileIds and files keys differ");
  if (stableString(declared) !== stableString(references)) errors.push("clarin asset manifest does not exactly match live element fileIds");
  for (const fileID of declared) {
    const metadata = manifest.files[fileID];
    if (!isRecord(metadata)) errors.push(`clarin asset manifest files.${fileID} must be an object`);
    else if (metadata.id !== undefined && metadata.id !== fileID) errors.push(`clarin asset manifest files.${fileID}.id must match its key`);
  }
  return errors;
}

function validateScene(scene, options) {
  const errors = [];
  if (!isRecord(scene)) return ["scene must be an object"];
  if (scene.type !== "excalidraw") errors.push(`type must be excalidraw, got ${JSON.stringify(scene.type)}`);
  if (!Number.isInteger(scene.version) || scene.version < 0) errors.push("version must be a non-negative integer");
  if (scene.appState !== undefined && !isRecord(scene.appState)) errors.push("appState must be an object when present");
  if (scene.files !== undefined && !isRecord(scene.files)) errors.push("files must be an object when present");
  const files = isRecord(scene.files) ? scene.files : {};
  errors.push(...validateFiles(files, "files"));
  errors.push(...validateElementCollection(scene.elements, "elements", files, options));
  if (Array.isArray(scene.elements)) errors.push(...validateClarinFileExtension(scene));
  return errors;
}

function validateLibrary(library, options) {
  const errors = [];
  if (!isRecord(library)) return ["library must be an object"];
  if (library.type !== "excalidrawlib") errors.push(`type must be excalidrawlib, got ${JSON.stringify(library.type)}`);
  if (library.version !== 1 && library.version !== 2) errors.push("library version must be 1 or 2");
  if (!Array.isArray(library.libraryItems)) return [...errors, "libraryItems must be an array"];
  const itemIDs = new Set();
  for (const [index, rawItem] of library.libraryItems.entries()) {
    const item = Array.isArray(rawItem) ? { elements: rawItem } : rawItem;
    if (!isRecord(item)) {
      errors.push(`libraryItems[${index}] must be an object or legacy element array`);
      continue;
    }
    if (!Array.isArray(rawItem)) {
      if (typeof item.id !== "string" || !item.id) errors.push(`libraryItems[${index}] has no string id`);
      else if (itemIDs.has(item.id)) errors.push(`duplicate library item id ${item.id}`);
      else itemIDs.add(item.id);
    }
    const itemFiles = isRecord(item.clarin) && isRecord(item.clarin.files) ? item.clarin.files : {};
    errors.push(...validateFiles(itemFiles, `libraryItems[${index}].clarin.files`));
    errors.push(...validateElementCollection(item.elements, `libraryItems[${index}].elements`, itemFiles, {
      ...options,
      allowExternalFiles: options.allowExternalFiles || Object.keys(itemFiles).length === 0,
    }));
  }
  return errors;
}

function validateFixture(value, kind, options) {
  return kind === "library" ? validateLibrary(value, options) : validateScene(value, options);
}

async function loadAdapter(rawPath) {
  if (!rawPath) {
    const structural = async (value) => clone(value);
    return { name: "JSON structural round trip", scene: structural, library: structural };
  }
  const path = resolve(rawPath);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Adapter not found: ${path}`);
  const module = await import(`${pathToFileURL(path).href}?compat=${Date.now()}`);
  const scene = module.roundTripScene ?? module.normalizeScene ?? module.roundTripFixture;
  const library = module.roundTripLibrary ?? module.normalizeLibrary ?? module.roundTripFixture;
  return {
    name: module.adapterName || path,
    scene: typeof scene === "function" ? scene : null,
    library: typeof library === "function" ? library : null,
  };
}

async function runFixture(path, root, adapter, args) {
  const file = relative(root, path).replaceAll("\\", "/");
  const errors = [];
  let kind = "scene";
  try {
    const source = JSON.parse(readFileSync(path, "utf8"));
    kind = fixtureKind(path, source);
    errors.push(...validateFixture(source, kind, args).map((message) => `source: ${message}`));
    if (errors.length > 0) return { file, kind, status: "FAIL", errors };
    const adapterFn = adapter[kind];
    if (typeof adapterFn !== "function") {
      errors.push(`adapter does not export a ${kind} round-trip function`);
      return { file, kind, status: "FAIL", errors };
    }

    const first = await adapterFn(clone(source), { file, kind, pass: 1 });
    errors.push(...validateFixture(first, kind, args).map((message) => `first pass: ${message}`));
    if (errors.length === 0 && stableString(criticalProjection(source, kind)) !== stableString(criticalProjection(first, kind))) {
      errors.push("critical IDs, ordering, relationships, links, extensions, durable appState, or files changed");
    }

    if (errors.length === 0) {
      const second = await adapterFn(clone(first), { file, kind, pass: 2 });
      errors.push(...validateFixture(second, kind, args).map((message) => `second pass: ${message}`));
      if (stableString(first) !== stableString(second)) errors.push("adapter is not idempotent after the first pass");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { file, kind, status: errors.length === 0 ? "PASS" : "FAIL", errors };
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
  if (!args.fixtures) throw new Error("--fixtures is required");
  const root = resolve(args.fixtures);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Fixture directory not found: ${root}`);
  const files = listFixtureFiles(root);
  if (files.length === 0) throw new Error(`No Excalidraw scene or library fixtures found in ${root}`);
  const adapter = await loadAdapter(args.adapter);
  const results = [];
  for (const path of files) results.push(await runFixture(path, root, adapter, args));
  const failures = results.filter((result) => result.status === "FAIL");
  const byKind = Object.fromEntries(["scene", "library"].map((kind) => {
    const selected = results.filter((result) => result.kind === kind);
    return [kind, { total: selected.length, passed: selected.filter((result) => result.status === "PASS").length }];
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    fixtures: root,
    adapter: adapter.name,
    allowExternalFiles: args.allowExternalFiles,
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    byKind,
    decision: failures.length === 0 ? "PASS" : "FAIL",
    results,
  };
  if (args.json) writeJson(args.json, report);
  console.log(`Decision: ${report.decision}`);
  console.log(`Fixtures: ${report.passed}/${report.total} passed with ${adapter.name} (${byKind.scene.passed}/${byKind.scene.total} scenes, ${byKind.library.passed}/${byKind.library.total} libraries)`);
  for (const result of failures) for (const error of result.errors) console.log(`FAIL: ${result.file}: ${error}`);
  process.exit(failures.length > 0 ? 2 : 0);
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  usage();
  process.exit(1);
}
