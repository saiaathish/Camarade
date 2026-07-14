import { describe, expect, it } from "vitest";
import { resolveRuleScope } from "../src/intelligence/resolve-rule-scope.js";
describe("rule scope coverage", () => { it("resolves paths, exceptions, technologies, and keywords", () => {
  const base = resolveRuleScope({ statement: "Use Next.js and Node.js", sourceRelativePath: "x.md" }); expect(base).toEqual({ include: ["**/*"], exclude: [], technologies: ["nextjs", "node"], taskKeywords: [] });
  for (const p of ["src/a.ts", "src/a.ts", "src/a.ts", "src/*.ts", ".env", "./src/a.ts", "src\\a.ts"]) { const s = resolveRuleScope({ statement: `Use \`${p}\``, sourceRelativePath: "AGENTS.md" }); expect(s.include[0]).toBe(p.replace(/\\/g, "/").replace(/^\.\//, "")); }
  expect(resolveRuleScope({ statement: "Use `src/a.ts`", sourceRelativePath: "AGENTS.md" }).include).toEqual(["src/a.ts"]); expect(resolveRuleScope({ statement: "Use /tmp/x.ts", sourceRelativePath: "AGENTS.md" }).include).toEqual(["**/*"]); expect(resolveRuleScope({ statement: "Use ../x.ts", sourceRelativePath: "AGENTS.md" }).include).toEqual(["**/*"]);
  const ex = resolveRuleScope({ statement: "Use all except `src/a.ts` unless excluding `src/b.ts`", sourceRelativePath: "AGENTS.md" }); expect(ex.exclude).toEqual(["src/a.ts", "src/b.ts"]); expect(resolveRuleScope({ statement: "Use only for webhook external-integration", sourceRelativePath: "AGENTS.md" }).exclude).toEqual([]); expect(resolveRuleScope({ statement: "Use only for webhook", sourceRelativePath: "AGENTS.md" }).include).toEqual(["**/*"]);
  const scoped = resolveRuleScope({ statement: "Use Next.js Node.js webhook external integration", sourceRelativePath: "AGENTS.md" }); expect(scoped.technologies).toEqual(["nextjs", "node"]); expect(scoped.taskKeywords).toContain("webhook"); expect(scoped.taskKeywords).not.toContain("next"); expect(scoped.taskKeywords.length).toBeLessThanOrEqual(12); expect(scoped.include).toEqual([...scoped.include].sort()); expect(scoped.technologies).toEqual([...scoped.technologies].sort());
  const input = { statement: "Use `src/a.ts`", sourceRelativePath: "AGENTS.md" }; const copy = structuredClone(input); resolveRuleScope(input); expect(input).toEqual(copy);
 }); });

describe("named S3-02 rule-scope coverage", () => {
  it("REQ-SCOPE-02 keeps AGENTS.md repository-wide", () => {
    expect(resolveRuleScope({ statement: "Apply this rule", sourceRelativePath: "AGENTS.md" }).include).toEqual(["**/*"]);
  });
  it("REQ-SCOPE-03 keeps cursor rule location repository-wide", () => {
    expect(resolveRuleScope({ statement: "Apply this rule", sourceRelativePath: ".cursor/rules/frontend.md" }).include).toEqual(["**/*"]);
  });
  it("REQ-SCOPE-05 extracts quoted paths", () => {
    expect(resolveRuleScope({ statement: 'Use "src/app/page.tsx"', sourceRelativePath: "AGENTS.md" }).include).toEqual(["src/app/page.tsx"]);
  });
  it("REQ-SCOPE-06 extracts slash paths", () => {
    expect(resolveRuleScope({ statement: "Use src/app/page.tsx", sourceRelativePath: "AGENTS.md" }).include).toEqual(["src/app/page.tsx"]);
  });
  it("REQ-SCOPE-18 extracts does-not-apply-to exclusions", () => {
    expect(resolveRuleScope({ statement: "Apply to all, does not apply to src/generated.ts", sourceRelativePath: "AGENTS.md" }).exclude).toEqual(["src/generated.ts"]);
  });
  it("REQ-SCOPE-19 records webhook exception keyword", () => {
    expect(resolveRuleScope({ statement: "Apply to all except webhooks", sourceRelativePath: "AGENTS.md" }).taskKeywords).toContain("exception:webhooks");
  });
  it("REQ-SCOPE-20 records external integration exception keyword", () => {
    expect(resolveRuleScope({ statement: "Apply to all unless external integrations", sourceRelativePath: "AGENTS.md" }).taskKeywords).toContain("exception:external integrations");
  });
  it("REQ-SCOPE-26 removes stop words from task keywords", () => {
    const scope = resolveRuleScope({ statement: "Use the service and the handler for testing", sourceRelativePath: "AGENTS.md" });
    expect(scope.taskKeywords).not.toEqual(expect.arrayContaining(["the", "and", "for"]));
  });
  it("REQ-SCOPE-27 excludes path tokens from task keywords", () => {
    const scope = resolveRuleScope({ statement: "Update src/app/page.tsx handler", sourceRelativePath: "AGENTS.md" });
    expect(scope.taskKeywords).not.toEqual(expect.arrayContaining(["src", "app", "page", "tsx"]));
  });
  it("REQ-SCOPE-28 excludes technology tokens from task keywords", () => {
    const scope = resolveRuleScope({ statement: "Use React and TypeScript components", sourceRelativePath: "AGENTS.md" });
    expect(scope.taskKeywords).not.toEqual(expect.arrayContaining(["react", "typescript"]));
  });
  it("REQ-SCOPE-30 returns deterministic sorted deduplicated arrays", () => {
    const input = { statement: "Use React, TypeScript, React in src/z.ts and src/a.ts", sourceRelativePath: "AGENTS.md" };
    const first = resolveRuleScope(input); const second = resolveRuleScope(input);
    expect(second).toEqual(first);
    expect(first.include).toEqual([...new Set(first.include)].sort());
    expect(first.exclude).toEqual([...new Set(first.exclude)].sort());
    expect(first.technologies).toEqual([...new Set(first.technologies)].sort());
    expect(first.taskKeywords).toEqual([...new Set(first.taskKeywords)].sort());
  });
});
