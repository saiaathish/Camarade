import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ContextPack, ContextSource, ContextSourceKind } from "../core/types.js";

export interface CompileContextInput {
  sources: readonly ContextSource[];
  task: string;
  repositoryPath: string;
  repositorySummary: string;
  validationCommands: readonly string[];
}

export interface CompiledContext {
  contextPack: ContextPack;
  markdown: string;
}

interface NormalizedSource extends ContextSource {
  sourceIndex: number;
}

interface Instruction {
  sourcePath: string;
  text: string;
  paths: string[];
}

interface ProtectedReference {
  sourcePath: string;
  instruction: string;
}

const INSTRUCTION_SOURCE_KINDS = new Set<ContextSourceKind>([
  "agents",
  "claude",
  "cursor",
  "copilot"
]);

const TASK_STOP_WORDS = new Set([
  "add", "and", "basic", "build", "change", "create", "for", "from", "implement",
  "into", "make", "the", "this", "with"
]);

const DIRECTIVE_PATTERN = /\b(?:always|avoid|cannot|do not|don't|ensure|keep|must|never|no|only|prefer|preserve|read|require|required|should|use|work)\b/i;
const PROTECTED_PATTERN = /(?:\bdo not\b|\bdon't\b|\bmust not\b|\bnever\b|\bcannot\b).{0,80}\b(?:edit|modify|change|touch|write|overwrite|delete|remove)\b|\b(?:read[ -]?only|protected)\b|\bno\b.{0,80}\b(?:edits?|changes?|modifications?)\b|\b(?:leave|keep|remain)\b.{0,80}\bunchanged\b/i;
const MARKDOWN_PREFIX_PATTERN = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/;
const PLAIN_PATH_PATTERN = /(?:^|[\s('"\[])(\.{0,2}\/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+|(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+|(?:AGENTS|CLAUDE|README)\.md|package(?:-lock)?\.json|tsconfig\.json)(?=$|[\s,.;:)'"\]])/g;

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function normalizedSources(sources: readonly ContextSource[]): NormalizedSource[] {
  return sources.map((source, sourceIndex) => ({
    relativePath: normalizeText(source.relativePath),
    absolutePath: normalizeText(source.absolutePath),
    kind: source.kind,
    content: normalizeText(source.content),
    sha256: normalizeText(source.sha256),
    sourceIndex
  }));
}

function words(value: string): string[] {
  const separated = normalizeText(value).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return separated.match(/[a-z0-9]+/g) ?? [];
}

function taskKeywords(task: string): string[] {
  return uniqueSorted(words(task).filter((word) => word.length >= 3 && !TASK_STOP_WORDS.has(word)));
}

function hasTaskKeyword(line: string, keywords: readonly string[]): boolean {
  const lineWords = new Set(words(line));
  return keywords.some((keyword) => lineWords.has(keyword));
}

function instructionLines(source: NormalizedSource, keywords: readonly string[]): string[] {
  const lines: string[] = [];
  let inFence = false;
  let frontMatter: "opening" | "inside" | "done" = source.content.trimStart().startsWith("---")
    ? "opening"
    : "done";

  for (const rawLine of source.content.split("\n")) {
    const line = rawLine.trim();
    if (frontMatter === "opening") {
      if (line === "") continue;
      if (line === "---") {
        frontMatter = "inside";
        continue;
      }
      frontMatter = "done";
    } else if (frontMatter === "inside") {
      if (line === "---") frontMatter = "done";
      continue;
    }
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (line === "" || inFence) continue;

    const undecorated = line.replace(MARKDOWN_PREFIX_PATTERN, "").trim();
    const heading = /^#{1,6}\s+/.test(line);
    const isInstructionSource = INSTRUCTION_SOURCE_KINDS.has(source.kind);
    const isRelevant = DIRECTIVE_PATTERN.test(undecorated) || hasTaskKeyword(undecorated, keywords);

    if ((!heading && isInstructionSource) || isRelevant) lines.push(line);
  }

  return lines;
}

function looksLikeFilePath(value: string): boolean {
  if (value === "" || /[\s\0]/.test(value) || /^(?:https?:|node:)/i.test(value)) return false;
  if (/[*?{}\[\]]/.test(value)) return false;
  const finalSegment = value.replace(/[\\/]+$/u, "").split(/[\\/]/).at(-1) ?? "";
  return value.includes("/") || value.startsWith(".") || /\.[A-Za-z0-9-]+$/.test(finalSegment);
}

function repositoryRelativePath(value: string, repositoryPath: string): string | null {
  const candidate = value.replace(/^['"]|['"]$/g, "").trim().replace(/[\\/]+$/u, "");
  if (!looksLikeFilePath(candidate)) return null;

  const repositoryRoot = resolve(repositoryPath);
  const absoluteCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(repositoryRoot, candidate);
  const relativeCandidate = relative(repositoryRoot, absoluteCandidate);
  if (relativeCandidate === "" || relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)) return null;
  return relativeCandidate.split(sep).join("/");
}

function literalPaths(line: string, repositoryPath: string): string[] {
  const candidates: string[] = [];
  const codeSpanPattern = /`([^`\n]+)`/g;
  for (const match of line.matchAll(codeSpanPattern)) candidates.push(match[1]);
  for (const match of line.matchAll(PLAIN_PATH_PATTERN)) candidates.push(match[1]);

  const paths: string[] = [];
  for (const candidate of candidates) {
    const path = repositoryRelativePath(candidate, repositoryPath);
    if (path !== null) paths.push(path);
  }
  return uniqueSorted(paths);
}

function addAttribution(attributions: Map<string, string[]>, path: string, sourcePath: string): void {
  const existing = attributions.get(path);
  if (existing === undefined) {
    attributions.set(path, [sourcePath]);
    return;
  }
  if (!existing.includes(sourcePath)) existing.push(sourcePath);
}

async function pathExistsWithoutEscapingRepository(repositoryRoot: string, relativePath: string): Promise<boolean> {
  let currentPath = repositoryRoot;
  for (const segment of relativePath.split("/")) {
    currentPath = resolve(currentPath, segment);
    let pathStat;
    try {
      pathStat = await lstat(currentPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
    if (!pathStat.isSymbolicLink()) continue;

    try {
      currentPath = await realpath(currentPath);
    } catch (cause) {
      let linkTarget: string;
      try {
        linkTarget = await readlink(currentPath, "utf8");
      } catch {
        throw cause;
      }
      const unresolvedTarget = resolve(dirname(currentPath), linkTarget);
      if (!isWithinRepository(repositoryRoot, unresolvedTarget)) {
        throw new Error(`Referenced repository path escapes the repository through a symbolic link: ${relativePath}`);
      }
      return false;
    }
    if (!isWithinRepository(repositoryRoot, currentPath)) {
      throw new Error(`Referenced repository path escapes the repository through a symbolic link: ${relativePath}`);
    }
  }
  return true;
}

function isWithinRepository(repositoryRoot: string, candidate: string): boolean {
  const pathFromRoot = relative(repositoryRoot, candidate);
  return pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

async function missingPaths(repositoryPath: string, paths: readonly string[]): Promise<string[]> {
  const repositoryRoot = resolve(repositoryPath);
  const checks = await Promise.all(paths.map(async (path) => {
    return await pathExistsWithoutEscapingRepository(repositoryRoot, path) ? null : path;
  }));
  return checks.filter((path): path is string => path !== null);
}

function code(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const delimiter = "`".repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
  return `${delimiter}${value}${delimiter}`;
}

function listOrNone(items: readonly string[]): string {
  return items.length === 0 ? "- None." : items.join("\n");
}

export async function compileContext(input: CompileContextInput): Promise<CompiledContext> {
  const task = normalizeText(input.task);
  const repositoryPath = await realpath(resolve(normalizeText(input.repositoryPath)));
  const repositorySummary = normalizeText(input.repositorySummary);
  const validationCommands = uniqueInOrder(input.validationCommands.map(normalizeText).filter((command) => command !== ""));
  const keywords = taskKeywords(task);
  const sources = normalizedSources(input.sources);
  const selectedSources: NormalizedSource[] = [];
  const instructions: Instruction[] = [];
  const seenInstructionLines = new Set<string>();
  const relevantPaths = new Set<string>();
  const protectedReferences = new Map<string, ProtectedReference>();
  const pathAttributions = new Map<string, string[]>();

  for (const source of sources) {
    const lines = instructionLines(source, keywords);
    if (lines.length > 0) selectedSources.push(source);

    for (const line of lines) {
      const paths = literalPaths(line, repositoryPath);
      const isProtected = PROTECTED_PATTERN.test(line.replace(MARKDOWN_PREFIX_PATTERN, ""));
      for (const path of paths) {
        addAttribution(pathAttributions, path, source.relativePath);
        if (isProtected) {
          if (!protectedReferences.has(path)) protectedReferences.set(path, { sourcePath: source.relativePath, instruction: line });
        } else {
          relevantPaths.add(path);
        }
      }

      if (seenInstructionLines.has(line)) continue;
      seenInstructionLines.add(line);
      instructions.push({ sourcePath: source.relativePath, text: line, paths });
    }
  }

  for (const path of literalPaths(task, repositoryPath)) {
    relevantPaths.add(path);
    addAttribution(pathAttributions, path, "task");
  }

  for (const path of protectedReferences.keys()) relevantPaths.delete(path);

  const generatedFileList = uniqueSorted([...relevantPaths, ...protectedReferences.keys()]);
  const missing = await missingPaths(repositoryPath, generatedFileList);
  const missingSet = new Set(missing);
  const relevantFiles = uniqueSorted([...relevantPaths].filter((path) => !missingSet.has(path)));
  const protectedFiles = uniqueSorted([...protectedReferences.keys()].filter((path) => !missingSet.has(path)));
  const existingNoDependencyInstruction = instructions.find((instruction) =>
    /\b(?:do not|don't|never)\b.{0,80}\b(?:add|install)\b.{0,80}\bdependenc/i.test(instruction.text) &&
    instruction.paths.some((path) => !missingSet.has(path))
  );
  const omittedInstructions = instructions.filter((instruction) => {
    const staleOnly = instruction.paths.length > 0 &&
      instruction.paths.every((path) => missingSet.has(path));
    const unsupportedInstall = existingNoDependencyInstruction !== undefined &&
      instruction !== existingNoDependencyInstruction &&
      !/\b(?:do not|don't|never)\b/i.test(instruction.text) &&
      /\b(?:add|install)\b/i.test(instruction.text);
    return staleOnly || unsupportedInstall;
  });
  const omittedSet = new Set(omittedInstructions);
  const activeInstructions = instructions.filter((instruction) => !omittedSet.has(instruction));
  const selectedSourcePaths = uniqueSorted(selectedSources.map((source) => source.relativePath));
  const attributedInstructions = activeInstructions.map(({ sourcePath, text }) => `[${sourcePath}] ${text}`);

  const contextPack: ContextPack = {
    task,
    repositorySummary,
    selectedSources: selectedSourcePaths,
    instructions: attributedInstructions,
    relevantFiles,
    protectedFiles,
    validationCommands
  };

  const instructionMarkdown = attributedInstructions.map((instruction) => `- ${instruction}`);
  const relevantMarkdown = relevantFiles.map((path) => `- ${code(path)}`);
  const protectedMarkdown = protectedFiles.map((path) => {
    const reference = protectedReferences.get(path);
    if (reference === undefined) throw new Error(`Missing protected-file attribution for ${path}`);
    return `- ${code(path)} — protected by explicit instruction ${code(reference.instruction)} in ${code(reference.sourcePath)}.`;
  });
  const validationMarkdown = validationCommands.map((command) => `- ${code(command)}`);
  const sourceMarkdown = [...selectedSources]
    .sort((left, right) => compareText(left.relativePath, right.relativePath) || compareText(left.sha256, right.sha256) || left.sourceIndex - right.sourceIndex)
    .map((source) => `- ${code(source.relativePath)} — SHA-256 ${code(source.sha256)}`);
  const missingMarkdown = missing.map((path) => {
    const sourcesForPath = pathAttributions.get(path) ?? [];
    return `- ${code(path)} — missing repository path referenced by ${sourcesForPath.map(code).join(", ")}.`;
  });
  const omittedMarkdown = omittedInstructions.map((instruction) => {
    const staleOnly = instruction.paths.length > 0 &&
      instruction.paths.every((path) => missingSet.has(path));
    const reason = staleOnly
      ? "all literal repository paths in this instruction are missing"
      : "it requests installation despite an existing repository utility referenced by an active no-dependency instruction";
    return `- ${code(instruction.sourcePath)} — omitted instruction ${code(instruction.text)} because ${reason}.`;
  });

  const markdown = [
    "# Camarade Task Context",
    `## Task\n\n${task}`,
    `## Repository\n\n- Summary: ${repositorySummary}`,
    `## Active Instructions\n\n${listOrNone(instructionMarkdown)}`,
    `## Relevant Files\n\n${listOrNone(relevantMarkdown)}`,
    `## Protected Files\n\n${listOrNone(protectedMarkdown)}`,
    `## Validation\n\n${listOrNone(validationMarkdown)}`,
    `## Source Evidence\n\n${listOrNone([...sourceMarkdown, ...missingMarkdown, ...omittedMarkdown])}`
  ].join("\n\n") + "\n";

  return { contextPack, markdown };
}
