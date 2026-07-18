import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../src/context/context-serialization.js";
import { buildImpactExplanation } from "../src/explanation/build-impact-explanation.js";
import { renderExplanationReport, validateExplanationArtifacts, writeExplanationArtifacts } from "../src/explanation/explanation-artifacts.js";
import type { InstructionImpactResult } from "../src/explanation/instruction-impact-types.js";

const roots: string[] = [];
async function fixture(status: "valid" | "limited" | "invalid" = "valid") { const root = await mkdtemp(join(tmpdir(), "camarade-s7-")); roots.push(root); const result = buildImpactExplanation({ instructions: [{ instructionId: "i-1", identity: "Keep validation", sourceRef: "instructions/rules.json" }], baseline: {}, optimized: { checkResults: [{ instructionId: "i-1", sourceRef: "stage-6/check.json", status: "passed" }] }, experimentStatus: status }); return { root, result }; }
afterEach(async () => { const { rm } = await import("node:fs/promises"); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function written(status: "valid" | "limited" | "invalid" = "valid") { const f = await fixture(status); await writeExplanationArtifacts(f.root, "cmp-1", status, f.result); return f; }

describe("S7-03 explanation artifacts", () => {
  it("[R01] canonical explanation directory", async () => { const f = await written(); expect(await readdir(join(f.root, "explanation"))).toEqual(["REPORT.md", "evidence-index.json", "explanation-summary.json", "harmful-instructions.json", "helped-instructions.json", "instruction-impacts.json", "unresolved-instructions.json"]); });
  it("[R02] complete valid artifact set", async () => { const f = await written(); const a = await validateExplanationArtifacts(f.root, "cmp-1"); expect(a.index.entries).toHaveLength(6); expect(a.report).toContain("## Experiment"); });
  it("[R03] canonical JSON ordering", async () => { const f = await written(); const b = await readFile(join(f.root, "explanation/instruction-impacts.json"), "utf8"); expect(b).toBe(canonicalJson(JSON.parse(b))); });
  it("[R04] deterministic Markdown report", async () => { const f = await written(); const a = await validateExplanationArtifacts(f.root, "cmp-1"); expect(a.report).toBe(renderExplanationReport(a.summary)); });
  it("[R05] evidence-index hashes", async () => { const f = await written(); const a = await validateExplanationArtifacts(f.root, "cmp-1"); for (const e of a.index.entries) { const b = await readFile(join(f.root, e.relativePath)); expect(e.sha256).toBe(sha256(b)); expect(e.byteLength).toBe(b.length); } });
  it("[R06] aggregate hash", async () => { const f = await written(); const a = await validateExplanationArtifacts(f.root, "cmp-1"); expect(a.index.aggregateHash).toBe(sha256(canonicalJson(a.index.entries))); });
  it("[R07] safe run-relative refs", async () => { const f = await written(); const a = await validateExplanationArtifacts(f.root, "cmp-1"); expect(JSON.stringify(a)).not.toMatch(/\/Users\/|\/private\/|\/tmp\//); for (const e of a.result.records.flatMap(r => r.evidence)) expect(e.sourceRef).not.toMatch(/^\//); });
  it("[R08] reject absolute artifact ref", async () => { const f = await written(); const p = join(f.root, "explanation/instruction-impacts.json"); const x = JSON.parse(await readFile(p, "utf8")); x.records[0].instruction.provenance.sourceRef = "/private/secret"; await writeFile(p, canonicalJson(x)); await expect(validateExplanationArtifacts(f.root, "cmp-1")).rejects.toThrow(); });
});
