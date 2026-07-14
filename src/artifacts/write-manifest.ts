import { randomUUID } from "node:crypto";
import { link, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isUnavailableEvidence, type RunManifest } from "../core/types.js";

export class ArtifactWriteError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ArtifactWriteError";
  }
}

export interface WriteManifestOptions {
  manifestPath: string;
  manifest: RunManifest;
}

const REQUIRED_MANIFEST_FIELDS = [
  "comparisonId", "runId", "repository", "startingCommit", "worktree", "task",
  "adapter", "adapterVersion", "model", "condition", "permissions", "limits",
  "environment", "contextSourceHashes", "validationCommands", "timestamps",
  "exitCodes", "changedFiles", "artifacts"
] as const satisfies readonly (keyof RunManifest)[];

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineCleanupFailures(
  artifactName: string,
  primaryFailed: boolean,
  primaryError: unknown,
  cleanupErrors: readonly unknown[]
): ArtifactWriteError | undefined {
  if (cleanupErrors.length === 0) return undefined;
  const cleanupMessage = cleanupErrors.map(describeError).join("; ");
  if (primaryFailed) {
    return new ArtifactWriteError(
      `${describeError(primaryError)}; cleanup failed: ${cleanupMessage}`,
      primaryError
    );
  }
  return new ArtifactWriteError(
    `${artifactName} cleanup failed: ${cleanupMessage}`,
    cleanupErrors[0]
  );
}

function assertRequiredObjectFields(
  value: unknown,
  field: string,
  required: readonly string[]
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactWriteError(`Run manifest field ${field} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of required) {
    if (!hasOwn(record, key) || record[key] === undefined) {
      throw new ArtifactWriteError(`Run manifest is missing required field: ${field}.${key}`);
    }
  }
}

export function assertCompleteRunManifest(manifest: RunManifest): void {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new ArtifactWriteError("Run manifest must be an object.");
  }
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!hasOwn(manifest, field) || manifest[field] === undefined) {
      throw new ArtifactWriteError(`Run manifest is missing required field: ${field}`);
    }
  }
  assertRequiredObjectFields(manifest.permissions, "permissions", ["filesystem", "network", "shell"]);
  assertRequiredObjectFields(manifest.limits, "limits", ["timeoutSeconds", "tokenBudget"]);
  assertRequiredObjectFields(manifest.environment, "environment", ["platform", "runtimeVersions", "environmentHash"]);
  assertRequiredObjectFields(manifest.timestamps, "timestamps", ["startedAt", "completedAt"]);
  assertRequiredObjectFields(manifest.exitCodes, "exitCodes", ["agent"]);
  assertRequiredObjectFields(manifest.artifacts, "artifacts", ["logs", "diff", "metrics", "manifest"]);

  const evidenceFields: Array<[string, unknown, boolean]> = [
    ["adapterVersion", manifest.adapterVersion, false],
    ["model", manifest.model, false],
    ["permissions.filesystem", manifest.permissions.filesystem, false],
    ["permissions.network", manifest.permissions.network, false],
    ["permissions.shell", manifest.permissions.shell, false],
    ["limits.tokenBudget", manifest.limits.tokenBudget, true],
    ["environment.platform", manifest.environment.platform, false],
    ["environment.environmentHash", manifest.environment.environmentHash, false]
  ];
  for (const [field, value, allowNumber] of evidenceFields) {
    const knownString = typeof value === "string" && value.trim() !== "";
    const knownNumber = allowNumber && typeof value === "number" && Number.isFinite(value);
    if (!knownString && !knownNumber && !isUnavailableEvidence(value)) {
      throw new ArtifactWriteError(
        `Run manifest field ${field} must contain known evidence or a non-empty unavailableReason.`
      );
    }
  }
  for (const [runtime, value] of Object.entries(manifest.environment.runtimeVersions)) {
    if (!((typeof value === "string" && value.trim() !== "") || isUnavailableEvidence(value))) {
      throw new ArtifactWriteError(
        `Run manifest field environment.runtimeVersions.${runtime} must contain known evidence or a non-empty unavailableReason.`
      );
    }
  }
  for (const [source, value] of Object.entries(manifest.contextSourceHashes)) {
    if (!((typeof value === "string" && value.trim() !== "") || isUnavailableEvidence(value))) {
      throw new ArtifactWriteError(
        `Run manifest field contextSourceHashes.${source} must contain known evidence or a non-empty unavailableReason.`
      );
    }
  }
}

export async function writeJsonExclusive(path: string, value: unknown, artifactName: string): Promise<string> {
  const absolutePath = resolve(path);
  let serialized: string;
  try {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) throw new TypeError("Value is not JSON serializable.");
    serialized = `${json}\n`;
  } catch (cause) {
    throw new ArtifactWriteError(`${artifactName} cannot be serialized as JSON: ${absolutePath}`, cause);
  }

  const temporaryPath = resolve(
    dirname(absolutePath),
    `.${basename(absolutePath)}.${randomUUID()}.tmp`
  );
  let file: FileHandle | undefined;
  let temporaryCreated = false;
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    try {
      file = await open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
    } catch (cause) {
      throw new ArtifactWriteError(`Cannot create temporary ${artifactName}: ${temporaryPath}`, cause);
    }

    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } catch (cause) {
      throw new ArtifactWriteError(`Failed while writing ${artifactName}: ${absolutePath}`, cause);
    }

    try {
      await file.close();
      file = undefined;
    } catch (cause) {
      throw new ArtifactWriteError(`Failed while closing ${artifactName}: ${absolutePath}`, cause);
    }

    try {
      await link(temporaryPath, absolutePath);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      const message = code === "EEXIST"
        ? `${artifactName} already exists; refusing to overwrite preserved evidence: ${absolutePath}`
        : `Cannot publish ${artifactName}: ${absolutePath}`;
      throw new ArtifactWriteError(message, cause);
    }
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (file !== undefined) {
    try {
      await file.close();
    } catch (cause) {
      cleanupErrors.push(new ArtifactWriteError(
        `Failed while closing temporary ${artifactName}: ${temporaryPath}: ${describeError(cause)}`,
        cause
      ));
    }
    file = undefined;
  }
  if (temporaryCreated) {
    try {
      await unlink(temporaryPath);
    } catch (cause) {
      cleanupErrors.push(new ArtifactWriteError(
        `Failed while removing temporary ${artifactName}: ${temporaryPath}: ${describeError(cause)}`,
        cause
      ));
    }
  }

  const combinedError = combineCleanupFailures(artifactName, primaryFailed, primaryError, cleanupErrors);
  if (combinedError !== undefined) throw combinedError;
  if (primaryFailed) throw primaryError;
  return absolutePath;
}

export function writeManifest(manifestPath: string, manifest: RunManifest): Promise<string>;
export function writeManifest(options: WriteManifestOptions): Promise<string>;
export function writeManifest(
  pathOrOptions: string | WriteManifestOptions,
  manifest?: RunManifest
): Promise<string> {
  if (typeof pathOrOptions === "string") {
    if (manifest === undefined) {
      throw new ArtifactWriteError("A run manifest is required.");
    }
    assertCompleteRunManifest(manifest);
    return writeJsonExclusive(pathOrOptions, manifest, "Run manifest");
  }
  assertCompleteRunManifest(pathOrOptions.manifest);
  return writeJsonExclusive(pathOrOptions.manifestPath, pathOrOptions.manifest, "Run manifest");
}
