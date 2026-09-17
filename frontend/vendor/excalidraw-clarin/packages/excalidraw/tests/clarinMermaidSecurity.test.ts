import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMermaidParser } from "../mermaid";

const originalGetBBox = SVGElement.prototype.getBBox;

beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value() {
      const text = this.textContent || "";
      return { x: 0, y: 0, width: Math.max(8, text.length * 8), height: 18 };
    },
  });
});

afterAll(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: originalGetBBox,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("Clarin Mermaid local conversion security", () => {
  const parse = async (definition: string) => {
    const parser = await loadMermaidParser(true);
    return parser.parseMermaidToExcalidraw(definition);
  };

  it.each([
    ["flowchart", "flowchart TD\n A[Inicio] --> B[Fin]"],
    ["sequence", "sequenceDiagram\n Alice->>Bob: Hola"],
    ["class", "classDiagram\n class Cuenta {\n +String nombre\n }"],
    ["ER", "erDiagram\n CUENTA ||--o{ CONTACTO : contiene"],
  ])("converts %s into editable elements without network or SVG fallback", async (_kind, definition) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await parse(definition);
    expect(result.elements.length).toBeGreaterThan(0);
    expect(Object.keys(result.files || {})).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not emit executable links or active SVG payloads from hostile labels", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await parse(`sequenceDiagram
      participant A as <img src=x onerror=alert(1)>
      A->>B: <script>alert(1)</script>
    `);
    for (const element of result.elements as Array<{ link?: string | null }>) {
      expect(element.link || "").not.toMatch(/^javascript:/iu);
    }
    for (const file of Object.values(result.files || {}) as Array<{ dataURL?: string }>) {
      const payload = decodeURIComponent(file.dataURL || "");
      expect(payload).not.toMatch(/<script|onerror\s*=|javascript:/iu);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
