import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverPublicArtifactPaths,
  inspectPublicEvidence,
  isControllerPrivatePath,
  sanitizePublicErrorMessage,
  verifyPublicArtifactTree,
} from "../src/artifacts/public-evidence-policy.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("public evidence policy", () => {
  it.each([
    [{ detail: "created at /private/controller/run.json" }, "ABSOLUTE_PATH"],
    [{ detail: "created at /srv/camarade/controller/run.json" }, "ABSOLUTE_PATH"],
    [{ detail: "C:\\repo\\run.json" }, "ABSOLUTE_PATH"],
    [{ detail: "\\\\server\\share\\run.json" }, "ABSOLUTE_PATH"],
    [{ detail: "raw prompt: do the hidden task" }, "SENSITIVE_FIELD"],
    [{ detail: "hidden-test = assert private behavior" }, "SENSITIVE_FIELD"],
    [{ detail: "environment: CAMARADE_PRIVATE_VALUE=opaque" }, "SENSITIVE_FIELD"],
    [{ hiddenTestContent: "assert secret" }, "SENSITIVE_FIELD"],
    [{ rawPrompt: "do the hidden task" }, "SENSITIVE_FIELD"],
    [{ token: "ghp_1234567890abcdefghijkl" }, "SECRET_VALUE"],
    [{ token: "opaque-session-value" }, "SENSITIVE_FIELD"],
    [{ credentials: "opaque-session-value" }, "SENSITIVE_FIELD"],
    [{ environment: { FOO: "opaque-session-value" } }, "SENSITIVE_FIELD"],
  ])("rejects sensitive public evidence", (value, code) => {
    expect(inspectPublicEvidence(value)).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it("classifies controller-private roots independently of public files", () => {
    expect(isControllerPrivatePath("conditions/baseline/prompt.md")).toBe(true);
    expect(isControllerPrivatePath("measurement/experiment-measurement.json")).toBe(false);
  });

  it("allows numeric telemetry fields but still rejects opaque token credentials", () => {
    expect(inspectPublicEvidence({ inputTokens: 12, outputTokens: 4, cachedInputTokens: 2, reasoningTokens: 3, totalTokens: 16, tokenEfficiency: { score: 3 }, tokenRuntimeObservations: ["Measurements are observations, not instruction causality."] })).toEqual([]);
    expect(inspectPublicEvidence({ token: "opaque-session-value" })).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SENSITIVE_FIELD" })]));
  });

  it("keeps ordinary prose and URLs while redacting arbitrary absolute paths", () => {
    const safe = "The execution environment is simulated; see https://example.com/docs and ratio 1/2.";
    expect(inspectPublicEvidence({ detail: safe })).toEqual([]);
    expect(sanitizePublicErrorMessage(safe)).toBe(safe);
    expect(sanitizePublicErrorMessage("Failed at /srv/camarade/controller/run.json after validation.")).toBe("Failed at <redacted-path> after validation.");
  });

  it.each([
    "# Raw prompt\nDo the private task.\n",
    "- Hidden test: assert private behavior\n",
    "Environment: CAMARADE_PRIVATE_VALUE=opaque\n",
  ])("rejects sensitive labels in public Markdown", async (markdown) => {
    const root = await mkdtemp(join(tmpdir(), "public-markdown-evidence-")); temporary.push(root);
    await mkdir(join(root, "explanation"));
    await writeFile(join(root, "explanation", "REPORT.md"), markdown);
    await expect(verifyPublicArtifactTree(root)).rejects.toMatchObject({
      findings: expect.arrayContaining([expect.objectContaining({ code: "SENSITIVE_FIELD", artifactPath: "explanation/REPORT.md" })]),
    });
  });

  it("discovers only allowlisted public surfaces and verifies safe JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "public-evidence-")); temporary.push(root);
    await mkdir(join(root, "measurement"));
    await mkdir(join(root, "conditions"));
    await writeFile(join(root, "experiment-summary.json"), '{"status":"limited","reference":"measurement/result.json"}\n');
    await writeFile(join(root, "measurement", "result.json"), '{"status":"unavailable"}\n');
    await writeFile(join(root, "conditions", "private.json"), '{"rawPrompt":"private"}\n');
    await expect(discoverPublicArtifactPaths(root)).resolves.toEqual(["experiment-summary.json", "measurement/result.json"]);
    await expect(verifyPublicArtifactTree(root)).resolves.toMatchObject({ findings: [] });
  });
});
