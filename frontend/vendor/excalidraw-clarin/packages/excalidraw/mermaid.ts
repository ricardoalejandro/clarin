/** Clarin: every parser entry point must pass this capability boundary. */
export const isMermaidEnabled = (mermaidEnabled: boolean | undefined) => mermaidEnabled === true;

let localParseQueue = Promise.resolve();

function prefixedMermaidIdSelector(selector: string): { selector: string; id: string; qualifier: string } | null {
  const hash = selector.match(/^#(.+)$/u);
  if (hash) return { selector: `[id$=${JSON.stringify(`-${hash[1]}`)}]`, id: hash[1], qualifier: "" };
  const attribute = selector.match(/^([a-z][a-z0-9-]*)?\[id=(["'])(.*?)\2\](.*)$/iu);
  if (attribute) {
    const qualifier = `${attribute[1] || ""}${attribute[4] || ""}`;
    return {
      selector: `${attribute[1] || ""}[id$=${JSON.stringify(`-${attribute[3]}`)}]${attribute[4] || ""}`,
      id: attribute[3],
      qualifier,
    };
  }
  return null;
}

/**
 * Mermaid 11.16 prefixes rendered SVG ids with the per-render id. The stable
 * converter still queries the pre-11.16 ids for Class/ER nodes and otherwise
 * falls back to a non-editable SVG. Scope the compatibility lookup to its
 * private off-screen container and restore the platform method immediately.
 */
async function parseWithLocalIdCompatibility<T>(task: () => Promise<T>): Promise<T> {
  const run = localParseQueue.then(async () => {
    if (typeof Element === "undefined") return task();
    const original = Element.prototype.querySelector;
    Element.prototype.querySelector = function (this: Element, selectors: string): Element | null {
      let found: Element | null = null;
      try {
        found = original.call(this, selectors);
      } catch (error) {
        if (!(this instanceof HTMLElement) || !this.id.startsWith("mermaid-to-excalidraw-") || !this.id.endsWith("-container")) throw error;
      }
      if (found || !(this instanceof HTMLElement) || !this.id.startsWith("mermaid-to-excalidraw-") || !this.id.endsWith("-container")) return found;
      const compatible = prefixedMermaidIdSelector(selectors);
      if (!compatible) return null;
      const selected = original.call(this, compatible.selector);
      if (selected) return selected;
      const classBase = compatible.id.match(/^(classId-.+)-\d+$/u)?.[1];
      return Array.from(this.querySelectorAll("[id]")).find(candidate => {
        const exactSuffix = candidate.id.endsWith(`-${compatible.id}`);
        const equivalentClassId = Boolean(classBase && new RegExp(`-${classBase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-\\d+$`, "u").test(candidate.id));
        return (exactSuffix || equivalentClassId) && (!compatible.qualifier || candidate.matches(compatible.qualifier));
      }) || null;
    } as typeof Element.prototype.querySelector;
    try {
      return await task();
    } finally {
      Element.prototype.querySelector = original;
    }
  });
  localParseQueue = run.then(() => undefined, () => undefined);
  return run;
}

export const loadMermaidParser = async (mermaidEnabled: boolean | undefined) => {
  if (!isMermaidEnabled(mermaidEnabled)) {
    throw new Error("Mermaid conversion is disabled by the host");
  }
  const parser = await import("@excalidraw/mermaid-to-excalidraw");
  return {
    ...parser,
    parseMermaidToExcalidraw: (...args: Parameters<typeof parser.parseMermaidToExcalidraw>) =>
      parseWithLocalIdCompatibility(() => parser.parseMermaidToExcalidraw(...args)),
  };
};

/** heuristically checks whether the text may be a mermaid diagram definition */
export const isMaybeMermaidDefinition = (text: string) => {
  const chartTypes = [
    "flowchart",
    "graph",
    "sequenceDiagram",
    "classDiagram",
    "stateDiagram",
    "stateDiagram-v2",
    "erDiagram",
    "journey",
    "gantt",
    "pie",
    "quadrantChart",
    "requirementDiagram",
    "gitGraph",
    "C4Context",
    "mindmap",
    "timeline",
    "zenuml",
    "sankey",
    "xychart",
    "block",
  ];

  const re = new RegExp(
    `^(?:%%{.*?}%%[\\s\\n]*)?\\b(?:${chartTypes
      .map((x) => `\\s*${x}(-beta)?`)
      .join("|")})\\b`,
  );

  return re.test(text.trim());
};
