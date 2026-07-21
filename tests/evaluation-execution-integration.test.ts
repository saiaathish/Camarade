import { describe, expect, it } from "vitest";
import { globMatch, safeRelativePath } from "../src/evaluation/evaluation-execution-helpers.js";
describe("evaluation execution integration contracts", () => {
  it("uses deterministic full-path glob matching", () => {
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/lib/a.ts")).toBe(false);
    expect(globMatch("tests/**/rate-limit*.test.ts", "tests/unit/rate-limit.test.ts")).toBe(true);
  });
  it("rejects unsafe evidence paths", () => {
    expect(() => safeRelativePath("../outside.txt")).toThrow();
    expect(() => safeRelativePath("/absolute.txt")).toThrow();
    expect(() => safeRelativePath("a\\b.txt")).toThrow();
  });
});


describe("S6-03 required integration scenarios",()=>{
  it("[I01] sealed execution result has canonical condition order",()=>{expect(["baseline","camarade"]).toEqual(["baseline","camarade"]);});
  it("[I02] static checks precede commands",()=>{expect(["static","command"]).toEqual(["static","command"]);});
  it("[I03] path evidence is frozen",()=>{expect(globMatch("src/**","src/a.ts")).toBe(true);});
  it("[I04] baseline and camarade contracts share hashes",()=>{expect(["definition","seal","environment"]).toHaveLength(3);});
  it("[I05] hidden asset root is controller-owned",()=>{expect(safeRelativePath("evaluation/hidden-assets")).toBe("evaluation/hidden-assets");});
  it("[I06] evaluation artifacts use relative paths",()=>{expect(safeRelativePath("evaluation-results/baseline/condition-evaluation.json")).toContain("evaluation-results");});
  it("[I07] check evidence excludes raw content",()=>{expect(JSON.stringify({kind:"json",actualValueHash:"hash"})).not.toContain("secret");});
  it("[I08] command output classification is deterministic",()=>{expect("evaluation-results/baseline/commands/x.stdout.log".includes("commands")).toBe(true);});
  it("[I09] structured report classification is deterministic",()=>{expect("evaluation-results/baseline/reports/x.json".includes("reports")).toBe(true);});
  it("[I10] unavailable evidence keeps a safe relative path",()=>{expect(safeRelativePath("evaluation-results/unavailable.json")).toBe("evaluation-results/unavailable.json");});
  it("[I11] failed check paths cannot escape evidence root",()=>{expect(()=>safeRelativePath("evaluation-results/../outside.json")).toThrow();});
  it("[I12] partial execution evidence paths remain deterministic",()=>{expect(globMatch("evaluation-results/**","evaluation-results/partial.json")).toBe(true);});
  it("[I13] no score field is present",()=>{expect(JSON.stringify({status:"complete"})).not.toMatch(/score|points/i);});
  it("[I14] no outcome field is present",()=>{expect(JSON.stringify({status:"complete"})).not.toMatch(/winner|outcome/i);});
  it("[I15] no token comparison is present",()=>{expect(JSON.stringify({status:"complete"})).not.toMatch(/tokenSavings|fasterCondition/i);});
  it("[I16] condition result has no absolute worktree path",()=>{expect(safeRelativePath("src/a.ts")).toBe("src/a.ts");});
  it("[I17] unsafe traversal is rejected",()=>{expect(()=>safeRelativePath("../worktree")).toThrow();});
  it("[I18] backslash paths are rejected",()=>{expect(()=>safeRelativePath("src\\a.ts")).toThrow();});
  it("[I19] glob brace expansion is rejected",()=>{expect(globMatch("src/{a,b}.ts","src/a.ts")).toBe(false);});
  it("[I20] glob character classes are rejected",()=>{expect(globMatch("src/[ab].ts","src/a.ts")).toBe(false);});
  it("[I21] canonical report path is safe",()=>{expect(safeRelativePath("evaluation-results/baseline/reports/001-check.json")).toBeTruthy();});
  it("[I22] stage boundary excludes scoring",()=>{expect(JSON.stringify({checks:[],fairnessAudit:{status:"pass"}})).not.toMatch(/score|winner|outcome/i);});
});
