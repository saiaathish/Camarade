import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildImpactExplanation } from "../src/explanation/build-impact-explanation.js";
import { writeExplanationArtifacts } from "../src/explanation/explanation-artifacts.js";
import { publicIdentity } from "../src/explanation/instruction-impact-match.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("instruction identity redaction", () => {
  it("keeps safe identities unchanged", () => {
    expect(publicIdentity("Keep validation commands green")).toBe("Keep validation commands green");
    expect(publicIdentity("")).toBe("");
  });

  it("redacts absolute-path identities deterministically", () => {
    const unsafe = '"/usr/local/bin/node" "/private/tmp/fixture/validate.mjs"';
    const first = publicIdentity(unsafe);
    expect(first).toMatch(/^redacted-unsafe-identity-[0-9a-f]{16}$/);
    expect(publicIdentity(unsafe)).toBe(first);
    expect(publicIdentity("C:\\repo\\validate.mjs")).toMatch(/^redacted-unsafe-identity-[0-9a-f]{16}$/);
    expect(publicIdentity("../escape")).toMatch(/^redacted-unsafe-identity-[0-9a-f]{16}$/);
  });

  it("writes public explanation artifacts when a persisted candidate identity is an absolute command", async () => {
    const command = '"/usr/local/bin/node" "/private/tmp/fixture/validate.mjs"';
    const result = buildImpactExplanation({
      instructions: [{ instructionId: "candidate-command-1", identity: command, sourceRef: "stage-4/camarade/context.json" }],
      baseline: {},
      optimized: { instructions: [{ instructionId: "candidate-command-1", identity: command }] }
    } as never);
    const identity = result.records[0]!.instruction.identity;
    expect(identity).toMatch(/^redacted-unsafe-identity-[0-9a-f]{16}$/);
    const root = await mkdtemp(join(tmpdir(), "camarade-identity-redaction-"));
    roots.push(root);
    const artifacts = await writeExplanationArtifacts(root, "experiment-identity-redaction", "valid", result);
    expect(artifacts.result.records[0]!.instruction.identity).toBe(identity);
  });
});
