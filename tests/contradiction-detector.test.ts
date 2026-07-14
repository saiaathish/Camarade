import { describe, expect, it } from "vitest";
import type { RepositoryRule } from "../src/intelligence/model.js";
import { detectRuleContradictions } from "../src/intelligence/detect-contradictions.js";

const rule = (id: string, action: string, polarity: RepositoryRule["polarity"], include = ["**/*"], subject = "api", evidenceIds = [`e-${id}`], exclude: string[] = []): RepositoryRule => ({ id, statement: `${polarity} ${action}`, normalizedSubject: subject, normalizedAction: action, polarity, strength: "required", scope: { include, exclude, technologies: [], taskKeywords: [] }, evidenceIds });
const one = (...rules: RepositoryRule[]) => detectRuleContradictions(rules).findings;

describe("S3-03 contradiction detector", () => {
  it("REQ-CON-01 detects opposite polarity on the same action", () => expect(one(rule("a", "use cache", "require"), rule("b", "use cache", "prohibit"))).toHaveLength(1));
  it("REQ-CON-02 detects require versus avoid as a contradiction", () => expect(one(rule("a", "authentication", "require"), rule("b", "authentication", "avoid"))[0].kind).toBe("contradiction"));
  it("REQ-CON-03 detects the middleware versus every-handler architecture conflict", () => expect(one(rule("a", "centralized middleware validation", "prefer"), rule("b", "every handler validation", "prefer"))).toHaveLength(1));
  it("REQ-CON-04 requires a semantic target match for polarity conflicts", () => expect(one(rule("a", "cache", "require", ["**/*"], "cache"), rule("b", "logging", "prohibit", ["**/*"], "logging"))).toHaveLength(0));
  it("REQ-CON-05 treats repository-wide scope as overlapping", () => expect(one(rule("a", "cache", "require"), rule("b", "cache", "prohibit"))[0].kind).toBe("contradiction"));
  it("REQ-CON-06 detects exact path scope overlap", () => expect(one(rule("a", "cache", "require", ["src/a.ts"]), rule("b", "cache", "prohibit", ["src/a.ts"]))[0].kind).toBe("contradiction"));
  it("REQ-CON-07 marks disjoint path conflicts as scope resolved", () => expect(one(rule("a", "cache", "require", ["src/a.ts"]), rule("b", "cache", "prohibit", ["src/b.ts"]))[0].kind).toBe("scope-resolved"));
  it("REQ-CON-08 marks exclusion-resolved conflicts as scope resolved", () => expect(one(rule("a", "cache", "require", ["**/*"], "api", [], ["src/a.ts"]), rule("b", "cache", "prohibit", ["src/a.ts"]))[0].kind).toBe("scope-resolved"));
  it("REQ-CON-09 creates a possible conflict for different positive actions", () => expect(one(rule("a", "cache", "require"), rule("b", "cache aggressively", "prefer"))[0].kind).toBe("possible-conflict"));
  it("REQ-CON-10 creates a possible conflict for unknown glob overlap", () => expect(one(rule("a", "cache", "require", ["src/*"]), rule("b", "cache", "prohibit", ["src/**/x*"]))[0].kind).toBe("possible-conflict"));
  it("REQ-CON-11 does not conflict on the same positive action", () => expect(one(rule("a", "cache", "require"), rule("b", "cache", "prefer"))).toHaveLength(0));
  it("REQ-CON-12 does not conflict on require versus allow for the same action", () => expect(one(rule("a", "cache", "require"), rule("b", "cache", "allow"))).toHaveLength(0));
  it("REQ-CON-13 does not create findings for unrelated rules", () => expect(one(rule("a", "cache", "require", ["**/*"], "cache"), rule("b", "logging", "prefer", ["**/*"], "logging"))).toHaveLength(0));
  it("REQ-CON-14 includes both rule IDs and evidence sets", () => expect(one(rule("a", "cache", "require", ["**/*"], "api", ["e2"]), rule("b", "cache", "prohibit", ["**/*"], "api", ["e1"]))[0]).toMatchObject({ affectedRuleIds: ["a", "b"], evidenceIds: ["e1", "e2"] }));
  it("REQ-CON-15 assigns correct severity and status per classification", () => expect(one(rule("a", "cache", "require", ["a"]), rule("b", "cache", "prohibit", ["b"]))[0]).toMatchObject({ severity: "info", status: "resolved" }));
  it("REQ-CON-16 never chooses a winning rule", () => expect(JSON.stringify(one(rule("a", "cache", "require"), rule("b", "cache", "prohibit")))).not.toMatch(/winner|authority/));
  it("REQ-CON-17 evaluates each unordered pair once", () => expect(one(rule("a", "cache", "require"), rule("b", "cache", "prohibit"), rule("c", "cache", "avoid"))).toHaveLength(2));
  it("REQ-CON-18 returns stable deterministic finding IDs", () => expect(one(rule("a", "cache", "require"), rule("b", "cache", "prohibit"))).toEqual(one(rule("b", "cache", "prohibit"), rule("a", "cache", "require"))));
  it("REQ-CON-19 does not mutate input rules", () => { const input = [rule("a", "cache", "require"), rule("b", "cache", "prohibit")]; const before = structuredClone(input); one(...input); expect(input).toEqual(before); });
});
