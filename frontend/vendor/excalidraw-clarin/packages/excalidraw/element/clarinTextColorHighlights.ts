/** Paint-only color/decorations keep WebKit kerning and contextual shaping intact. */
export interface ClarinTextColorPatch { node: Text; from: number; to: number; color: string; marks?: number }
type HighlightValue = { clear(): void };
type HighlightRegistry = { set(name: string, value: HighlightValue): unknown; delete(name: string): unknown };
type HighlightRuntime = { registry: HighlightRegistry; Highlight: new (...ranges: Range[]) => HighlightValue };
type ColorSession = { registry: HighlightRegistry; names: string[]; values: HighlightValue[]; ranges: Range[]; style: HTMLStyleElement };
const sessions = new WeakMap<HTMLElement, ColorSession>();
let nextSession = 0;

const runtimeFor = (editable: HTMLElement): HighlightRuntime | null => {
  const view = editable.ownerDocument.defaultView as (Window & {
    CSS?: { highlights?: HighlightRegistry }; Highlight?: HighlightRuntime["Highlight"];
  }) | null;
  const registry = view?.CSS?.highlights; const Highlight = view?.Highlight;
  return registry && typeof registry.set === "function" && typeof registry.delete === "function" && typeof Highlight === "function"
    ? { registry, Highlight } : null;
};
export const supportsClarinTextColorHighlights = (editable: HTMLElement) => Boolean(runtimeFor(editable));

export const clearClarinTextColorHighlights = (editable: HTMLElement) => {
  const session = sessions.get(editable);
  sessions.delete(editable);
  delete editable.dataset.clarinColorSession;
  if (!session) return;
  for (const name of session.names) session.registry.delete(name);
  for (const value of session.values) value.clear();
  for (const range of session.ranges) {
    // Empty even references temporarily held by native highlight inspection.
    try { range.setStart(editable.ownerDocument, 0); range.collapse(true); range.detach(); } catch { /* Already released. */ }
  }
  session.names.length = 0; session.values.length = 0; session.ranges.length = 0;
  session.style.remove();
};

/** Called centrally before an editor/board/account surface is reset or removed. */
export const clearClarinTextColorsWithin = (root: HTMLElement | null) => {
  if (!root) return;
  if (root.hasAttribute("data-clarin-color-session")) clearClarinTextColorHighlights(root);
  for (const editable of root.querySelectorAll<HTMLElement>("[data-clarin-color-session]")) clearClarinTextColorHighlights(editable);
};

export const applyClarinTextColorHighlights = (editable: HTMLElement, patches: readonly ClarinTextColorPatch[]): boolean => {
  clearClarinTextColorHighlights(editable);
  const runtime = runtimeFor(editable);
  if (!runtime) return false;
  const valid = patches.filter(({ node, from, to, color, marks }) => /^#[0-9a-f]{6}$/i.test(color)
    && node.ownerDocument === editable.ownerDocument && editable.contains(node)
    && Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to && to <= node.length
    && (marks === undefined || Number.isInteger(marks) && marks >= 0 && marks <= 15));
  if (!valid.length) return true;
  const id = (++nextSession).toString(36);
  const style = editable.ownerDocument.createElement("style");
  style.dataset.clarinTextColors = id;
  const session: ColorSession = { registry: runtime.registry, names: [], values: [], ranges: [], style };
  sessions.set(editable, session); editable.dataset.clarinColorSession = id;
  try {
    const colors = new Map<string, { color: string; decoration: string; ranges: Range[] }>();
    for (const patch of valid) {
      const range = editable.ownerDocument.createRange(); range.setStart(patch.node, patch.from); range.setEnd(patch.node, patch.to);
      session.ranges.push(range);
      const color = patch.color.toUpperCase();
      const paintMarks = (patch.marks ?? 0) & 12;
      const decoration = [paintMarks & 4 ? "underline" : "", paintMarks & 8 ? "line-through" : ""].filter(Boolean).join(" ") || "none";
      const key = `${color}|${paintMarks}`;
      const paint = colors.get(key) ?? { color, decoration, ranges: [] }; paint.ranges.push(range); colors.set(key, paint);
    }
    const rules: string[] = [];
    for (const { color, decoration, ranges } of colors.values()) {
      const name = `clarin-text-color-${id}-${session.names.length}`;
      const highlight = new runtime.Highlight(...ranges);
      session.names.push(name); session.values.push(highlight); runtime.registry.set(name, highlight);
      // Names are generated identifiers; color is validated six-digit hex.
      rules.push(`::highlight(${name}) { color: ${color}; text-decoration-color: ${color}; text-decoration-line: ${decoration}; }`);
    }
    style.textContent = rules.join("\n");
    (editable.ownerDocument.head ?? editable.ownerDocument.documentElement).appendChild(style);
    return true;
  } catch { clearClarinTextColorHighlights(editable); return false; }
};
