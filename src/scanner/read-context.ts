import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ContextSource } from "../core/types.js";
import {
  ContextDiscoveryError,
  resolveRepositoryRoot,
  type ContextDiscoveryResult,
  type ContextSkipEvidence,
  type DiscoveredContextFile
} from "./discover-context.js";

export const DEFAULT_MAX_CONTEXT_FILE_BYTES = 1024 * 1024;

export interface ReadContextOptions {
  maxFileBytes?: number;
}

export interface ContextReadResult {
  sources: ContextSource[];
  skipped: ContextSkipEvidence[];
}

function comparePaths(
  left: { relativePath: string; reason?: string },
  right: { relativePath: string; reason?: string }
): number {
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  const leftReason = left.reason ?? "";
  const rightReason = right.reason ?? "";
  return leftReason < rightReason ? -1 : leftReason > rightReason ? 1 : 0;
}

function isWithinRepository(repositoryRoot: string, candidate: string): boolean {
  const pathFromRoot = relative(repositoryRoot, candidate);
  return pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

function hasControllerSegment(repositoryRoot: string, targetPath: string): boolean {
  return relative(repositoryRoot, targetPath).split(sep).includes(".camarade");
}

function skip(
  file: DiscoveredContextFile,
  reason: ContextSkipEvidence["reason"],
  detail: string
): ContextSkipEvidence {
  return { relativePath: file.relativePath, absolutePath: file.absolutePath, reason, detail };
}

function validateMaxFileBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ContextDiscoveryError("maxFileBytes must be a positive safe integer.");
  }
  return value;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function normalizeFiles(
  discoveryOrFiles: ContextDiscoveryResult | readonly DiscoveredContextFile[]
): readonly DiscoveredContextFile[] {
  return "files" in discoveryOrFiles ? discoveryOrFiles.files : discoveryOrFiles;
}

export async function readContext(
  repositoryPath: string,
  discoveryOrFiles: ContextDiscoveryResult | readonly DiscoveredContextFile[],
  options: ReadContextOptions = {}
): Promise<ContextReadResult> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes ?? DEFAULT_MAX_CONTEXT_FILE_BYTES);
  const files = [...normalizeFiles(discoveryOrFiles)].sort(comparePaths);
  const sources: ContextSource[] = [];
  const skipped: ContextSkipEvidence[] = [];

  for (const file of files) {
    const expectedAbsolutePath = resolve(repositoryRoot, file.relativePath);
    if (file.relativePath === "" || isAbsolute(file.relativePath) || expectedAbsolutePath !== file.absolutePath ||
        !isWithinRepository(repositoryRoot, expectedAbsolutePath)) {
      skipped.push(skip(file, "outside-repository", "Discovered path does not resolve to its declared repository location."));
      continue;
    }

    let targetPath: string;
    try {
      targetPath = await realpath(expectedAbsolutePath);
    } catch {
      skipped.push(skip(file, "unreadable", "Discovered context file no longer exists or cannot be resolved."));
      continue;
    }
    if (!isWithinRepository(repositoryRoot, targetPath)) {
      skipped.push(skip(file, "outside-repository", "Resolved context file is outside the repository."));
      continue;
    }
    if (hasControllerSegment(repositoryRoot, targetPath)) {
      skipped.push(skip(file, "excluded", "Resolved context file is a controller artifact."));
      continue;
    }

    let fileStat;
    try {
      fileStat = await stat(targetPath);
    } catch {
      skipped.push(skip(file, "unreadable", "Context file metadata could not be read."));
      continue;
    }
    if (!fileStat.isFile()) {
      skipped.push(skip(file, "not-regular-file", "Context path is not a regular file."));
      continue;
    }
    if (fileStat.size > maxFileBytes) {
      skipped.push(skip(file, "oversized", `File size ${fileStat.size} exceeds the ${maxFileBytes}-byte limit.`));
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(targetPath);
    } catch {
      skipped.push(skip(file, "unreadable", "Context file could not be read."));
      continue;
    }
    if (buffer.length > maxFileBytes) {
      skipped.push(skip(file, "oversized", `File size ${buffer.length} exceeds the ${maxFileBytes}-byte limit.`));
      continue;
    }
    if (isBinary(buffer)) {
      skipped.push(skip(file, "binary", "File contains a null byte and was classified as binary."));
      continue;
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      skipped.push(skip(file, "invalid-utf8", "File is not valid UTF-8."));
      continue;
    }

    sources.push({
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      kind: file.kind,
      content,
      sha256: createHash("sha256").update(buffer).digest("hex")
    });
  }

  sources.sort(comparePaths);
  skipped.sort(comparePaths);
  return { sources, skipped };
}

export async function readDiscoveredContext(
  discovery: ContextDiscoveryResult,
  options: ReadContextOptions = {}
): Promise<ContextReadResult> {
  const read = await readContext(discovery.repositoryRoot, discovery.files, options);
  return {
    sources: read.sources,
    skipped: [...discovery.skipped, ...read.skipped].sort(comparePaths)
  };
}
