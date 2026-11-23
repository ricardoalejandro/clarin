import { afterEach, describe, expect, it } from "vitest";
import { applyClarinTextColorHighlights, clearClarinTextColorHighlights, clearClarinTextColorsWithin, supportsClarinTextColorHighlights } from "../element/clarinTextColorHighlights";

class HighlightMock extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } }
const originalCSS = Object.getOwnPropertyDescriptor(window, "CSS");
const originalHighlight = Object.getOwnPropertyDescriptor(window, "Highlight");
const activeEditables = new Set<HTMLElement>();
const install = () => {
  const registry = new Map<string, HighlightMock>();
  Object.defineProperty(window, "CSS", { configurable: true, value: { highlights: registry } });
  Object.defineProperty(window, "Highlight", { configurable: true, value: HighlightMock });
  return registry;
};
const editable = (text = "AV private <text>") => {
  const root = document.createElement("div"); const node = document.createTextNode(text);
  root.appendChild(node); document.body.appendChild(root); activeEditables.add(root); return { root, node };
};
afterEach(() => {
  for (const root of activeEditables) clearClarinTextColorHighlights(root);
  activeEditables.clear(); document.body.replaceChildren();
  for (const style of document.querySelectorAll("[data-clarin-text-colors]")) style.remove();
  if (originalCSS) Object.defineProperty(window, "CSS", originalCSS); else Reflect.deleteProperty(window, "CSS");
  if (originalHighlight) Object.defineProperty(window, "Highlight", originalHighlight); else Reflect.deleteProperty(window, "Highlight");
});

describe("paint-only editor color sessions", () => {
  it("paints underline and strike independently from font shaping with allowlisted decoration values", () => {
    const registry = install(); const { root, node } = editable("AV");
    applyClarinTextColorHighlights(root, [{ node, from: 0, to: 1, color: "#123456", marks: 4 },
      { node, from: 1, to: 2, color: "#123456", marks: 8 }]);
    expect([...registry.values()].map(value => [...value].map(range => range.toString()))).toEqual([["A"], ["V"]]);
    const css = document.querySelector("[data-clarin-text-colors]")!.textContent!;
    expect(css).toContain("text-decoration-line: underline;"); expect(css).toContain("text-decoration-line: line-through;");
    expect(root.childNodes).toHaveLength(1);
  });
  it("colors ranges within one text node using only trusted hex CSS and generated names", () => {
    const registry = install(); const { root, node } = editable();
    expect(applyClarinTextColorHighlights(root, [{ node, from: 0, to: 1, color: "#ff0000" }, { node, from: 1, to: 2, color: "#112233" }])).toBe(true);
    const id = root.dataset.clarinColorSession!;
    expect([...registry.keys()]).toEqual([`clarin-text-color-${id}-0`, `clarin-text-color-${id}-1`]);
    expect([...registry.values()].map(value => [...value].map(range => range.toString()))).toEqual([["A"], ["V"]]);
    const css = document.querySelector<HTMLStyleElement>(`style[data-clarin-text-colors="${id}"]`)!.textContent!;
    expect(css).toContain("color: #FF0000;"); expect(css).toContain("color: #112233;"); expect(css).not.toContain("private");
    expect(root.childNodes).toHaveLength(1); expect(root.firstChild).toBe(node); expect(root.textContent).toBe("AV private <text>");
  });
  it("replaces prior ranges, registry entries and style nodes on every render", () => {
    const registry = install(); const { root, node } = editable();
    applyClarinTextColorHighlights(root, [{ node, from: 0, to: 1, color: "#FF0000" }]);
    const oldName = [...registry.keys()][0]; const oldHighlight = registry.get(oldName)!;
    const oldRange = [...oldHighlight][0]; const oldStyle = document.querySelector("[data-clarin-text-colors]")!;
    applyClarinTextColorHighlights(root, [{ node, from: 1, to: 2, color: "#0000FF" }]);
    expect(registry.has(oldName)).toBe(false); expect(oldHighlight.size).toBe(0); expect(oldRange.startContainer).toBe(document);
    expect(oldRange.toString()).toBe(""); expect(oldStyle.isConnected).toBe(false);
    expect(registry.size).toBe(1); expect(document.querySelectorAll("[data-clarin-text-colors]")).toHaveLength(1);
  });
  it("centrally releases all editors owned by a board without clearing another editor", () => {
    const registry = install(); const board = document.createElement("section"); document.body.appendChild(board);
    const first = editable("one"); const second = editable("two"); const neighbor = editable("other board");
    board.append(first.root, second.root);
    for (const entry of [first, second, neighbor]) applyClarinTextColorHighlights(entry.root, [{ node: entry.node, from: 0, to: 1, color: "#123456" }]);
    const neighborId = neighbor.root.dataset.clarinColorSession;
    clearClarinTextColorsWithin(board);
    expect(registry.size).toBe(1); expect([...registry.keys()][0]).toContain(`-${neighborId}-`);
    expect(first.root.dataset.clarinColorSession).toBeUndefined(); expect(second.root.dataset.clarinColorSession).toBeUndefined();
    expect(document.querySelectorAll("[data-clarin-text-colors]")).toHaveLength(1);
    clearClarinTextColorsWithin(neighbor.root); expect(registry.size).toBe(0);
  });
  it("rejects CSS payloads, invalid ranges and foreign text nodes", () => {
    const registry = install(); const { root, node } = editable(); const foreign = document.createTextNode("outside");
    applyClarinTextColorHighlights(root, [{ node, from: 0, to: 1, color: "red; background: url(x)" },
      { node, from: -1, to: 1, color: "#FF0000" }, { node, from: 0, to: 999, color: "#FF0000" },
      { node: foreign, from: 0, to: 1, color: "#FF0000" }]);
    expect(registry.size).toBe(0); expect(root.dataset.clarinColorSession).toBeUndefined();
    expect(document.querySelectorAll("[data-clarin-text-colors]")).toHaveLength(0);
  });
  it("cleans a partially registered session when the native API rejects it", () => {
    const registry = install(); const { root, node } = editable(); const set = registry.set.bind(registry); let calls = 0;
    registry.set = (name, value) => { if (++calls === 2) throw new Error("native API unavailable"); return set(name, value); };
    expect(applyClarinTextColorHighlights(root, [{ node, from: 0, to: 1, color: "#FF0000" }, { node, from: 1, to: 2, color: "#0000FF" }])).toBe(false);
    expect(registry.size).toBe(0); expect(root.dataset.clarinColorSession).toBeUndefined();
    expect(document.querySelectorAll("[data-clarin-text-colors]")).toHaveLength(0);
  });
  it("reports unsupported runtimes so the editor can preserve its functional fallback", () => {
    const { root, node } = editable();
    Object.defineProperty(window, "CSS", { configurable: true, value: {} });
    expect(supportsClarinTextColorHighlights(root)).toBe(false);
    expect(applyClarinTextColorHighlights(root, [{ node, from: 0, to: 1, color: "#123456" }])).toBe(false);
    expect(root.textContent).toBe(node.data); expect(document.querySelectorAll("[data-clarin-text-colors]")).toHaveLength(0);
  });
});
