export interface UnavailableEvidence {
  unavailableReason: string;
}

export type EvidenceValue<T> = T | UnavailableEvidence;

export function isUnavailableEvidence(value: unknown): value is UnavailableEvidence {
  return typeof value === "object" && value !== null &&
    typeof (value as { unavailableReason?: unknown }).unavailableReason === "string" &&
    (value as { unavailableReason: string }).unavailableReason.trim().length > 0;
}

export interface ComparisonRequest { repositoryPath: string; task: string; adapter: string; validationCommands: string[]; }
export type ContextSourceKind = "agents" | "claude" | "cursor" | "copilot" | "readme" | "docs" | "configuration";
export interface ContextSource { relativePath: string; absolutePath: string; kind: ContextSourceKind; content: string; sha256: string; }
export interface ContextPack { task: string; repositorySummary: string; selectedSources: string[]; instructions: string[]; relevantFiles: string[]; protectedFiles: string[]; validationCommands: string[]; }
export type RunCondition = "baseline" | "camarade";
export interface RunIdentity { comparisonId: string; runId: string; condition: RunCondition; }
export interface UsageEvidence { inputTokens?: number; outputTokens?: number; unavailableReason?: string; }
export interface AgentRunResult { exitCode: number | null; startedAt: string; completedAt: string; stdoutPath: string; stderrPath: string; usage: UsageEvidence; }
export interface ValidationResult { command: string; exitCode: number | null; durationMs: number; stdoutPath: string; stderrPath: string; startedAt?: string; completedAt?: string; timedOut?: boolean; spawnFailed?: boolean; terminationWarnings?: string[]; }
export interface RunMetrics { changedFiles: string[]; diffLineCount: number; dependencyFilesChanged: string[]; validationResults: ValidationResult[]; durationMs: number; }
export interface RunPermissions { filesystem: EvidenceValue<string>; network: EvidenceValue<string>; shell: EvidenceValue<string>; }
export interface RunLimits { timeoutSeconds: number; tokenBudget: EvidenceValue<number | string>; }
export interface RunEnvironment { platform: EvidenceValue<string>; runtimeVersions: Record<string, EvidenceValue<string>>; environmentHash: EvidenceValue<string>; }
export interface RunTimestamps { startedAt: string; completedAt: string; }
export interface RunExitCodes { agent: number | null; typecheck?: number | null; lint?: number | null; test?: number | null; build?: number | null; [commandName: string]: number | null | undefined; }
export interface RunArtifacts { logs: string; diff: string; metrics: string; manifest: string; }
export interface RunManifest { comparisonId: string; runId: string; repository: string; startingCommit: string; worktree: string; task: string; adapter: string; adapterVersion: EvidenceValue<string>; model: EvidenceValue<string>; condition: RunCondition; permissions: RunPermissions; limits: RunLimits; environment: RunEnvironment; contextSourceHashes: Record<string, EvidenceValue<string>>; validationCommands: string[]; timestamps: RunTimestamps; exitCodes: RunExitCodes; changedFiles: string[]; artifacts: RunArtifacts; }
export interface RunConfig { validationCommands: string[]; timeoutSeconds: number; }
export interface LoadedRunConfig extends RunConfig { configPath: string | null; }
