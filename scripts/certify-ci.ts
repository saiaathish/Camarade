import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMain, npmInvocation, repositoryRoot, requirePortableSuccess, tsxInvocation, type PortableInvocation } from "./lib/portable-command.js";

type Phase = { name: string; invocation: PortableInvocation; timeoutMs: number; env?: NodeJS.ProcessEnv };

function fullPhases(root: string, environment: NodeJS.ProcessEnv): Phase[] {
  const npm = (name: string, script: string, timeoutMs = 900_000): Phase => ({ name, invocation: npmInvocation(["run", script]), timeoutMs, env: environment });
  const tsx = (name: string, script: string, timeoutMs = 300_000): Phase => ({ name, invocation: tsxInvocation(root, script), timeoutMs, env: environment });
  return [
    npm("root-typecheck", "typecheck"),
    npm("frontend-typecheck", "frontend:typecheck"),
    npm("full-tests", "test"),
    npm("stage3-certification", "certify:stage3"),
    npm("stage4-mcp", "verify:mcp:stage4"),
    npm("stage5-mcp", "verify:mcp:stage5"),
    npm("stage6-mcp", "verify:mcp:stage6"),
    npm("stage7-mcp", "verify:mcp:stage7"),
    npm("stage5-certification", "certify:stage5"),
    npm("stage6-certification", "certify:stage6"),
    npm("stage7-certification", "certify:stage7"),
    tsx("stage8-portable", "scripts/verify-stage-8-portable.ts", 600_000),
    npm("plugin-certification", "verify:plugin"),
    npm("plugin-determinism", "verify:plugin:determinism"),
    npm("package-certification", "certify:package"),
    npm("coverage", "test:coverage"),
    npm("test-quality", "verify:test-quality"),
    tsx("public-artifact-policy", "scripts/verify-public-artifacts.ts"),
  ];
}

function focusedPhases(root: string, environment: NodeJS.ProcessEnv): Phase[] {
  return [
    {
      name: "release-hardening-focused-tests",
      invocation: {
        command: process.execPath,
        args: [join(root, "node_modules/vitest/vitest.mjs"), "run",
          "tests/artifact-versioning.test.ts", "tests/public-evidence-policy.test.ts",
          "tests/release-workflows.test.ts", "--reporter=dot"],
      },
      timeoutMs: 300_000,
      env: environment,
    },
    { name: "public-artifact-policy", invocation: tsxInvocation(root, "scripts/verify-public-artifacts.ts"), timeoutMs: 120_000, env: environment },
  ];
}

export async function certifyCi(environment: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const root = repositoryRoot(import.meta.url);
  const mode = environment.CAMARADE_CERTIFY_CI_MODE === "focused" ? "focused" : "full";
  const artifactRoot = environment.CAMARADE_CI_ARTIFACT_ROOT ?? join(root, ".artifacts", "private", "ci");
  const logRoot = join(artifactRoot, "logs");
  await mkdir(logRoot, { recursive: true });
  const phases = mode === "focused" ? focusedPhases(root, environment) : fullPhases(root, environment);
  const results: Array<Record<string, unknown>> = [];
  let status: "pass" | "fail" = "pass";
  for (const phase of phases) {
    try {
      const result = await requirePortableSuccess({ ...phase.invocation, cwd: root, env: phase.env, timeoutMs: phase.timeoutMs, maximumOutputBytes: 32 * 1024 * 1024 });
      const stdoutFile = `logs/${phase.name}.stdout.log`;
      const stderrFile = `logs/${phase.name}.stderr.log`;
      await writeFile(join(artifactRoot, stdoutFile), result.stdout, "utf8");
      await writeFile(join(artifactRoot, stderrFile), result.stderr, "utf8");
      results.push({ name: phase.name, status: "pass", durationMs: result.durationMs, stdoutFile, stderrFile, stdoutSha256: createHash("sha256").update(result.stdout).digest("hex"), stderrSha256: createHash("sha256").update(result.stderr).digest("hex") });
    } catch (error) {
      status = "fail";
      results.push({ name: phase.name, status: "fail", error: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  const report = { schemaVersion: 1, status, mode, startedFromCleanInstall: null, results };
  await writeFile(join(artifactRoot, "certification.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (status === "fail") throw new Error(`CI_CERTIFICATION_FAILED:${String(results.at(-1)?.name)}`);
  return report;
}

if (isMain(import.meta.url)) {
  certifyCi().then((report) => console.log(JSON.stringify({ status: report.status, mode: report.mode, phases: (report.results as unknown[]).length }))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
