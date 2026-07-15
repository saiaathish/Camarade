import { describe, expect, it } from "vitest";
import { detectDuplicateRules } from "../src/intelligence/detect-duplicates.js";
import type { RepositoryRule, RuleScope } from "../src/intelligence/model.js";

const scope: RuleScope = { include: ["src"], exclude: [], technologies: ["ts"], taskKeywords: ["build"] };
const rule = (id: string, statement: string, extra: Partial<RepositoryRule> = {}): RepositoryRule => ({ id, statement, normalizedSubject: "code", normalizedAction: "write", polarity: "require", strength: "required", scope, evidenceIds: [`e-${id}`], ...extra });
const findings = (...rules: RepositoryRule[]) => detectDuplicateRules(rules).findings;
const exact = (a: string, b: string, extra: Partial<RepositoryRule> = {}) => findings(rule("a", a, extra), rule("b", b, extra))[0];

it("REQ-DUP-01 normalizes repeated whitespace for exact duplicates", () => expect(exact("Use   tabs", "use tabs")).toBeTruthy());
it("REQ-DUP-02 normalizes Markdown list markers for exact duplicates", () => expect(exact("- Use tabs", "Use tabs")).toBeTruthy());
it("REQ-DUP-03 normalizes terminal punctuation for exact duplicates", () => expect(exact("Use tabs!", "Use tabs.")).toBeTruthy());
it("REQ-DUP-04 preserves negation during duplicate normalization", () => expect(exact("Do not commit.", "do not commit")).toBeTruthy());
it("REQ-DUP-05 creates an exact duplicate finding", () => expect(exact("Use tabs", "Use tabs").kind).toBe("duplicate"));
it("REQ-DUP-06 does not mark different scopes as exact duplicates", () => expect(findings(rule("a", "Use tabs"), rule("b", "Use tabs", { scope: { ...scope, include: ["test"] } }))).toHaveLength(0));
it("REQ-DUP-07 does not mark opposite polarities as duplicates", () => expect(findings(rule("a", "Use tabs"), rule("b", "Use tabs", { polarity: "avoid" }))).toHaveLength(0));
it("REQ-DUP-08 does not mark different strengths as duplicates", () => expect(findings(rule("a", "Use tabs"), rule("b", "Use tabs", { strength: "preferred" }))).toHaveLength(0));
it("REQ-DUP-09 creates a near duplicate at the similarity threshold", () => expect(findings(rule("a", "a b c d e f g h i j k l m n o p q"), rule("b", "a b c d e f g h i j k l m n o p q r s t")).some((f) => f.kind === "near-duplicate")).toBe(true));
it("REQ-DUP-10 rejects a near duplicate below the threshold", () => expect(findings(rule("a", "Use clean safe code"), rule("b", "Use clean fast code")).some((f) => f.kind === "near-duplicate")).toBe(false));
it("REQ-DUP-11 requires the same normalized subject for near duplicates", () => expect(findings(rule("a", "Use clean safe code"), rule("b", "Use clean safe code now", { normalizedSubject: "tests" }))).toHaveLength(0));
it("REQ-DUP-12 requires the same polarity for near duplicates", () => expect(findings(rule("a", "Use clean safe code"), rule("b", "Use clean safe code now", { polarity: "avoid" }))).toHaveLength(0));
it("REQ-DUP-13 requires the same scope for near duplicates", () => expect(findings(rule("a", "Use clean safe code"), rule("b", "Use clean safe code now", { scope: { ...scope, exclude: ["x"] } }))).toHaveLength(0));
it("REQ-DUP-14 includes both rule IDs and evidence sets", () => { const f = exact("Use tabs", "Use tabs"); expect(f.affectedRuleIds).toEqual(["a", "b"]); expect(f.evidenceIds).toEqual(["e-a", "e-b"]); });
it("REQ-DUP-15 evaluates each unordered pair once", () => expect(findings(rule("a", "Use tabs"), rule("b", "Use tabs"))).toHaveLength(1));
it("REQ-DUP-16 returns stable deterministic finding IDs", () => expect(findings(rule("b", "Use tabs"), rule("a", "Use tabs"))[0].id).toBe(findings(rule("a", "Use tabs"), rule("b", "Use tabs"))[0].id));
it("REQ-DUP-17 does not mutate input rules", () => { const input = [rule("b", "Use tabs"), rule("a", "Use tabs")]; const before = structuredClone(input); detectDuplicateRules(input); expect(input).toEqual(before); });
