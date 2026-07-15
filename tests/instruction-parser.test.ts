import { describe, expect, it } from "vitest";
import { parseInstructionSegments } from "../src/intelligence/parse-instructions.js";
import type { EvidenceSource, SourceSegment } from "../src/intelligence/model.js";

const source: EvidenceSource = { id: "s", sourceType: "instruction", relativePath: "AGENTS.md", sha256: "a".repeat(64), authority: "high" };
const seg = (id: string, raw: string, kind: SourceSegment["kind"] = "directive", line = Number(id)): SourceSegment => ({ id, sourceId: "s", kind, startLine: line, endLine: line + 1, rawExcerpt: raw, normalizedText: raw, excerptHash: id.repeat(64).slice(0, 64) });

describe("instruction parser coverage", () => {
  it("REQ-PARSER-22 derives subject from under phrase", () => {
    const result = parseInstructionSegments([source], [seg("22", "Use middleware under deployment controls")]);
    expect(result.rules[0]?.normalizedSubject).toBe("deployment controls");
  });

  it("REQ-PARSER-27 repeats stable evidence ID", () => {
    const input = [seg("27", "Must use tests")];
    expect(parseInstructionSegments([source], input).evidence[0]?.id).toBe(parseInstructionSegments([source], input).evidence[0]?.id);
  });

  it("REQ-PARSER-28 repeats stable rule ID", () => {
    const input = [seg("28", "Must use tests")];
    expect(parseInstructionSegments([source], input).rules[0]?.id).toBe(parseInstructionSegments([source], input).rules[0]?.id);
  });

  it("covers all directive parsing requirements", () => {
    const segments = [seg("1", "- Never use mustard."), seg("2", "12. Do not use a dependency"), seg("3", "Avoid the cache"), seg("4", "Always use TypeScript"), seg("5", "Must use tests"), seg("6", "Prefer server actions"), seg("7", "May use mocks"), seg("8", "Plain text", "paragraph"), seg("9", "```Never use x```", "code-block"), seg("10", ""), seg("11", "Use the existing middleware layer for API security controls"), seg("12", "Implement rate limiting in every API handler"), seg("13", "Use middleware for API security controls"), seg("14", "Do not add a rate-limiting dependency"), seg("15", "Mustard is not a directive"), { ...seg("16", "Use missing"), sourceId: "missing" }];
    const original = structuredClone(segments); const result = parseInstructionSegments([source], segments); const get = (s: string) => result.rules.find((r) => r.statement === s)!;
    expect([get("Never use mustard").polarity, get("Never use mustard").strength]).toEqual(["prohibit", "absolute"]); expect([get("Do not use a dependency").polarity, get("Do not use a dependency").strength]).toEqual(["prohibit", "required"]); expect([get("Avoid the cache").polarity, get("Avoid the cache").strength]).toEqual(["avoid", "preferred"]); expect([get("Always use TypeScript").polarity, get("Always use TypeScript").strength]).toEqual(["require", "absolute"]); expect([get("Must use tests").polarity, get("Must use tests").strength]).toEqual(["require", "required"]); expect([get("Prefer server actions").polarity, get("Prefer server actions").strength]).toEqual(["prefer", "preferred"]); expect([get("May use mocks").polarity, get("May use mocks").strength]).toEqual(["allow", "permitted"]);
    expect(result.rules.some((r) => r.statement === "Plain text")).toBe(false); expect(result.rules.some((r) => r.statement.includes("Never use x"))).toBe(false); expect(result.rules.some((r) => r.statement === "Mustard is not a directive")).toBe(false); expect(get("Do not add a rate-limiting dependency").normalizedAction).toBe("add rate limiting dependency"); expect(get("Use the existing middleware layer for API security controls").normalizedAction).toBe("existing middleware layer for api security controls"); expect(get("Use middleware for API security controls").normalizedSubject).toBe("api security controls"); expect(get("Implement rate limiting in every API handler").normalizedSubject).toBe("every api handler"); expect(get("Do not add a rate-limiting dependency").normalizedSubject).toBe("rate limiting dependency"); expect(result.rules.every((r) => r.normalizedSubject.length > 0)).toBe(true);
    const ev = result.evidence.find((e) => e.id === get("Never use mustard").evidenceIds[0])!; expect(ev.startLine).toBe(1); expect(ev.endLine).toBe(2); expect(ev.excerpt).toBe(segments[0].rawExcerpt); expect(ev.id).toMatch(/^evidence_/); expect(get("Never use mustard").id).toMatch(/^rule_/); expect(get("Never use mustard").evidenceIds).toEqual([ev.id]);
    const duplicates = parseInstructionSegments([source], [seg("20", "Must use tests", "directive", 20), seg("21", "Must use tests", "directive", 21)]); expect(duplicates.rules).toHaveLength(2); expect(new Set(duplicates.rules.map((r) => r.id)).size).toBe(2); expect(new Set(duplicates.evidence.map((e) => e.id)).size).toBe(2); expect(result).toEqual(parseInstructionSegments([source], [...segments].reverse())); expect(segments).toEqual(original); expect(result.rules.every((r) => !r.id.includes("/"))).toBe(true); expect(result.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining(["Source not found", "Empty normalized statement", "Directive polarity could not be classified"]));
  });
});
