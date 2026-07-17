import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeGit } from "../experiment/git.js";
import type { EvaluationDefinition } from "./evaluation-definition-schema.js";
import type { DependencyAnalysisResult, DependencyChange } from "./types.js";

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

type Manifest = Partial<Record<typeof SECTIONS[number], Record<string, string>>>;

function parseManifest(raw: string, source: string): Manifest {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Package manifest is malformed: ${source}`);
  return value as Manifest;
}

function entries(manifest: Manifest): Map<string, { section: typeof SECTIONS[number]; version: string }> {
  const result = new Map<string, { section: typeof SECTIONS[number]; version: string }>();
  for (const section of SECTIONS) for (const [name, version] of Object.entries(manifest[section] ?? {})) {
    if (typeof version === "string") result.set(name, { section, version });
  }
  return result;
}

export async function analyzeNpmDependencies(sandboxPath: string, startingCommit: string, definition: EvaluationDefinition, changedFiles: readonly string[]): Promise<DependencyAnalysisResult> {
  if (definition.dependencyPolicy.packageManager !== "npm") {
    return { status: "unavailable", packageManager: definition.dependencyPolicy.packageManager, additions: [], removals: [], versionChanges: [], lockfileChanges: [], limitation: `UNSUPPORTED_PACKAGE_MANAGER_${definition.dependencyPolicy.packageManager.toUpperCase()}` };
  }
  let originalRaw: string;
  try {
    originalRaw = (await executeGit(sandboxPath, ["show", `${startingCommit}:package.json`])).stdout;
  } catch {
    originalRaw = "{}";
  }
  const currentRaw = await readFile(resolve(sandboxPath, "package.json"), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "{}" : Promise.reject(error));
  const before = entries(parseManifest(originalRaw, `${startingCommit}:package.json`));
  const after = entries(parseManifest(currentRaw, "package.json"));
  const additions: DependencyChange[] = [];
  const removals: DependencyChange[] = [];
  const versionChanges: DependencyChange[] = [];
  for (const [name, current] of after) {
    const previous = before.get(name);
    if (previous === undefined) {
      const allowed = definition.dependencyPolicy.allowedAddedPackages.includes(name);
      const forbidden = definition.dependencyPolicy.forbiddenPackages.includes(name);
      const classification = allowed ? "allowed" : forbidden || !definition.dependencyPolicy.allowUnlistedAdditions ? "unnecessary" : "unknown";
      additions.push({ package: name, section: current.section, after: current.version, classification });
    } else if (previous.version !== current.version || previous.section !== current.section) {
      versionChanges.push({ package: name, section: current.section, before: previous.version, after: current.version, classification: "version-change" });
    }
  }
  for (const [name, previous] of before) if (!after.has(name)) removals.push({ package: name, section: previous.section, before: previous.version, classification: "removed" });
  const byName = (left: DependencyChange, right: DependencyChange) => left.package.localeCompare(right.package);
  return {
    status: "measured",
    packageManager: "npm",
    additions: additions.sort(byName),
    removals: removals.sort(byName),
    versionChanges: versionChanges.sort(byName),
    lockfileChanges: changedFiles.filter((path) => ["package-lock.json", "npm-shrinkwrap.json"].includes(path)).sort()
  };
}
