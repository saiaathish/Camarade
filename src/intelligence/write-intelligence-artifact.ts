import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { serializeIntelligenceArtifact, type IntelligenceArtifact } from "./build-intelligence-artifact.js";

export const DEFAULT_INTELLIGENCE_ARTIFACT_PATH = ".camarade/intelligence.json";
export interface WriteIntelligenceArtifactOptions { repositoryPath: string; artifact: IntelligenceArtifact; outputPath?: string; destination?: string; }
export interface WriteIntelligenceArtifactResult { relativePath: string; absolutePath: string; bytesWritten: number; }

const unsafeOutput = (value: string): boolean => !value || path.isAbsolute(value) || /^\\\\/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes("..");
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

async function ensureSafeParents(root: string, target: string): Promise<void> {
  const relativeParent = path.relative(root, path.dirname(target));
  let current = root;
  for (const component of relativeParent ? relativeParent.split(path.sep) : []) {
    current = path.join(current, component);
    try { const info = await lstat(current); if (info.isSymbolicLink()) throw new Error("Artifact output path escapes through a symbolic link."); if (!info.isDirectory()) throw new Error("Artifact output parent is not a directory."); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; await mkdir(current); }
  }
}

export async function writeIntelligenceArtifact(options: WriteIntelligenceArtifactOptions): Promise<WriteIntelligenceArtifactResult> {
  if (!options.repositoryPath.trim()) throw new Error("repositoryPath must be non-empty.");
  const outputPath = options.outputPath ?? options.destination ?? DEFAULT_INTELLIGENCE_ARTIFACT_PATH;
  if (unsafeOutput(outputPath)) throw new Error("Artifact output path must be repository-relative and safe.");
  const root = await realpath(options.repositoryPath);
  const target = path.resolve(root, outputPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Artifact output path escapes repository.");
  await ensureSafeParents(root, target);
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error("Artifact output path must not be a symbolic link."); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  const bytes = Buffer.from(serializeIntelligenceArtifact(options.artifact), "utf8");
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.write(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, target);
  } catch (error) { await rm(temp, { force: true }); throw error; }
  return { relativePath: path.relative(root, target).split(path.sep).join("/"), absolutePath: target, bytesWritten: bytes.byteLength };
}
