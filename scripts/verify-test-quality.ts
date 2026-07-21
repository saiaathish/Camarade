import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const testRoot = join(root, "tests");
const files: string[] = [];
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
}
await collect(testRoot);
const forbidden: Array<{ file: string; marker: string; line: number }> = [];
const weak: Array<{ file: string; line: number; text: string }> = [];
const literalEquality = /expect\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')\s*\)\.toBe\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')\s*\)/g;
const literalContainment = /expect\(\s*\[([^\]]*)\]\s*\)\.toContain\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')\s*\)/g;
for (const file of files.sort()) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  lines.forEach((text, index) => {
    if (/\b(?:describe|it|test|suite)\.(?:only|skip|todo)\b|\bx(?:it|describe|test)\b/.test(text)) forbidden.push({ file, marker: text.trim(), line: index + 1 });
    const staticEquality = [...text.matchAll(literalEquality)].some((match) => match[1] === match[2]);
    const staticContainment = [...text.matchAll(literalContainment)].some((match) => match[1].split(",").map((value) => value.trim()).includes(match[2]));
    if (staticEquality || staticContainment) weak.push({ file, line: index + 1, text: text.trim() });
  });
}
const result = { status: forbidden.length === 0 && weak.length === 0 ? "pass" : "fail", scannedFiles: files.length, forbiddenMarkers: forbidden, weakAssertions: weak };
console.log(JSON.stringify(result, null, 2));
if (forbidden.length > 0 || weak.length > 0) process.exitCode = 1;
