import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runValidations } from "../evaluator/run-validations.js";
import { isValidationCommand, type ValidationCommand } from "../core/types.js";
import { writeJsonExclusive } from "../artifacts/write-manifest.js";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import type { ConditionValidationResult, ExecutedCondition, PreparedConditionManifest, ValidationEnvironmentEvidence, ExperimentValidationCommandResult } from "./experiment-types.js";
import { gitOutput } from "./git.js";

export interface RunConditionValidationsInput { condition: ExecutedCondition; preparedCondition: PreparedConditionManifest; commands: readonly ValidationCommand[]; timeoutSeconds: number; conditionDirectory: string; environment: NodeJS.ProcessEnv; environmentEvidence: ValidationEnvironmentEvidence; }

export async function runConditionValidations(input: RunConditionValidationsInput): Promise<ConditionValidationResult> {
  const worktree = resolve(input.preparedCondition.worktree.path);
  const info = await stat(worktree).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new Error(`Validation worktree is unavailable: ${worktree}`);
  const head = (await gitOutput(worktree, ["rev-parse", "HEAD"])).trim();
  if (head !== input.preparedCondition.worktree.startingCommit) throw new Error("Validation worktree starting commit mismatch.");
  if (input.commands.length === 0 || input.commands.some((command) => !isValidationCommand(command))) throw new Error("Validation command list must be non-empty.");
  await mkdir(resolve(input.conditionDirectory, "logs"), { recursive: true });
  const raw = await runValidations({ commands: input.commands, cwd: worktree, logsDirectory: resolve(input.conditionDirectory, "logs"), timeoutSeconds: input.timeoutSeconds, environment: input.environment });
  const commands: ExperimentValidationCommandResult[] = raw.map((r, i) => ({ command: r.command, ...(r.configuration === undefined ? {} : { configuration: r.configuration }), startedAt: r.startedAt ?? new Date(0).toISOString(), completedAt: r.completedAt ?? new Date(0).toISOString(), durationMs: r.durationMs, exitCode: r.exitCode, timedOut: r.timedOut ?? false, stdoutPath: r.stdoutPath, stderrPath: r.stderrPath, sequence: i + 1, spawnFailed: r.spawnFailed ?? false, terminationWarnings: r.terminationWarnings ?? [] }));
  const status = commands.some((c) => c.timedOut) ? "timed-out" : commands.every((c) => c.exitCode === 0 && !c.spawnFailed) ? "passed" : "failed";
  const result: ConditionValidationResult = { conditionId: input.condition.conditionId, commands, status, timeoutSeconds: input.timeoutSeconds, commandListHash: sha256(canonicalJson(input.commands)), environment: input.environmentEvidence, resultPath: resolve(input.conditionDirectory, "validation-results.json") };
  await writeJsonExclusive(result.resultPath, result, "Validation results");
  return result;
}
