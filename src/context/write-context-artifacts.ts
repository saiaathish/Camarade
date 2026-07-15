import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { ContextCompilationError } from "../core/errors.js";
import type {
  ContextCompilationArtifactPaths,
  ContextCompilationSummary
} from "./context-types.js";
import { canonicalJson } from "./context-serialization.js";

export const CONTEXT_ARTIFACT_FILES = {
  taskSpecification: "task-spec.json",
  candidates: "candidate-context.json",
  decisions: "selection-decisions.json",
  contractJson: "context-contract.json",
  contractMarkdown: "context-contract.md",
  excludedContext: "excluded-context.json",
  unresolvedDecisions: "unresolved-decisions.json",
  provenance: "provenance.json",
  summary: "compilation-summary.json"
} as const;

export type ContextArtifactKey = keyof typeof CONTEXT_ARTIFACT_FILES;

export interface ContextArtifactWriter {
  readonly compilationId: string;
  readonly stagingDirectory: string;
  readonly finalDirectory: string;
  readonly paths: ContextCompilationArtifactPaths;
  writeJson(key: Exclude<ContextArtifactKey, "contractMarkdown">, value: unknown): Promise<void>;
  writeText(key: ContextArtifactKey, content: string): Promise<void>;
  publish(): Promise<ContextCompilationArtifactPaths>;
  fail(summary: ContextCompilationSummary): Promise<string>;
}

function artifactPaths(directory: string): ContextCompilationArtifactPaths {
  return {
    directory,
    taskSpecification: path.join(directory, CONTEXT_ARTIFACT_FILES.taskSpecification),
    candidates: path.join(directory, CONTEXT_ARTIFACT_FILES.candidates),
    decisions: path.join(directory, CONTEXT_ARTIFACT_FILES.decisions),
    contractJson: path.join(directory, CONTEXT_ARTIFACT_FILES.contractJson),
    contractMarkdown: path.join(directory, CONTEXT_ARTIFACT_FILES.contractMarkdown),
    excludedContext: path.join(directory, CONTEXT_ARTIFACT_FILES.excludedContext),
    unresolvedDecisions: path.join(directory, CONTEXT_ARTIFACT_FILES.unresolvedDecisions),
    provenance: path.join(directory, CONTEXT_ARTIFACT_FILES.provenance),
    summary: path.join(directory, CONTEXT_ARTIFACT_FILES.summary)
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function requireRealDirectory(target: string, description: string): Promise<void> {
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(target) !== path.resolve(target)) {
    throw new ContextCompilationError(
      `${description} must be a real directory without symbolic-link traversal: ${target}.`,
      "CONTEXT_WRITE_FAILED",
      "write-context-artifacts",
      { target }
    );
  }
}

async function createOrValidateChildDirectory(parent: string, name: string): Promise<string> {
  const target = path.join(parent, name);
  try {
    await mkdir(target, { recursive: false, mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  await requireRealDirectory(target, "Context artifact directory");
  return target;
}

async function atomicWrite(target: string, content: string, replace = false): Promise<void> {
  if (!replace && await exists(target)) {
    throw new ContextCompilationError(
      `Context artifact already exists: ${target}.`,
      "CONTEXT_ARTIFACT_EXISTS",
      "write-context-artifacts",
      { target }
    );
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (replace) await unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(temporary, target);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (cause instanceof ContextCompilationError) throw cause;
    throw new ContextCompilationError(
      `Failed to write context artifact: ${target}.`,
      "CONTEXT_WRITE_FAILED",
      "write-context-artifacts",
      { target },
      path.dirname(target),
      cause
    );
  }
}

export interface CreateContextArtifactWriterInput {
  controllerRoot: string;
  compilationId: string;
}

export async function createContextArtifactWriter(
  input: CreateContextArtifactWriterInput
): Promise<ContextArtifactWriter> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.compilationId)) {
    throw new ContextCompilationError(
      "The compilation ID is not safe for use as an artifact directory name.",
      "CONTEXT_REQUEST_INVALID",
      "write-context-artifacts"
    );
  }
  try {
    await requireRealDirectory(input.controllerRoot, "Controller root");
  } catch (cause) {
    if (cause instanceof ContextCompilationError) throw cause;
    throw new ContextCompilationError(
      `Controller root cannot be resolved safely: ${input.controllerRoot}.`,
      "CONTEXT_WRITE_FAILED",
      "write-context-artifacts",
      { controllerRoot: input.controllerRoot },
      undefined,
      cause
    );
  }
  let compilationsRoot: string;
  try {
    const controlRoot = await createOrValidateChildDirectory(input.controllerRoot, ".camarade");
    compilationsRoot = await createOrValidateChildDirectory(controlRoot, "compilations");
  } catch (cause) {
    if (cause instanceof ContextCompilationError) throw cause;
    throw new ContextCompilationError(
      `Context artifact root cannot be created safely under: ${input.controllerRoot}.`,
      "CONTEXT_WRITE_FAILED",
      "write-context-artifacts",
      { controllerRoot: input.controllerRoot },
      undefined,
      cause
    );
  }
  const finalDirectory = path.join(compilationsRoot, input.compilationId);
  await access(compilationsRoot, constants.W_OK);
  if (await exists(finalDirectory)) {
    throw new ContextCompilationError(
      `Compilation artifact directory already exists: ${finalDirectory}.`,
      "CONTEXT_ARTIFACT_EXISTS",
      "write-context-artifacts",
      { finalDirectory },
      finalDirectory
    );
  }
  const stagingDirectory = path.join(compilationsRoot, `.${input.compilationId}.staging-${randomUUID()}`);
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
  } catch (cause) {
    throw new ContextCompilationError(
      `Failed to create context artifact staging directory: ${stagingDirectory}.`,
      "CONTEXT_WRITE_FAILED",
      "write-context-artifacts",
      { stagingDirectory },
      compilationsRoot,
      cause
    );
  }

  let published = false;
  const paths = artifactPaths(finalDirectory);
  const stagingPaths = artifactPaths(stagingDirectory);
  const pathFor = (key: ContextArtifactKey): string => stagingPaths[key];

  return {
    compilationId: input.compilationId,
    stagingDirectory,
    finalDirectory,
    paths,
    async writeJson(key, value) {
      if (published) throw new ContextCompilationError("The compilation has already been published.", "CONTEXT_WRITE_FAILED", "write-context-artifacts", undefined, finalDirectory);
      await atomicWrite(pathFor(key), canonicalJson(value));
    },
    async writeText(key, content) {
      if (published) throw new ContextCompilationError("The compilation has already been published.", "CONTEXT_WRITE_FAILED", "write-context-artifacts", undefined, finalDirectory);
      await atomicWrite(pathFor(key), content);
    },
    async publish() {
      if (published) return paths;
      if (await exists(finalDirectory)) {
        throw new ContextCompilationError(
          `Compilation artifact directory already exists: ${finalDirectory}.`,
          "CONTEXT_ARTIFACT_EXISTS",
          "write-context-artifacts",
          { finalDirectory },
          stagingDirectory
        );
      }
      try {
        await rename(stagingDirectory, finalDirectory);
        published = true;
        return paths;
      } catch (cause) {
        throw new ContextCompilationError(
          `Failed to publish context artifact directory: ${finalDirectory}.`,
          "CONTEXT_WRITE_FAILED",
          "write-context-artifacts",
          { finalDirectory },
          stagingDirectory,
          cause
        );
      }
    },
    async fail(summary) {
      if (published) return finalDirectory;
      for (const key of ["contractJson", "contractMarkdown", "provenance"] as const) {
        await rm(pathFor(key), { force: true }).catch(() => undefined);
      }
      try {
        await atomicWrite(pathFor("summary"), canonicalJson(summary), true);
      } catch {
        // The valid intermediate files still constitute useful failure evidence.
      }
      if (!await exists(finalDirectory)) {
        try {
          await rename(stagingDirectory, finalDirectory);
          published = true;
          return finalDirectory;
        } catch {
          // Preserve the staging directory when publication itself is what failed.
        }
      }
      return stagingDirectory;
    }
  };
}
