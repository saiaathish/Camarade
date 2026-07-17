import { lstat, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { EvaluationExecutionError } from "./evaluation-execution-errors.js";
import { canonicalJson, sha256 } from "../context/context-serialization.js";
export const TEXT_LIMIT = 8 * 1024 * 1024;
export const JSON_LIMIT = 8 * 1024 * 1024;
export const REPORT_LIMIT = 16 * 1024 * 1024;
export function safeRelativePath(value: string): string {
  if (
    !value ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").includes("..")
  )
    throw new EvaluationExecutionError(
      "Unsafe repository path.",
      "EVALUATION_PATH_UNSAFE",
      "check-execution",
      { path: value },
    );
  return value;
}
export async function safePath(
  root: string,
  value: string,
  limit: number,
  kind: "file" | "entry" = "file",
): Promise<{ path: string; bytes: Buffer; stat: import("node:fs").Stats }> {
  const rel = safeRelativePath(value);
  const path = resolve(root, rel);
  const rootResolved = resolve(root);
  if (path !== rootResolved && !path.startsWith(`${rootResolved}${sep}`))
    throw new EvaluationExecutionError(
      "Path escapes worktree.",
      "EVALUATION_PATH_UNSAFE",
      "check-execution",
    );
  const parts = rel.split("/");
  let current = rootResolved;
  for (const part of parts) {
    current = join(current, part);
    const st = await lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (st?.isSymbolicLink())
      throw new EvaluationExecutionError(
        "Symbolic-link path rejected.",
        "EVALUATION_PATH_UNSAFE",
        "check-execution",
        { path: rel },
      );
  }
  const st = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!st)
    throw new EvaluationExecutionError(
      "File is missing.",
      "EVALUATION_FILE_INVALID",
      "check-execution",
      { path: rel },
    );
  if (kind === "file" && !st.isFile())
    throw new EvaluationExecutionError(
      "Path is not a regular file.",
      "EVALUATION_FILE_INVALID",
      "check-execution",
      { path: rel },
    );
  if (st.size > limit)
    throw new EvaluationExecutionError(
      "File exceeds size limit.",
      "EVALUATION_FILE_TOO_LARGE",
      "check-execution",
      { path: rel },
    );
  const bytes = kind === "file" ? await readFile(path) : Buffer.alloc(0);
  return { path, bytes, stat: st };
}
export function experimentRelative(root: string, path: string): string {
  const out = relative(root, path).split(sep).join("/");
  if (out.startsWith("..") || out.startsWith("/"))
    throw new EvaluationExecutionError(
      "Evidence path escapes experiment.",
      "EVALUATION_PATH_UNSAFE",
      "execution-publication",
    );
  return out;
}
export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}
export function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function globMatch(pattern: string, value: string): boolean {
  safeRelativePath(pattern);
  const escaped = pattern
    .split("/")
    .map((segment) =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/§§/g, ".*"),
    )
    .join("\\/");
  return new RegExp(`^${escaped}$`).test(value);
}
