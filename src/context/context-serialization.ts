import { createHash } from "node:crypto";
import path from "node:path";

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort(compareText)
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createContextId(prefix: string, components: readonly unknown[]): string {
  const digest = sha256(JSON.stringify(canonicalize(components))).slice(0, 12);
  return `${prefix}_${digest}`;
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function isSafeRepositoryPath(value: string): boolean {
  if (value === "<task>") return true;
  return value.length > 0 &&
    !path.isAbsolute(value) &&
    !/^\\\\/.test(value) &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.split(/[\\/]/).includes("..") &&
    !value.includes("\0");
}

export function characterCount(value: string): number {
  return Array.from(value).length;
}
