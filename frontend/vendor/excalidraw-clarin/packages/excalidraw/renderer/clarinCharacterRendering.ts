import { SVG_NS } from "../constants";
import type { ExcalidrawTextElement } from "../element/types";
import { CLARIN_TEXT_MARK } from "../element/clarinRichText";
import { getClarinCharacterLineMetrics } from "../element/clarinCharacterLayout";
import { getFontFamilyString } from "../utils";
import { getClarinVisualLineLayouts } from "./clarinParagraphAlignment";

/** One positioned run model for editable geometry and both export renderers. */
export const getClarinPositionedCharacterGroups = (element: ExcalidrawTextElement) => {
  const alignments = getClarinVisualLineLayouts(element);
  return getClarinCharacterLineMetrics(element).map((line, index) => {
    const alignment = alignments[index]?.textAlign || element.textAlign;
    let x = alignment === "center" ? (element.width - line.width) / 2
      : alignment === "right" ? element.width - line.width : 0;
    const hasNativePositions = line.groups.every((group) => group.nativeX !== undefined);
    const groups = hasNativePositions ? line.groups : line.groups[0]?.rtl ? [...line.groups].reverse() : line.groups;
    const origin = x;
    return groups.map((group) => {
      const positioned = { ...group, x: hasNativePositions ? origin + group.nativeX! : x,
        top: line.top, height: line.height, baseline: line.baseline };
      x += group.width;
      return positioned;
    });
  });
};

export const getClarinPositionedCharacterRuns = (element: ExcalidrawTextElement) =>
  getClarinPositionedCharacterGroups(element).map((groups) => groups.flatMap((group) => {
    const segments = group.segments.map(({ run, clips }) => ({
      ...run, x: group.x + Math.min(...clips.map((clip) => clip.x)),
      width: clips.reduce((width, clip) => width + clip.width, 0),
      baseline: group.baseline, rtl: group.rtl,
    }));
    return group.rtl ? segments.sort((left, right) => left.x - right.x) : segments;
  }));

export const getClarinCharacterRasterBounds = (
  bounds: { left: number; top: number; right: number; bottom: number },
  transform: Pick<DOMMatrix, "a" | "b" | "c" | "d" | "e" | "f">,
  canvasWidth: number,
  canvasHeight: number,
) => {
  const points = [[bounds.left, bounds.top], [bounds.right, bounds.top],
    [bounds.left, bounds.bottom], [bounds.right, bounds.bottom]].map(([x, y]) => ({
      x: transform.a * x + transform.c * y + transform.e,
      y: transform.b * x + transform.d * y + transform.f,
    }));
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x))) - 1);
  const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))) - 1);
  const right = Math.min(canvasWidth, Math.ceil(Math.max(...points.map((point) => point.x))) + 1);
  const bottom = Math.min(canvasHeight, Math.ceil(Math.max(...points.map((point) => point.y))) + 1);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
};

type PositionedGroup = ReturnType<typeof getClarinPositionedCharacterGroups>[number][number];

/**
 * Color masks live on an isolated, cropped surface. Source-atop preserves the
 * original glyph alpha exactly, including fractional clips and 50% opacity;
 * it must never run on the shared scene canvas. The target transform is copied
 * with an integer device-pixel offset to avoid raster resampling or blur.
 */
const drawIsolatedCharacterGroup = (context: CanvasRenderingContext2D, group: PositionedGroup) => {
  if (typeof context.getTransform !== "function" || !context.canvas) return false;
  const transform = context.getTransform();
  const x = group.rtl ? group.x + group.width : group.x;
  const shapingText = group.shapingText ?? group.text;
  const metrics = context.measureText(shapingText);
  const size = group.segments[0].run.fontSize;
  const left = Math.min(group.x, x - (metrics.actualBoundingBoxLeft || 0)) - 2;
  const right = Math.max(group.x + group.width, x + (metrics.actualBoundingBoxRight || 0)) + 2;
  const top = group.baseline - (metrics.actualBoundingBoxAscent || size * 2) - 2;
  const bottom = group.baseline + (metrics.actualBoundingBoxDescent || size) + 2;
  const crop = getClarinCharacterRasterBounds({ left, top, right, bottom }, transform, context.canvas.width, context.canvas.height);
  if (!crop) return true;
  const bitmap = document.createElement("canvas");
  bitmap.width = crop.width; bitmap.height = crop.height;
  try {
    const paint = bitmap.getContext("2d");
    if (!paint) return false;
    paint.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e - crop.left, transform.f - crop.top);
    paint.font = group.font; paint.textAlign = context.textAlign;
    paint.textBaseline = context.textBaseline; paint.direction = group.rtl ? "rtl" : "ltr";
    paint.fillStyle = group.segments[0].run.color;
    paint.fillText(shapingText, x, group.baseline);
    paint.globalCompositeOperation = "source-atop";
    for (const { run, clips } of group.segments) {
      paint.save(); paint.beginPath();
      for (const clip of clips) {
        const from = clip.x <= 0.01 ? Math.min(left - group.x, -size) : clip.x;
        const to = clip.x + clip.width >= group.width - 0.01
          ? Math.max(right - group.x, group.width + size) : clip.x + clip.width;
        paint.rect(group.x + from, top, to - from, bottom - top);
      }
      paint.clip(); paint.fillStyle = run.color;
      paint.fillRect(left, top, right - left, bottom - top);
      paint.restore();
    }
    context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(bitmap, crop.left, crop.top); context.restore();
    return true;
  } finally { bitmap.width = 0; bitmap.height = 0; }
};

export const drawClarinCharacterText = (
  context: CanvasRenderingContext2D,
  element: ExcalidrawTextElement,
) => {
  for (const groups of getClarinPositionedCharacterGroups(element)) {
    for (const group of groups) {
      context.textAlign = group.rtl ? "right" : "left";
      context.direction = group.rtl ? "rtl" : "ltr";
      context.textBaseline = "alphabetic";
      context.font = group.font;
      const x = group.rtl ? group.x + group.width : group.x;
      const colors = new Set(group.segments.map(({ run }) => run.color));
      if (colors.size === 1) {
        context.fillStyle = group.segments[0].run.color;
        context.fillText(group.shapingText ?? group.text, x, group.baseline);
      } else if (!drawIsolatedCharacterGroup(context, group)) for (const { run, clips } of group.segments) {
        context.save();
        context.beginPath();
        const transform = typeof context.getTransform === "function" ? context.getTransform() : null;
        const edge = 0.5 / Math.max(0.01, transform ? Math.hypot(transform.a, transform.b) : 1);
        for (const clip of clips) {
          // Fractional native advances must not leave an antialiased seam.
          // The outermost color also owns glyph ink beyond its advance box.
          const left = clip.x <= edge ? -run.fontSize : clip.x - edge;
          const right = clip.x + clip.width >= group.width - edge
            ? group.width + run.fontSize : clip.x + clip.width + edge;
          context.rect(group.x + left, group.top - group.height, right - left, group.height * 3);
        }
        context.clip();
        context.fillStyle = run.color;
        // Shape the complete group on every paint pass. Clipping changes only
        // its color, preserving ligatures, kerning and cursive joining.
        context.fillText(group.shapingText ?? group.text, x, group.baseline);
        context.restore();
      }
      for (const { run, clips } of group.segments) {
        context.fillStyle = run.color;
        const thickness = Math.max(1, run.fontSize / 16);
        for (const clip of clips) {
          if (run.marks & CLARIN_TEXT_MARK.UNDERLINE) {
            context.fillRect(group.x + clip.x, group.baseline + run.fontSize * 0.08, clip.width, thickness);
          }
          if (run.marks & CLARIN_TEXT_MARK.STRIKE) {
            context.fillRect(group.x + clip.x, group.baseline - run.fontSize * 0.3, clip.width, thickness);
          }
        }
      }
    }
  }
};

let characterMaskSequence = 0;

export const appendClarinCharacterSvgText = (
  owner: Document,
  node: SVGElement,
  element: ExcalidrawTextElement,
) => {
  for (const groups of getClarinPositionedCharacterGroups(element)) {
    for (const group of groups) {
      const text = owner.createElementNS(SVG_NS, "text");
      text.setAttribute("style", "white-space: pre;");
      text.setAttribute("dominant-baseline", "alphabetic");
      text.setAttribute("direction", group.rtl ? "rtl" : "ltr");
      text.setAttribute("x", String(group.rtl ? group.x + group.width : group.x));
      text.setAttribute("y", String(group.baseline));
      text.setAttribute("text-anchor", "start");
      const first = group.segments[0].run;
      text.setAttribute("font-family", getFontFamilyString(first));
      text.setAttribute("font-size", `${first.fontSize}px`);
      if (first.marks & CLARIN_TEXT_MARK.BOLD) text.setAttribute("font-weight", "700");
      if (first.marks & CLARIN_TEXT_MARK.ITALIC) text.setAttribute("font-style", "italic");
      text.textContent = group.shapingText ?? group.text;
      const rectangle = (parent: SVGElement, color: string, x: number, y: number, width: number, height: number) => {
        const rect = owner.createElementNS(SVG_NS, "rect");
        for (const [key, value] of Object.entries({ x, y, width, height, fill: color })) rect.setAttribute(key, String(value));
        parent.appendChild(rect);
      };
      const colors = new Set(group.segments.map(({ run }) => run.color));
      if (colors.size === 1) {
        text.setAttribute("fill", first.color); node.appendChild(text);
      } else {
        // Firefox also splits shaping across fill-only tspans. A single native
        // text mask keeps vector glyphs/ligatures intact in every browser.
        const defs = owner.createElementNS(SVG_NS, "defs");
        const mask = owner.createElementNS(SVG_NS, "mask");
        const maskId = `clarin-character-mask-${++characterMaskSequence}`;
        const left = group.x - first.fontSize * 2;
        const right = group.x + group.width + first.fontSize * 2;
        const top = group.baseline - first.fontSize * 2;
        const height = first.fontSize * 4;
        for (const [key, value] of Object.entries({ id: maskId, x: left, y: top,
          width: right - left, height, maskUnits: "userSpaceOnUse", style: "mask-type: alpha;" })) mask.setAttribute(key, String(value));
        text.setAttribute("fill", "#FFFFFF"); mask.appendChild(text); defs.appendChild(mask); node.appendChild(defs);
        const paint = owner.createElementNS(SVG_NS, "g");
        paint.setAttribute("mask", `url(#${maskId})`);
        rectangle(paint, first.color, left, top, right - left, height);
        for (const { run, clips } of group.segments) for (const clip of clips) {
          const from = clip.x <= 0.01 ? left : group.x + clip.x;
          const to = clip.x + clip.width >= group.width - 0.01 ? right : group.x + clip.x + clip.width;
          rectangle(paint, run.color, from, top, to - from, height);
        }
        node.appendChild(paint);
      }
      for (const { run, clips } of group.segments) for (const clip of clips) {
        const thickness = Math.max(1, run.fontSize / 16);
        if (run.marks & CLARIN_TEXT_MARK.UNDERLINE) rectangle(node, run.color,
          group.x + clip.x, group.baseline + run.fontSize * 0.08, clip.width, thickness);
        if (run.marks & CLARIN_TEXT_MARK.STRIKE) rectangle(node, run.color,
          group.x + clip.x, group.baseline - run.fontSize * 0.3, clip.width, thickness);
      }
    }
  }
};
