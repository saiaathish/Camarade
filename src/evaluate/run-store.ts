import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  ARTIFACT_VERSION_ERROR,
  ArtifactReaderError,
  readVersionedArtifact,
} from "../artifacts/versioning.js";
import { assertPublicEvidence } from "../artifacts/public-evidence-policy.js";
import { DashboardRunListSchema, DashboardRunSummarySchema, type DashboardRun, type DashboardRunSummary } from "../dashboard/contract.js";
import { EvaluateTaskError } from "./errors.js";

export const MAX_DASHBOARD_RUN_BYTES = 2_097_152;
const root = (base?: string): string => resolve(base ?? process.env.CAMARADE_HOME ?? resolve(homedir(), ".camarade"), ".camarade", "runs");
type CorruptRunReporter = (entry: string, code?: string) => void;
const outside = (distance: string): boolean => distance === ".." || distance.startsWith("../") || distance.startsWith("..\\") || isAbsolute(distance);

function readerError(error: unknown): EvaluateTaskError {
  if (error instanceof ArtifactReaderError && error.code === ARTIFACT_VERSION_ERROR) {
    return new EvaluateTaskError("UNSUPPORTED_ARTIFACT_VERSION", "Persisted run uses an unsupported artifact version.");
  }
  return new EvaluateTaskError("INVALID_RUN", "Persisted run is invalid.");
}

export class SafeDashboardRunRepository {
  readonly runsRoot: string;
  constructor(controllerRoot?: string) { this.runsRoot = root(controllerRoot); }

  async listRuns(onCorrupt?: CorruptRunReporter): Promise<DashboardRunSummary[]> {
    const names = await readdir(this.runsRoot).catch(() => [] as string[]);
    const out: DashboardRunSummary[] = [];
    for (const name of names) {
      try {
        const directory = resolve(this.runsRoot, name);
        const path = resolve(directory, "dashboard-run.json");
        const [directoryMetadata, fileMetadata] = await Promise.all([lstat(directory), lstat(path)]);
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || !fileMetadata.isFile() || fileMetadata.isSymbolicLink()) throw new Error("unsafe run entry");
        if (fileMetadata.size > MAX_DASHBOARD_RUN_BYTES) {
          onCorrupt?.(name, "DASHBOARD_ARTIFACT_TOO_LARGE");
          continue;
        }
        const run = await readVersionedArtifact(path, "dashboard-run", MAX_DASHBOARD_RUN_BYTES);
        assertPublicEvidence(run, "dashboard-run.json");
        out.push(DashboardRunSummarySchema.parse({ schemaVersion: run.schemaVersion, comparisonId: run.comparisonId, task: run.task, repository: run.repository, timestamps: run.timestamps, status: run.status, outcome: run.outcome, progress: run.progress }));
      } catch (error) {
        onCorrupt?.(name, error instanceof ArtifactReaderError && error.code === ARTIFACT_VERSION_ERROR ? "UNSUPPORTED_ARTIFACT_VERSION" : "INVALID_RUN");
      }
    }
    out.sort((left, right) => String(right.timestamps.startedAt).localeCompare(String(left.timestamps.startedAt)) || left.comparisonId.localeCompare(right.comparisonId));
    return DashboardRunListSchema.parse(out);
  }

  getRun(id: string): Promise<DashboardRun> { return showRunFromRoot(id, this.runsRoot); }
}

export const createSafeDashboardRunRepository = (controllerRoot?: string): SafeDashboardRunRepository => new SafeDashboardRunRepository(controllerRoot);
export const listRuns = (controllerRoot?: string, onCorrupt?: CorruptRunReporter): Promise<DashboardRunSummary[]> => new SafeDashboardRunRepository(controllerRoot).listRuns(onCorrupt);
export const showRun = (id: string, controllerRoot?: string): Promise<DashboardRun> => showRunFromRoot(id, root(controllerRoot));

async function showRunFromRoot(id: string, directory: string): Promise<DashboardRun> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(id)) throw new EvaluateTaskError("UNSAFE_COMPARISON_ID", "Unsafe comparison ID.");
  const runDirectory = resolve(directory, id);
  const path = resolve(runDirectory, "dashboard-run.json");
  const distance = relative(directory, path);
  if (outside(distance)) throw new EvaluateTaskError("UNSAFE_COMPARISON_ID", "Unsafe comparison ID.");
  const [directoryMetadata, fileMetadata] = await Promise.all([lstat(runDirectory).catch(() => undefined), lstat(path).catch(() => undefined)]);
  if (!directoryMetadata?.isDirectory() || directoryMetadata.isSymbolicLink() || !fileMetadata?.isFile() || fileMetadata.isSymbolicLink()) throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID", "Unknown comparison ID.");
  if (fileMetadata.size > MAX_DASHBOARD_RUN_BYTES) throw new EvaluateTaskError("DASHBOARD_ARTIFACT_TOO_LARGE", "Persisted run exceeds the dashboard artifact size limit.");
  const actual = await realpath(path).catch(() => { throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID", "Unknown comparison ID."); });
  const canonicalRoot = await realpath(directory).catch(() => directory);
  if (outside(relative(canonicalRoot, actual))) throw new EvaluateTaskError("UNKNOWN_COMPARISON_ID", "Run escapes canonical controller root.");
  try {
    const run = await readVersionedArtifact(actual, "dashboard-run", MAX_DASHBOARD_RUN_BYTES);
    assertPublicEvidence(run, "dashboard-run.json");
    return run;
  }
  catch (error) { throw readerError(error); }
}
