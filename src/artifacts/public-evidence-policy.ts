import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const PUBLIC_EVIDENCE_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const PUBLIC_EVIDENCE_MAX_NODES = 500_000;

export const CONTROLLER_PRIVATE_PATHS = [
  "artifact-index.json",
  "experiment-manifest.json",
  "experiment-result.json",
  "conditions/",
  "evaluation/",
  "evaluation-results/",
  "logs/",
  "original-context/",
  "prompts/",
  "worktrees/",
] as const;

const PUBLIC_ROOT_FILES = new Set(["dashboard-run.json", "experiment-summary.json"]);
const PUBLIC_DIRECTORIES = new Set(["measurement", "scoring", "explanation"]);
const SENSITIVE_KEY = /(?:^|[_-])(?:tokens?|credentials?|environment|env|secret|password|api[_-]?key|authorization|cookie|prompt|raw[_-]?prompt|system[_-]?prompt|hidden[_-]?tests?)(?:$|[_-])/iu;
const SAFE_EVIDENCE_KEY = /^(?:actual[_-]?token[_-]?usage[_-]?available|input[_-]?tokens?|output[_-]?tokens?|cached[_-]?input[_-]?tokens?|reasoning[_-]?tokens?|total[_-]?tokens?|token[_-]?efficiency|token[_-]?runtime[_-]?observations)$/iu;
const SENSITIVE_TEXT = /(?:^|[\r\n])\s*(?:#{1,6}\s*(?:prompts?|raw[ _-]?prompts?|system[ _-]?prompts?|hidden[ _-]?tests?|credentials?|environment|env|secrets?|password|api[ _-]?key|authorization|cookie)\s*(?=$|[\r\n])|(?:[-*+]\s*)?["'`]?(?:prompts?|raw[ _-]?prompts?|system[ _-]?prompts?|hidden[ _-]?tests?|credentials?|environment|env|secrets?|password|api[ _-]?key|authorization|cookie)["'`]?\s*[:=])/iu;
const ABSOLUTE_PATH = /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\|~(?:[\\/]|$)|file:\/\/)|(?:^|[\s"'`(=:[,{])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|~(?:[\\/]|$)|file:\/\/)/u;
const SECRET_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\b(?:sk|gh[pousr])_[A-Za-z0-9]{16,})/iu;

export type PublicEvidenceFinding = {
  code: "SENSITIVE_FIELD" | "SECRET_VALUE" | "ABSOLUTE_PATH" | "UNSAFE_FILE" | "INVALID_JSON";
  artifactPath: string;
  valuePath: string;
};

export class PublicEvidenceError extends Error {
  readonly code = "PUBLIC_EVIDENCE_POLICY_VIOLATION" as const;
  constructor(readonly findings: readonly PublicEvidenceFinding[]) {
    super(`Public evidence policy rejected ${findings.length} finding(s).`);
    this.name = "PublicEvidenceError";
  }
}

export function assertPublicEvidence(value: unknown, artifactPath = "artifact.json"): void {
  const findings = inspectPublicEvidence(value, artifactPath);
  if (findings.length > 0) throw new PublicEvidenceError(findings);
}

export function sanitizePublicErrorMessage(value: unknown, fallback = "Operation failed."): string {
  const raw = typeof value === "string" ? value : fallback;
  const sanitized = raw
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu, "<redacted-secret>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/giu, "Bearer <redacted>")
    .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9]{16,}/giu, "<redacted-secret>")
    .replace(/file:\/\/[^\s,;)}\]"'`]+/giu, "<redacted-path>")
    .replace(/(^|[\s"'`(=:[,{])(\/(?!\/)[^\s,;)}\]"'`]*|[A-Za-z]:[\\/][^\s,;)}\]"'`]*|\\\\[^\\/\s]+[\\/][^\s,;)}\]"'`]*|~(?:[\\/][^\s,;)}\]"'`]*)?)/gmu, (_match, prefix: string) => `${prefix}<redacted-path>`)
    .trim();
  return sanitized === "" ? fallback : sanitized.slice(0, 2_000);
}

export function isControllerPrivatePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  return CONTROLLER_PRIVATE_PATHS.some((candidate) => candidate.endsWith("/")
    ? normalized.startsWith(candidate)
    : normalized === candidate);
}

function isSafeReference(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized !== "" && !normalized.includes("\0") && !isAbsolute(value) &&
    !/^[A-Za-z]:[\\/]/u.test(value) && !normalized.startsWith("file://") &&
    !normalized.startsWith("~/") && !normalized.split("/").includes("..");
}

export function publicReference(root: string, candidate: unknown, fallback: string): string {
  const safeFallback = fallback.replaceAll("\\", "/");
  if (!isSafeReference(safeFallback)) throw new TypeError("Public evidence fallback must be a safe relative reference.");
  if (typeof candidate !== "string" || candidate.includes("\0") || /^[A-Za-z]:[\\/]/u.test(candidate)) return safeFallback;
  const normalized = candidate.replaceAll("\\", "/");
  if (!isAbsolute(candidate)) return isSafeReference(normalized) ? normalized : safeFallback;
  const projected = relative(resolve(root), resolve(candidate)).replaceAll("\\", "/");
  return isSafeReference(projected) ? projected : safeFallback;
}

export function inspectPublicEvidence(value: unknown, artifactPath = "artifact.json"): PublicEvidenceFinding[] {
  const findings: PublicEvidenceFinding[] = [];
  const pending: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: "$", depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > PUBLIC_EVIDENCE_MAX_NODES || current.depth > 256) {
      findings.push({ code: "UNSAFE_FILE", artifactPath, valuePath: current.path });
      break;
    }
    if (typeof current.value === "string") {
      if (ABSOLUTE_PATH.test(current.value)) findings.push({ code: "ABSOLUTE_PATH", artifactPath, valuePath: current.path });
      if (SECRET_VALUE.test(current.value)) findings.push({ code: "SECRET_VALUE", artifactPath, valuePath: current.path });
      if (SENSITIVE_TEXT.test(current.value)) findings.push({ code: "SENSITIVE_FIELD", artifactPath, valuePath: current.path });
    } else if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => pending.push({ value: item, path: `${current.path}[${index}]`, depth: current.depth + 1 }));
    } else if (current.value !== null && typeof current.value === "object") {
      for (const [key, child] of Object.entries(current.value)) {
        const childPath = `${current.path}.${key}`;
        const normalizedKey = key.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
        if (SENSITIVE_KEY.test(normalizedKey) && !SAFE_EVIDENCE_KEY.test(normalizedKey)) findings.push({ code: "SENSITIVE_FIELD", artifactPath, valuePath: childPath });
        pending.push({ value: child, path: childPath, depth: current.depth + 1 });
      }
    }
  }
  return findings;
}

function safeInside(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance !== ".." && !distance.startsWith(`..${sep}`) && !resolve(distance).startsWith(`${sep}..`);
}

export async function discoverPublicArtifactPaths(root: string): Promise<string[]> {
  const canonicalRoot = await realpath(root);
  const paths: string[] = [];
  for (const name of PUBLIC_ROOT_FILES) {
    const metadata = await lstat(resolve(canonicalRoot, name)).catch(() => undefined);
    if (metadata?.isFile() && !metadata.isSymbolicLink()) paths.push(name);
  }
  for (const directory of PUBLIC_DIRECTORIES) {
    const directoryPath = resolve(canonicalRoot, directory);
    const metadata = await lstat(directoryPath).catch(() => undefined);
    if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink?.()) continue;
      if (!/\.(?:json|md)$/iu.test(entry.name)) continue;
      paths.push(`${directory}/${entry.name}`);
    }
  }
  return paths.sort();
}

export async function verifyPublicArtifactTree(root: string): Promise<{ files: string[]; findings: PublicEvidenceFinding[] }> {
  const canonicalRoot = await realpath(root);
  const files = await discoverPublicArtifactPaths(canonicalRoot);
  const findings: PublicEvidenceFinding[] = [];
  for (const relativePath of files) {
    if (isControllerPrivatePath(relativePath)) continue;
    const path = resolve(canonicalRoot, relativePath);
    if (!safeInside(canonicalRoot, path)) {
      findings.push({ code: "UNSAFE_FILE", artifactPath: relativePath, valuePath: "$" });
      continue;
    }
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > PUBLIC_EVIDENCE_MAX_FILE_BYTES) {
      findings.push({ code: "UNSAFE_FILE", artifactPath: relativePath, valuePath: "$" });
      continue;
    }
    const bytes = await readFile(path);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      findings.push({ code: "INVALID_JSON", artifactPath: relativePath, valuePath: "$" });
      continue;
    }
    if (relativePath.endsWith(".json")) {
      try {
        findings.push(...inspectPublicEvidence(JSON.parse(text), relativePath));
      } catch {
        findings.push({ code: "INVALID_JSON", artifactPath: relativePath, valuePath: "$" });
      }
    } else {
      if (SECRET_VALUE.test(text)) findings.push({ code: "SECRET_VALUE", artifactPath: relativePath, valuePath: "$" });
      if (SENSITIVE_TEXT.test(text)) findings.push({ code: "SENSITIVE_FIELD", artifactPath: relativePath, valuePath: "$" });
      const absolute = text.split(/\r?\n/u).find((line) => ABSOLUTE_PATH.test(line.trim()));
      if (absolute !== undefined) findings.push({ code: "ABSOLUTE_PATH", artifactPath: relativePath, valuePath: "$" });
    }
  }
  if (findings.length > 0) throw new PublicEvidenceError(findings);
  return { files, findings };
}
