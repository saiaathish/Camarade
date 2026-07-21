import { lstat, readFile } from "node:fs/promises";
import { DashboardRunSchema, type DashboardRun } from "../dashboard/contract.js";
import type {
  ExperimentArtifactIndex,
  ExperimentArtifactIndexEntry,
  ExperimentArtifactKind,
} from "../experiment/experiment-types.js";

export const ARTIFACT_VERSION_ERROR = "UNSUPPORTED_ARTIFACT_VERSION" as const;
export const ARTIFACT_INVALID_ERROR = "INVALID_ARTIFACT" as const;
export const MAX_VERSIONED_ARTIFACT_BYTES = 16 * 1024 * 1024;

export type VersionedArtifactKind =
  | "stage-3-intelligence"
  | "stage-4-context-contract"
  | "stage-5-experiment"
  | "stage-6-measurement"
  | "stage-6-scoring"
  | "stage-7-explanation"
  | "dashboard-run"
  | "experiment-artifact-index";
export type VersionedArtifact = DashboardRun | ExperimentArtifactIndex | Record<string, unknown>;
export const SUPPORTED_ARTIFACT_VERSIONS: Readonly<Record<VersionedArtifactKind, string>> = {
  "stage-3-intelligence": "1.0.0",
  "stage-4-context-contract": "1.0.0",
  "stage-5-experiment": "1.0.0",
  "stage-6-measurement": "s6-04.1",
  "stage-6-scoring": "s6-05.1",
  "stage-7-explanation": "s7-03.1",
  "dashboard-run": "stage-8-dashboard.v1",
  "experiment-artifact-index": "1.0.0",
};

export class ArtifactReaderError extends Error {
  constructor(
    readonly code: typeof ARTIFACT_VERSION_ERROR | typeof ARTIFACT_INVALID_ERROR,
    message: string,
    readonly artifactKind: VersionedArtifactKind,
    readonly version?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactReaderError";
  }
}

const INDEX_KINDS = new Set<ExperimentArtifactKind>([
  "specification", "starting-state", "context", "context-manifest", "preparation",
  "prompt", "invocation", "process-output", "execution-result", "validation-output",
  "validation-result", "post-validation-state", "fairness-audit", "cleanup-result",
  "evaluation-seal",
  "evaluation-definition", "evaluation-hidden-asset", "evaluation-execution",
  "evaluation-check-result", "evaluation-command-output", "evaluation-structured-report",
  "experiment-measurement", "condition-measurement", "measurement-evidence",
  "condition-score", "experiment-comparison", "comparison-report",
  "scoring-evidence-index", "other",
]);
const SHA256 = /^[0-9a-f]{64}$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function versionOf(kind: VersionedArtifactKind, value: unknown): string | undefined {
  const candidate = record(value);
  if (candidate === undefined) return undefined;
  if (kind === "stage-5-experiment") {
    const specification = record(candidate.specification);
    return typeof specification?.schemaVersion === "string" ? specification.schemaVersion : undefined;
  }
  const version = candidate.schemaVersion;
  return typeof version === "string" ? version : undefined;
}

function invalid(kind: VersionedArtifactKind, version: string, message: string): never {
  throw new ArtifactReaderError(ARTIFACT_INVALID_ERROR, message, kind, version);
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") &&
    !value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function parseIndexEntry(value: unknown, index: number): ExperimentArtifactIndexEntry {
  const entry = record(value);
  if (entry === undefined) invalid("experiment-artifact-index", "1.0.0", `entries[${index}] must be an object.`);
  const allowed = new Set(["relativePath", "kind", "conditionId", "sha256", "byteLength"]);
  if (Object.keys(entry).some((key) => !allowed.has(key))) invalid("experiment-artifact-index", "1.0.0", `entries[${index}] has an unknown field.`);
  if (!isSafeRelativePath(entry.relativePath) || !INDEX_KINDS.has(entry.kind as ExperimentArtifactKind) ||
      typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) ||
      !Number.isSafeInteger(entry.byteLength) || (entry.byteLength as number) < 0 ||
      (entry.conditionId !== undefined && entry.conditionId !== "baseline" && entry.conditionId !== "camarade")) {
    invalid("experiment-artifact-index", "1.0.0", `entries[${index}] is malformed.`);
  }
  return entry as unknown as ExperimentArtifactIndexEntry;
}

function parseArtifactIndex(value: unknown): ExperimentArtifactIndex {
  const index = record(value);
  if (index === undefined) invalid("experiment-artifact-index", "1.0.0", "Artifact index must be an object.");
  const allowed = new Set(["schemaVersion", "experimentId", "entries", "entriesHash"]);
  if (Object.keys(index).some((key) => !allowed.has(key)) ||
      typeof index.experimentId !== "string" || index.experimentId.length === 0 ||
      !Array.isArray(index.entries) || typeof index.entriesHash !== "string" || !SHA256.test(index.entriesHash)) {
    invalid("experiment-artifact-index", "1.0.0", "Artifact index shape is malformed.");
  }
  const entries = index.entries.map(parseIndexEntry);
  if (new Set(entries.map((entry) => entry.relativePath)).size !== entries.length) {
    invalid("experiment-artifact-index", "1.0.0", "Artifact index paths must be unique.");
  }
  return { schemaVersion: "1.0.0", experimentId: index.experimentId, entries, entriesHash: index.entriesHash };
}

export function parseVersionedArtifact(kind: "dashboard-run", value: unknown): DashboardRun;
export function parseVersionedArtifact(kind: "experiment-artifact-index", value: unknown): ExperimentArtifactIndex;
export function parseVersionedArtifact(kind: Exclude<VersionedArtifactKind, "dashboard-run" | "experiment-artifact-index">, value: unknown): Record<string, unknown>;
export function parseVersionedArtifact(kind: VersionedArtifactKind, value: unknown): VersionedArtifact {
  const version = versionOf(kind, value);
  const expected = SUPPORTED_ARTIFACT_VERSIONS[kind];
  if (version !== expected) {
    throw new ArtifactReaderError(
      ARTIFACT_VERSION_ERROR,
      `${kind} version ${JSON.stringify(version ?? "missing")} is unsupported; expected ${expected}.`,
      kind,
      version,
    );
  }
  if (kind === "dashboard-run") {
    const parsed = DashboardRunSchema.safeParse(value);
    if (!parsed.success) invalid(kind, version, "Dashboard artifact does not match the current schema.");
    return parsed.data;
  }
  if (kind === "experiment-artifact-index") return parseArtifactIndex(value);
  const artifact = record(value)!;
  const validShape = kind === "stage-3-intelligence"
    ? typeof artifact.id === "string" && Array.isArray(artifact.fileIndex)
    : kind === "stage-4-context-contract"
      ? typeof artifact.compilationId === "string" && record(artifact.task) !== undefined
      : kind === "stage-5-experiment"
        ? record(artifact.specification) !== undefined && record(artifact.manifest) !== undefined &&
          record(artifact.manifest)?.schemaVersion === version &&
          typeof record(artifact.specification)?.experimentId === "string" &&
          record(artifact.specification)?.experimentId === record(artifact.manifest)?.experimentId
        : kind === "stage-6-measurement"
          ? typeof artifact.experimentId === "string" && record(artifact.baseline) !== undefined && record(artifact.camarade) !== undefined
          : (kind === "stage-6-scoring" || kind === "stage-7-explanation")
            ? typeof artifact.experimentId === "string" && Array.isArray(artifact.entries)
            : false;
  if (!validShape) invalid(kind, version, `${kind} artifact does not match the current versioned shape.`);
  return artifact;
}

export function assertSupportedArtifactVersion(kind: VersionedArtifactKind, value: unknown): void {
  parseVersionedArtifact(kind as "stage-3-intelligence", value);
}

export async function readVersionedArtifact(
  path: string,
  kind: "dashboard-run",
  maximumBytes?: number,
): Promise<DashboardRun>;
export async function readVersionedArtifact(
  path: string,
  kind: "experiment-artifact-index",
  maximumBytes?: number,
): Promise<ExperimentArtifactIndex>;
export async function readVersionedArtifact(
  path: string,
  kind: Exclude<VersionedArtifactKind, "dashboard-run" | "experiment-artifact-index">,
  maximumBytes?: number,
): Promise<Record<string, unknown>>;
export async function readVersionedArtifact(
  path: string,
  kind: VersionedArtifactKind,
  maximumBytes = MAX_VERSIONED_ARTIFACT_BYTES,
): Promise<VersionedArtifact> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("maximumBytes must be a positive safe integer.");
  }
  const metadata = await lstat(path).catch((cause: unknown) => {
    throw new ArtifactReaderError(ARTIFACT_INVALID_ERROR, "Artifact is unavailable.", kind, undefined, { cause });
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new ArtifactReaderError(ARTIFACT_INVALID_ERROR, "Artifact must be a bounded regular non-symlink file.", kind);
  }
  let value: unknown;
  try {
    const bytes = await readFile(path);
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new ArtifactReaderError(ARTIFACT_INVALID_ERROR, "Artifact is not valid UTF-8 JSON.", kind, undefined, { cause });
  }
  return parseVersionedArtifact(kind as never, value) as VersionedArtifact;
}
