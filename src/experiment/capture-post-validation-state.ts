import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectDiff } from "../evaluator/collect-diff.js";
import { sha256 } from "../context/context-serialization.js";
import { gitOutput } from "./git.js";
import type { ConditionPostValidationState, ExperimentConditionId } from "./experiment-types.js";

export async function capturePostValidationState(conditionId: ExperimentConditionId, worktreePath: string, startingCommit: string, conditionDirectory: string): Promise<ConditionPostValidationState> {
  const diff = await collectDiff(worktreePath);
  const statusPath = resolve(conditionDirectory, "post-validation-git-status.txt"); const changedFilesPath = resolve(conditionDirectory, "post-validation-changed-files.json"); const patchPath = resolve(conditionDirectory, "post-validation.patch"); const statePath = resolve(conditionDirectory, "post-validation-state.json");
  await writeFile(statusPath, diff.statusShort, "utf8"); await writeFile(changedFilesPath, `${JSON.stringify([...diff.changedFiles].sort(), null, 2)}\n`, "utf8"); await writeFile(patchPath, diff.diff, "utf8");
  const state: ConditionPostValidationState = { conditionId, headAfterValidation: (await gitOutput(worktreePath, ["rev-parse", "HEAD"])).trim(), startingCommitMatched: false, statusPath, changedFilesPath, patchPath, patchHash: sha256(diff.diff), changedFiles: [...diff.changedFiles].sort() }; state.startingCommitMatched = state.headAfterValidation === startingCommit; await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8"); return state;
}
