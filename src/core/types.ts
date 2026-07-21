export interface UnavailableEvidence {
  unavailableReason: string;
}

export type EvidenceValue<T> = T | UnavailableEvidence;

export function isUnavailableEvidence(value: unknown): value is UnavailableEvidence {
  return typeof value === "object" && value !== null &&
    typeof (value as { unavailableReason?: unknown }).unavailableReason === "string" &&
    (value as { unavailableReason: string }).unavailableReason.trim().length > 0;
}

export type DegradationCode =
  | "REPOSITORY_TOO_LARGE"
  | "UNSUPPORTED_ENCODING"
  | "NO_GIT_HISTORY"
  | "SHALLOW_HISTORY"
  | "VALIDATION_COMMAND_UNAVAILABLE"
  | "TELEMETRY_UNAVAILABLE"
  | "DASHBOARD_ARTIFACT_TOO_LARGE"
  | "AGENT_AUTHENTICATION_REQUIRED"
  | "UNSUPPORTED_ARTIFACT_VERSION";

export interface DegradationEvidence {
  code: DegradationCode;
  message: string;
}

export interface StructuredValidationCommand {
  executable: string;
  arguments?: string[];
  workingDirectory?: string;
  timeoutSeconds?: number;
}

export type ValidationCommand = string | StructuredValidationCommand;

export function validationCommandLabel(command: ValidationCommand): string {
  if (typeof command === "string") return command;
  const argumentsLabel = (command.arguments ?? []).map((argument) => JSON.stringify(argument)).join(" ");
  const invocation = argumentsLabel === "" ? command.executable : `${command.executable} ${argumentsLabel}`;
  return command.workingDirectory === undefined ? invocation : `${invocation} (cwd: ${command.workingDirectory})`;
}

export function isValidationCommand(value: unknown): value is ValidationCommand {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  if (typeof command.executable !== "string" || command.executable.trim() === "") return false;
  if (command.arguments !== undefined && (!Array.isArray(command.arguments) || command.arguments.some((item) => typeof item !== "string"))) return false;
  if (command.workingDirectory !== undefined && typeof command.workingDirectory !== "string") return false;
  return command.timeoutSeconds === undefined ||
    (typeof command.timeoutSeconds === "number" && Number.isSafeInteger(command.timeoutSeconds) && command.timeoutSeconds > 0);
}

export interface ComparisonRequest { repositoryPath: string; task: string; adapter: string; validationCommands: ValidationCommand[]; }
export type ContextSourceKind = "agents" | "claude" | "cursor" | "copilot" | "readme" | "docs" | "configuration";
export interface ContextSource { relativePath: string; absolutePath: string; kind: ContextSourceKind; content: string; sha256: string; }
export interface ContextPack { task: string; repositorySummary: string; selectedSources: string[]; instructions: string[]; relevantFiles: string[]; protectedFiles: string[]; validationCommands: string[]; }
export type RunCondition = "baseline" | "camarade";
export interface RunIdentity { comparisonId: string; runId: string; condition: RunCondition; }
export interface UsageEvidence { inputTokens?: number; outputTokens?: number; unavailableReason?: string; }
export interface AgentRunResult { exitCode: number | null; startedAt: string; completedAt: string; stdoutPath: string; stderrPath: string; usage: UsageEvidence; }
export interface ValidationResult { command: string; configuration?: ValidationCommand; exitCode: number | null; durationMs: number; stdoutPath: string; stderrPath: string; startedAt?: string; completedAt?: string; timedOut?: boolean; spawnFailed?: boolean; terminationWarnings?: string[]; degradationCode?: DegradationCode; }
export interface RunMetrics { changedFiles: string[]; diffLineCount: number; dependencyFilesChanged: string[]; validationResults: ValidationResult[]; durationMs: number; }
export interface RunPermissions { filesystem: EvidenceValue<string>; network: EvidenceValue<string>; shell: EvidenceValue<string>; }
export interface RunLimits { timeoutSeconds: number; tokenBudget: EvidenceValue<number | string>; }
export interface RunEnvironment { platform: EvidenceValue<string>; runtimeVersions: Record<string, EvidenceValue<string>>; environmentHash: EvidenceValue<string>; }
export interface RunTimestamps { startedAt: string; completedAt: string; }
export interface RunExitCodes { agent: number | null; typecheck?: number | null; lint?: number | null; test?: number | null; build?: number | null; [commandName: string]: number | null | undefined; }
export interface RunArtifacts { logs: string; diff: string; metrics: string; manifest: string; }
export interface RunManifest { comparisonId: string; runId: string; repository: string; startingCommit: string; worktree: string; task: string; adapter: string; adapterVersion: EvidenceValue<string>; model: EvidenceValue<string>; condition: RunCondition; permissions: RunPermissions; limits: RunLimits; environment: RunEnvironment; contextSourceHashes: Record<string, EvidenceValue<string>>; validationCommands: ValidationCommand[]; timestamps: RunTimestamps; exitCodes: RunExitCodes; changedFiles: string[]; artifacts: RunArtifacts; }
export interface RunConfig { validationCommands: ValidationCommand[]; timeoutSeconds: number; }
export interface LoadedRunConfig extends RunConfig { configPath: string | null; }
