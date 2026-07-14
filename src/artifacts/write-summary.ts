import { writeJsonExclusive } from "./write-manifest.js";

export interface WriteSummaryOptions {
  summaryPath: string;
  summary: unknown;
}

export function writeSummary(summaryPath: string, summary: unknown): Promise<string>;
export function writeSummary(options: WriteSummaryOptions): Promise<string>;
export function writeSummary(
  pathOrOptions: string | WriteSummaryOptions,
  summary?: unknown
): Promise<string> {
  if (typeof pathOrOptions === "string") {
    return writeJsonExclusive(pathOrOptions, summary, "Comparison summary");
  }
  return writeJsonExclusive(pathOrOptions.summaryPath, pathOrOptions.summary, "Comparison summary");
}
