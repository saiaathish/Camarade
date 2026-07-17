import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  canonicalJson,
  sha256,
  toPosixPath,
} from "../context/context-serialization.js";
import type {
  ExperimentArtifactIndex,
  ExperimentArtifactIndexEntry,
} from "./experiment-types.js";
async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    if (entry.isSymbolicLink())
      throw new Error(`Artifact symlink rejected: ${path}`);
    if (entry.isDirectory()) await walk(path, out);
    else if (entry.isFile()) out.push(path);
    else throw new Error(`Unsupported artifact entry: ${path}`);
  }
}
function kind(path: string): ExperimentArtifactIndexEntry["kind"] {
  if (path === "measurement/experiment-measurement.json") return "experiment-measurement";
  if (path === "measurement/baseline.json" || path === "measurement/camarade.json") return "condition-measurement";
  if (path.startsWith("measurement/")) return "measurement-evidence";
  if (path === "scoring/baseline-score.json" || path === "scoring/camarade-score.json") return "condition-score";
  if (path === "scoring/comparison.json") return "experiment-comparison";
  if (path === "scoring/REPORT.md") return "comparison-report";
  if (path === "scoring/evidence-index.json") return "scoring-evidence-index";
  if (path === "evaluation/evaluation-seal.json") return "evaluation-seal";
  if (path === "evaluation/evaluation-definition.json")
    return "evaluation-definition";
  if (path.startsWith("evaluation/hidden-assets/"))
    return "evaluation-hidden-asset";
  if (
    path === "evaluation-results/evaluation-execution.json" ||
    path.endsWith("/condition-evaluation.json")
  )
    return "evaluation-execution";
  if (path.includes("/checks/")) return "evaluation-check-result";
  if (path.includes("/commands/") && path.endsWith(".log"))
    return "evaluation-command-output";
  if (path.includes("/reports/")) return "evaluation-structured-report";
  return "other";
}
export async function buildArtifactIndex(
  experimentDirectory: string,
  experimentId: string,
): Promise<ExperimentArtifactIndex> {
  const root = resolve(experimentDirectory),
    paths: string[] = [];
  await walk(root, paths);
  const excluded = new Set([
    "artifact-index.json",
    "experiment-manifest.json",
    "experiment-summary.json",
    "experiment-result.json",
  ]);
  const entries: ExperimentArtifactIndexEntry[] = [];
  for (const path of paths) {
    const relativePath = toPosixPath(relative(root, path));
    if (excluded.has(relativePath)) continue;
    const bytes = await readFile(path);
    const stat = await lstat(path);
    entries.push({
      relativePath,
      kind: kind(relativePath),
      sha256: sha256(bytes),
      byteLength: stat.size,
    });
  }
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const index = {
    schemaVersion: "1.0.0",
    experimentId,
    entries,
    entriesHash: sha256(canonicalJson(entries)),
  };
  try {
    await writeFile(
      resolve(root, "artifact-index.json"),
      canonicalJson(index),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return index;
}
