import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ConditionRuntimeLayout, ExperimentConditionId } from "./experiment-types.js";
import { isPathWithin } from "./git.js";
export async function createConditionRuntime(experimentDirectory: string, conditionId: ExperimentConditionId): Promise<ConditionRuntimeLayout> {
  const dir = resolve(experimentDirectory, conditionId); const logs = join(dir, "logs"); await mkdir(logs, { recursive: true });
  const files: ConditionRuntimeLayout = { conditionId, conditionDirectory: dir, logsDirectory: logs, promptPath: join(dir,"prompt.md"), invocationPath: join(dir,"invocation.json"), stdoutPath: join(logs,"codex.jsonl"), stderrPath: join(logs,"codex.stderr.log"), finalMessagePath: join(dir,"final-message.txt"), transcriptSummaryPath: join(dir,"transcript-summary.json"), processResultPath: join(dir,"process-result.json"), gitStatusPath: join(dir,"git-status.txt"), changedFilesPath: join(dir,"changed-files.json"), patchPath: join(dir,"diff.patch") };
  for (const path of Object.entries(files).filter(([key]) => key !== "conditionId").map(([, value]) => value)) if (!isPathWithin(dir, path)) throw new Error("Runtime path escaped condition directory"); return files;
}
