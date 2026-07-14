import { describe, expect, it } from "vitest";
import { createStableId, normalizeSemanticText, serializeEvidenceGraph, canonicalizeEvidenceGraph } from "../src/intelligence/stable-id.js";
import type { EvidenceGraph } from "../src/intelligence/model.js";

const hash = "a".repeat(64);
const graph = (): EvidenceGraph => ({ metadata: { schemaVersion: "1.0", repositoryName: "repo", repositoryCommit: "commit", task: "task" }, sources: [{ id: "s", sourceType: "code", relativePath: "src/a.ts", sha256: hash, authority: "high" }], evidence: [{ id: "e", sourceId: "s", startLine: 1, endLine: 1, excerpt: "x", excerptHash: hash }], segments: [], rules: [{ id: "r", statement: "x", normalizedSubject: "x", normalizedAction: "use", polarity: "require", scope: { include: [], exclude: [], technologies: [], taskKeywords: [] }, evidenceIds: ["e"] }], findings: [{ id: "f", kind: "convention", summary: "x", evidenceIds: ["e"], affectedRuleIds: ["r"], severity: "info", status: "open", explanation: "x" }], recommendations: [{ id: "rec", statement: "x", applicability: { include: [], exclude: [], technologies: [], taskKeywords: [] }, confidence: { level: "high", score: 100, reasons: ["x"], penalties: [] }, evidenceIds: ["e"], supportingFindingIds: ["f"], contradictingFindingIds: [], exceptions: [], explanation: "x" }] });

describe("stable IDs", () => {
  it("normalizes line endings, whitespace, and case while preserving negation", () => expect(normalizeSemanticText("  Do NOT\r\n remove; no!  ")).toBe("do not remove; no!"));
  it("normalizes LF and CRLF deterministically", () => {
    const lf = "Use\nthis rule.";
    const crlf = "Use\r\nthis rule.";
    expect(normalizeSemanticText(lf)).toBe(normalizeSemanticText(crlf));
    expect(normalizeSemanticText(lf)).toBe(normalizeSemanticText(lf));
  });
  it("is deterministic, key-order independent, and exact", () => { const a = createStableId("rule", [{ b: 2, a: 1 }, "src/file.ts"]); expect(a).toBe(createStableId("rule", [{ a: 1, b: 2 }, "src/file.ts"])); expect(a).toMatch(/^rule_[0-9a-f]{12}$/); expect(a).not.toBe(createStableId("rule", [{ a: 2, b: 1 }, "src/file.ts"])); });
  it("preserves the order of generic ID components", () => expect(createStableId("rule", ["first", "second"])).not.toBe(createStableId("rule", ["second", "first"])));
  it("canonicalizes reordered graph collections", () => {
    const value = graph();
    value.sources.push({ id: "s2", sourceType: "code", relativePath: "src/b.ts", sha256: hash, authority: "high" });
    value.evidence.push({ id: "e2", sourceId: "s2", startLine: 2, endLine: 2, excerpt: "y", excerptHash: hash });
    const shuffled = structuredClone(value);
    shuffled.sources.reverse();
    shuffled.evidence.reverse();
    expect(serializeEvidenceGraph(value)).toBe(serializeEvidenceGraph(shuffled));
  });
  it("canonicalizes every required set-like array", () => {
    const value = graph();
    value.rules[0].scope = { include: ["b", "a"], exclude: ["d", "c"], technologies: ["t2", "t1"], taskKeywords: ["k2", "k1"] };
    value.rules[0].evidenceIds = ["e2", "e1"];
    value.findings[0].evidenceIds = ["e2", "e1"];
    value.findings[0].affectedRuleIds = ["r2", "r1"];
    value.recommendations[0].evidenceIds = ["e2", "e1"];
    value.recommendations[0].supportingFindingIds = ["f2", "f1"];
    value.recommendations[0].contradictingFindingIds = ["f4", "f3"];
    value.recommendations[0].confidence.reasons = ["z", "a", "z"];
    value.recommendations[0].confidence.penalties = ["y", "b", "y"];
    const shuffled = structuredClone(value);
    shuffled.rules[0].scope.include.reverse();
    shuffled.rules[0].scope.exclude.reverse();
    shuffled.rules[0].scope.technologies.reverse();
    shuffled.rules[0].scope.taskKeywords.reverse();
    shuffled.rules[0].evidenceIds.reverse();
    shuffled.findings[0].evidenceIds.reverse();
    shuffled.findings[0].affectedRuleIds.reverse();
    shuffled.recommendations[0].evidenceIds.reverse();
    shuffled.recommendations[0].supportingFindingIds.reverse();
    shuffled.recommendations[0].contradictingFindingIds.reverse();
    shuffled.recommendations[0].confidence.reasons.reverse();
    shuffled.recommendations[0].confidence.penalties.reverse();
    expect(serializeEvidenceGraph(value)).toBe(serializeEvidenceGraph(shuffled));
  });
  it("canonicalization does not mutate the original graph", () => {
    const value = graph();
    value.rules[0].scope.include = ["b", "a"];
    value.rules[0].evidenceIds = ["e", "e"];
    const before = JSON.stringify(value);
    const canonical = canonicalizeEvidenceGraph(value);
    expect(JSON.stringify(value)).toBe(before);
    expect(canonical).not.toBe(value);
  });
  it("uses only repository-relative ID components", () => {
    const components = ["src/a.ts", hash] as const;
    expect(components.every((component) => !component.startsWith("/"))).toBe(true);
    expect(createStableId("source", components)).toMatch(/^source_[0-9a-f]{12}$/);
  });
  it("ends with exactly one newline and repeats byte-identically", () => { const output = serializeEvidenceGraph(graph()); expect(output.endsWith("\n")).toBe(true); expect(output.endsWith("\n\n")).toBe(false); expect(output).toBe(serializeEvidenceGraph(graph())); });
});
