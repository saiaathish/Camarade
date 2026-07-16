import { readFile, writeFile } from "node:fs/promises";
import type { ContextCompilationResult } from "../context/context-types.js";
import { sha256 } from "../context/context-serialization.js";

export async function prepareCamaradeContext(
  result: ContextCompilationResult,
  outputPath: string,
  mode: "augmentation" | "replacement",
  baselineMarkdown: string
): Promise<{ contextHash: string; markdown: string; compilation: ContextCompilationResult }> {
  const compiledMarkdown = await readFile(result.artifacts.contractMarkdown, "utf8");
  const markdown = mode === "augmentation"
    ? `${baselineMarkdown}${baselineMarkdown ? "\n\n" : ""}${compiledMarkdown}`
    : compiledMarkdown;
  await writeFile(outputPath, markdown, "utf8");
  return { contextHash: sha256(markdown), markdown, compilation: result };
}
