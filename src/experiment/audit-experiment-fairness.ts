import { canonicalJson, sha256 } from "../context/context-serialization.js";
import type {
  ConditionValidationResult,
  ExecutedPreparedExperiment,
  ExperimentStartingState,
  FairnessAudit,
  FairnessAuditCheck,
  PreparedFairExperiment,
} from "./experiment-types.js";
import { sameFilesystemPath } from "./git.js";

export interface AuditExperimentFairnessInput {
  prepared: PreparedFairExperiment;
  executed: ExecutedPreparedExperiment;
  baselineValidation: ConditionValidationResult;
  camaradeValidation: ConditionValidationResult;
  sourcePostRunState: Omit<ExperimentStartingState, "clean"> & { clean: boolean };
}

function check(
  checkId: string,
  ok: boolean,
  message: string,
  baseline?: unknown,
  camarade?: unknown,
): FairnessAuditCheck {
  return {
    checkId,
    status: ok ? "pass" : "fail",
    ...(baseline === undefined ? {} : { baselineValueHash: sha256(canonicalJson(baseline)) }),
    ...(camarade === undefined ? {} : { camaradeValueHash: sha256(canonicalJson(camarade)) }),
    message,
  };
}

export function auditExperimentFairness(input: AuditExperimentFairnessInput): FairnessAudit {
  const { prepared, executed, baselineValidation, camaradeValidation, sourcePostRunState } = input;
  const baseline = prepared.baseline;
  const camarade = prepared.camarade;
  const baselineInvocation = executed.baseline.invocation;
  const camaradeInvocation = executed.camarade.invocation;
  const baselineCommands = baselineValidation.commands ?? [];
  const camaradeCommands = camaradeValidation.commands ?? [];
  const expectedCommands = prepared.specification.validationCommands.length;

  const checks = [
    check("preparation-audit-passed", prepared.fairnessAudit.status === "pass", "Preparation audit"),
    check("execution-audit-passed", executed.fairnessAudit.status === "pass" && executed.fairnessAudit.checks.length > 0, "Execution audit"),
    check("same-starting-commit", baseline.worktree.startingCommit === camarade.worktree.startingCommit, "Starting commit", baseline.worktree.startingCommit, camarade.worktree.startingCommit),
    check("same-starting-tree", baseline.worktree.startingTree === camarade.worktree.startingTree, "Starting tree", baseline.worktree.startingTree, camarade.worktree.startingTree),
    check("same-tracked-tree-hash", baseline.worktree.trackedTreeHash === camarade.worktree.trackedTreeHash, "Tracked tree", baseline.worktree.trackedTreeHash, camarade.worktree.trackedTreeHash),
    check("same-task-hash", baseline.taskHash === camarade.taskHash, "Task hash", baseline.taskHash, camarade.taskHash),
    check("same-context-budget", baseline.contextBudgetHash === camarade.contextBudgetHash, "Context budget", baseline.contextBudgetHash, camarade.contextBudgetHash),
    check("expected-context-treatment-difference", baseline.context.contextHash !== camarade.context.contextHash, "Context differs", baseline.context.contextHash, camarade.context.contextHash),
    check("same-agent-executable", baselineInvocation.executable === camaradeInvocation.executable, "Agent executable", baselineInvocation.executable, camaradeInvocation.executable),
    check("same-agent-version", baselineInvocation.executableVersion === camaradeInvocation.executableVersion, "Agent version", baselineInvocation.executableVersion, camaradeInvocation.executableVersion),
    check("same-agent-arguments", baselineInvocation.normalizedArgumentsHash === camaradeInvocation.normalizedArgumentsHash && canonicalJson(baselineInvocation.arguments) === canonicalJson(camaradeInvocation.arguments), "Agent arguments", baselineInvocation.arguments, camaradeInvocation.arguments),
    check("same-agent-timeout", baselineInvocation.timeoutSeconds === camaradeInvocation.timeoutSeconds, "Agent timeout", baselineInvocation.timeoutSeconds, camaradeInvocation.timeoutSeconds),
    check("same-agent-environment-policy", baselineInvocation.environmentPolicyHash === camaradeInvocation.environmentPolicyHash, "Agent environment policy", baselineInvocation.environmentPolicyHash, camaradeInvocation.environmentPolicyHash),
    check("configured-model-recorded", executed.codex.model.trim() !== "", "Agent model"),
    check("configured-sandbox-recorded", executed.codex.sandbox === "workspace-write", "Sandbox"),
    check("configured-approval-policy-recorded", executed.codex.approvalPolicy === "never", "Approval"),
    check("same-prompt-template", executed.baseline.prompt.templateHash === executed.camarade.prompt.templateHash, "Prompt template", executed.baseline.prompt.templateHash, executed.camarade.prompt.templateHash),
    check("configured-execution-order-recorded", canonicalJson(executed.executionOrder) === canonicalJson(prepared.specification.orderedConditionIds), "Execution order", executed.executionOrder, prepared.specification.orderedConditionIds),
    check("same-validation-command-list", baselineValidation.commandListHash === camaradeValidation.commandListHash, "Validation commands", baselineValidation.commandListHash, camaradeValidation.commandListHash),
    check("same-validation-command-order", canonicalJson(baselineCommands.map((entry) => entry.configuration ?? entry.command)) === canonicalJson(camaradeCommands.map((entry) => entry.configuration ?? entry.command)), "Validation order"),
    check("same-validation-command-count", baselineCommands.length === camaradeCommands.length, "Validation count", baselineCommands.length, camaradeCommands.length),
    check("same-validation-timeout", baselineValidation.timeoutSeconds === camaradeValidation.timeoutSeconds, "Validation timeout", baselineValidation.timeoutSeconds, camaradeValidation.timeoutSeconds),
    check("same-validation-environment-values", baselineValidation.environment.normalizedValueHash === camaradeValidation.environment.normalizedValueHash, "Validation environment", baselineValidation.environment.normalizedValueHash, camaradeValidation.environment.normalizedValueHash),
    check("separate-validation-log-paths", baselineCommands.every((entry, index) => entry.stdoutPath !== camaradeCommands[index]?.stdoutPath && entry.stderrPath !== camaradeCommands[index]?.stderrPath), "Validation logs"),
    check("baseline-all-commands-attempted", baselineCommands.length === expectedCommands, "Baseline attempts", baselineCommands.length, expectedCommands),
    check("camarade-all-commands-attempted", camaradeCommands.length === expectedCommands, "Camarade attempts", camaradeCommands.length, expectedCommands),
    check("separate-worktrees", baseline.worktree.path !== camarade.worktree.path, "Separate worktrees", baseline.worktree.path, camarade.worktree.path),
    check("separate-context-paths", baseline.context.contextPath !== camarade.context.contextPath, "Context paths", baseline.context.contextPath, camarade.context.contextPath),
    check("separate-prompt-paths", executed.baseline.prompt.promptPath !== executed.camarade.prompt.promptPath, "Prompt paths", executed.baseline.prompt.promptPath, executed.camarade.prompt.promptPath),
    check("source-repository-path-unchanged", sameFilesystemPath(sourcePostRunState.repositoryPath, prepared.startingState.repositoryPath), "Source path", sourcePostRunState.repositoryPath, prepared.startingState.repositoryPath),
    check("source-commit-unchanged", sourcePostRunState.startingCommit === prepared.startingState.startingCommit, "Source commit", sourcePostRunState.startingCommit, prepared.startingState.startingCommit),
    check("source-tree-unchanged", sourcePostRunState.startingTree === prepared.startingState.startingTree, "Source tree", sourcePostRunState.startingTree, prepared.startingState.startingTree),
    check("source-tracked-tree-hash-unchanged", sourcePostRunState.repositoryFingerprint === prepared.startingState.repositoryFingerprint, "Source fingerprint", sourcePostRunState.repositoryFingerprint, prepared.startingState.repositoryFingerprint),
    check("source-worktree-clean", sourcePostRunState.clean, "Source clean"),
  ];

  return { status: checks.every((entry) => entry.status === "pass") ? "pass" : "fail", checks };
}
