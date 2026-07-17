import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { sha256 } from "../context/context-serialization.js";

export interface EvaluationEvidenceIndexEntry {
  evidenceId: string;
  artifact: string;
  sha256: string;
  byteLength: number;
}

async function walk(root: string, directory: string, output: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Evaluation evidence contains a symbolic link: ${path}`);
    if (entry.isDirectory()) await walk(root, path, output);
    else if (entry.isFile() && entry.name !== "evidence-index.json") output.push(path);
    else if (!entry.isFile()) throw new Error(`Unsupported evaluation evidence entry: ${path}`);
  }
}

export async function buildEvaluationEvidenceIndex(evaluationDirectory: string): Promise<{ schemaVersion: "1.0.0"; entries: EvaluationEvidenceIndexEntry[] }> {
  const paths: string[] = [];
  await walk(evaluationDirectory, evaluationDirectory, paths);
  const entries = [];
  for (const path of paths.sort((left, right) => left.localeCompare(right))) {
    const bytes = await readFile(path);
    const state = await lstat(path);
    const artifact = relative(evaluationDirectory, path).replaceAll("\\", "/");
    entries.push({ evidenceId: artifact.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, ""), artifact, sha256: sha256(bytes), byteLength: state.size });
  }
  return { schemaVersion: "1.0.0", entries };
}
