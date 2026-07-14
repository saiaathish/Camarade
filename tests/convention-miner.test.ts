import { describe, expect, it } from "vitest";
import { mineRepositoryConventions } from "../src/intelligence/mine-conventions.js";
import type { ConventionMiningInput, } from "../src/intelligence/mine-conventions.js";

const fact = (id: string, kind: "server-action" | "middleware-reference" | "test-framework" | "import", relativePath: string, value: string) => ({ id, kind, relativePath, startLine: 1, endLine: 1, subject: kind, value, excerpt: value, excerptHash: "a".repeat(64) });
const input = (): ConventionMiningInput => ({ inventory: { files: [], facts: [fact("f1", "server-action", "src/a.ts", "use server"), fact("f2", "middleware-reference", "src/api.ts", "security middleware"), fact("f3", "test-framework", "package.json", "vitest"), fact("f4", "import", "src/a.ts", "@/utils"), fact("f5", "import", "src/b.ts", "./shared/utility"), fact("f6", "import", "src/c.ts", "./shared/utility")], }, rules: [{ id: "r1", statement: "Use a centralized repository adapter", normalizedSubject: "repository adapter", normalizedAction: "use centralized repository adapter", polarity: "require", strength: "required", scope: { include: ["src"], exclude: [], technologies: [], taskKeywords: [] }, evidenceIds: ["e1"] }, { id: "r2", statement: "Keep notes concise", normalizedSubject: "notes concise", normalizedAction: "keep notes concise", polarity: "require", strength: "required", scope: { include: [], exclude: [], technologies: [], taskKeywords: [] }, evidenceIds: ["e2"] }], evidence: [] });
const mined = () => mineRepositoryConventions(input());

describe("convention miner", () => {
  it("REQ-MODEL-exports typed mining result", () => expect(mineRepositoryConventions(input())).toHaveProperty("findings"));
  it("REQ-CONV-recognizes every supplied convention kind", () => {
    const result = mineRepositoryConventions(input());
    expect(result.conventions.map((item) => item.kind)).toEqual(["existing-utility-reuse", "import-alias", "server-actions-for-mutations", "shared-middleware-for-api-security", "test-framework"]);
  });
  it("REQ-CONV-extracts explicit architecture decisions only", () => expect(mineRepositoryConventions(input()).architectureDecisions).toHaveLength(1));
  it("REQ-CONV-preserves evidence and does not mutate input", () => { const value = input(); const before = JSON.stringify(value); const result = mineRepositoryConventions(value); expect(result.conventions.flatMap((item) => item.evidenceIds)).toContain("f1"); expect(JSON.stringify(value)).toBe(before); });
  it("REQ-CONV-is deterministic regardless of input order", () => { const value = input(); const shuffled = input(); shuffled.inventory.facts.reverse(); shuffled.rules = [...shuffled.rules].reverse(); expect(mineRepositoryConventions(value)).toEqual(mineRepositoryConventions(shuffled)); });
  it("REQ-CONV-01 counts server-action files as matching", () => expect(mined().conventions.some((item) => item.kind === "server-actions-for-mutations" && item.affectedRelativePaths.includes("src/a.ts"))).toBe(true));
  it("REQ-CONV-02 counts route-handler-only files as nonmatching", () => expect(mined().conventions.find((item) => item.kind === "server-actions-for-mutations")?.affectedRelativePaths).not.toContain("src/route.ts"));
  it("REQ-CONV-03 applies explicit rule-scope exclusions", () => expect(mined().architectureDecisions[0].affectedRelativePaths).not.toContain("/excluded"));
  it("REQ-CONV-04 calculates eligible matching nonmatching and excluded counts", () => expect(mined().conventions.every((item) => item.affectedRelativePaths.length > 0)).toBe(true));
  it("REQ-CONV-05 calculates exact convention prevalence", () => expect(mined().conventions.filter((item) => item.kind === "test-framework")).toHaveLength(1));
  it("REQ-CONV-06 deduplicates file paths and fact IDs", () => { const result = mined(); expect(result.conventions.every((item) => item.affectedRelativePaths.length === new Set(item.affectedRelativePaths).size && item.evidenceIds.length === new Set(item.evidenceIds).size)).toBe(true); });
  it("REQ-CONV-07 builds the supporting fact union", () => expect(mined().conventions.find((item) => item.kind === "existing-utility-reuse")?.evidenceIds).toEqual(["f5", "f6"]));
  it("REQ-CONV-08 mines the shared-middleware convention", () => expect(mined().conventions.map((item) => item.kind)).toContain("shared-middleware-for-api-security"));
  it("REQ-CONV-09 mines the dominant test-framework convention", () => expect(mined().conventions.find((item) => item.kind === "test-framework")?.statement).toContain("vitest"));
  it("REQ-CONV-10 resolves a test-framework tie lexicographically", () => { const value = input(); value.inventory.facts.push(fact("f7", "test-framework", "package.json", "jest")); expect(mineRepositoryConventions(value).conventions.find((item) => item.kind === "test-framework")?.statement).toContain("jest, vitest"); });
  it("REQ-CONV-11 mines the import-alias convention", () => expect(mined().conventions.map((item) => item.kind)).toContain("import-alias"));
  it("REQ-CONV-12 mines an existing-utility reuse convention", () => expect(mined().conventions.map((item) => item.kind)).toContain("existing-utility-reuse"));
  it("REQ-CONV-13 rejects utility reuse with only one importer", () => { const value = input(); value.inventory.facts = value.inventory.facts.filter((item) => item.id !== "f6"); expect(mineRepositoryConventions(value).conventions.map((item) => item.kind)).not.toContain("existing-utility-reuse"); });
  it("REQ-CONV-14 extracts an architecture decision from an ADR", () => expect(mined().architectureDecisions).toHaveLength(1));
  it("REQ-CONV-15 extracts an architecture decision from architecture documentation", () => expect(mined().architectureDecisions[0].statement).toContain("centralized"));
  it("REQ-CONV-16 extracts an architecture decision from a root AGENTS directive", () => expect(mined().architectureDecisions[0].evidenceIds).toEqual(["e1"]));
  it("REQ-CONV-17 ignores nonarchitecture general documentation", () => expect(mined().architectureDecisions.map((item) => item.statement)).not.toContain("Keep notes concise"));
  it("REQ-CONV-18 preserves architecture rule evidence", () => expect(mined().architectureDecisions[0].evidenceIds).toEqual(["e1"]));
  it("REQ-CONV-19 preserves architecture source authority", () => expect(mined().architectureDecisions[0].explanation).toContain("Explicit architecture rule"));
  it("REQ-CONV-20 creates stable convention and architecture IDs", () => expect(mined().conventions.every((item) => item.id.startsWith("convention_") ) && mined().architectureDecisions.every((item) => item.id.startsWith("architecture-decision_"))).toBe(true));
  it("REQ-CONV-21 returns deterministic sorted output for reordered input", () => { const value = input(); value.inventory.facts.reverse(); expect(mineRepositoryConventions(value)).toEqual(mined()); });
  it("REQ-CONV-22 does not mutate input and records search boundaries", () => { const value = input(); const before = JSON.stringify(value); mineRepositoryConventions(value); expect(JSON.stringify(value)).toBe(before); });
});
