import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runValidations } from "../evaluator/run-validations.js";
import { collectDiff } from "../evaluator/collect-diff.js";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
import {
  evaluationCheckSchema,
  type EvaluationCheck,
} from "./evaluation-definition-schema.js";
import { EvaluationExecutionError } from "./evaluation-execution-errors.js";
import {
  experimentRelative,
  globMatch,
  hashBytes,
  hashJson,
  safePath,
  TEXT_LIMIT,
  JSON_LIMIT,
  REPORT_LIMIT,
} from "./evaluation-execution-helpers.js";
import type {
  EvaluationCheckExecutionResult,
  EvaluationCheckIdentity,
  EvaluationExecutionContext,
  EvaluationCheckEvidence,
} from "./evaluation-execution-types.js";
import type { ConditionPostValidationState } from "../experiment/experiment-types.js";
function now(): string {
  return new Date().toISOString();
}
function base(
  identity: EvaluationCheckIdentity,
  result: EvaluationCheckExecutionResult["result"],
  message: string,
  start: string,
  evidence: EvaluationCheckEvidence,
  paths: string[] = [],
): EvaluationCheckExecutionResult {
  const completed = now();
  return {
    ...identity,
    result,
    message,
    startedAt: start,
    completedAt: completed,
    durationMs: Math.max(0, Date.parse(completed) - Date.parse(start)),
    evidencePaths: paths,
    evidence,
  };
}
function errorEvidence(
  check: EvaluationCheck,
  _message: string,
): EvaluationCheckEvidence {
  const path = "path" in check ? check.path : "";
  if (check.type === "command")
    return {
      kind: "command",
      commandHash: sha256(check.command),
      successExitCodes: check.successExitCodes,
      exitCode: null,
      timedOut: false,
      spawnFailed: false,
      stdoutRelativePath: "",
      stderrRelativePath: "",
      worktreeUnchanged: true,
    };
  if (check.type === "path-changed" || check.type === "path-unchanged")
    return {
      kind: "path",
      pattern: check.path,
      matchedPaths: [],
      changedFilesEvidenceRelativePath: "",
    };
  if (check.type === "dependency-present" || check.type === "dependency-absent")
    return {
      kind: "dependency",
      packageManager: "other",
      packageName: check.package,
      manifestRelativePath: "package.json",
      manifestHash: "",
      present: false,
    };
  if (check.type === "json-value")
    return {
      kind: "json",
      repositoryRelativePath: path,
      pointer: check.pointer,
      fileHash: "",
      expectedValueHash: hashJson(check.equals),
      pointerFound: false,
    };
  if (check.type === "text-present" || check.type === "text-absent")
    return {
      kind: "text",
      repositoryRelativePath: path,
      fileHash: "",
      byteLength: 0,
      matchFound: false,
    };
  return { kind: "file", repositoryRelativePath: path, observedKind: "error" };
}
export async function executeEvaluationCheck(
  raw: unknown,
  identity: EvaluationCheckIdentity,
  context: EvaluationExecutionContext,
): Promise<EvaluationCheckExecutionResult> {
  const started = now();
  const source = raw as Record<string, unknown>;
  const { weight: _weight, mandatory: _mandatory, ...unweighted } = source;
  let check: EvaluationCheck;
  try { check = evaluationCheckSchema.parse(unweighted) as EvaluationCheck; } catch (error) { return base(identity, "error", error instanceof Error ? error.message : "Invalid evaluation check.", started, errorEvidence(raw as EvaluationCheck, "Invalid evaluation check.")); }
  try {
    if ((check.type === "dependency-present" || check.type === "dependency-absent") && context.packageManager === "other") {
      return base(identity, "unavailable", "Unsupported package manager for deterministic dependency check.", started, { kind: "dependency", packageManager: "other", packageName: check.package, manifestRelativePath: "package.json", manifestHash: "", present: false });
    }
    if (check.type === "path-changed" || check.type === "path-unchanged") {
      const matched = context.postValidationState.changedFiles
        .filter((path) => globMatch(check.path, path))
        .sort();
      const pass =
        check.type === "path-changed"
          ? matched.length > 0
          : matched.length === 0;
      return base(
        identity,
        pass ? "pass" : "fail",
        pass
          ? "Path pattern condition satisfied."
          : "Path pattern condition not satisfied.",
        started,
        {
          kind: "path",
          pattern: check.path,
          matchedPaths: matched,
          changedFilesEvidenceRelativePath: experimentRelative(
            context.experimentDirectory,
            context.postValidationState.changedFilesPath,
          ),
        },
        [
          experimentRelative(
            context.experimentDirectory,
            context.postValidationState.changedFilesPath,
          ),
        ],
      );
    }
    if (
      check.type === "dependency-present" ||
      check.type === "dependency-absent"
    ) {
      const loaded = await safePath(
        context.worktreePath,
        "package.json",
        JSON_LIMIT,
      );
      const value = JSON.parse(loaded.bytes.toString("utf8")) as Record<
        string,
        unknown
      >;
      const sections = [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ];
      const present = sections.some((section) => {
        const item = value[section];
        return (
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Object.prototype.hasOwnProperty.call(item, check.package)
        );
      });
      const pass = check.type === "dependency-present" ? present : !present;
      return base(
        identity,
        pass ? "pass" : "fail",
        pass
          ? "Dependency condition satisfied."
          : "Dependency condition not satisfied.",
        started,
        {
          kind: "dependency",
          packageManager: "npm",
          packageName: check.package,
          manifestRelativePath: "package.json",
          manifestHash: hashBytes(loaded.bytes),
          present,
        },
        ["package.json"],
      );
    }
    if (check.type === "command") {
      const dir = join(
        context.experimentDirectory,
        "evaluation-results",
        context.conditionId,
        "commands",
        `${String(identity.sequence).padStart(3, "0")}-${check.id}`,
      );
      await mkdir(dir, { recursive: true });
      const before = await collectDiff(context.worktreePath);
      const [run] = await runValidations({
        commands: [check.command],
        cwd: context.worktreePath,
        logsDirectory: dir,
        timeoutSeconds: check.timeoutSeconds,
        environment: context.environment,
      });
      const after = await collectDiff(context.worktreePath);
      const unchanged =
        sha256(
          canonicalJson({
            status: before.statusShort,
            files: before.changedFiles,
            diff: before.diff,
          }),
        ) ===
        sha256(
          canonicalJson({
            status: after.statusShort,
            files: after.changedFiles,
            diff: after.diff,
          }),
        );
      const result = !unchanged
        ? "error"
        : run.spawnFailed || run.timedOut
          ? "error"
          : check.successExitCodes.includes(run.exitCode ?? -1)
            ? "pass"
            : "fail";
      const stdout = experimentRelative(
          context.experimentDirectory,
          run.stdoutPath,
        ),
        stderr = experimentRelative(
          context.experimentDirectory,
          run.stderrPath,
        );
      return base(
        identity,
        result,
        !unchanged
          ? "EVALUATION_COMMAND_MUTATED_WORKTREE"
          : result === "pass"
            ? "Command succeeded."
            : "Command failed.",
        started,
        {
          kind: "command",
          successExitCodes: check.successExitCodes,
          commandHash: sha256(check.command),
          exitCode: run.exitCode,
          timedOut: !!run.timedOut,
          spawnFailed: !!run.spawnFailed,
          stdoutRelativePath: stdout,
          stderrRelativePath: stderr,
          worktreeUnchanged: unchanged,
        },
        [stdout, stderr],
      );
    }
    const path = "path" in check ? check.path : "";
    const loaded = await safePath(
      context.worktreePath,
      path,
      check.type === "json-value" ? JSON_LIMIT : TEXT_LIMIT,
    );
    const hash = hashBytes(loaded.bytes);
    if (check.type === "file-exists" || check.type === "file-absent") {
      const pass = check.type === "file-exists";
      return base(
        identity,
        pass ? "pass" : "fail",
        pass ? "Regular file exists." : "Entry exists.",
        started,
        {
          kind: "file",
          repositoryRelativePath: path,
          observedKind: "regular-file",
          sha256: hash,
          byteLength: loaded.stat.size,
        },
        [path],
      );
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
    if (check.type === "text-present" || check.type === "text-absent") {
      const found = text.includes(check.text),
        pass = check.type === "text-present" ? found : !found;
      return base(
        identity,
        pass ? "pass" : "fail",
        pass ? "Text condition satisfied." : "Text condition not satisfied.",
        started,
        {
          kind: "text",
          repositoryRelativePath: path,
          fileHash: hash,
          byteLength: loaded.stat.size,
          matchFound: found,
        },
        [path],
      );
    }
    if (check.type === "json-value") {
      const value = JSON.parse(text) as unknown;
      const segments = check.pointer === "" ? [] : check.pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      let actual: unknown = value;
      let found = true;
      for (const segment of segments) {
        if (actual !== null && typeof actual === "object" && Object.prototype.hasOwnProperty.call(actual, segment)) actual = (actual as Record<string, unknown>)[segment];
        else { found = false; break; }
      }
      const pass = found && hashJson(actual) === hashJson(check.equals);
      return base(
        identity,
        pass ? "pass" : "fail",
        pass ? "JSON value matches." : "JSON value does not match.",
        started,
        {
          kind: "json",
          repositoryRelativePath: path,
          pointer: check.pointer,
          fileHash: hash,
          expectedValueHash: hashJson(check.equals),
          actualValueHash: found ? hashJson(actual) : undefined,
          pointerFound: found,
        },
        [path],
      );
    }
    throw new Error("Unsupported check type");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Evaluation check failed.";
    if (error instanceof EvaluationExecutionError && error.code === "EVALUATION_FILE_INVALID" && message.includes("missing") && check.type === "file-absent") {
      return base(identity, "pass", "No filesystem entry exists.", started, { kind: "file", repositoryRelativePath: check.path, observedKind: "missing" }, [check.path]);
    }
    return base(
      identity,
      error instanceof EvaluationExecutionError &&
        error.code === "EVALUATION_FILE_INVALID" &&
        message.includes("missing")
        ? "fail"
        : "error",
      message,
      started,
      errorEvidence(check, message),
    );
  }
}
