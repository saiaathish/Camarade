import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectPublicEvidence, verifyPublicArtifactTree } from "../src/artifacts/public-evidence-policy.js";
import { isMain, repositoryRoot } from "./lib/portable-command.js";

export async function verifyPublicArtifactPolicy(environment: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const root = repositoryRoot(import.meta.url);
  const fixtureRoot = await mkdtemp(join(tmpdir(), "camarade-public-artifacts-"));
  try {
    await writeFile(join(fixtureRoot, "dashboard-run.json"), await readFile(join(root, "fixtures/stage-8/dashboard/valid-camarade-win.json")), "utf8");
    await mkdir(join(fixtureRoot, "scoring"));
    await writeFile(join(fixtureRoot, "scoring", "comparison.json"), '{"schemaVersion":"s6-05.1","status":"valid","reference":"scoring/evidence.json"}\n', "utf8");
    await mkdir(join(fixtureRoot, "conditions"));
    await writeFile(join(fixtureRoot, "conditions", "private.json"), '{"environment":{"TOKEN":"private"},"prompt":"private"}\n', "utf8");
    const verified = await verifyPublicArtifactTree(fixtureRoot);
    const probes = [
      { value: { source: "/private/controller/run.json" }, code: "ABSOLUTE_PATH" },
      { value: { source: "C:\\private\\run.json" }, code: "ABSOLUTE_PATH" },
      { value: { source: "\\\\server\\share\\run.json" }, code: "ABSOLUTE_PATH" },
      { value: { source: "~/private/run.json" }, code: "ABSOLUTE_PATH" },
      { value: { rawPrompt: "private" }, code: "SENSITIVE_FIELD" },
      { value: { credential: "ghp_1234567890abcdefghijkl" }, code: "SECRET_VALUE" },
    ];
    for (const probe of probes) {
      if (!inspectPublicEvidence(probe.value).some((finding) => finding.code === probe.code)) throw new Error(`PUBLIC_POLICY_PROBE_FAILED:${probe.code}`);
    }
    return { schemaVersion: 1, status: "pass", scannedFiles: verified.files, privateRootsExcluded: true, probeCount: probes.length };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  verifyPublicArtifactPolicy().then((report) => console.log(JSON.stringify(report))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
