const DURABLE_APP_STATE_KEYS = ["gridSize", "gridStep", "gridModeEnabled", "viewBackgroundColor"];

export const adapterName = "Clarin Excalidraw 0.18.1 file-cycle adapter";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function durableAppState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(DURABLE_APP_STATE_KEYS.flatMap((key) => Object.hasOwn(source, key) ? [[key, clone(source[key])]] : []));
}

function safeFileMetadata(value) {
  if (Array.isArray(value)) return value.map(safeFileMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["dataURL", "url", "src"].includes(key))
    .map(([key, child]) => [key, safeFileMetadata(child)]));
}

export function openScene(scene) {
  return clone(scene);
}

export function editScene(scene) {
  return {
    ...clone(scene),
    appState: {
      ...clone(scene.appState || {}),
      selectedElementIds: { "compat-selection": true },
      scrollX: 999,
      scrollY: -999,
      futureEditorOnlyState: { transient: true },
    },
  };
}

export function saveScene(scene) {
  return {
    ...clone(scene),
    type: "excalidraw",
    version: 2,
    elements: clone(scene.elements || []),
    appState: durableAppState(scene.appState),
    files: safeFileMetadata(scene.files || {}),
  };
}

export function exportScene(scene) {
  return JSON.stringify(scene);
}

export function reopenScene(serialized) {
  return JSON.parse(serialized);
}

export async function roundTripScene(scene) {
  const opened = openScene(scene);
  const edited = editScene(opened);
  const saved = saveScene(edited);
  return reopenScene(exportScene(saved));
}

export async function roundTripLibrary(library) {
  return JSON.parse(JSON.stringify(clone(library)));
}
