import { collectDiff } from "../evaluator/collect-diff.js";
import { executeGit } from "../experiment/git.js";
import type { EvaluationDefinition } from "./evaluation-definition-schema.js";
import { firstMatchingPattern, matchesPathPattern, normalizeEvaluationPath } from "./path-matcher.js";
import type { ChangeAnalysisResult, ChangedFileMeasurement } from "./types.js";

const INTRINSIC_IGNORES = [
  ".camarade/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "coverage/**",
  "*.log",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor/rules/**",
  ".github/copilot-instructions.md"
];

function parseNameStatus(output: string): Map<string, ChangedFileMeasurement["status"]> {
  const fields = output.split("\0").filter((field) => field !== "");
  const statuses = new Map<string, ChangedFileMeasurement["status"]>();
  for (let index = 0; index < fields.length;) {
    const code = fields[index++]!;
    const source = fields[index++]!;
    if (code.startsWith("R")) {
      const destination = fields[index++]!;
      statuses.set(normalizeEvaluationPath(destination), "renamed");
      continue;
    }
    const status = code.startsWith("A") ? "added" : code.startsWith("M") ? "modified" : code.startsWith("D") ? "deleted" : "unknown";
    statuses.set(normalizeEvaluationPath(source), status);
  }
  return statuses;
}

function classify(path: string, policy: EvaluationDefinition["changePolicy"]): Pick<ChangedFileMeasurement, "classification" | "matchedPattern"> {
  const ignored = firstMatchingPattern(path, [...INTRINSIC_IGNORES, ...policy.ignoredPaths]);
  if (ignored !== undefined) return { classification: "ignored-control-artifact", matchedPattern: ignored };
  const protectedPattern = firstMatchingPattern(path, policy.protectedPaths);
  if (protectedPattern !== undefined) return { classification: "protected-path-violation", matchedPattern: protectedPattern };
  const expected = firstMatchingPattern(path, policy.allowedPaths);
  if (expected !== undefined) return { classification: "expected", matchedPattern: expected };
  return { classification: "unnecessary" };
}

export async function analyzeGitChanges(sandboxPath: string, definition: EvaluationDefinition): Promise<ChangeAnalysisResult> {
  const [tracked, untracked, numstat, diff] = await Promise.all([
    executeGit(sandboxPath, ["diff", "HEAD", "--name-status", "-z", "--find-renames"]),
    executeGit(sandboxPath, ["ls-files", "--others", "--exclude-standard", "-z"]),
    executeGit(sandboxPath, ["diff", "HEAD", "--numstat"]),
    collectDiff(sandboxPath, { excludedImplementationPaths: definition.changePolicy.ignoredPaths.map((pattern) => pattern.replace(/\/\*\*.*$/u, "").replace(/\/\*.*$/u, "")) })
  ]);
  const status = parseNameStatus(tracked.stdout);
  for (const path of untracked.stdout.split("\0").filter((entry) => entry !== "")) status.set(normalizeEvaluationPath(path), "untracked");
  const files = [...status.entries()].map(([path, fileStatus]) => ({ path, status: fileStatus, ...classify(path, definition.changePolicy) })).sort((left, right) => left.path.localeCompare(right.path));
  const binaryFiles = numstat.stdout.split(/\r?\n/gu).filter((line) => line.startsWith("-\t-\t")).map((line) => normalizeEvaluationPath(line.split("\t").slice(2).join("\t"))).sort();
  const pathsFor = (classification: ChangedFileMeasurement["classification"]) => files.filter((file) => file.classification === classification).map((file) => file.path);
  const expectedFiles = pathsFor("expected");
  const unnecessaryFiles = pathsFor("unnecessary");
  const protectedFiles = pathsFor("protected-path-violation");
  const ignoredFiles = pathsFor("ignored-control-artifact");
  const scoredCount = expectedFiles.length + unnecessaryFiles.length + protectedFiles.length;
  const missingRequiredChangedPaths = definition.changePolicy.requiredChangedPaths.filter((pattern) => !files.some((file) => file.classification !== "ignored-control-artifact" && matchesPathPattern(file.path, pattern)));
  const score = protectedFiles.length > 0 || scoredCount === 0 || missingRequiredChangedPaths.length > 0 ? 0 : 10 * expectedFiles.length / scoredCount;
  return {
    files,
    addedLines: diff.addedLines,
    removedLines: diff.deletedLines,
    binaryFiles,
    expectedFiles,
    unnecessaryFiles,
    protectedFiles,
    ignoredFiles,
    missingRequiredChangedPaths,
    score
  };
}
