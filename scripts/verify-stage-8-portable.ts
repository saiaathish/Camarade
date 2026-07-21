import { isMain, npmInvocation, repositoryRoot, requirePortableSuccess, tsxInvocation } from "./lib/portable-command.js";

export async function verifyStage8Portable(environment: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const root = repositoryRoot(import.meta.url);
  const stage8Environment = { ...environment, CAMARADE_STAGE8_ALLOW_FRONTEND_DIFF: "1" };
  const phases = [
    { name: "build-stage8", invocation: npmInvocation(["run", "build:stage8"]), env: environment, timeoutMs: 300_000 },
    { name: "verify-stage8-foundation", invocation: tsxInvocation(root, "scripts/verify-stage-8-foundation.ts"), env: stage8Environment, timeoutMs: 300_000 },
    { name: "verify-stage8-integration", invocation: tsxInvocation(root, "scripts/verify-stage-8.ts"), env: environment, timeoutMs: 120_000 },
    { name: "certify-stage8", invocation: tsxInvocation(root, "scripts/certify-stage-8.ts"), env: environment, timeoutMs: 120_000 },
  ];
  const results: Array<Record<string, unknown>> = [];
  for (const phase of phases) {
    const result = await requirePortableSuccess({ ...phase.invocation, cwd: root, env: phase.env, timeoutMs: phase.timeoutMs });
    results.push({ name: phase.name, status: "pass", durationMs: result.durationMs });
  }
  return { schemaVersion: 1, status: "pass", phases: results };
}

if (isMain(import.meta.url)) {
  verifyStage8Portable().then((report) => console.log(JSON.stringify(report))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
