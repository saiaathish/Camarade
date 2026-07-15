import { lstat, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { RunConfigError } from "../core/errors.js";
import type { LoadedRunConfig } from "../core/types.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudgetConfig
} from "../context/context-types.js";

const DEFAULT_TIMEOUT = 1800;

export interface LoadedRunConfigWithContext extends LoadedRunConfig {
  contextCompilerBudget?: ContextBudgetConfig;
  experiment?: ExperimentRunConfig;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RunConfigError(`${field} must be a positive integer in camarade.run.yaml.`);
  }
  return value;
}

function contextBudget(config: Record<string, unknown>): ContextBudgetConfig | undefined {
  const rawCompiler = config.context_compiler;
  if (rawCompiler === undefined) return undefined;
  if (typeof rawCompiler !== "object" || rawCompiler === null || Array.isArray(rawCompiler)) {
    throw new RunConfigError("context_compiler must be a mapping in camarade.run.yaml.");
  }
  const rawBudget = (rawCompiler as Record<string, unknown>).budget;
  if (rawBudget === undefined) return undefined;
  if (typeof rawBudget !== "object" || rawBudget === null || Array.isArray(rawBudget)) {
    throw new RunConfigError("context_compiler.budget must be a mapping in camarade.run.yaml.");
  }
  const budget = rawBudget as Record<string, unknown>;
  const unit = budget.unit ?? DEFAULT_CONTEXT_BUDGET.unit;
  if (unit !== "characters") {
    throw new RunConfigError("context_compiler.budget.unit must be characters in camarade.run.yaml.");
  }
  return {
    unit,
    maximum: positiveInteger(
      budget.maximum ?? DEFAULT_CONTEXT_BUDGET.maximum,
      "context_compiler.budget.maximum"
    ),
    maximumItems: positiveInteger(
      budget.maximum_items ?? DEFAULT_CONTEXT_BUDGET.maximumItems,
      "context_compiler.budget.maximum_items"
    ),
    maximumEvidenceItemsPerRule: positiveInteger(
      budget.maximum_evidence_items_per_rule ?? DEFAULT_CONTEXT_BUDGET.maximumEvidenceItemsPerRule,
      "context_compiler.budget.maximum_evidence_items_per_rule"
    )
  };
}

import type { ExperimentRunConfig, ExperimentInstructionMode, ExperimentExecutionOrder } from "../experiment/experiment-types.js";

export async function loadRunConfig(repositoryPath: string): Promise<LoadedRunConfigWithContext> {
  if (repositoryPath.trim() === "") throw new RunConfigError("Repository path is empty.");
  let repositoryStat;
  try { repositoryStat = await stat(repositoryPath); } catch (cause) { throw new RunConfigError(`Repository path does not exist: ${repositoryPath}`, cause); }
  if (!repositoryStat.isDirectory()) throw new RunConfigError(`Repository path is not a directory: ${repositoryPath}`);
  const configPath = join(repositoryPath, "camarade.run.yaml");
  let text: string;
  try { const configStat = await lstat(configPath); if (!configStat.isFile()) throw new RunConfigError("Config path is not a regular file: camarade.run.yaml"); text = await readFile(configPath, "utf8"); }
  catch (cause) { if (cause instanceof RunConfigError) throw cause; if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { configPath: null, validationCommands: [], timeoutSeconds: DEFAULT_TIMEOUT }; throw new RunConfigError("Config cannot be read: camarade.run.yaml", cause); }
  let parsed: unknown;
  try { parsed = parse(text); } catch (cause) { throw new RunConfigError("Invalid YAML syntax in camarade.run.yaml.", cause); }
  if (parsed === null) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new RunConfigError("YAML root must be a mapping in camarade.run.yaml.");
  const config = parsed as Record<string, unknown>;
  const rawCommands = config.validationCommands;
  if (rawCommands !== undefined && !Array.isArray(rawCommands)) throw new RunConfigError("validationCommands must be an array in camarade.run.yaml.");
  const commands = (rawCommands ?? []).map((command, index) => { if (typeof command !== "string" || command.trim() === "") throw new RunConfigError(`Validation command at index ${index} must be a non-empty string in camarade.run.yaml.`); return command.trim(); });
  if (new Set(commands).size !== commands.length) throw new RunConfigError("validationCommands contains duplicate commands after trimming in camarade.run.yaml.");
  const timeout = config.timeoutSeconds ?? DEFAULT_TIMEOUT;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) throw new RunConfigError("timeoutSeconds must be a positive integer in camarade.run.yaml.");
  const compilerBudget = contextBudget(config);
  const base = {
    configPath,
    validationCommands: commands,
    timeoutSeconds: timeout,
    ...(compilerBudget === undefined ? {} : { contextCompilerBudget: compilerBudget })
  };
  const rawExperiment = config.experiment;
  if (rawExperiment === undefined) return base;
  if (!isMapping(rawExperiment) || hasUnknown(rawExperiment, ["instruction_mode", "execution_order", "codex"])) throw new RunConfigError("experiment must be a valid mapping in camarade.run.yaml.");
  const mode = rawExperiment.instruction_mode;
  const order = rawExperiment.execution_order;
  if (mode !== "augmentation" && mode !== "replacement") throw new RunConfigError("experiment.instruction_mode is invalid in camarade.run.yaml.");
  if (order !== "baseline-first" && order !== "camarade-first") throw new RunConfigError("experiment.execution_order is invalid in camarade.run.yaml.");
  const rawCodex = rawExperiment.codex;
  if (!isMapping(rawCodex) || hasUnknown(rawCodex, ["executable", "timeout_seconds", "arguments", "environment_allowlist"])) throw new RunConfigError("experiment.codex must be a valid mapping in camarade.run.yaml.");
  if (typeof rawCodex.executable !== "string" || rawCodex.executable.trim() === "" || rawCodex.executable.includes("\0")) throw new RunConfigError("experiment.codex.executable is invalid in camarade.run.yaml.");
  const codexTimeout = rawCodex.timeout_seconds;
  if (typeof codexTimeout !== "number" || !Number.isSafeInteger(codexTimeout) || codexTimeout <= 0) throw new RunConfigError("experiment.codex.timeout_seconds must be a positive safe integer in camarade.run.yaml.");
  const args = rawCodex.arguments ?? [];
  if (!Array.isArray(args) || args.some((v) => typeof v !== "string" || v.length === 0 || v.includes("\0"))) throw new RunConfigError("experiment.codex.arguments is invalid in camarade.run.yaml.");
  const env = rawCodex.environment_allowlist ?? [];
  if (!Array.isArray(env) || env.some((v) => typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) || new Set(env).size !== env.length) throw new RunConfigError("experiment.codex.environment_allowlist is invalid in camarade.run.yaml.");
  const experiment: ExperimentRunConfig = { instructionMode: mode as ExperimentInstructionMode, executionOrder: order as ExperimentExecutionOrder, codex: { executable: rawCodex.executable.trim(), timeoutSeconds: codexTimeout, arguments: [...args] as string[], environmentAllowlist: [...env].sort() as string[] } };
  return { ...base, experiment };
}

function isMapping(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasUnknown(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).some((key) => !allowed.includes(key)); }
