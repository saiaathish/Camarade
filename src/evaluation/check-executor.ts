import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EvaluationCheck } from "./evaluation-definition-schema.js";
import type { ChangeAnalysisResult, CheckMeasurement, DependencyAnalysisResult, MeasurementStatus } from "./types.js";
import { matchesPathPattern } from "./path-matcher.js";
import { runEvaluationCommand } from "./command-runner.js";

export interface CheckExecutionContext {
  condition: "baseline" | "camarade";
  sandboxPath: string;
  logsDirectory: string;
  changes: ChangeAnalysisResult;
  dependencies: DependencyAnalysisResult;
  environment: NodeJS.ProcessEnv;
}

function inside(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function result(id: string, type: string, status: MeasurementStatus, message: string, path: string): CheckMeasurement {
  return { id, type, status, message, evidence: [{ path, description: message }] };
}

async function safeState(root: string, relativePath: string) {
  const path = resolve(root, relativePath);
  if (!inside(root, path)) throw new Error(`Check path escapes evaluation sandbox: ${relativePath}`);
  const state = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (state?.isSymbolicLink()) throw new Error(`Check path is symbolic and cannot be measured safely: ${relativePath}`);
  return { path, state };
}

function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  return pointer.slice(1).split("/").reduce<unknown>((current, rawPart) => {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) return /^\d+$/u.test(part) ? current[Number.parseInt(part, 10)] : undefined;
    return typeof current === "object" && current !== null ? (current as Record<string, unknown>)[part] : undefined;
  }, value);
}

function allDeclaredPackages(dependencies: DependencyAnalysisResult): Set<string> {
  return new Set([
    ...dependencies.additions.map((change) => change.package),
    ...dependencies.versionChanges.map((change) => change.package)
  ]);
}

async function packageNames(sandboxPath: string): Promise<Set<string>> {
  const path = resolve(sandboxPath, "package.json");
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "{}" : Promise.reject(error));
  const value = JSON.parse(raw) as Record<string, unknown>;
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  return new Set(sections.flatMap((section) => {
    const entries = value[section];
    return typeof entries === "object" && entries !== null && !Array.isArray(entries) ? Object.keys(entries) : [];
  }));
}

export async function executeEvaluationCheck(check: EvaluationCheck, context: CheckExecutionContext, idPrefix: string): Promise<CheckMeasurement> {
  try {
    if (check.type === "command") {
      const command = await runEvaluationCommand({
        id: `${idPrefix}-${check.id}`,
        command: check.command,
        workingDirectory: context.sandboxPath,
        logsDirectory: context.logsDirectory,
        timeoutSeconds: check.timeoutSeconds,
        successExitCodes: check.successExitCodes,
        structuredReport: check.structuredReport,
        environment: context.environment
      });
      return {
        id: check.id,
        type: check.type,
        status: command.status,
        message: command.status === "pass" ? `Command passed with exit code ${String(command.exitCode)}.` : command.timedOut ? "Command timed out." : command.spawnFailed ? "Command could not be launched." : `Command failed with exit code ${String(command.exitCode)}.`,
        evidence: [
          { path: command.resultPath, description: "Structured command result" },
          { path: command.stdoutPath, description: "Command stdout" },
          { path: command.stderrPath, description: "Command stderr" }
        ],
        commandResult: command
      };
    }
    if (check.type === "path-changed" || check.type === "path-unchanged") {
      const changed = context.changes.files.some((file) => file.classification !== "ignored-control-artifact" && matchesPathPattern(file.path, check.path));
      const passed = check.type === "path-changed" ? changed : !changed;
      return result(check.id, check.type, passed ? "pass" : "fail", `${check.path} was ${changed ? "changed" : "unchanged"}.`, "changes.json");
    }
    if (check.type === "dependency-present" || check.type === "dependency-absent") {
      if (context.dependencies.status === "unavailable") return result(check.id, check.type, "unavailable", context.dependencies.limitation ?? "Dependency measurement unavailable.", "dependencies.json");
      const names = await packageNames(context.sandboxPath);
      const present = names.has(check.package);
      const passed = check.type === "dependency-present" ? present : !present;
      return result(check.id, check.type, passed ? "pass" : "fail", `${check.package} is ${present ? "declared" : "not declared"} in the package manifest.`, "dependencies.json");
    }
    if (!("path" in check)) return result(check.id, check.type, "unavailable", `Check type ${check.type} does not expose a measurable path.`, "evaluation-definition.json");
    const inspected = await safeState(context.sandboxPath, check.path);
    if (check.type === "file-exists" || check.type === "file-absent") {
      const exists = inspected.state !== undefined;
      const passed = check.type === "file-exists" ? exists : !exists;
      return result(check.id, check.type, passed ? "pass" : "fail", `${check.path} ${exists ? "exists" : "does not exist"}.`, inspected.path);
    }
    if (inspected.state === undefined || !inspected.state.isFile()) return result(check.id, check.type, "fail", `${check.path} is not a regular file.`, inspected.path);
    const content = await readFile(inspected.path, "utf8");
    if (check.type === "text-present" || check.type === "text-absent") {
      const present = content.includes(check.text);
      const passed = check.type === "text-present" ? present : !present;
      return result(check.id, check.type, passed ? "pass" : "fail", `Declared text is ${present ? "present" : "absent"} in ${check.path}.`, inspected.path);
    }
    if (check.type === "json-value") {
      const actual = readJsonPointer(JSON.parse(content) as unknown, check.pointer);
      const passed = JSON.stringify(actual) === JSON.stringify(check.equals);
      return result(check.id, check.type, passed ? "pass" : "fail", passed ? `JSON pointer ${check.pointer || "/"} matched.` : `JSON pointer ${check.pointer || "/"} did not match.`, inspected.path);
    }
    allDeclaredPackages(context.dependencies);
    return result(check.id, check.type, "unavailable", `Unsupported check type: ${(check as { type: string }).type}`, "evaluation-definition.json");
  } catch (error) {
    return result(check.id, check.type, "error", error instanceof Error ? error.message : String(error), "evaluation-error");
  }
}

export function aggregateCheckStatus(checks: readonly CheckMeasurement[]): MeasurementStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "unavailable")) return "unavailable";
  return "pass";
}
