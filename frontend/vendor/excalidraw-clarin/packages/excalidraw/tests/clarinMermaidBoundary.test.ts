import { describe, expect, it, vi } from "vitest";
import { isMaybeMermaidDefinition, isMermaidEnabled, loadMermaidParser } from "../mermaid";

const parser = vi.hoisted(() => ({ loaded: vi.fn(), parse: vi.fn() }));
vi.mock("@excalidraw/mermaid-to-excalidraw", () => {
  parser.loaded();
  return { parseMermaidToExcalidraw: parser.parse };
});

describe("Clarin Mermaid capability boundary", () => {
  it("does not even import the parser for disabled or absent capability", async () => {
    for (const enabled of [false, undefined]) {
      expect(isMermaidEnabled(enabled)).toBe(false);
      await expect(loadMermaidParser(enabled)).rejects.toThrow("disabled by the host");
    }
    expect(parser.loaded).not.toHaveBeenCalled();
    expect(parser.parse).not.toHaveBeenCalled();
  });

  it("recognizes diagram text without changing it, for ordinary text fallback", () => {
    const text = "graph TD\n A[Cuenta A] --> B[Cuenta B]";
    expect(isMaybeMermaidDefinition(text)).toBe(true);
    expect(isMermaidEnabled(false) && isMaybeMermaidDefinition(text)).toBe(false);
    expect(text).toBe("graph TD\n A[Cuenta A] --> B[Cuenta B]");
    expect(isMaybeMermaidDefinition("Una nota normal")).toBe(false);
  });

  it("enables local Mermaid independently from the disabled AI capability", async () => {
    const aiEnabled = false;
    const mermaidEnabled = true;
    expect(aiEnabled).toBe(false);
    expect(isMermaidEnabled(mermaidEnabled)).toBe(true);
    const api = await loadMermaidParser(true);
    expect(parser.loaded).toHaveBeenCalledTimes(1);
    expect(api.parseMermaidToExcalidraw).not.toBe(parser.parse);
    expect(parser.parse).not.toHaveBeenCalled();
  });
});
