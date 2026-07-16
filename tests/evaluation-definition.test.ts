// @ts-nocheck Invalid-definition tables intentionally construct values outside discriminated runtime types.
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVALUATION_CHECK_RESULTS, EVALUATION_DEFINITION_VERSION, EVALUATION_OUTCOMES,
  EVALUATION_RULE_SEVERITIES, EVALUATION_STATUSES, EVALUATION_TOTAL_SCORE,
  EVALUATION_WEIGHTS, STAGE_6_TIE_TOLERANCE, SUPPORTED_EVALUATION_CHECK_TYPES,
} from "../src/evaluation/evaluation-types.js";
import { EvaluationDefinitionError } from "../src/evaluation/evaluation-errors.js";
import { validateEvaluationDefinition } from "../src/evaluation/evaluation-definition-schema.js";
import { loadEvaluationDefinition } from "../src/evaluation/load-evaluation-definition.js";

const roots: string[] = [];
const baseDefinition = () => ({
  version: 1, id: "hero-v1", task: "Add the feature.",
  tieTolerance: { absoluteScorePoints: 1 },
  correctnessChecks: [
    { id: "command", type: "command", command: "npm run build", weight: 1, mandatory: true },
    { id: "exists", type: "file-exists", path: "src/feature.ts", weight: 1, mandatory: true },
    { id: "absent", type: "file-absent", path: "src/legacy.ts", weight: 1, mandatory: false },
    { id: "present", type: "text-present", path: "README.md", text: "feature", weight: 1, mandatory: false },
    { id: "not-present", type: "text-absent", path: "README.md", text: "secret", weight: 1, mandatory: false },
    { id: "unchanged", type: "path-unchanged", path: "src/stable.ts", weight: 1, mandatory: false },
    { id: "changed", type: "path-changed", path: "src/**", weight: 1, mandatory: false },
    { id: "dep", type: "dependency-present", package: "redis", weight: 1, mandatory: false },
    { id: "no-dep", type: "dependency-absent", package: "express-rate-limit", weight: 1, mandatory: false },
    { id: "json", type: "json-value", path: "config.json", pointer: "/limit", equals: { enabled: true, limits: [10, 20, null], nested: { mode: "strict" } }, weight: 1, mandatory: false },
  ],
  requirements: [{ id: "req", description: "Feature works.", weight: 1, mandatory: true, checks: [{ id: "req-check", type: "file-exists", path: "src/feature.ts" }] }],
  rules: [{ id: "rule", description: "Only feature paths change.", weight: 1, severity: "normal", checks: [{ id: "rule-check", type: "path-changed", path: "src/**" }] }],
  changePolicy: { allowedPaths: ["src/**"], protectedPaths: ["private/**"], ignoredPaths: ["coverage/**"], requiredChangedPaths: ["src/feature.ts"] },
  dependencyPolicy: { packageManager: "npm", allowedAddedPackages: ["@scope/package"], forbiddenPackages: ["left-pad"], allowUnlistedAdditions: false },
  telemetryPolicy: { requireTokens: true, requireRuntime: true }, hiddenAssets: [],
});
type Definition = ReturnType<typeof baseDefinition>;
const clone = (): Definition => structuredClone(baseDefinition());
const rootsForCleanup = (root: string) => { roots.push(root); return root; };
async function jsonFile(value: unknown = baseDefinition()) { const root = rootsForCleanup(await mkdtemp(join(tmpdir(), "camarade-eval-"))); const path = join(root, "evaluation.json"); await writeFile(path, JSON.stringify(value)); return path; }
async function errorCode(promise: Promise<unknown>) { try { await promise; throw new Error("expected failure"); } catch (error) { expect(error).toBeInstanceOf(EvaluationDefinitionError); return (error as EvaluationDefinitionError).code; } }
function expectSchema(value: unknown) { expect(() => validateEvaluationDefinition(value)).toThrow(EvaluationDefinitionError); try { validateEvaluationDefinition(value); } catch (error) { expect((error as EvaluationDefinitionError).code).toBe("INVALID_SCHEMA"); } }
function expectSemantics(value: unknown, text?: string) { try { validateEvaluationDefinition(value); throw new Error("expected failure"); } catch (error) { expect(error).toBeInstanceOf(EvaluationDefinitionError); expect((error as EvaluationDefinitionError).code).toBe("INVALID_SEMANTICS"); if (text) expect((error as EvaluationDefinitionError).issues?.join(" ")).toContain(text); } }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("S6-01 evaluation definition", () => {
  it("loads a valid absolute JSON definition and applies defaults", async () => { const path = await jsonFile(); const loaded = await loadEvaluationDefinition(path); expect(loaded.definitionPath).toBe(path); expect(loaded.definitionDirectory).toBe(dirname(path)); expect(loaded.definition.correctnessChecks[0]).toMatchObject({ timeoutSeconds: 1800, successExitCodes: [0] }); expect(loaded.definition.correctnessChecks[0]).not.toHaveProperty("structuredReport"); expect(loaded.definition.dependencyPolicy.allowUnlistedAdditions).toBe(false); });
  it("explicitly validates all ten supported check types", () => { const result = validateEvaluationDefinition(clone()); expect(result.correctnessChecks.map(check => check.type)).toEqual(SUPPORTED_EVALUATION_CHECK_TYPES); });
  // @ts-expect-error Deliberately exercises structurally distinct discriminated variants.
  it("accepts package managers, scoped packages, hidden assets, pointers, and nested JSON", () => { for (const packageManager of ["npm", "pnpm", "yarn", "other"] as const) { const d = clone(); d.dependencyPolicy.packageManager = packageManager; d.dependencyPolicy.allowedAddedPackages = ["redis", "express-rate-limit", "@scope/package", "@scope/package-name"]; d.hiddenAssets = ["fixtures/hidden.json"]; expect(validateEvaluationDefinition(d).dependencyPolicy.packageManager).toBe(packageManager); } expect(validateEvaluationDefinition(clone()).correctnessChecks[9]).toMatchObject({ pointer: "/limit" }); });
  // @ts-expect-error Deliberately narrows the JSON-value variant for focused valid-input coverage.
  it("accepts an empty JSON pointer and nested JSON values", () => { const d = clone(); const check = d.correctnessChecks[9]; check.pointer = ""; check.equals = { enabled: true, limits: [10, 20, null], nested: { mode: "strict" } }; expect(validateEvaluationDefinition(d).correctnessChecks[9].pointer).toBe(""); });
  it("freezes constants and separates statuses from outcomes", () => { expect(EVALUATION_DEFINITION_VERSION).toBe(1); expect(EVALUATION_TOTAL_SCORE).toBe(100); expect(Object.values(EVALUATION_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100); expect(STAGE_6_TIE_TOLERANCE).toBe(1); expect(SUPPORTED_EVALUATION_CHECK_TYPES).toHaveLength(10); expect(EVALUATION_STATUSES).toEqual(["valid", "limited", "invalid"]); expect(EVALUATION_OUTCOMES).toEqual(["win", "tie", "regression"]); expect(EVALUATION_CHECK_RESULTS).toEqual(["pass", "fail", "unavailable", "error"]); expect(EVALUATION_RULE_SEVERITIES).toEqual(["normal", "material"]); });

  it.each([["blank", ""], ["relative", "evaluation.json"], ["null byte", "bad\0path"]])("rejects %s definition path", async (_, path) => expect(await errorCode(loadEvaluationDefinition(path))).toBe("INVALID_PATH"));
  it("rejects missing files, directories, symlinks, oversized files, malformed JSON, arrays, and null roots", async () => { expect(await errorCode(loadEvaluationDefinition(join(tmpdir(), "missing-camarade-eval")))).toBe("NOT_FOUND"); const root = rootsForCleanup(await mkdtemp(join(tmpdir(), "camarade-eval-"))); expect(await errorCode(loadEvaluationDefinition(root))).toBe("NOT_REGULAR_FILE"); const target = await jsonFile(); const link = join(root, "link.json"); await symlink(target, link); expect(await errorCode(loadEvaluationDefinition(link))).toBe("SYMLINK_NOT_ALLOWED"); const big = await jsonFile(); await writeFile(big, "x".repeat(1048577)); expect(await errorCode(loadEvaluationDefinition(big))).toBe("FILE_TOO_LARGE"); for (const raw of ["{", "[]", "null"]) { const path = await jsonFile(); await writeFile(path, raw); expect(await errorCode(loadEvaluationDefinition(path))).toBe(raw === "{" ? "INVALID_JSON" : "INVALID_SCHEMA"); } });

  const unknownCases: Array<[string, (d: Definition) => void]> = [
    ["top-level", d => { (d as unknown as Record<string, unknown>).extra = true; }],
    ["tieTolerance", d => { (d.tieTolerance as unknown as Record<string, unknown>).extra = true; }],
    ["command", d => { (d.correctnessChecks[0] as unknown as Record<string, unknown>).extra = true; }],
    ["structuredReport", d => { (d.correctnessChecks[0] as unknown as Record<string, unknown>).structuredReport = { format: "junit-xml", path: "report.xml", extra: true }; }],
    ["requirement", d => { (d.requirements[0] as unknown as Record<string, unknown>).extra = true; }],
    ["rule", d => { (d.rules[0] as unknown as Record<string, unknown>).extra = true; }],
    ["changePolicy", d => { (d.changePolicy as unknown as Record<string, unknown>).extra = true; }],
    ["dependencyPolicy", d => { (d.dependencyPolicy as unknown as Record<string, unknown>).extra = true; }],
    ["telemetryPolicy", d => { (d.telemetryPolicy as unknown as Record<string, unknown>).extra = true; }],
  ];
  it.each(unknownCases)("rejects unknown fields at %s object level", (_, mutate) => { const d = clone(); mutate(d); expectSchema(d); });

  // @ts-ignore The table intentionally assigns invalid values to valid definitions.
  it.each([
    ["version", d => { d.version = 2; }], ["tie tolerance", d => { d.tieTolerance.absoluteScorePoints = 2; }], ["blank ID", d => { d.id = ""; }], ["invalid ID", d => { d.id = "bad id"; }], ["blank task", d => { d.task = ""; }], ["null task", d => { d.task = "bad\0task"; }], ["empty correctness", d => { d.correctnessChecks = []; }], ["empty requirements", d => { d.requirements = []; }], ["empty rules", d => { d.rules = []; }], ["zero weight", d => { d.correctnessChecks[0].weight = 0; }], ["negative requirement weight", d => { d.requirements[0].weight = -1; }], ["non-finite rule weight", d => { d.rules[0].weight = Infinity; }], ["long command", d => { d.correctnessChecks[0].command = "x".repeat(4097); }], ["zero timeout", d => { d.correctnessChecks[0].timeoutSeconds = 0; }], ["large timeout", d => { d.correctnessChecks[0].timeoutSeconds = 86401; }], ["duplicate exit code", d => { d.correctnessChecks[0].successExitCodes = [0, 0]; }], ["negative exit code", d => { d.correctnessChecks[0].successExitCodes = [-1]; }], ["large exit code", d => { d.correctnessChecks[0].successExitCodes = [256]; }], ["empty requirement checks", d => { d.requirements[0].checks = []; }], ["empty rule checks", d => { d.rules[0].checks = []; }], ["invalid severity", d => { d.rules[0].severity = "bad"; }], ["invalid report format", d => { d.correctnessChecks[0].structuredReport = { format: "bad", path: "report.json" }; }],
  ] as Array<[string, (d: Definition) => void]>) ("rejects structural failure: %s", (_, mutate) => { const d = clone(); mutate(d); expectSchema(d); });

  // @ts-ignore Unsafe paths are intentionally supplied for rejection coverage.
  it.each(["/etc/passwd", "C:\\temp\\file.json", "src\\middleware.ts", "../secret.txt", "src/../secret.txt", "", "bad\0path"])("rejects unsafe repository path %j", path => { const d = clone(); d.correctnessChecks[1].path = path; expectSchema(d); });
  // @ts-ignore Unsafe paths are intentionally supplied for rejection coverage.
  it("rejects unsafe hidden, policy, and report paths", () => { for (const change of [(d: Definition) => { d.hiddenAssets = ["../secret"]; }, (d: Definition) => { d.changePolicy.allowedPaths = ["/etc"]; }, (d: Definition) => { d.correctnessChecks[0].structuredReport = { format: "junit-xml", path: "../report.xml" }; }]) { const d = clone(); change(d); expectSchema(d); } });

  const idCases: Array<[string, (d: Definition) => void]> = [
    ["definition/correctness", d => { d.correctnessChecks[0].id = d.id; }], ["two correctness", d => { d.correctnessChecks[1].id = d.correctnessChecks[0].id; }], ["two requirements", d => { d.requirements.push({ ...d.requirements[0], id: "req-2", checks: [{ id: "req-2-check", type: "file-exists", path: "x" }] }); d.requirements[1].id = d.requirements[0].id; }], ["nested requirements", d => { d.requirements[0].checks.push({ ...d.requirements[0].checks[0], id: d.requirements[0].checks[0].id }); }], ["two rules", d => { d.rules.push({ ...d.rules[0], id: "rule-2", checks: [{ id: "rule-2-check", type: "path-changed", path: "x" }] }); d.rules[1].id = d.rules[0].id; }], ["nested rules", d => { d.rules[0].checks.push({ ...d.rules[0].checks[0], id: d.rules[0].checks[0].id }); }], ["requirement/rule", d => { d.rules[0].id = d.requirements[0].id; }], ["correctness/nested rule", d => { d.rules[0].checks[0].id = d.correctnessChecks[0].id; }], ["nested requirement/nested rule", d => { d.rules[0].checks[0].id = d.requirements[0].checks[0].id; }],
  ];
  it.each(idCases)("rejects global ID collision: %s", (_, mutate) => { const d = clone(); mutate(d); expectSemantics(d, "duplicate ID"); });

  // @ts-expect-error Duplicate normalized values are intentionally supplied for semantic rejection coverage.
  it.each(["allowedPaths", "protectedPaths", "ignoredPaths", "requiredChangedPaths", "allowedAddedPackages", "forbiddenPackages", "hiddenAssets"] as const)("rejects normalized duplicates in %s", field => { const d = clone(); if (field === "hiddenAssets") d.hiddenAssets = ["src/a", " src/a "]; else { const policy = field in d.changePolicy ? d.changePolicy : d.dependencyPolicy; const values = policy[field as keyof typeof policy]; if (Array.isArray(values)) (policy as unknown as Record<string, unknown>)[field] = [values[0], ` ${String(values[0])} `]; } expectSemantics(d, field); });
  // @ts-expect-error Duplicate exit codes are intentionally supplied for schema rejection coverage.
  it("rejects duplicate success exit codes as schema failure", () => { const d = clone(); d.correctnessChecks[0].successExitCodes = [0, 0]; expectSchema(d); });
  it.each([["allowed/protected", (d: Definition) => { d.changePolicy.protectedPaths = ["src/**"]; }, "src/**"], ["required/protected", (d: Definition) => { d.changePolicy.requiredChangedPaths = ["private/**"]; }, "private/**"], ["allowed/forbidden package", (d: Definition) => { d.dependencyPolicy.forbiddenPackages = ["@scope/package"]; }, "@scope/package"]] as Array<[string, (d: Definition) => void, string]>) ("rejects cross-policy conflict: %s", (_, mutate, value) => { const d = clone(); mutate(d); expectSemantics(d, value); });

  it.each(["", "bad package", "@scope", "@/package", "scope/package", "package@1.0.0", "package^1.0.0", "https://example.com/package.tgz", "git+https://example.com/repo.git", "file:../package", "../local-package", "./local-package", "C:\\package", "package/name/extra"])("rejects invalid package name %j", value => { const d = clone(); d.dependencyPolicy.allowedAddedPackages = [value]; expectSchema(d); });
  // @ts-expect-error Non-finite values are intentionally supplied through unknown validation input.
  it.each([Infinity, -Infinity, NaN])("rejects non-finite JSON value %s at every nesting level", value => { for (const equals of [value, [value], { nested: value }]) { const d = clone(); d.correctnessChecks[9].equals = equals; expectSchema(d); } });
  // @ts-expect-error The command is intentionally a marker-producing declaration that must not execute.
  it("does not execute commands, read or hash hidden assets, and does not mutate input", async () => { const marker = join(rootsForCleanup(await mkdtemp(join(tmpdir(), "camarade-eval-"))), "marker"); const d = clone(); d.correctnessChecks[0].command = `touch ${marker}`; d.hiddenAssets = ["missing-hidden.json"]; const before = JSON.stringify(d); const loaded = await loadEvaluationDefinition(await jsonFile(d)); expect(JSON.stringify(d)).toBe(before); expect(loaded.definition.hiddenAssets).toEqual(["missing-hidden.json"]); expect(loaded.definition).not.toHaveProperty("hiddenAssetHashes"); });
});
