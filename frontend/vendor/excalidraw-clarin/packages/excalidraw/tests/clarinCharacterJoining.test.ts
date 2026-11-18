import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getClarinJoiningContext, getClarinJoiningType } from "../element/clarinCharacterJoining";
import { CLARIN_JOINING_RANGES } from "../element/clarinJoiningTypes18";

const ZWJ = "\u200D";
const context = (text: string, from: number, to: number, prefix = "", suffix = "") => {
  expect(getClarinJoiningContext(text, from, to)).toEqual({ prefix, suffix, shapingText: prefix + text.slice(from, to) + suffix });
};

describe("pinned Unicode 18 joining data", () => {
  it("preserves the audited compact ranges and official per-type cardinalities", () => {
    expect(CLRangesHash()).toBe("94c61d3088de42c0e1c4c0026a64863d37a273d7318bd9ea9c45936cbf53b1ca");
    expect(CLARIN_JOINING_RANGES).toHaveLength(533);
    const counts: Record<string, number> = {};
    let previous = -1;
    for (const [from, to, type] of CLARIN_JOINING_RANGES) {
      expect(from).toBeGreaterThan(previous);
      expect(to).toBeGreaterThanOrEqual(from);
      expect(to).toBeLessThanOrEqual(0x10FFFF);
      counts[type] = (counts[type] ?? 0) + to - from + 1;
      for (let point = from; point <= to; point++) expect(getClarinJoiningType(point)).toBe(type);
      if (from > previous + 1) expect(getClarinJoiningType(from - 1)).toBe("U");
      previous = to;
    }
    expect(counts).toEqual({ C: 7, D: 615, R: 153, L: 27, T: 2255 });
    expect(getClarinJoiningType(0x10FFFF)).toBe("U");
  });
  it("uses U for invalid values, unlisted controls, Latin, Hebrew and surrogate code points", () => {
    for (const point of [-1, NaN, Infinity, 1.5, 0x110000, 0x200C, 0x0020, 0x0041, 0x05D0, 0xD800, 0xDFFF]) {
      expect(getClarinJoiningType(point)).toBe("U");
    }
    expect(getClarinJoiningType(0x200D)).toBe("C");
    expect(getClarinJoiningType(0x10ED9)).toBe("L");
    expect(getClarinJoiningType(0xE0100)).toBe("T");
  });
});

function CLRangesHash() { return createHash("sha256").update(JSON.stringify(CLARIN_JOINING_RANGES)).digest("hex"); }

describe("display-only fragment joining context", () => {
  it("preserves both connections around the selected lam while respecting alef's one-sided joining", () => {
    const text = "سلام";
    context(text, 0, 1, "", ZWJ);
    context(text, 1, 2, ZWJ, ZWJ);
    context(text, 2, 3, ZWJ);
    context(text, 3, 4);
    context(text, 0, text.length);
    expect(text).toBe("سلام");
  });
  it("preserves lam-alef across typography boundaries without altering canonical offsets", () => {
    context("لا", 0, 1, "", ZWJ);
    context("لا", 1, 2, ZWJ);
    context("بلا", 1, 3, ZWJ);
    context("سلام", 1, 3, ZWJ);
  });
  it("implements the complete logical joining-type matrix", () => {
    const values = [["U", " "], ["C", "\u200D"], ["D", "ب"], ["L", "\uA872"], ["R", "ا"]] as const;
    for (const [beforeType, before] of values) for (const [afterType, after] of values) {
      const joins = ["D", "L", "C"].includes(beforeType) && ["D", "R", "C"].includes(afterType);
      context(before + after, before.length, before.length + after.length, joins ? ZWJ : "");
      context(before + after, 0, before.length, "", joins ? ZWJ : "");
    }
  });
  it("skips transparent marks on both sides of a boundary and handles a mark-only fragment", () => {
    context("بَِب", 3, 4, ZWJ);
    context("بَِب", 0, 1, "", ZWJ);
    context("بَِب", 1, 3, ZWJ, ZWJ);
    context("ب" + "\u0300".repeat(10000) + "ب", 10001, 10002, ZWJ);
    context("\u0300ب", 1, 2);
    context("ب\u0300", 0, 1);
  });
  it("treats ZWNJ, spaces, punctuation, newlines, emoji and nonjoining letters as hard boundaries", () => {
    for (const blocker of ["\u200C", " ", "،", "\n", "\r", "a", "א", "😀"]) {
      const text = "بَ" + blocker + "ِب";
      context(text, text.length - 1, text.length);
      context(text, 0, 1);
    }
    context("دب", 1, 2);
    context("بب", 0, 2);
  });
  it("retains explicit join-causing characters and joins Syriac, Mongolian and supplementary scripts", () => {
    context("ب\u200Dب", 2, 3, ZWJ);
    context("بـب", 2, 3, ZWJ);
    context("ܒܓ", 1, 2, ZWJ);
    context("ᠠᠡ", 1, 2, ZWJ);
    const first = String.fromCodePoint(0x1E900), transparent = String.fromCodePoint(0xE0100), second = String.fromCodePoint(0x1E901);
    const text = first + transparent + second;
    context(text, first.length + transparent.length, text.length, ZWJ);
    context(text, 0, first.length, "", ZWJ);
    const leftJoining = String.fromCodePoint(0x10ED9);
    context(leftJoining + "ب", leftJoining.length, leftJoining.length + 1, ZWJ);
    context("ب" + leftJoining, 0, 1);
  });
  it("fails closed for empty/invalid bounds and boundaries inside supplementary characters", () => {
    const text = "ب😀ب";
    for (const [from, to] of [[1, 1], [-1, 3], [0, 100], [3, 2], [1.5, 3], [NaN, 3], [2, 3], [1, 2]]) {
      context(text, from, to);
    }
    context("", 0, 0);
  });
});
